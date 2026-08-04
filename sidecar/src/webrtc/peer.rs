//! WebRTC peer for the kerbcast sidecar. One `KerbcastPeer` per browser
//! connection; each carries one H.264 video track per camera the browser
//! subscribed to AND a "kerbcast-control" data channel for bidirectional
//! protocol messages (see `crate::protocol`). webrtc-rs handles
//! ICE/DTLS/SRTP/RTP packetisation internally.
//!
//! Track lifecycle: the peer owns Arcs to its tracks for the duration of
//! its RTCPeerConnection. Each camera's registry entry holds a Weak ref
//! to the same track + a subscriber count. When the peer is dropped,
//! the Arcs go with it; the camera-side consume loop notices the dead
//! Weaks on its next tick and decrements its subscriber count.
//!
//! Data channel: created by the browser side (the offer SDP includes a
//! datachannel m-section). When it opens, the handler dispatches
//! incoming `ClientMessage` JSON; the server replies / pushes
//! `ServerMessage` JSON back. The plugin reads the mutated control
//! state via its periodic `*.control.json` poll, so layer/render-size
//! changes propagate within ~1s of the data-channel write.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

/// Monotonic counter for per-peer identifiers. Identifies a peer for
/// logging and slot bookkeeping (SetDegrade arrives via the data
/// channel rather than RTCP, so there's no SSRC to lean on).
static NEXT_PEER_ID: AtomicU32 = AtomicU32::new(1);

use anyhow::{anyhow, Result};
use tokio::sync::{Mutex, Notify};
use tracing::{info, warn};

use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::{MediaEngine, MIME_TYPE_H264};
use webrtc::api::setting_engine::SettingEngine;
use webrtc::api::APIBuilder;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::data_channel::RTCDataChannel;
use webrtc::interceptor::registry::Registry as InterceptorRegistry;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtcp;
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
use webrtc::rtp_transceiver::rtp_sender::RTCRtpSender;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::track::track_local::TrackLocal;

use crate::cameras::CameraState as InternalCameraState;

use crate::cameras::CameraRegistry;
use crate::encoder::selected_backend_name;
use crate::protocol::{
    CameraSnapshotPayload, CameraStateChangedPayload, ClientMessage, ErrorPayload, ErrorSource,
    FlightIdPayload, HelloPayload, Layer, QualityPreset, ReportDisplaySizePayload,
    SceneStateChangedPayload, ServerMessage, SetBackgroundCaptureFpsPayload, SetDegradePayload,
    SetForceFullResolutionPayload, SetFovPayload, SetLayersPayload, SetPanPayload,
    SetPanRatePayload, SetQualityPayload, SetRenderSizePayload, SetThrottleMainScreenPayload,
    SetTrackTargetPayload, SetZoomRatePayload, SlotMapPayload,
};

const CONTROL_CHANNEL_LABEL: &str = "kerbcast-control";

/// One pre-negotiated video slot. The track stays on the peer connection
/// for the connection's lifetime; `bound` records which camera currently
/// feeds it (`None` = idle/silent) and `mid` is the transceiver mid the
/// browser keys its `SlotMap` routing on (filled once the answer is set).
struct Slot {
    track: Arc<TrackLocalStaticSample>,
    mid: Option<String>,
    bound: Option<u32>,
}

pub struct KerbcastPeer {
    pc: Arc<RTCPeerConnection>,
    /// Stable identifier for this peer for the lifetime of the
    /// connection. Used for logging and slot bookkeeping.
    pub peer_id: u32,
    /// The pre-negotiated slot pool. `Subscribe` binds a camera to a free
    /// slot; `Unsubscribe` frees one — no renegotiation. Dropping the peer
    /// drops the slot-track Arcs; the matching Weak refs in each camera's
    /// `tracks` list go stale and are pruned on the next encode tick.
    slots: Arc<Mutex<Vec<Slot>>>,
    /// flight_ids bound at connect time — echoed (in slot order) in the
    /// `/offer` answer so the browser maps its initial cameras to slots.
    pub subscribed: Vec<u32>,
    /// Set once the browser opens the control channel. Held for the
    /// peer's lifetime so server-initiated pushes (AdaptiveShed,
    /// vessel-change-driven camera-state-changed) can address this
    /// peer directly without re-discovering the channel each time.
    control_channel: Arc<Mutex<Option<Arc<RTCDataChannel>>>>,
    connected: Arc<Notify>,
    /// Flipped to `false` when the underlying RTCPeerConnection reaches a
    /// terminal state. The daemon polls `is_alive()` each consume tick.
    alive: Arc<AtomicBool>,
}

