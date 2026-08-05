//! kerbcast sidecar binary. Reads RGBA frames from the KSP plugin's
//! shared-memory ring, encodes them via the selected EncoderBackend,
//! fans the resulting NAL units out to every connected WebRTC peer.
//! Browsers connect via the HTTP signalling endpoint at `--http-bind`.
//!
//! Subscription-driven: when no peer is connected, the encoder idles and
//! we don't poll the ring beyond the heartbeat interval. The plugin keeps
//! writing frames into the ring; the sidecar just doesn't consume them.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use anyhow::Result;
use clap::Parser;
use tokio::net::TcpListener;
use tokio::signal;
use tokio::sync::RwLock;
use tokio::time::sleep;
use tracing::{debug, info, warn};
use webrtc::media::Sample;

use kerbcast_sidecar::cameras::{CameraRegistry, CameraState};
use kerbcast_sidecar::encoder::{
    record_init_failure, resolve_bitrate_bps, select_backend, EncodeConfig, EncoderBackend,
    EncoderChoice, RawFrame, SessionVerdict, Software, SILENT_SESSION_FRAME_LIMIT,
};
use kerbcast_sidecar::heartbeat::{HeartbeatWatch, HEARTBEAT_FILE};
use kerbcast_sidecar::protocol::{
    AdaptiveShedPayload, CameraLifecycle, CameraState as ProtocolCameraState,
    CameraStateChangedPayload, CaptureState, SceneStateChangedPayload, ServerMessage,
};
use kerbcast_sidecar::shared_mem::MmapRingConfig;
use kerbcast_sidecar::signalling::{router, AppState};
use kerbcast_sidecar::webrtc::{resync_after_camera_churn, KerbcastPeer};
use kerbcast_sidecar::VERSION;

/// Consecutive encode() failures before the consume loop drops a
/// camera's encoder to force re-initialisation. ~1s of frames at 30fps:
/// transient hiccups don't churn the session, a wedged one recovers
/// quickly.
const ENCODE_FAILURE_REINIT_THRESHOLD: u32 = 30;

#[derive(Parser, Debug)]
#[command(name = "kerbcast-sidecar", version = VERSION, about)]
struct Cli {
    #[arg(long, value_enum, default_value_t = EncoderChoice::Auto)]
    encoder: EncoderChoice,

    /// Directory the KSP plugin drops per-camera ring files into.
    /// Matches the plugin's `KerbcastCore.ResolveRingDir` default —
    /// `$XDG_RUNTIME_DIR/kerbcast/` if that dir exists, else
    /// `/tmp/kerbcast/`. Override with `--shm-dir` when running
    /// against a relocated install or a recorded fixture. Each file
    /// inside is named `<flight_id>.ring`.
    #[arg(long, default_value_os_t = default_shm_dir())]
    shm_dir: PathBuf,

    #[arg(long, default_value_t = 1024)]
    max_width: u32,

    #[arg(long, default_value_t = 576)]
    max_height: u32,

    #[arg(long, default_value_t = 4)]
    slot_count: u32,

    #[arg(long, default_value_t = 30)]
    fps: u32,

    /// Target encode bitrate in bits per second. When omitted, the default
    /// derives from the selected encoder backend: hardware backends
    /// (libva/videotoolbox/nvenc) get 4 Mbps, the software fallback stays
    /// at 1.5 Mbps.
    #[arg(long)]
    bitrate_bps: Option<u32>,

    /// Polling interval (ms) for the consumer loop while at least one
    /// peer is subscribed. When no peer is subscribed the loop sleeps for
    /// `idle_interval_ms` instead.
    #[arg(long, default_value_t = 16)]
    poll_interval_ms: u64,

    /// Sleep interval (ms) when no peer is subscribed. Keeps CPU near
    /// zero while still checking the subscriber set often enough to wake
    /// up promptly when a browser connects.
    #[arg(long, default_value_t = 250)]
    idle_interval_ms: u64,

    /// HTTP bind address for the signalling endpoint. The bundled browser
    /// test page is served at `GET /`; POST `/offer` accepts SDP.
    #[arg(long, default_value = "127.0.0.1:8088")]
    http_bind: SocketAddr,

    /// Orphan protection: the KSP plugin touches `global.heartbeat` in the
    /// shm dir ~1Hz for the whole game session. Once that file has been
    /// seen at least once, the sidecar exits after its mtime stays stale
    /// for longer than this many seconds on two consecutive checks
    /// (covering a Deck suspend/resume race). Dev workflows without the
    /// plugin never write the file, so the watch never arms. 0 disables.
    /// Generous default: a long scene load blocks Unity's Update (and so
    /// the heartbeat) for its whole duration.
    #[arg(long, default_value_t = 90)]
    heartbeat_timeout_secs: u64,
}

fn default_shm_dir() -> PathBuf {
    // Mirror the C# plugin's path-picking so a vanilla `cargo run` lines
    // up with a vanilla KSP launch on the same machine.
    if let Some(xdg) = std::env::var_os("XDG_RUNTIME_DIR") {
        let p = PathBuf::from(xdg);
        if p.is_dir() {
            return p.join("kerbcast");
        }
    }
    PathBuf::from("/tmp/kerbcast")
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_target(false)
        .init();

    let cli = Cli::parse();
    info!(
        version = VERSION,
        shm_dir = %cli.shm_dir.display(),
        encoder = ?cli.encoder,
        http_bind = %cli.http_bind,
        "kerbcast sidecar starting",
    );

    // Resolve the effective bitrate once, here: AppState and the consume
    // loop both take the resolved value, so nothing downstream needs to
    // know whether the operator passed --bitrate-bps or not.
    let backend_for_default = select_backend(cli.encoder);
    let bitrate_bps = resolve_bitrate_bps(cli.bitrate_bps, backend_for_default.as_ref());
    if cli.bitrate_bps.is_some() {
        info!(bitrate_bps, "bitrate set explicitly via --bitrate-bps");
    } else {
        info!(
            bitrate_bps,
            backend = backend_for_default.name(),
            hardware = backend_for_default.is_hardware(),
            "no --bitrate-bps flag; default chosen from the encoder backend",
        );
    }
    drop(backend_for_default);

    let ring_cfg = MmapRingConfig {
        slot_count: cli.slot_count,
        max_width: cli.max_width,
        max_height: cli.max_height,
    };

    let registry = Arc::new(CameraRegistry::new(cli.shm_dir.clone()));
    info!(
        dir = %cli.shm_dir.display(),
        slot_count = ring_cfg.slot_count,
        max_dims = format!("{}x{}", ring_cfg.max_width, ring_cfg.max_height),
        "camera registry initialised — scanning for rings (per-ring geometry)",
    );

    let peers: Arc<RwLock<Vec<Arc<KerbcastPeer>>>> = Arc::new(RwLock::new(Vec::new()));
    let state = AppState {
        registry: registry.clone(),
        peers: peers.clone(),
        encoder_choice: cli.encoder,
        fps: cli.fps,
        bitrate_bps,
    };

    let http_listener = TcpListener::bind(cli.http_bind).await.map_err(|e| {
        anyhow::anyhow!("binding HTTP signalling endpoint at {}: {e}", cli.http_bind)
    })?;
    let http_addr = http_listener.local_addr().unwrap_or(cli.http_bind);
    info!(addr = %http_addr, "HTTP signalling endpoint listening");
    let http_app = router(state);
    let http_server = tokio::spawn(async move {
        if let Err(e) = axum::serve(http_listener, http_app).await {
            warn!(error = %e, "HTTP server exited with error");
        }
    });

    let ping_peers = peers.clone();
    let ping_task = tokio::spawn(async move {
        let interval = Duration::from_secs(5);
        loop {
            sleep(interval).await;
            let snapshot: Vec<Arc<KerbcastPeer>> = ping_peers.read().await.clone();
            for peer in &snapshot {
                if peer.is_alive() {
                    peer.push_message(&ServerMessage::Ping).await;
                }
            }
        }
    });

    let consume = consume_loop(
        registry,
        peers,
        cli.encoder,
        Duration::from_millis(cli.poll_interval_ms),
        Duration::from_millis(cli.idle_interval_ms),
        Duration::from_secs(1), // rescan cadence
        cli.fps,
        bitrate_bps,
    );

    // Orphan watch: the plugin owns this process for the KSP session and
    // kills it on a clean game exit; if KSP dies hard nothing does, so we
    // self-exit once the plugin's heartbeat file goes stale. Pure decision
    // logic (and the arming/streak rules) live in heartbeat::HeartbeatWatch.
    let heartbeat_path = cli.shm_dir.join(HEARTBEAT_FILE);
    let heartbeat_timeout = cli.heartbeat_timeout_secs;
    let orphan_watch = async move {
        if heartbeat_timeout == 0 {
            std::future::pending::<()>().await;
        }
        let mut watch = HeartbeatWatch::new(Duration::from_secs(heartbeat_timeout));
        loop {
            sleep(Duration::from_secs(5)).await;
            let mtime = tokio::fs::metadata(&heartbeat_path)
                .await
                .ok()
                .and_then(|m| m.modified().ok());
            if watch.observe(mtime, SystemTime::now()) {
                info!(
                    timeout_secs = heartbeat_timeout,
                    path = %heartbeat_path.display(),
                    "plugin heartbeat stale; assuming KSP exited without stopping us, shutting down",
                );
                break;
            }
        }
    };

    // SIGTERM is what the plugin's process kill, systemd and container
    // runtimes send first — without a handler the runtime never unwinds
    // and the supervisor escalates to SIGKILL after its timeout. No-op
    // pending future on non-unix (Windows gets ctrl_c only).
    #[cfg(unix)]
    let terminate = async {
        match signal::unix::signal(signal::unix::SignalKind::terminate()) {
            Ok(mut sig) => {
                sig.recv().await;
            }
            Err(e) => {
                warn!(error = %e, "SIGTERM handler unavailable");
                std::future::pending::<()>().await;
            }
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    let result = tokio::select! {
        result = consume => result,
        _ = signal::ctrl_c() => {
            info!("ctrl-c received, shutting down");
            Ok(())
        }
        _ = terminate => {
            info!("SIGTERM received, shutting down");
            Ok(())
        }
        _ = orphan_watch => {
            Ok(())
        }
    };
    // Detached loops would otherwise keep the runtime alive past the
    // shutdown signal.
    http_server.abort();
    ping_task.abort();
    result
}

/// Per-tick: rescan the rings dir periodically; for every camera with
/// at least one subscribed track, read its latest frame, lazy-init its
/// own encoder, and fan the encoded sample out to its alive tracks.
/// Idle-sleeps when no camera has subscribers.
#[allow(clippy::too_many_arguments)]
async fn consume_loop(
    registry: Arc<CameraRegistry>,
    peers: Arc<RwLock<Vec<Arc<KerbcastPeer>>>>,
    encoder_choice: EncoderChoice,
    poll_interval: Duration,
    idle_interval: Duration,
    rescan_interval: Duration,
    fps: u32,
    bitrate_bps: u32,
) -> Result<()> {
    let mut last_rescan = Instant::now() - rescan_interval; // rescan immediately
    let frame_duration = Duration::from_secs(1) / fps;

    loop {
        if last_rescan.elapsed() >= rescan_interval {
            let churn = registry.rescan().await;
            // The sidecar persists across KSP scene changes, so ring churn
            // (every camera removed on flight exit, re-attached on the next
            // flight) happens under live peers: rebind surviving slot
            // subscriptions to the re-attached cameras and push a fresh
            // camera snapshot so browser lists drain and repopulate.
            if !churn.attached.is_empty() || !churn.removed.is_empty() {
                let snapshot: Vec<Arc<KerbcastPeer>> = peers.read().await.clone();
                resync_after_camera_churn(&registry, &snapshot, &churn.attached).await;
            }
            let newly_destroyed = churn.newly_destroyed;
            // Status poll piggybacks on the rescan cadence — both are
            // ~1Hz and the plugin's status writer matches that rate.
            let delta = registry.poll_status().await;
            /* Background capture ceiling moved (operator change, or the plugin shedding /
            restoring the background rung), so every camera's requested
            capture rate has to be recomputed and pushed back down. Done
            before the broadcast so a peer's next state read is consistent
            with what the plugin was just told. */
            if delta.background_ceiling_changed {
                registry.reflush_all_capture_rates().await;
            }
            if delta.adaptive_shed.is_some()
                || !delta.changed_cameras.is_empty()
                || delta.settings.is_some()
            {
                broadcast_status_delta(&peers, delta).await;
            }
            // Scene state lives in a separate host-written file (outlives the
            // flight-only status writer). Broadcast only when the flag flips.
            if let Some(in_flight) = registry.poll_in_flight().await {
                let snapshot: Vec<Arc<KerbcastPeer>> = peers.read().await.clone();
                let msg = ServerMessage::SceneStateChanged(SceneStateChangedPayload { in_flight });
                broadcast(&snapshot, &msg).await;
            }
            // Broadcast camera-state-changed for newly-destroyed cameras and
            // acknowledge (delete tombstone). "Clean close" is via the
            // data-channel notification rather than RTCP/track removal because
            // KerbcastPeer doesn't store per-camera RTCRtpSender refs; the
            // published client renders SIGNAL LOST on receipt and keeps the
            // last decoded frame visible through the HTML video element.
            if !newly_destroyed.is_empty() {
                broadcast_destroyed_cameras(&registry, &peers, &newly_destroyed).await;
                for flight_id in newly_destroyed {
                    registry.acknowledge_destruction(flight_id).await;
                }
            }
            last_rescan = Instant::now();
        }

        // Sidecar-side state changes (viewer quality requests) marked dirty
        // by the data-channel handlers. Broadcast the authoritative state to
        // EVERY peer each tick so all UIs converge on the last write;
        // unlike the 1Hz status diff above, this also fires when the
        // effective render dims didn't move (e.g. a preset set while the
        // adaptive controller already holds the camera lower).
        let dirty = registry.take_dirty_cameras().await;
        if !dirty.is_empty() {
            let snapshot: Vec<Arc<KerbcastPeer>> = peers.read().await.clone();
            for flight_id in dirty {
                let Some(state) = registry.protocol_state(flight_id).await else {
                    continue;
                };
                let msg = ServerMessage::CameraStateChanged(CameraStateChangedPayload { state });
                broadcast(&snapshot, &msg).await;
            }
        }

        // Prune dead peers — dropped Arcs propagate to the Weak refs
        // in each CameraState.tracks list, which we GC inline below.
        // Each dropped peer also gets its per-consumer state cleared so no
        // stale entry pins a camera high (pan/zoom rates zeroed; reported
        // display size forgotten peer-wide).
        let dropped_peers: Vec<Arc<KerbcastPeer>> = {
            let mut guard = peers.write().await;
            let mut dropped = Vec::new();
            guard.retain(|p| {
                if p.is_alive() {
                    true
                } else {
                    dropped.push(p.clone());
                    false
                }
            });
            dropped
        };
        for peer in dropped_peers {
            // Close the RTCPeerConnection so its senders release the slot
            // tracks. Dropping the Arc<KerbcastPeer> alone is NOT enough —
            // webrtc-rs keeps the sender tasks (and their track Arcs) alive
            // until close(), so without this the camera's Weak refs never die,
            // the subscriber count stays > 0, and the plugin keeps rendering
            // for a viewer that has already disconnected. (See
            // peer::tests::close_releases_track_arc.)
            if let Err(e) = peer.close().await {
                warn!(peer_id = peer.peer_id, error = %e, "peer close on reap failed");
            }
            // Release this peer's cameras IMMEDIATELY (decrement subscribers +
            // flush set_subscribed(false) at zero), the same way the graceful
            // Disconnect message does. Don't wait for the consume loop's lazy
            // dead-Weak prune — that only runs on a tick where the camera has a
            // NEW frame to encode, which capture staggering can starve, leaving
            // a disconnected viewer's cameras rendering indefinitely (fps never
            // recovers until a KSP restart).
            // Snapshot what this peer was driving BEFORE release_all: it
            // take()s every slot.bound, so reading bound_flight_ids() after
            // it would see nothing and the deadman below would silently no-op.
            let driven_flight_ids = peer.bound_flight_ids().await;
            peer.release_all(&registry).await;
            // Deadman: a browser that dropped mid-hold must not leave a
            // camera drifting to its travel limit. Zero the persistent
            // pan/zoom rates on every camera this peer was driving.
            for flight_id in driven_flight_ids {
                registry.zero_rates(flight_id).await;
            }
            // Peer-scoped display-size clear: forget this peer's reported size
            // across EVERY camera, not just the ones it bound — a report can
            // exist for a camera it never bound (report + slot-exhausted
            // Subscribe), which a binding-scoped clear would leak forever
            // (the v1.6.3 pin-high class).
            registry.forget_display_size_all(peer.peer_id).await;
            // Same peer-scoped sweep for any force this peer held, so a feed
            // never stays pinned at the ceiling after a dead-peer reap.
            registry.forget_forced_all(peer.peer_id).await;
            // Same for background capture request: a dead peer must not leave background
            // capture pinned on (the v1.6.3 pin-high class).
            if registry.forget_background_request(peer.peer_id).await {
                registry.reflush_all_capture_rates().await;
            }
        }

        let cameras = registry.snapshot().await;
        let mut any_active = false;

        for cam in &cameras {
            // Destroyed cameras never encode — the part is gone.
            if cam.destroyed.load(Ordering::Acquire) {
                continue;
            }
            if cam.subscribers.load(Ordering::Acquire) == 0 {
                debug!(flight_id = cam.flight_id, "skipped: no subscribers");
                continue;
            }
            any_active = true;
            encode_and_fan_out(cam, encoder_choice, fps, bitrate_bps, frame_duration).await;
        }

        // After encode + GC of dead weak refs, any cam that just lost its
        // last subscriber needs `subscribed=false` flushed so the plugin sleeps
        // it — unless the force-render profiling override is on, in which case
        // every live camera is kept subscribed so it renders without a peer.
        registry.refresh_idle_subscriptions(&cameras).await;

        if any_active {
            sleep(poll_interval).await;
        } else {
            sleep(idle_interval).await;
        }
    }
}

/// Fan one message out to an already-snapshotted set of peers. Best-effort:
/// peers whose data channels aren't open silently drop it. Empty set is a
/// no-op. Callers snapshot `peers` once and may call this several times.
async fn broadcast(peers: &[Arc<KerbcastPeer>], msg: &ServerMessage) {
    if peers.is_empty() {
        return;
    }
    for peer in peers {
        peer.push_message(msg).await;
    }
}

/// Push a status delta (adaptive-shed level changes + per-camera state
/// changes) to every connected peer's data channel. Best-effort: peers
/// whose data channels haven't opened yet (or have closed) silently
/// drop the message — there's always another snapshot a tick later.
async fn broadcast_status_delta(
    peers: &Arc<RwLock<Vec<Arc<KerbcastPeer>>>>,
    delta: kerbcast_sidecar::cameras::StatusDelta,
) {
    let snapshot: Vec<Arc<KerbcastPeer>> = peers.read().await.clone();
    if snapshot.is_empty() {
        return;
    }

    if let Some((level, ksp_fps)) = delta.adaptive_shed {
        let reason = if level == 0 {
            "ksp-fps-recovered".to_string()
        } else {
            "ksp-fps-low".to_string()
        };
        let msg = ServerMessage::AdaptiveShed(AdaptiveShedPayload {
            level,
            ksp_fps,
            reason,
        });
        broadcast(&snapshot, &msg).await;
    }

    for state in delta.changed_cameras {
        let msg = ServerMessage::CameraStateChanged(CameraStateChangedPayload { state });
        broadcast(&snapshot, &msg).await;
    }

    if let Some(settings) = delta.settings {
        let msg = ServerMessage::SettingsState(settings);
        broadcast(&snapshot, &msg).await;
    }
}

/// Broadcast `camera-state-changed` with `lifecycle: "destroyed"` for
/// each camera whose part was destroyed this tick. Sends to every
/// connected peer so their UI can render a "SIGNAL LOST" overlay.
async fn broadcast_destroyed_cameras(
    registry: &Arc<CameraRegistry>,
    peers: &Arc<RwLock<Vec<Arc<KerbcastPeer>>>>,
    flight_ids: &[u32],
) {
    let snapshot: Vec<Arc<KerbcastPeer>> = peers.read().await.clone();
    if snapshot.is_empty() {
        return;
    }
    for &flight_id in flight_ids {
        let Some(cam) = registry.get(flight_id).await else {
            continue;
        };
        let state = ProtocolCameraState {
            flight_id,
            lifecycle: CameraLifecycle::Destroyed,
            // Destroyed: nothing is being captured, whatever subscribers linger.
            capture_state: CaptureState::Off,
            kind: cam.kind,
            kerbal_persistent_id: cam.kerbal_persistent_id,
            crew_location: cam.crew_location(),
            track_mode: cam.track_mode(),
            part_name: cam.part_name.clone(),
            part_title: cam.part_title.clone(),
            camera_name: cam.camera_name.clone(),
            vessel_name: cam.vessel_name.clone(),
            layers: Vec::new(),
            operator_layers: Vec::new(),
            render_width: 0,
            render_height: 0,
            operator_width: 0,
            operator_height: 0,
            supports_zoom: cam.supports_zoom,
            fov: 0.0,
            fov_min: cam.fov_min,
            fov_max: cam.fov_max,
            supports_pan: cam.supports_pan,
            pan_yaw: 0.0,
            pan_pitch: 0.0,
            pan_yaw_min: cam.pan_yaw_min,
            pan_yaw_max: cam.pan_yaw_max,
            pan_pitch_min: cam.pan_pitch_min,
            pan_pitch_max: cam.pan_pitch_max,
            encoder_bitrate_bps: 0,
            target_bitrate_bps: 0,
            degrade_level: 0.0,
            viewer_quality: None,
            quality_limited_by: None,
        };
        let msg = ServerMessage::CameraStateChanged(CameraStateChangedPayload { state });
        broadcast(&snapshot, &msg).await;
    }
}

/// Close and forget a camera's encoder session so the next frame
/// re-runs init, and reset the per-session counters that describe it.
fn drop_encoder_session(
    cam: &Arc<CameraState>,
    encoder_guard: &mut tokio::sync::MutexGuard<'_, Option<Box<dyn EncoderBackend>>>,
) {
    if let Some(mut backend) = encoder_guard.take() {
        backend.close();
    }
    cam.encoder_width.store(0, Ordering::Release);
    cam.encoder_height.store(0, Ordering::Release);
    cam.encoder_bitrate.store(0, Ordering::Release);
    cam.encode_failure_streak.store(0, Ordering::Release);
}

/// The one operator-facing line when a camera gives up on hardware
/// encode. Fired exactly once per camera, gated by the
/// EscalateToSoftware verdict.
fn warn_escalated(cam: &Arc<CameraState>, backend_name: &str, what_happened: &str) {
    warn!(
        flight_id = cam.flight_id,
        camera = %cam.camera_name,
        part = %cam.part_title,
        backend = backend_name,
        "{what_happened}; this camera now encodes in software \
         (likely concurrent hardware encode session limit). Other cameras keep hardware."
    );
}

async fn encode_and_fan_out(
    cam: &Arc<CameraState>,
    encoder_choice: EncoderChoice,
    fps: u32,
    bitrate_bps: u32,
    frame_duration: Duration,
) {
    // Throttle against configured fps. The plugin writes into the ring at
    // LateUpdate's cadence (40–60 Hz on the Deck), but the encoder is
    // configured for `fps` and each emitted sample carries duration=1/fps —
    // tagging samples wall-clock-too-fast makes the receiver drop about
    // half of them (`framesReceived` ≫ `framesDecoded`). Skipping encodes
    // until enough wall time has elapsed since the last one keeps the
    // encoder running at its configured rate and the receiver's playback
    // clock honest.
    // Wall-clock interval since the previous encode for this camera.
    // Drives both (a) the throttle (skip if it's too soon) and (b) the
    // sample duration we tag on the wire. The browser playback clock
    // advances by `sample.duration` per frame; if we always tag the
    // configured 1/fps but real encodes arrive every ~140ms (CPU-bound
    // openh264 across 6 cams), playback time falls behind arrival
    // monotonically — jitterBufferDelay grows from 0 to hundreds of
    // ms over a session, which presents visually as "framerate slowly
    // drops as time goes by". Tagging with the actual interval keeps
    // playback honest.
    let actual_duration: Duration;
    {
        let mut last_at = cam.last_encoded_at.lock().await;
        let now = Instant::now();
        actual_duration = match *last_at {
            Some(prev) => {
                let elapsed = now.duration_since(prev);
                if elapsed < frame_duration {
                    return;
                }
                elapsed
            }
            None => frame_duration, // first encode — no prior reference
        };
        *last_at = Some(now);
    }

    let frame = match cam.ring.latest() {
        Ok(Some(f)) => f,
        Ok(None) => {
            debug!(flight_id = cam.flight_id, "ring had no frame this tick");
            return;
        }
        Err(e) => {
            warn!(flight_id = cam.flight_id, error = %e, "ring read failed");
            return;
        }
    };

    let last = cam.last_sequence.load(Ordering::Acquire);
    if frame.sequence <= last {
        /* Stale-or-equal frame. Equal is the normal idle case (we already
        sent it). BEHIND is not normal and is unrecoverable on its own: a
        recreated ring restarts its sequence low while last_sequence keeps
        the old high value, so every future frame fails this check and the
        camera goes permanently silent with no error anywhere. Warn (not
        debug) on that case so it is visible without raising the log level. */
        if frame.sequence < last {
            warn!(
                flight_id = cam.flight_id,
                ring_sequence = frame.sequence,
                last_sequence = last,
                "ring sequence went BACKWARDS — camera will stay silent until this resets"
            );
        } else {
            debug!(
                flight_id = cam.flight_id,
                sequence = frame.sequence,
                "no new frame this tick (sequence unchanged)"
            );
        }
        return;
    }
    debug!(
        flight_id = cam.flight_id,
        sequence = frame.sequence,
        advanced_by = frame.sequence - last,
        "new frame accepted for encode"
    );
    cam.last_sequence.store(frame.sequence, Ordering::Release);

    // Apply SetDegrade. Two cheap levers:
    //
    //   * Frame skipping — at level>0 we deterministically drop a
    //     fraction of frames. Receiver sees timestamp gaps → P-frame
    //     recovery → stuttering. Saves encoder CPU on every skipped
    //     frame (the whole encode/packetise path is bypassed).
    //
    //   * Bitrate floor — feeds into the encoder reinit threshold
    //     below. The encoder runs at `(1 - 0.7*level) * effective`
    //     so level=1.0 lands ≈ 30% of the operator target. Heavy
    //     bitrate squeeze creates the blocky/macro look real
    //     signal loss has.
    let degrade = cam.current_degrade();
    if degrade > 0.001 {
        let skip_every = 1u64 + (degrade * 3.0).round() as u64; // 1..=4
        if !frame.sequence.is_multiple_of(skip_every) {
            return;
        }
    }

    // Lazy encoder init — first encoded frame per camera. Done under
    // the camera's encoder lock so concurrent ticks can't double-init.
    //
    // Close + reinit ONLY on frame dimension changes (plugin's adaptive
    // downscale path) — that genuinely requires a new encoder session
    // because openh264 picks up dims from the first YUV buffer it sees.
    //
    // We used to also reinit when REMB-driven target bitrate diverged
    // >30% from the encoder's current bitrate. That turned out to be a
    // catastrophic death spiral: every reinit emits a fresh IDR + new
    // SPS/PPS, decoder loses its reference chain, fires PLI, encoder
    // produces another IDR, REMB sees bursts and drops bitrate further,
    // which trips another reinit. Receivers ended up at ~0.2 fps
    // visible with `pliCount > 1000` and `bytesReceived` collapsed to
    // a few kbps out of a 1.5Mbps budget.
    //
    // Until we plumb a live-update path through the EncoderBackend
    // trait (openh264 0.9 exposes SBitrateInfo via raw_api.set_option
    // but no safe wrapper; libva supports live bitrate natively), we
    // simply ignore REMB feedback on the encode side and let the
    // initial bitrate stand. The wire bitrate stays predictable, the
    // decoder stays in sync, and the LAN can comfortably carry
    // 6 × 1.5Mbps anyway.
    let mut encoder_guard = cam.encoder.lock().await;
    let cur_w = cam.encoder_width.load(Ordering::Acquire);
    let cur_h = cam.encoder_height.load(Ordering::Acquire);
    // Always init at the CLI bitrate default — DO NOT consult REMB's
    // target_bitrate_bps here. REMB starts with a very low probe
    // estimate (often <100kbps) and ramps up, so consulting it at
    // cold start means the encoder boots at probe-speed and stays
    // there forever (we don't re-init on bitrate change any more).
    // REMB feedback is still recorded for diagnostics but ignored
    // by the encode path until a real live-update lands.
    let effective_bps_pre_degrade = bitrate_bps;
    // Apply degrade as a multiplicative bitrate squeeze. degrade=1.0
    // lands the encoder around 30% of the otherwise-target — enough
    // to produce visible macroblocking. Floor at 64kbps so we never
    // try to init the encoder at an absurdly low rate. Only takes
    // effect at first init (no live-update yet).
    let effective_bps = if degrade > 0.001 {
        let factor = 1.0 - 0.7 * degrade.clamp(0.0, 1.0);
        ((effective_bps_pre_degrade as f32) * factor).max(64_000.0) as u32
    } else {
        effective_bps_pre_degrade
    };
    let dims_changed = encoder_guard.is_some() && (cur_w != frame.width || cur_h != frame.height);
    if dims_changed {
        if let Some(mut backend) = encoder_guard.take() {
            backend.close();
        }
        info!(
            flight_id = cam.flight_id,
            from = format!("{cur_w}x{cur_h}"),
            to = format!("{}x{}", frame.width, frame.height),
            "resolution change, encoder reinit",
        );
    }
    if encoder_guard.is_none() {
        let cfg = EncodeConfig {
            width: frame.width,
            height: frame.height,
            fps,
            bitrate_bps: effective_bps,
        };
        // The session-health machine picks the backend: the configured
        // choice normally, the software fallback once this camera has
        // been escalated (consecutive silent/failed hardware sessions).
        let mut backend = cam.session_health.lock().unwrap().select(encoder_choice);
        if let Err(e) = backend.init(cfg.clone()) {
            // Hardware backend failed (e.g. VAAPI probe passed but
            // avcodec_open2 rejected the resolution or profile). Fall back
            // to software immediately rather than retrying the same failing
            // backend every frame. Also record the failure against this
            // camera's session health: some drivers (e.g. Media Foundation
            // on certain D3D devices) fail hardware init on every single
            // resolution reinit, and without this the camera would retry
            // the doomed hardware path on every adaptive-quality resize
            // for the rest of the session instead of pinning to software
            // after a couple of strikes.
            let was_hardware = backend.is_hardware();
            let failed_backend_name = backend.name();
            warn!(flight_id = cam.flight_id, error = %e, backend = failed_backend_name, "encoder init failed; falling back to software");
            let verdict =
                record_init_failure(&mut cam.session_health.lock().unwrap(), was_hardware);
            if verdict == Some(SessionVerdict::EscalateToSoftware) {
                warn_escalated(
                    cam,
                    failed_backend_name,
                    "hardware init failed on consecutive reinits",
                );
            }
            backend = Box::new(Software::new());
            if let Err(e2) = backend.init(cfg) {
                warn!(flight_id = cam.flight_id, error = %e2, "software fallback init failed");
                return;
            }
        }
        info!(
            flight_id = cam.flight_id,
            width = frame.width,
            height = frame.height,
            bitrate_bps = effective_bps,
            backend = backend.name(),
            "per-camera encoder initialised",
        );
        cam.encoder_width.store(frame.width, Ordering::Release);
        cam.encoder_height.store(frame.height, Ordering::Release);
        cam.encoder_bitrate.store(effective_bps, Ordering::Release);
        *encoder_guard = Some(backend);
    }
    let encoder = encoder_guard.as_mut().unwrap();
    let backend_name = encoder.name();
    let backend_is_hardware = encoder.is_hardware();

    /* Consume any pending promotion keyframe request before encoding, so the
    IDR rides the very next frame rather than waiting out the periodic GOP. */
    if cam.take_keyframe_request() {
        encoder.request_keyframe();
    }

    let nals = match encoder.encode(&RawFrame {
        width: frame.width,
        height: frame.height,
        data: &frame.pixels,
        capture_ts_ms: frame.capture_ts_ms,
    }) {
        Ok(n) => {
            cam.encode_failure_streak.store(0, Ordering::Release);
            /* A promotion is complete once a keyframe actually goes out — that
            is the moment the feed becomes renderable, so it's what flips the
            published state from Ramping to Full. Keyed on a real IDR in the
            output rather than on time elapsed, so a slow ramp reports
            honestly instead of claiming Full while still undecodable. */
            if cam.ramping.load(Ordering::Acquire) && n.iter().any(|nal| nal.is_keyframe()) {
                cam.finish_ramp();
            }
            n
        }
        Err(e) => {
            // A persistently-failing encoder session (wedged VAAPI
            // context, driver reset) never heals by retrying encode();
            // peers would stall forever on an open track. Drop it after
            // a sustained streak so the next frame re-runs init. The
            // session-health strike means a backend whose fresh sessions
            // keep failing too escalates to software instead of cycling
            // the same broken hardware forever.
            let streak = cam.encode_failure_streak.fetch_add(1, Ordering::AcqRel) + 1;
            warn!(flight_id = cam.flight_id, error = %e, streak, "encode failed");
            if streak >= ENCODE_FAILURE_REINIT_THRESHOLD {
                drop_encoder_session(cam, &mut encoder_guard);
                warn!(
                    flight_id = cam.flight_id,
                    backend = backend_name,
                    "encoder dropped after {streak} consecutive failures; will reinit on next frame"
                );
                let verdict = cam.session_health.lock().unwrap().note_session_error();
                if verdict == SessionVerdict::EscalateToSoftware {
                    warn_escalated(cam, backend_name, "consecutive sessions kept failing");
                }
            }
            return;
        }
    };

    if nals.is_empty() {
        // Zero NALs from one encode() call is legal (encoder still
        // buffering), but a hardware session that stays silent for
        // SILENT_SESSION_FRAME_LIMIT straight calls is the GPU
        // concurrent-session-limit signature: it inits cleanly, accepts
        // every frame, errors never, emits nothing. Field case: AMD RX
        // 9070 XT via Media Foundation, 13 cameras, the last-added few
        // streamed black with zero log evidence. Strike the session;
        // enough strikes pin this camera to the software encoder.
        if backend_is_hardware {
            let verdict = cam.session_health.lock().unwrap().note_silent_frame();
            if verdict != SessionVerdict::Continue {
                drop_encoder_session(cam, &mut encoder_guard);
                warn!(
                    flight_id = cam.flight_id,
                    camera = %cam.camera_name,
                    backend = backend_name,
                    frames = SILENT_SESSION_FRAME_LIMIT,
                    "hardware encode session accepted frames but never produced output; dropping it"
                );
                if verdict == SessionVerdict::EscalateToSoftware {
                    warn_escalated(cam, backend_name, "sessions init fine but stay silent");
                }
            }
        }
        return;
    }
    // Only a hardware session producing real output clears strikes. A
    // software encode succeeding here (the fallback path after a hardware
    // init failure) says nothing about hardware health, so it must not
    // wipe out the strike record_init_failure just logged above — otherwise
    // a camera whose hardware init fails on every resolution reinit would
    // strike, immediately get cleared by the successful fallback encode,
    // and never reach SESSION_STRIKE_LIMIT.
    if backend_is_hardware {
        cam.session_health.lock().unwrap().note_output();
    }
    drop(encoder_guard);

    // Concatenate NALs into the Annex-B bytestream webrtc-rs expects.
    let total_len: usize = nals.iter().map(|n| n.0.len()).sum();
    let mut combined = Vec::with_capacity(total_len);
    for nal in &nals {
        combined.extend_from_slice(&nal.0);
    }
    let sample = Sample {
        data: combined.into(),
        duration: actual_duration,
        ..Default::default()
    };

    // Fan-out + GC dead weak refs in one pass. Pruned weaks mean a peer
    // dropped without telling us — decrement the camera's subscriber
    // count so the encoder can idle once the last viewer leaves.
    let mut tracks = cam.tracks.write().await;
    let prev = std::mem::take(&mut *tracks);
    let mut alive = Vec::with_capacity(prev.len());
    let mut pruned = 0usize;
    let mut sent = 0usize;
    for weak in prev {
        if let Some(track) = weak.upgrade() {
            if let Err(e) = track.write_sample(&sample).await {
                warn!(flight_id = cam.flight_id, error = %e, "write_sample failed");
            } else {
                sent += 1;
            }
            alive.push(weak);
        } else {
            pruned += 1;
        }
    }
    /* Subscribers>0 but zero live tracks means the subscriber count and the
    weak-ref list have diverged: we believe someone is watching, so we keep
    encoding, but there is nobody to send to. Silent black feed. */
    if sent == 0 {
        warn!(
            flight_id = cam.flight_id,
            pruned,
            subscribers = cam.subscribers.load(Ordering::Acquire),
            "encoded a frame but sent it to NOBODY (no live tracks)"
        );
    } else {
        debug!(
            flight_id = cam.flight_id,
            sent,
            pruned,
            bytes = sample.data.len(),
            "sample fanned out"
        );
    }
    *tracks = alive;
    drop(tracks);
    if pruned > 0 {
        cam.release(pruned);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kerbcast_sidecar::encoder::{Nvenc, Software};

    #[test]
    fn bitrate_flag_absent_is_distinguishable_from_explicit() {
        // No clap default: an omitted flag must parse as None so the
        // backend-aware default can kick in downstream.
        let absent = Cli::try_parse_from(["kerbcast-sidecar"]).unwrap();
        assert_eq!(absent.bitrate_bps, None);

        let explicit =
            Cli::try_parse_from(["kerbcast-sidecar", "--bitrate-bps", "1500000"]).unwrap();
        assert_eq!(explicit.bitrate_bps, Some(1_500_000));
    }

    #[test]
    fn explicit_flag_wins_regardless_of_backend_class() {
        let cli = Cli::try_parse_from(["kerbcast-sidecar", "--bitrate-bps", "2000000"]).unwrap();
        assert_eq!(
            resolve_bitrate_bps(cli.bitrate_bps, &Nvenc::new()),
            2_000_000
        );
        assert_eq!(
            resolve_bitrate_bps(cli.bitrate_bps, &Software::new()),
            2_000_000
        );
    }
}