impl KerbcastPeer {
    /// Build a peer with a pool of `slot_count` pre-negotiated H.264 video
    /// slots + a "kerbcast-control" data channel. The cameras in `initial`
    /// are bound to the first slots immediately (skipping unknown/destroyed
    /// ones); the rest stay idle until the browser `Subscribe`s a camera
    /// into them. `slot_count` must equal the number of recv-only video
    /// transceivers in the browser's offer or SDP negotiation won't match.
    pub async fn new(
        registry: Arc<CameraRegistry>,
        initial: &[u32],
        slot_count: usize,
    ) -> Result<Self> {
        let peer_id = NEXT_PEER_ID.fetch_add(1, Ordering::Relaxed);
        let mut media_engine = MediaEngine::default();
        media_engine.register_default_codecs()?;
        // Install the default interceptors — critically the NACK responder,
        // which retransmits packets the browser reports lost (via the `nack`
        // feedback `register_default_codecs` already advertises). Without it a
        // single lost packet breaks the H.264 reference chain with no recovery
        // until the next scheduled keyframe (~2s GOP) — feeds "cut to static
        // for a moment then return". The responder recovers the loss in ~1 RTT.
        // No REMB interceptor is in this set, and the encode side ignores
        // bandwidth estimates anyway, so the old REMB-driven reinit death spiral
        // (see main.rs) cannot recur.
        let mut interceptor_registry = InterceptorRegistry::new();
        interceptor_registry =
            register_default_interceptors(interceptor_registry, &mut media_engine)?;
        // Disable mDNS candidate obfuscation: the default QueryAndGather mode
        // generates .local hostnames that desktop Chrome resolves but Android
        // Chrome cannot, preventing streams from loading on mobile.
        let mut setting_engine = SettingEngine::default();
        setting_engine.set_ice_multicast_dns_mode(ice::mdns::MulticastDnsMode::QueryOnly);
        let api = APIBuilder::new()
            .with_media_engine(media_engine)
            .with_setting_engine(setting_engine)
            .with_interceptor_registry(interceptor_registry)
            .build();

        // No external STUN server: this is a LAN-only tool and host candidates
        // are sufficient. The Google STUN URL was unreachable over IPv6 from
        // the Deck (Network is unreachable) and its timeout caused 1-2 minute
        // delays before mobile ICE proceeded with what it had.
        let config = RTCConfiguration::default();

        let pc = Arc::new(api.new_peer_connection(config).await?);

        // Build the slot pool: one send-track per slot, added to the PC so
        // the answer carries `slot_count` video m-lines matching the offer's
        // recv-only transceivers. Each sender's RTCP must be drained or
        // webrtc-rs's NACK/PLI pipelines stall (see `drain_rtcp_sink`); the
        // senders are held here and the per-slot drain tasks are spawned once
        // the slot pool is shared (below), so each drain can resolve the camera
        // bound to its slot when it honors a PLI.
        let mut slots: Vec<Slot> = Vec::with_capacity(slot_count);
        let mut senders: Vec<Arc<RTCRtpSender>> = Vec::with_capacity(slot_count);
        for i in 0..slot_count {
            let track = Arc::new(TrackLocalStaticSample::new(
                /* Declare the fmtp explicitly. With only a mime type here, codec
                matching falls back to a mime-only fuzzy search across every
                H.264 payload type the browser offered — including
                packetization-mode=0 ones, which permit single-NAL packets
                only. Our encoder emits fragmented and aggregated NALs, so
                landing on such a payload type yields RTP the browser accepts
                and cannot decode: traffic on the wire, readyState stuck at 0,
                and not one error anywhere in the stack. Pinning
                packetization-mode=1 with the constrained-baseline profile
                every browser offers makes the choice deterministic. */
                RTCRtpCodecCapability {
                    mime_type: MIME_TYPE_H264.to_owned(),
                    sdp_fmtp_line:
                        "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f"
                            .to_owned(),
                    ..Default::default()
                },
                format!("video-slot{i}"),
                format!("kerbcast-slot{i}"),
            ));
            let rtp_sender = pc
                .add_track(track.clone() as Arc<dyn TrackLocal + Send + Sync>)
                .await?;
            senders.push(rtp_sender);
            slots.push(Slot {
                track,
                mid: None,
                bound: None,
            });
        }

        // Bind the initial subscription onto the first free slots. Camera ->
        // slot binding is just `cam.add_track`; the consume loop then feeds
        // the slot from that camera's encoder. set_subscribed(true) wakes the
        // plugin's per-camera render on its next ~1Hz control poll.
        let mut subscribed = Vec::new();
        for &flight_id in initial {
            let cam = match registry.get(flight_id).await {
                Some(c) => c,
                None => {
                    warn!(flight_id, "initial camera not found, skipping");
                    continue;
                }
            };
            if cam.destroyed.load(Ordering::Acquire) {
                warn!(flight_id, "skipping destroyed initial camera");
                continue;
            }
            let Some(slot) = slots.iter_mut().find(|s| s.bound.is_none()) else {
                warn!(flight_id, "no free slot for initial subscription");
                break;
            };
            cam.add_track(slot.track.clone()).await;
            registry.set_subscribed(flight_id, true).await;
            slot.bound = Some(flight_id);
            subscribed.push(flight_id);
        }

        let slots = Arc::new(Mutex::new(slots));

        // Spawn the per-slot RTCP drains now that the slot pool is shared. Each
        // drain pumps its sender's RTCP (driving the NACK responder) and honors
        // PLI/FIR by forcing a keyframe on the camera currently bound to its
        // slot.
        for (slot_idx, sender) in senders.into_iter().enumerate() {
            let slots = slots.clone();
            let registry = registry.clone();
            tokio::spawn(async move {
                drain_rtcp_sink(sender, slot_idx, slots, registry).await;
            });
        }

        let control_channel: Arc<Mutex<Option<Arc<RTCDataChannel>>>> = Arc::new(Mutex::new(None));

        let registry_for_dc = registry.clone();
        let control_channel_for_handler = control_channel.clone();
        let slots_for_handler = slots.clone();
        pc.on_data_channel(Box::new(move |dc: Arc<RTCDataChannel>| {
            let registry = registry_for_dc.clone();
            let control_channel = control_channel_for_handler.clone();
            let slots = slots_for_handler.clone();
            Box::pin(async move {
                if dc.label() != CONTROL_CHANNEL_LABEL {
                    info!(label = %dc.label(), "ignoring unexpected data channel");
                    return;
                }
                info!(label = %dc.label(), "control channel opened");
                *control_channel.lock().await = Some(dc.clone());

                let dc_for_msg = dc.clone();
                dc.on_message(Box::new(move |msg: DataChannelMessage| {
                    let registry = registry.clone();
                    let slots = slots.clone();
                    let dc = dc_for_msg.clone();
                    Box::pin(async move {
                        handle_client_message(registry, peer_id, slots, dc, msg).await;
                    })
                }));
            })
        }));

        let connected = Arc::new(Notify::new());
        let alive = Arc::new(AtomicBool::new(true));
        let connected_for_handler = connected.clone();
        let alive_for_handler = alive.clone();
        pc.on_peer_connection_state_change(Box::new(move |state: RTCPeerConnectionState| {
            info!(?state, "peer connection state");
            if state == RTCPeerConnectionState::Connected {
                connected_for_handler.notify_waiters();
            }
            if matches!(
                state,
                RTCPeerConnectionState::Disconnected
                    | RTCPeerConnectionState::Failed
                    | RTCPeerConnectionState::Closed
            ) {
                alive_for_handler.store(false, Ordering::Release);
            }
            Box::pin(async {})
        }));

        Ok(Self {
            pc,
            peer_id,
            slots,
            subscribed,
            control_channel,
            connected,
            alive,
        })
    }

    /// Browser-initiated SDP flow used by the HTTP signalling endpoint.
    /// Browser POSTs its offer, we set it as the remote description, then
    /// create + return our answer.
    pub async fn answer_to_offer(&self, offer_sdp: String) -> Result<String> {
        let offer = RTCSessionDescription::offer(offer_sdp)?;
        self.pc.set_remote_description(offer).await?;

        let answer = self.pc.create_answer(None).await?;
        self.pc.set_local_description(answer).await?;

        let mut gather_complete = self.pc.gathering_complete_promise().await;
        let _ = gather_complete.recv().await;

        // Record each slot's negotiated transceiver mid so SlotMap addresses
        // slots by the same stable mid the browser sees. Slot-tracks were
        // add_track'd in order, so get_transceivers() is index-aligned with
        // the pool (Unified Plan preserves m-line order).
        let transceivers = self.pc.get_transceivers().await;
        {
            let mut slots = self.slots.lock().await;
            if slots.len() != transceivers.len() {
                warn!(
                    slots = slots.len(),
                    transceivers = transceivers.len(),
                    "slot/transceiver count mismatch — slot mids may misalign",
                );
            }
            for (slot, tr) in slots.iter_mut().zip(transceivers.iter()) {
                slot.mid = tr.mid().map(|m| m.to_string());
            }
            /* A slot with no mid never matched an m-line, so its track was
            never bound to a sender. write_sample() on such a track returns
            Ok and silently discards the frame — the exact shape of a black
            feed with a healthy-looking pipeline. Loud, because nothing
            downstream can tell you this happened. */
            let unbound: Vec<usize> = slots
                .iter()
                .enumerate()
                .filter(|(_, s)| s.mid.is_none())
                .map(|(i, _)| i)
                .collect();
            if !unbound.is_empty() {
                warn!(
                    unbound_slots = ?unbound,
                    total_slots = slots.len(),
                    transceivers = transceivers.len(),
                    "slots have NO negotiated mid — their tracks are unbound and \
                     every write_sample on them is silently dropped"
                );
            }
            for (i, (slot, tr)) in slots.iter().zip(transceivers.iter()).enumerate() {
                info!(
                    slot = i,
                    mid = ?slot.mid,
                    direction = ?tr.direction(),
                    current_direction = ?tr.current_direction(),
                    "slot negotiation result"
                );
            }
        }

        let local = self
            .pc
            .local_description()
            .await
            .ok_or_else(|| anyhow!("local description missing after set_local_description"))?;

        /* Which H.264 payload type and fmtp actually got negotiated. The slot
        tracks declare only a mime type (no sdp_fmtp_line), so codec matching
        falls back to a mime-only fuzzy search and can land on a payload type
        whose parameters our encoder does not satisfy — packetization-mode or
        profile-level-id in particular. That produces RTP the browser accepts
        but cannot decode: traffic on the wire, readyState stuck at 0. */
        for line in local.sdp.lines() {
            if line.starts_with("a=rtpmap:") && line.to_ascii_uppercase().contains("H264") {
                info!(sdp_line = line, "negotiated H264 rtpmap");
            }
            if line.starts_with("a=fmtp:") {
                info!(sdp_line = line, "negotiated fmtp");
            }
        }
        Ok(local.sdp)
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }

    /// Flight IDs currently bound to this peer's slots. Unlike the
    /// construction-time `subscribed` list, this reflects dynamic
    /// `Subscribe`/`Unsubscribe` (which mutate the slots, not that list),
    /// so the dead-peer cleanup can zero rates on exactly the cameras this
    /// peer was driving when it dropped.
    pub async fn bound_flight_ids(&self) -> Vec<u32> {
        self.slots
            .lock()
            .await
            .iter()
            .filter_map(|s| s.bound)
            .collect()
    }

    /// Release every camera this peer's slots are bound to (immediate
    /// subscriber-count decrement + `set_subscribed(false)` at zero). Called by
    /// the reaper when the peer is reaped, and shares the exact logic of the
    /// graceful `Disconnect` message — so a dropped viewer's cameras stop
    /// rendering on the next reaper tick instead of waiting for the consume
    /// loop's lazy dead-Weak prune (which a staggered camera can starve).
    pub async fn release_all(&self, registry: &Arc<CameraRegistry>) {
        release_all_bound(registry, &self.slots).await;
    }

    /// Tracks of this peer's slots currently bound to `flight_id` (0 or 1
    /// in practice; Subscribe never double-binds). Used by the consume
    /// loop to rebind a surviving subscription when a camera's ring
    /// disappears and reappears across a KSP scene change: the slot stays
    /// bound through the gap, but the re-attached ring gets a brand-new
    /// `CameraState` that doesn't know about this track yet.
    pub async fn tracks_bound_to(&self, flight_id: u32) -> Vec<Arc<TrackLocalStaticSample>> {
        self.slots
            .lock()
            .await
            .iter()
            .filter(|s| s.bound == Some(flight_id))
            .map(|s| s.track.clone())
            .collect()
    }

    /// Push a fresh camera snapshot over the control channel (no-op until
    /// the channel opens). Server-initiated counterpart of the Hello-time
    /// snapshot, used when registry membership churns mid-connection so a
    /// browser's camera list drains and repopulates across scene changes.
    pub async fn push_camera_snapshot(&self, registry: &Arc<CameraRegistry>) {
        let dc = match self.control_channel.lock().await.as_ref() {
            Some(d) => d.clone(),
            None => return,
        };
        send_camera_snapshot(registry, &dc).await;
    }

    /// Server-initiated push to the browser. No-op if the control
    /// channel hasn't been opened yet (we drop the message rather than
    /// queue — pushes from the consume loop are state snapshots, so a
    /// later snapshot supersedes a dropped one).
    pub async fn push_message(&self, msg: &ServerMessage) {
        let dc = match self.control_channel.lock().await.as_ref() {
            Some(d) => d.clone(),
            None => return,
        };
        send_server_message(&dc, msg).await;
    }

    /// Block until the peer reaches the Connected state. Used by tests.
    #[allow(dead_code)]
    pub async fn wait_connected(&self) {
        self.connected.notified().await;
    }

    /// Tear down the peer cleanly. Idempotent. Releases the RTCRtpSenders'
    /// strong refs to the slot tracks (see `close_releases_track_arc`), so each
    /// camera's Weak goes dead and the consume loop prunes it — dropping the
    /// subscriber count to zero and flushing `set_subscribed(false)`. Must be
    /// called when reaping a dropped peer, or cameras keep rendering for a
    /// viewer that's already gone.
    pub async fn close(&self) -> Result<()> {
        self.pc.close().await?;
        Ok(())
    }
}

/// Single-message dispatch. Pulled out of the closure so the error
/// paths and per-variant logic don't drown the construction code.
async fn handle_client_message(
    registry: Arc<CameraRegistry>,
    peer_id: u32,
    slots: Arc<Mutex<Vec<Slot>>>,
    dc: Arc<RTCDataChannel>,
    msg: DataChannelMessage,
) {
    let text = match std::str::from_utf8(&msg.data) {
        Ok(s) => s,
        Err(e) => {
            warn!(error = %e, "control channel: non-utf8 payload, dropping");
            return;
        }
    };
    let parsed: ClientMessage = match serde_json::from_str(text) {
        Ok(m) => m,
        Err(e) => {
            warn!(error = %e, payload = %text, "control channel: parse failed");
            send_server_message(
                &dc,
                &ServerMessage::Error(ErrorPayload {
                    message: format!("parse failed: {e}"),
                    source: ErrorSource::Sidecar,
                }),
            )
            .await;
            return;
        }
    };

    match parsed {
        ClientMessage::Hello => {
            info!("control channel: hello received");
            send_server_message(
                &dc,
                &ServerMessage::Hello(HelloPayload {
                    sidecar_version: crate::VERSION.to_owned(),
                    encoder_backend: selected_backend_name().to_owned(),
                }),
            )
            .await;
            send_camera_snapshot(&registry, &dc).await;
            /* Prime the client with current global settings (throttle + the
             * mission-time capture clock, if the plugin has reported one). */
            send_server_message(
                &dc,
                &ServerMessage::SettingsState(registry.last_settings().await),
            )
            .await;
            /* Prime scene state so a peer connecting out of flight shows the
             * standby immediately, not a stale live layout. */
            if let Some(in_flight) = registry.read_in_flight().await {
                send_server_message(
                    &dc,
                    &ServerMessage::SceneStateChanged(SceneStateChangedPayload { in_flight }),
                )
                .await;
            }
            // Announce the initial slot bindings so the client maps its
            // initial cameras to slots by mid — uniform with dynamic
            // Subscribe, no reliance on the answer's camera order.
            send_initial_slot_maps(&slots, &dc).await;
        }
        ClientMessage::SetLayers(SetLayersPayload { flight_id, layers }) => {
            apply_layer_change(&registry, &dc, flight_id, layers).await;
        }
        ClientMessage::SetRenderSize(SetRenderSizePayload {
            flight_id,
            width,
            height,
        }) => {
            apply_render_size_change(&registry, &dc, flight_id, width, height).await;
        }
        // A consumer reporting its own display px for one camera. Recorded
        // keyed by peer_id into the per-camera MAX-across-consumers tracker;
        // forgotten on unsubscribe / disconnect / peer reap (below + in the
        // consume-loop reaper) so the max relaxes when it leaves.
        ClientMessage::ReportDisplaySize(ReportDisplaySizePayload {
            flight_id,
            width,
            height,
        }) => {
            registry
                .record_display_size(flight_id, peer_id, width, height)
                .await;
        }
        ClientMessage::SetFov(SetFovPayload { flight_id, fov }) => {
            apply_fov_change(&registry, &dc, flight_id, fov).await;
        }
        ClientMessage::SetPan(SetPanPayload {
            flight_id,
            yaw,
            pitch,
        }) => {
            apply_pan_change(&registry, &dc, flight_id, yaw, pitch).await;
        }
        ClientMessage::SetPanRate(SetPanRatePayload {
            flight_id,
            yaw_rate,
            pitch_rate,
        }) => {
            apply_pan_rate_change(&registry, &dc, flight_id, yaw_rate, pitch_rate).await;
        }
        ClientMessage::SetZoomRate(SetZoomRatePayload { flight_id, rate }) => {
            apply_zoom_rate_change(&registry, &dc, flight_id, rate).await;
        }
        ClientMessage::SetDegrade(SetDegradePayload { flight_id, level }) => {
            apply_degrade_change(&registry, &dc, peer_id, flight_id, level).await;
        }
        ClientMessage::SetQuality(SetQualityPayload { flight_id, preset }) => {
            apply_quality_change(&registry, &dc, flight_id, preset).await;
        }
        ClientMessage::SetTrackTarget(SetTrackTargetPayload { flight_id, mode }) => {
            /* Server-authoritative auto-track: store + flush the mode; the
            broadcast (mark_dirty) syncs every browser. A browser track
            overrides a kOS aim on the same camera. */
            if let Err(message) = registry.apply_track_target(flight_id, mode).await {
                send_server_message(
                    &dc,
                    &ServerMessage::Error(ErrorPayload {
                        message,
                        source: ErrorSource::Sidecar,
                    }),
                )
                .await;
            }
        }
        ClientMessage::RequestKeyframe(FlightIdPayload { flight_id }) => {
            // The encoder backends expose `request_keyframe()`; we call
            // it through the per-camera encoder lock if it's currently
            // initialised. If not, the next encode produces an IDR
            // anyway (cold start), so the no-op is the right thing.
            if let Some(cam) = registry.get(flight_id).await {
                request_keyframe_for(&cam).await;
                info!(flight_id, "keyframe requested");
            }
        }
        ClientMessage::Subscribe(FlightIdPayload { flight_id }) => {
            handle_subscribe(&registry, &slots, &dc, flight_id).await;
        }
        ClientMessage::Unsubscribe(FlightIdPayload { flight_id }) => {
            handle_unsubscribe(&registry, peer_id, &slots, &dc, flight_id).await;
        }
        ClientMessage::Pong => {
            // No-op — the peer is alive by virtue of having sent this.
        }
        ClientMessage::SetThrottleMainScreen(SetThrottleMainScreenPayload { enabled }) => {
            /* Write global.control.json; the plugin polls it next to status. */
            if let Err(e) = registry.write_global_control(enabled).await {
                warn!(error = %e, "write_global_control failed");
            } else {
                info!(enabled, "global control: throttle_main_screen written");
            }
        }
        // A recording (or other consumer) forcing this camera to the ring
        // ceiling for as long as it holds the force. OR-aggregated per peer;
        // forgotten on unsubscribe / disconnect / peer reap (below + in the
        // consume-loop reaper) so the ceiling relaxes once no peer forces it.
        ClientMessage::SetForceFullResolution(SetForceFullResolutionPayload {
            flight_id,
            force,
        }) => {
            registry
                .set_forced_full_res(flight_id, peer_id, force)
                .await;
        }
        // Background capture ("hum"): this consumer asking that cameras it
        // isn't displaying keep ticking over instead of stopping. Per-peer and
        // MAX-aggregated; forgotten on disconnect / peer reap so a departed
        // consumer can't pin the hum on with nobody watching.
        ClientMessage::SetBackgroundCaptureFps(SetBackgroundCaptureFpsPayload { fps }) => {
            if registry.set_hum_request(peer_id, fps).await {
                // The aggregate moved, so every camera's requested rate has to
                // be recomputed and pushed down to the plugin.
                registry.reflush_all_capture_rates().await;
            }
        }
        ClientMessage::Disconnect => {
            // Graceful teardown: release every camera this peer is feeding now,
            // so they sleep immediately instead of waiting for the ICE drop to
            // be detected. The client closes its connection after this; the
            // reaper still handles the close (and any ungraceful exit).
            info!(
                peer_id,
                "client requested graceful disconnect — releasing cameras"
            );
            release_all_bound(&registry, &slots).await;
            // Peer-scoped display-size clear: sweeps EVERY camera this peer
            // reported a size for, including any it never bound a slot to.
            registry.forget_display_size_all(peer_id).await;
            // Same peer-scoped sweep for any force this peer held, so a feed
            // never stays pinned at the ceiling after its forcer leaves.
            registry.forget_forced_all(peer_id).await;
            // And the hum request, or a departed consumer keeps background
            // capture running for the rest of the session with nobody watching
            // — the v1.6.3 pin-high class again.
            if registry.forget_hum_request(peer_id).await {
                registry.reflush_all_capture_rates().await;
            }
        }
    }
}

/// Force the camera's encoder to emit an IDR on its next encode. No-op when no
/// encoder exists yet (a cold start already produces an IDR). Shared by the
/// explicit keyframe request and the slot-subscribe path.
async fn request_keyframe_for(cam: &Arc<InternalCameraState>) {
    let mut guard = cam.encoder.lock().await;
    if let Some(backend) = guard.as_mut() {
        backend.request_keyframe();
    }
}

/// Bind a camera to a free slot (or re-announce if already bound). On a fresh
/// bind the camera's subscriber count goes 0 -> 1, waking the plugin render;
/// the consume loop then feeds the slot's track from the camera's encoder.
async fn handle_subscribe(
    registry: &Arc<CameraRegistry>,
    slots: &Arc<Mutex<Vec<Slot>>>,
    dc: &Arc<RTCDataChannel>,
    flight_id: u32,
) {
    let cam = match registry.get(flight_id).await {
        Some(c) if !c.destroyed.load(Ordering::Acquire) => c,
        _ => {
            send_server_message(
                dc,
                &ServerMessage::Error(ErrorPayload {
                    message: format!("no live camera with flight_id={flight_id}"),
                    source: ErrorSource::Sidecar,
                }),
            )
            .await;
            return;
        }
    };

    // Choose a slot under the lock, then release it before the awaiting camera
    // ops. `fresh` distinguishes a new bind (add_track once) from a re-subscribe
    // of an already-bound camera (re-announce only — never double add_track).
    let (track, mid, fresh) = {
        let mut guard = slots.lock().await;
        if let Some(slot) = guard.iter().find(|s| s.bound == Some(flight_id)) {
            (slot.track.clone(), slot.mid.clone(), false)
        } else if let Some(slot) = guard.iter_mut().find(|s| s.bound.is_none()) {
            slot.bound = Some(flight_id);
            (slot.track.clone(), slot.mid.clone(), true)
        } else {
            drop(guard);
            send_server_message(
                dc,
                &ServerMessage::Error(ErrorPayload {
                    message: "no free slot — negotiate more video transceivers".into(),
                    source: ErrorSource::Sidecar,
                }),
            )
            .await;
            return;
        }
    };

    if fresh {
        // Keyframe BEFORE add_track so the next encode emits an IDR (with
        // SPS/PPS) to every track of this camera, including the freshly-added
        // slot — otherwise the slot's first frame is a mid-GOP P-frame that
        // decodes as garbage until the next periodic IDR.
        request_keyframe_for(&cam).await;
        cam.add_track(track).await;
        registry.set_subscribed(flight_id, true).await;
        info!(flight_id, "subscribed camera to slot");
    }

    match mid {
        Some(mid) => {
            send_server_message(
                dc,
                &ServerMessage::SlotMap(SlotMapPayload {
                    mid,
                    flight_id: Some(flight_id),
                }),
            )
            .await;
        }
        None => warn!(
            flight_id,
            "slot has no negotiated mid yet — SlotMap skipped"
        ),
    }
}

/// Release a camera's slot. The slot-track stays alive (reused for a later
/// subscribe); the camera sleeps once its last viewer leaves.
async fn handle_unsubscribe(
    registry: &Arc<CameraRegistry>,
    peer_id: u32,
    slots: &Arc<Mutex<Vec<Slot>>>,
    dc: &Arc<RTCDataChannel>,
    flight_id: u32,
) {
    // Clear-on-departure FIRST, before the slot early-out: an explicit
    // Unsubscribe(X) must forget this peer's reported display size for X even
    // when X was never bound to a slot (a report is not binding-gated), so the
    // MAX relaxes and can't pin high. Also covers the rebind-away path (a slot
    // only rebinds after an unsubscribe).
    registry.forget_display_size(flight_id, peer_id).await;

    let (track, mid) = {
        let mut guard = slots.lock().await;
        match guard.iter_mut().find(|s| s.bound == Some(flight_id)) {
            Some(slot) => {
                slot.bound = None;
                (slot.track.clone(), slot.mid.clone())
            }
            None => return, // not bound to any slot — nothing more to do
        }
    };

    if let Some(cam) = registry.get(flight_id).await {
        let remaining = cam.remove_track(&track).await;
        if remaining == 0 {
            // Last viewer — sleep the camera promptly (the consume loop's
            // refresh_idle_subscriptions would also catch this next tick).
            registry.set_subscribed(flight_id, false).await;
        }
        info!(flight_id, remaining, "unsubscribed camera from slot");
    }

    if let Some(mid) = mid {
        send_server_message(
            dc,
            &ServerMessage::SlotMap(SlotMapPayload {
                mid,
                flight_id: None,
            }),
        )
        .await;
    }
}

/// Release EVERY camera this peer's slots are bound to — the shared teardown
/// used by both the graceful `Disconnect` message and the drop-detection
/// reaper. Mirrors `handle_unsubscribe`'s release (unbind the slot, drop the
/// camera's track ref by pointer, flush `set_subscribed(false)` when the last
/// viewer leaves) but over all slots at once, and without the per-slot SlotMap
/// reply (on a graceful Disconnect the client is leaving; on a reap the channel
/// is already gone). Decrements immediately — no dependence on the consume
/// loop's lazy dead-Weak prune (which a staggered camera's reduced frame
/// cadence can starve). Idempotent: a second call finds nothing bound.
async fn release_all_bound(registry: &Arc<CameraRegistry>, slots: &Arc<Mutex<Vec<Slot>>>) {
    // NOTE: display-size clear-on-departure is NOT done here — it is
    // peer-scoped (forget_display_size_all), not binding-scoped, because a
    // report can exist for a camera this peer never bound. Callers on the
    // peer-death paths (graceful Disconnect, the reaper) invoke
    // forget_display_size_all separately.
    let bound: Vec<(u32, Arc<TrackLocalStaticSample>)> = {
        let mut guard = slots.lock().await;
        let mut v = Vec::new();
        for slot in guard.iter_mut() {
            if let Some(flight_id) = slot.bound.take() {
                v.push((flight_id, slot.track.clone()));
            }
        }
        v
    };
    for (flight_id, track) in bound {
        if let Some(cam) = registry.get(flight_id).await {
            let remaining = cam.remove_track(&track).await;
            if remaining == 0 {
                registry.set_subscribed(flight_id, false).await;
            }
            info!(flight_id, remaining, "released camera on peer teardown");
        }
    }
}

/// Resync long-lived peers after registry membership churn (the consume loop
/// calls this on every rescan that attached or removed rings). Two halves:
///
///   1. Rebind: a peer that stayed connected across a KSP scene change has
///      slots still bound to flight ids whose rings just re-attached, but the
///      re-attach built a brand-new `CameraState` with an empty track list and
///      `subscribers == 0`. Re-add each bound slot's track and re-flush
///      `set_subscribed(true)` so the plugin resumes rendering and the
///      browser's existing video element picks the stream back up (the fresh
///      encoder session opens with an IDR, so the decoder resyncs cleanly).
///
///   2. Snapshot push: send every peer a fresh `camera-snapshot` so browser
///      camera lists drain and repopulate with the scene; clients already
///      handle this message (it's the Hello-time priming snapshot).
pub async fn resync_after_camera_churn(
    registry: &Arc<CameraRegistry>,
    peers: &[Arc<KerbcastPeer>],
    attached: &[u32],
) {
    if peers.is_empty() {
        return;
    }
    for &flight_id in attached {
        let Some(cam) = registry.get(flight_id).await else {
            continue;
        };
        let mut rebound = 0usize;
        for peer in peers {
            for track in peer.tracks_bound_to(flight_id).await {
                cam.add_track(track).await;
                rebound += 1;
            }
        }
        if rebound > 0 {
            registry.set_subscribed(flight_id, true).await;
            info!(
                flight_id,
                tracks = rebound,
                "re-attached camera rebound to surviving peer subscriptions",
            );
        }
    }
    for peer in peers {
        peer.push_camera_snapshot(registry).await;
    }
}

/// Announce the currently-bound slots to a freshly-opened control channel so
/// the client maps its initial cameras to slots by mid (the same mechanism
/// dynamic Subscribe uses). Idle slots and slots without a negotiated mid are
/// skipped.
async fn send_initial_slot_maps(slots: &Arc<Mutex<Vec<Slot>>>, dc: &Arc<RTCDataChannel>) {
    let bindings: Vec<(String, u32)> = {
        let guard = slots.lock().await;
        guard
            .iter()
            .filter_map(|s| match (&s.mid, s.bound) {
                (Some(mid), Some(flight_id)) => Some((mid.clone(), flight_id)),
                _ => None,
            })
            .collect()
    };
    for (mid, flight_id) in bindings {
        send_server_message(
            dc,
            &ServerMessage::SlotMap(SlotMapPayload {
                mid,
                flight_id: Some(flight_id),
            }),
        )
        .await;
    }
}

async fn apply_layer_change(
    registry: &Arc<CameraRegistry>,
    dc: &Arc<RTCDataChannel>,
    flight_id: u32,
    layers: Vec<Layer>,
) {
    let cam = match registry.get(flight_id).await {
        Some(c) => c,
        None => {
            send_server_message(
                dc,
                &ServerMessage::Error(ErrorPayload {
                    message: format!("no camera with flight_id={flight_id}"),
                    source: ErrorSource::Sidecar,
                }),
            )
            .await;
            return;
        }
    };

    let snapshot = {
        let mut ctrl = cam.control.lock().await;
        ctrl.layers = layers.clone();
        ctrl.clone()
    };

    if let Err(e) = registry.flush_control(flight_id, &snapshot).await {
        warn!(flight_id, error = %e, "control file flush failed");
        send_server_message(
            dc,
            &ServerMessage::Error(ErrorPayload {
                message: format!("control file flush failed: {e}"),
                source: ErrorSource::Sidecar,
            }),
        )
        .await;
        return;
    }

    info!(flight_id, layers = ?layers, "data-channel set-layers applied");
    push_camera_state(registry, dc, flight_id).await;
}

async fn apply_render_size_change(
    registry: &Arc<CameraRegistry>,
    dc: &Arc<RTCDataChannel>,
    flight_id: u32,
    width: u32,
    height: u32,
) {
    let cam = match registry.get(flight_id).await {
        Some(c) => c,
        None => {
            send_server_message(
                dc,
                &ServerMessage::Error(ErrorPayload {
                    message: format!("no camera with flight_id={flight_id}"),
                    source: ErrorSource::Sidecar,
                }),
            )
            .await;
            return;
        }
    };

    // Cap at the ring's allocated max — anything bigger would be
    // rejected by the plugin's MmapFrameRing.Produce on the next emit.
    let w = make_even(width.min(cam.max_width));
    let h = make_even(height.min(cam.max_height));

    // SetRenderSize is now a CAP, not a direct set: it bounds the auto
    // MAX-across-consumers resolution rather than clobbering it. The effective
    // size flushed to the plugin is min(auto, this cap).
    if let Err(e) = registry
        .set_manual_render_size(flight_id, Some((w, h)))
        .await
    {
        warn!(flight_id, error = %e, "control file flush failed");
        send_server_message(
            dc,
            &ServerMessage::Error(ErrorPayload {
                message: format!("control file flush failed: {e}"),
                source: ErrorSource::Sidecar,
            }),
        )
        .await;
        return;
    }

    info!(
        flight_id,
        width = w,
        height = h,
        "data-channel set-render-size applied (manual cap)"
    );
    push_camera_state(registry, dc, flight_id).await;
}

async fn apply_fov_change(
    registry: &Arc<CameraRegistry>,
    dc: &Arc<RTCDataChannel>,
    flight_id: u32,
    fov: f32,
) {
    let cam = match registry.get(flight_id).await {
        Some(c) => c,
        None => {
            send_server_message(
                dc,
                &ServerMessage::Error(ErrorPayload {
                    message: format!("no camera with flight_id={flight_id}"),
                    source: ErrorSource::Sidecar,
                }),
            )
            .await;
            return;
        }
    };
    if !cam.supports_zoom {
        send_server_message(
            dc,
            &ServerMessage::Error(ErrorPayload {
                message: format!("camera {flight_id} does not support zoom"),
                source: ErrorSource::Sidecar,
            }),
        )
        .await;
        return;
    }
    // Clamp to the part's declared FoV range so the plugin doesn't get
    // a value the Hullcam module would reject.
    let clamped = fov.clamp(cam.fov_min, cam.fov_max);

    let snapshot = {
        let mut ctrl = cam.control.lock().await;
        ctrl.fov = Some(clamped);
        // Bump so the plugin applies this absolute even mid zoom-rate hold
        // (and distinguishes it from the same value re-serialised on an
        // unrelated write). Wrapping is fine — the plugin compares for
        // change, not magnitude.
        ctrl.fov_seq = ctrl.fov_seq.wrapping_add(1);
        ctrl.clone()
    };

    if let Err(e) = registry.flush_control(flight_id, &snapshot).await {
        warn!(flight_id, error = %e, "control file flush failed");
        send_server_message(
            dc,
            &ServerMessage::Error(ErrorPayload {
                message: format!("control file flush failed: {e}"),
                source: ErrorSource::Sidecar,
            }),
        )
        .await;
        return;
    }

    info!(flight_id, fov = clamped, "data-channel set-fov applied");
    push_camera_state(registry, dc, flight_id).await;
}

async fn apply_pan_change(
    registry: &Arc<CameraRegistry>,
    dc: &Arc<RTCDataChannel>,
    flight_id: u32,
    yaw: f32,
    pitch: f32,
) {
    let cam = match registry.get(flight_id).await {
        Some(c) => c,
        None => {
            send_server_message(
                dc,
                &ServerMessage::Error(ErrorPayload {
                    message: format!("no camera with flight_id={flight_id}"),
                    source: ErrorSource::Sidecar,
                }),
            )
            .await;
            return;
        }
    };
    if !cam.supports_pan {
        send_server_message(
            dc,
            &ServerMessage::Error(ErrorPayload {
                message: format!(
                    "camera {flight_id} does not support pan/tilt (yet — \
                     planned mod extension)"
                ),
                source: ErrorSource::Sidecar,
            }),
        )
        .await;
        return;
    }
    let yaw_clamped = yaw.clamp(cam.pan_yaw_min, cam.pan_yaw_max);
    let pitch_clamped = pitch.clamp(cam.pan_pitch_min, cam.pan_pitch_max);

    let snapshot = {
        let mut ctrl = cam.control.lock().await;
        ctrl.pan_yaw = Some(yaw_clamped);
        ctrl.pan_pitch = Some(pitch_clamped);
        // Bump so the plugin applies this absolute even mid pan-rate hold
        // (see `ControlState::pan_seq`). Covers both yaw and pitch.
        ctrl.pan_seq = ctrl.pan_seq.wrapping_add(1);
        ctrl.clone()
    };

    if let Err(e) = registry.flush_control(flight_id, &snapshot).await {
        warn!(flight_id, error = %e, "control file flush failed");
        send_server_message(
            dc,
            &ServerMessage::Error(ErrorPayload {
                message: format!("control file flush failed: {e}"),
                source: ErrorSource::Sidecar,
            }),
        )
        .await;
        return;
    }

    info!(
        flight_id,
        yaw = yaw_clamped,
        pitch = pitch_clamped,
        "data-channel set-pan applied"
    );
    push_camera_state(registry, dc, flight_id).await;
}

/// Persistent pan velocity. Mirrors `apply_pan_change` but stores a
/// normalised rate the plugin integrates per frame rather than an absolute
/// target. A rate holds until superseded (including by zero), so the on-disk
/// `pan_yaw_rate`/`pan_pitch_rate` carry the last command.
async fn apply_pan_rate_change(
    registry: &Arc<CameraRegistry>,
    dc: &Arc<RTCDataChannel>,
    flight_id: u32,
    yaw_rate: f32,
    pitch_rate: f32,
) {
    let cam = match registry.get(flight_id).await {
        Some(c) => c,
        None => {
            send_server_message(
                dc,
                &ServerMessage::Error(ErrorPayload {
                    message: format!("no camera with flight_id={flight_id}"),
                    source: ErrorSource::Sidecar,
                }),
            )
            .await;
            return;
        }
    };
    if !cam.supports_pan {
        send_server_message(
            dc,
            &ServerMessage::Error(ErrorPayload {
                message: format!(
                    "camera {flight_id} does not support pan/tilt (yet — \
                     planned mod extension)"
                ),
                source: ErrorSource::Sidecar,
            }),
        )
        .await;
        return;
    }
    let yaw_clamped = yaw_rate.clamp(-1.0, 1.0);
    let pitch_clamped = pitch_rate.clamp(-1.0, 1.0);

    let snapshot = {
        let mut ctrl = cam.control.lock().await;
        ctrl.pan_yaw_rate = Some(yaw_clamped);
        ctrl.pan_pitch_rate = Some(pitch_clamped);
        ctrl.clone()
    };

    if let Err(e) = registry.flush_control(flight_id, &snapshot).await {
        warn!(flight_id, error = %e, "control file flush failed");
        send_server_message(
            dc,
            &ServerMessage::Error(ErrorPayload {
                message: format!("control file flush failed: {e}"),
                source: ErrorSource::Sidecar,
            }),
        )
        .await;
        return;
    }

    info!(
        flight_id,
        yaw_rate = yaw_clamped,
        pitch_rate = pitch_clamped,
        "data-channel set-pan-rate applied"
    );
    push_camera_state(registry, dc, flight_id).await;
}

/// Persistent zoom velocity. Mirrors `apply_fov_change` but stores a
/// normalised rate (+1 = zoom in) the plugin integrates into the FoV target
/// per frame, rather than an absolute FoV. Holds until superseded.
async fn apply_zoom_rate_change(
    registry: &Arc<CameraRegistry>,
    dc: &Arc<RTCDataChannel>,
    flight_id: u32,
    rate: f32,
) {
    let cam = match registry.get(flight_id).await {
        Some(c) => c,
        None => {
            send_server_message(
                dc,
                &ServerMessage::Error(ErrorPayload {
                    message: format!("no camera with flight_id={flight_id}"),
                    source: ErrorSource::Sidecar,
                }),
            )
            .await;
            return;
        }
    };
    if !cam.supports_zoom {
        send_server_message(
            dc,
            &ServerMessage::Error(ErrorPayload {
                message: format!("camera {flight_id} does not support zoom"),
                source: ErrorSource::Sidecar,
            }),
        )
        .await;
        return;
    }
    let clamped = rate.clamp(-1.0, 1.0);

    let snapshot = {
        let mut ctrl = cam.control.lock().await;
        ctrl.zoom_rate = Some(clamped);
        ctrl.clone()
    };

    if let Err(e) = registry.flush_control(flight_id, &snapshot).await {
        warn!(flight_id, error = %e, "control file flush failed");
        send_server_message(
            dc,
            &ServerMessage::Error(ErrorPayload {
                message: format!("control file flush failed: {e}"),
                source: ErrorSource::Sidecar,
            }),
        )
        .await;
        return;
    }

    info!(
        flight_id,
        rate = clamped,
        "data-channel set-zoom-rate applied"
    );
    push_camera_state(registry, dc, flight_id).await;
}

/// Viewer quality preset. Validation is structural (an unknown preset
/// string already fails the serde parse) plus the unknown-camera check
/// inside `apply_viewer_quality`; the preset can only LOWER quality below
/// the operator ceiling, so there is no upper bound to clamp here. Replies
/// with the authoritative state; the registry's dirty mark makes the
/// consume loop broadcast the same state to every other peer (last write
/// wins, all UIs converge).
async fn apply_quality_change(
    registry: &Arc<CameraRegistry>,
    dc: &Arc<RTCDataChannel>,
    flight_id: u32,
    preset: Option<QualityPreset>,
) {
    if let Err(message) = registry.apply_viewer_quality(flight_id, preset).await {
        send_server_message(
            dc,
            &ServerMessage::Error(ErrorPayload {
                message,
                source: ErrorSource::Sidecar,
            }),
        )
        .await;
        return;
    }
    info!(flight_id, ?preset, "data-channel set-quality applied");
    push_camera_state(registry, dc, flight_id).await;
}

async fn apply_degrade_change(
    registry: &Arc<CameraRegistry>,
    dc: &Arc<RTCDataChannel>,
    peer_id: u32,
    flight_id: u32,
    level: f32,
) {
    let cam = match registry.get(flight_id).await {
        Some(c) => c,
        None => {
            send_server_message(
                dc,
                &ServerMessage::Error(ErrorPayload {
                    message: format!("no camera with flight_id={flight_id}"),
                    source: ErrorSource::Sidecar,
                }),
            )
            .await;
            return;
        }
    };
    cam.set_degrade(level);
    info!(
        flight_id,
        peer_id,
        level = level.clamp(0.0, 1.0),
        effective = cam.current_degrade(),
        "set-degrade applied",
    );
    push_camera_state(registry, dc, flight_id).await;
}

async fn send_camera_snapshot(registry: &Arc<CameraRegistry>, dc: &Arc<RTCDataChannel>) {
    // Per-camera state via the registry's shared snapshot builder: the
    // last plugin-reported effective state when one exists, optimistic
    // operator-equals-effective defaults before the first status write.
    // `list()` supplies the stable flight-id ordering.
    let cams = registry.list().await;
    let mut cameras = Vec::with_capacity(cams.len());
    for c in cams {
        if let Some(state) = registry.protocol_state(c.flight_id).await {
            cameras.push(state);
        }
    }
    send_server_message(
        dc,
        &ServerMessage::CameraSnapshot(CameraSnapshotPayload { cameras }),
    )
    .await;
}

async fn push_camera_state(
    registry: &Arc<CameraRegistry>,
    dc: &Arc<RTCDataChannel>,
    flight_id: u32,
) {
    let Some(state) = registry.protocol_state(flight_id).await else {
        return;
    };
    send_server_message(
        dc,
        &ServerMessage::CameraStateChanged(CameraStateChangedPayload { state }),
    )
    .await;
}

async fn send_server_message(dc: &Arc<RTCDataChannel>, msg: &ServerMessage) {
    let body = match serde_json::to_string(msg) {
        Ok(s) => s,
        Err(e) => {
            warn!(error = %e, "control channel: serialise failed");
            return;
        }
    };
    if let Err(e) = dc.send_text(body).await {
        warn!(error = %e, "control channel: send failed");
    }
}

fn make_even(v: u32) -> u32 {
    if v.is_multiple_of(2) {
        v
    } else {
        v.saturating_sub(1)
    }
}

/// True if a batch of received RTCP contains a keyframe request — a Picture
/// Loss Indication (PLI) or Full Intra Request (FIR). The browser sends these
/// when it hits a loss it can't recover from retransmission; honoring one forces
/// an IDR so the decoder unwedges in ~1 RTT instead of waiting for the next
/// scheduled keyframe (a full GOP of static — the "feeds cut to static" bug).
fn rtcp_requests_keyframe(packets: &[Box<dyn rtcp::packet::Packet + Send + Sync>]) -> bool {
    use rtcp::payload_feedbacks::full_intra_request::FullIntraRequest;
    use rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
    packets.iter().any(|p| {
        let any = p.as_any();
        any.is::<PictureLossIndication>() || any.is::<FullIntraRequest>()
    })
}

/// Decide whether to honor a keyframe request for the camera currently bound to
/// a slot, given the `(flight_id, time)` of the last keyframe this slot forced.
/// Honor it when the bound camera has *changed* since then (a camera freshly
/// swapped into the slot must always get its first IDR — otherwise it stays
/// static for a GOP), or when the per-camera debounce gap has elapsed. The
/// debounce only suppresses repeats for the *same* camera, so it bounds IDR
/// bursts under sustained loss without ever starving a newly-bound feed.
fn should_force_keyframe(
    bound: u32,
    last: Option<(u32, std::time::Instant)>,
    now: std::time::Instant,
    min_gap: std::time::Duration,
) -> bool {
    match last {
        Some((fid, t)) if fid == bound => now.duration_since(t) >= min_gap,
        _ => true,
    }
}

/// Per-slot RTCP drain. webrtc-rs's NACK/PLI pipelines stall silently if a
/// sender's RTCP isn't read, so every slot-track's sender must be drained for
/// the connection's lifetime regardless of which camera (if any) currently
/// feeds the slot. Draining also pumps the NACK responder interceptor, which
/// does the actual retransmission. Exits when the sender closes (peer torn
/// down).
///
/// On top of draining, a PLI/FIR keyframe request is honored: the browser sends
/// one when a loss broke the reference chain and retransmission didn't recover
/// it, so we force an IDR on the camera bound to this slot. A per-slot debounce
/// caps this to one forced keyframe per `MIN_KEYFRAME_GAP`: a forced IDR is a
/// large packet burst, and without the cap a sustained loss (browser PLI every
/// few hundred ms) would become an IDR storm -> bitrate spike -> more loss. The
/// NACK responder recovers most losses with no PLI at all, so this rarely fires.
///
/// REMB is still deliberately NOT consumed. In the slot model a slot's camera
/// changes on Subscribe/Unsubscribe, so a REMB keyed by the slot's (stable)
/// SSRC can't be pinned to one camera. That's acceptable *only* because
/// REMB-driven bitrate is currently disabled (it caused a reinit death spiral
/// — see `main.rs`). The frame-skip congestion follow-up must re-introduce
/// per-slot bandwidth attribution before it can act on REMB again. A PLI is
/// instantaneous, so it pins to the slot's *current* binding cleanly (a stale
/// rebind just costs one wasted IDR), unlike REMB's running bitrate estimate.
async fn drain_rtcp_sink(
    sender: Arc<webrtc::rtp_transceiver::rtp_sender::RTCRtpSender>,
    slot_idx: usize,
    slots: Arc<Mutex<Vec<Slot>>>,
    registry: Arc<CameraRegistry>,
) {
    use std::time::Instant;
    const MIN_KEYFRAME_GAP: std::time::Duration = std::time::Duration::from_millis(1000);

    // (flight_id, when) of the last keyframe this slot forced. Tracking the
    // flight_id (not just the time) means a camera freshly swapped into the slot
    // always gets its first PLI honored instead of being suppressed by the
    // previous camera's debounce.
    let mut last_forced: Option<(u32, Instant)> = None;
    while let Ok((packets, _)) = sender.read_rtcp().await {
        // REMB and other RTCP intentionally discarded — see fn doc. Only a
        // keyframe request is acted on.
        if !rtcp_requests_keyframe(&packets) {
            continue;
        }
        let bound = {
            let guard = slots.lock().await;
            guard.get(slot_idx).and_then(|s| s.bound)
        };
        let Some(flight_id) = bound else { continue };
        let now = Instant::now();
        if !should_force_keyframe(flight_id, last_forced, now, MIN_KEYFRAME_GAP) {
            continue;
        }
        if let Some(cam) = registry.get(flight_id).await {
            request_keyframe_for(&cam).await;
            last_forced = Some((flight_id, now));
            info!(flight_id, "keyframe forced by browser PLI/FIR");
        }
    }
    // read_rtcp errors when the sender closes (peer torn down) — the normal
    // exit. If it ever happens mid-connection this slot loses its NACK pump and
    // PLI handling for the rest of the session, so leave a breadcrumb.
    info!(slot_idx, "RTCP drain exited (sender closed)");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Weak;
    use std::time::Duration;

    // Build a minimal RTCPeerConnection the same way KerbcastPeer::new does, so
    // the sender/track lifecycle matches production.
    async fn build_pc() -> Arc<RTCPeerConnection> {
        let mut media_engine = MediaEngine::default();
        media_engine
            .register_default_codecs()
            .expect("register default codecs");
        let api = APIBuilder::new().with_media_engine(media_engine).build();
        Arc::new(
            api.new_peer_connection(RTCConfiguration::default())
                .await
                .expect("create peer connection"),
        )
    }

    // F4 premise (deterministic, no real connection needed): `pc.close()` must
    // release the RTCRtpSender's strong ref to the track, so the camera's Weak
    // goes dead and the consume loop prunes it — dropping the subscriber count
    // to zero, which flushes `set_subscribed(false)` and lets the plugin stop
    // rendering. WITHOUT close() the sender holds the track Arc for the life of
    // the (already-dropped) peer, so the Weak never dies: that is the leak that
    // left cameras rendering after a clean disconnect (the reaper dropped the
    // Arc<KerbcastPeer> but never called close()).
    #[tokio::test]
    async fn close_releases_track_arc() {
        let pc = build_pc().await;
        let track = Arc::new(TrackLocalStaticSample::new(
            RTCRtpCodecCapability {
                mime_type: MIME_TYPE_H264.to_owned(),
                ..Default::default()
            },
            "video".to_owned(),
            "stream".to_owned(),
        ));
        pc.add_track(track.clone() as Arc<dyn TrackLocal + Send + Sync>)
            .await
            .expect("add_track");

        let weak: Weak<TrackLocalStaticSample> = Arc::downgrade(&track);
        drop(track); // release our ref; the sender inside pc still holds one

        assert!(
            weak.upgrade().is_some(),
            "while the peer is open the sender keeps the track alive — this is \
             exactly the leak when close() is never called on disconnect"
        );

        pc.close().await.expect("close");

        // close() winds sender tasks down asynchronously; poll briefly.
        let mut freed = false;
        for _ in 0..40 {
            if weak.upgrade().is_none() {
                freed = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(
            freed,
            "pc.close() must release the sender's track Arc within ~2s — \
             this is the mechanism F4 relies on to free camera subscriptions"
        );
    }

    // The persistent-sidecar scene-change contract: a peer that stays
    // connected while every ring is deleted (flight exit) and recreated
    // (flight re-entry, same flight id) must get its subscription rebound
    // onto the brand-new CameraState by resync_after_camera_churn, so the
    // stream resumes without the browser doing anything.
    #[tokio::test]
    async fn reattached_ring_rebinds_surviving_subscription() {
        use crate::shared_mem::{MmapFrameRing, MmapRingConfig};
        use std::sync::atomic::Ordering;

        let dir = tempfile::tempdir().expect("tempdir");
        let cfg = MmapRingConfig {
            slot_count: 4,
            max_width: 64,
            max_height: 64,
        };
        let ring_path = dir.path().join("1.ring");
        MmapFrameRing::create(&ring_path, cfg).expect("create ring");
        let registry = Arc::new(CameraRegistry::new(dir.path().to_path_buf()));
        registry.rescan().await;

        let peer = Arc::new(
            KerbcastPeer::new(registry.clone(), &[1], 2)
                .await
                .expect("peer"),
        );
        let cam = registry.get(1).await.expect("camera attached");
        assert_eq!(
            cam.subscribers.load(Ordering::Acquire),
            1,
            "initial subscription bound"
        );

        // Scene exit: the plugin deletes the ring; rescan drops the camera.
        std::fs::remove_file(&ring_path).expect("delete ring");
        let outcome = registry.rescan().await;
        assert_eq!(outcome.removed, vec![1], "normal teardown reported");
        assert!(registry.get(1).await.is_none(), "camera gone from registry");

        // Scene re-entry: the same flight id reappears as a NEW CameraState
        // that knows nothing about the still-bound peer slot.
        MmapFrameRing::create(&ring_path, cfg).expect("recreate ring");
        let outcome = registry.rescan().await;
        assert_eq!(outcome.attached, vec![1], "re-attach reported");
        let cam2 = registry.get(1).await.expect("camera re-attached");
        assert_eq!(
            cam2.subscribers.load(Ordering::Acquire),
            0,
            "fresh CameraState starts unsubscribed"
        );

        resync_after_camera_churn(&registry, std::slice::from_ref(&peer), &outcome.attached).await;

        assert_eq!(
            cam2.subscribers.load(Ordering::Acquire),
            1,
            "subscription survives the scene change"
        );
        assert!(
            cam2.control.lock().await.subscribed,
            "plugin is told to resume rendering"
        );
    }

    /// A browser PLI is the signal that a feed is wedged on a broken reference
    /// and needs an IDR. It must be recognised as a keyframe request so the
    /// drain loop can force one (otherwise the feed stays static for a GOP).
    #[test]
    fn pli_is_recognised_as_a_keyframe_request() {
        use rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
        let pkts: Vec<Box<dyn rtcp::packet::Packet + Send + Sync>> =
            vec![Box::new(PictureLossIndication::default())];
        assert!(rtcp_requests_keyframe(&pkts));
    }

    /// A Full Intra Request is the other keyframe-request RTCP feedback; some
    /// stacks send FIR instead of PLI, so both must force an IDR.
    #[test]
    fn fir_is_recognised_as_a_keyframe_request() {
        use rtcp::payload_feedbacks::full_intra_request::FullIntraRequest;
        let pkts: Vec<Box<dyn rtcp::packet::Packet + Send + Sync>> =
            vec![Box::new(FullIntraRequest::default())];
        assert!(rtcp_requests_keyframe(&pkts));
    }

    /// Routine RTCP (receiver reports, NACKs) must NOT be mistaken for a
    /// keyframe request — those are handled by the NACK responder / reports and
    /// forcing an IDR on every one of them would be a keyframe storm.
    #[test]
    fn routine_rtcp_is_not_a_keyframe_request() {
        use rtcp::receiver_report::ReceiverReport;
        let pkts: Vec<Box<dyn rtcp::packet::Packet + Send + Sync>> =
            vec![Box::new(ReceiverReport::default())];
        assert!(!rtcp_requests_keyframe(&pkts));
    }

    const GAP: Duration = Duration::from_millis(1000);

    #[test]
    fn first_keyframe_request_for_a_slot_is_honored() {
        let now = std::time::Instant::now();
        assert!(should_force_keyframe(7, None, now, GAP));
    }

    #[test]
    fn repeat_request_for_same_camera_within_gap_is_debounced() {
        let t0 = std::time::Instant::now();
        let now = t0 + Duration::from_millis(400);
        assert!(!should_force_keyframe(7, Some((7, t0)), now, GAP));
    }

    #[test]
    fn repeat_request_for_same_camera_after_gap_is_honored() {
        let t0 = std::time::Instant::now();
        let now = t0 + Duration::from_millis(1200);
        assert!(should_force_keyframe(7, Some((7, t0)), now, GAP));
    }

    /// The slot-rebind case: camera 9 was just subscribed into the slot camera 7
    /// held. Its first PLI must be honored even though camera 7 forced a
    /// keyframe under the debounce gap ago — otherwise the freshly-bound feed
    /// stays static for a full GOP (a narrower recurrence of the very bug).
    #[test]
    fn request_for_newly_bound_camera_bypasses_the_previous_cameras_debounce() {
        let t0 = std::time::Instant::now();
        let now = t0 + Duration::from_millis(200);
        assert!(should_force_keyframe(9, Some((7, t0)), now, GAP));
    }
}
