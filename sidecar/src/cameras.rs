//! Per-camera state owned by the sidecar.
//!
//! The plugin (writer side) creates one ring file per Hullcam VDS part,
//! keyed by KSP's stable `Part.flightID`. The sidecar (reader side) globs
//! `<shm_dir>/*.ring`, parses the filename's stem as a u32 flight ID, and
//! maintains a registry of `CameraState` keyed by that ID.
//!
//! Each `CameraState` owns one mmap ring, one lazy-initialised
//! `EncoderBackend` (created on first frame so it sees the actual ring
//! dimensions), and a list of `TrackLocalStaticSample` weak refs — one per
//! peer-track subscribed to this camera. The consume loop iterates the
//! registry once per tick, encodes only cameras with `subscribers > 0`,
//! and fans the resulting NALs out to every alive track.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Weak};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, RwLock};
use tracing::{info, warn};
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;

use crate::encoder::{EncoderBackend, SessionHealth};
use crate::protocol::{
    CameraKind, CameraLifecycle, CameraState as ProtocolCameraState, CaptureState, CrewLocation,
    Layer, QualityPreset, SettingsStatePayload, TrackMode,
};
use crate::shared_mem::{ControlBlock, MmapFrameRing};

/// Filesystem identity for a `.ring` file: distinguishes "same path, same
/// underlying file" from "same path, file was unlinked and a new one
/// created in its place". Inode is exact on unix; `MetadataExt::file_index`
/// would give the same on Windows but is still unstable
/// (`windows_by_handle`, rust-lang/rust#63010), so non-unix falls back to
/// the mtime in nanoseconds — coarser (a same-tick delete+recreate could in
/// theory collide) but still a large improvement over never detecting the
/// swap at all.
#[cfg(unix)]
fn ring_file_identity(meta: &std::fs::Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    meta.ino()
}

#[cfg(not(unix))]
fn ring_file_identity(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0)
}

/// File the host writes ~1Hz with "1" (in a flight scene) or "0" (not).
/// Separate from `global.status.json` because the session-persistent host
/// outlives the flight-only status writer and must report the non-flight
/// state too.
pub const INFLIGHT_FILE: &str = "global.inflight";

/// Parse the `global.inflight` body. `Some(true)`/`Some(false)` for the
/// "1"/"0" the host writes; `None` for anything else (missing, partial).
pub fn parse_in_flight(body: &str) -> Option<bool> {
    match body.trim() {
        "1" => Some(true),
        "0" => Some(false),
        _ => None,
    }
}

/// On-disk shape of `global.status.json` — the plugin → sidecar push
/// half of the IPC. The plugin rewrites this file at ~1Hz with the
/// current effective state for every tracked camera plus the global
/// KSP framerate and adaptive shed level.
///
/// `Serialize` is derived too so `GET /dumpLogs` can replay buffered
/// snapshots straight back to the harness as JSONL. `PartialEq` powers
/// the dedup that keeps the buffer small (the consume loop polls at
/// ~62Hz; the plugin writes at ~1Hz).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GlobalStatusFile {
    ksp_fps: f32,
    shed_level: u32,
    #[serde(default)]
    cameras: Vec<PerCameraStatus>,
    /// Effective state of the KSP main render throttle. Written by the
    /// plugin from `_throttleEffective` each status cycle. Absent in
    /// older plugin writes; defaults to `false` so existing data is safe.
    #[serde(default)]
    throttle_main_screen: bool,
    /// Background-background ceiling currently in force, in fps, after the plugin's
    /// background shed rung. The plugin owns this number; the sidecar only knows
    /// which cameras nobody is displaying. Absent in older plugin writes and
    /// 0 when the operator left background capture off, both of which mean "no background capture",
    /// so every camera keeps being asked for the primary rate as before.
    #[serde(default)]
    background_capture_fps: f32,
    /// Mission-time capture clock (see `SettingsStatePayload`). All three
    /// absent in older plugin writes; `None` => no clock, surfaced as
    /// "unknown" to consumers.
    #[serde(default)]
    capture_ut: Option<f64>,
    #[serde(default)]
    capture_epoch: Option<u32>,
    #[serde(default)]
    time_warp_rate: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PerCameraStatus {
    flight_id: u32,
    render_width: u32,
    render_height: u32,
    operator_width: u32,
    operator_height: u32,
    #[serde(default)]
    layers: Vec<Layer>,
    #[serde(default)]
    operator_layers: Vec<Layer>,
    #[serde(default)]
    fov: f32,
    #[serde(default)]
    pan_yaw: f32,
    #[serde(default)]
    pan_pitch: f32,
    /// The plugin's CURRENT applied auto-track mode (0=none/1=active-vessel/
    /// 2=target), echoed up so the read path can reflect a kOS-set value. Read
    /// only when `track_report_seq` advances (a kOS SetTrackMode). Int, not the
    /// enum, because the plugin hand-writes this JSON.
    #[serde(default)]
    track_mode: u32,
    /// Monotonic counter the plugin bumps ONLY on a kOS-facade SetTrackMode
    /// (never when applying a control-block flush — the anti-loop guard). The
    /// sidecar adopts the reported `track_mode` when this advances, exactly
    /// once per kOS set.
    #[serde(default)]
    track_report_seq: u32,
}

/// Project the wire `SettingsStatePayload` out of an on-disk status snapshot.
fn settings_from_status(s: &GlobalStatusFile) -> SettingsStatePayload {
    SettingsStatePayload {
        throttle_main_screen: s.throttle_main_screen,
        capture_ut: s.capture_ut,
        capture_epoch: s.capture_epoch,
        time_warp_rate: s.time_warp_rate,
    }
}

/// Diff result from a status poll. Empty vec / None when nothing
/// changed so the consume loop can skip broadcasting.
#[derive(Debug, Default)]
pub struct StatusDelta {
    pub adaptive_shed: Option<(u32, f32)>, // (level, ksp_fps)
    pub changed_cameras: Vec<ProtocolCameraState>,
    /// Set when any global setting (throttle, or the mission-time capture
    /// clock) changed since the last poll. The consume loop broadcasts one
    /// `SettingsState` carrying the full current payload when this is `Some`.
    pub settings: Option<SettingsStatePayload>,
    /// The plugin's background-background ceiling moved (operator change, or background capture
    /// rung shedding / restoring under load). Every capturing in the background camera's requested
    /// rate derives from it, so the consume loop reflushes control blocks.
    pub background_ceiling_changed: bool,
}

/// Membership churn from one `rescan` pass over the shm dir. With the
/// sidecar persisting for the whole KSP session, a scene change shows up
/// as `removed` (flight exit deletes every ring) followed, one or more
/// ticks later, by `attached` (the next flight recreates them, often
/// with the same flight ids). The consume loop uses `attached` to rebind
/// surviving peer subscriptions and pushes a fresh camera snapshot on
/// any churn.
#[derive(Debug, Default)]
pub struct RescanOutcome {
    /// Destroyed-tombstone transitions not yet broadcast to peers.
    pub newly_destroyed: Vec<u32>,
    /// Flight ids whose rings were attached this pass.
    pub attached: Vec<u32>,
    /// Flight ids dropped under normal teardown this pass.
    pub removed: Vec<u32>,
}

/// In-memory mirror of a camera's control state. The data-channel message
/// handlers mutate this struct and the registry's `flush_control` publishes the
/// full state to the camera's shared-memory control block
/// (`<flight_id>.control.bin`, read by the plugin), so independent setters
/// (SetLayers, SetRenderSize, SetFov, …) compose cleanly without clobbering each
/// other. (`Serialize` is retained only for `/dumpLogs`-style debug output.)
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlState {
    /// Whether at least one peer is subscribed to this camera. Drives
    /// the plugin's subscriber-aware capture skip: when `false` the
    /// plugin disables the per-camera layer renders and short-circuits
    /// Refresh(), so unsubscribed cameras cost nothing on the KSP
    /// side. Always emitted (no `skip_serializing_if`) so the field
    /// is unambiguously present in the JSON — the plugin treats
    /// "field missing" as `false` for safety.
    pub subscribed: bool,
    /// Operator-requested layer mask. Empty = "fall back to settings.cfg
    /// initial mask on the plugin side"; populated = explicit override.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub layers: Vec<Layer>,
    /// Operator-requested render size. None = "use settings.cfg initial".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    /// Operator-requested camera FoV in degrees. None = "leave Hullcam's
    /// default alone". Ignored for parts where `supports_zoom == false`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fov: Option<f32>,
    /// Operator-requested pan/tilt in degrees. None = "neutral / rest".
    /// Ignored for parts where `supports_pan == false` (the fixed-mount
    /// majority); honored by steerable mounts (`DC.TurretCam`, `hc.launchcam`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pan_yaw: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pan_pitch: Option<f32>,
    /// Persistent pan velocity, normalised -1..=1 per axis. `None` =
    /// unchanged (the plugin keeps the last rate); `Some(0.0)` = stop.
    /// The plugin integrates these into `pan_yaw`/`pan_pitch` every frame.
    /// Sign matches the absolute pan: +yaw = right, +pitch = up.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pan_yaw_rate: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pan_pitch_rate: Option<f32>,
    /// Persistent zoom velocity, normalised -1..=1. +1 = zoom in (FoV
    /// decreasing). `None` = unchanged; `Some(0.0)` = stop. The plugin
    /// integrates this into the FoV target every frame.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zoom_rate: Option<f32>,
    /// Monotonic counter bumped on every *absolute* pan command
    /// (`apply_pan_change`). control.json is a full-state snapshot
    /// re-serialised on every command, so the stale `pan_yaw`/`pan_pitch`
    /// ride along on unrelated writes (and on the rate-stop flush itself).
    /// While a rate integrates the plugin's target away from that stale
    /// absolute, re-applying it would snap the camera back. The plugin
    /// therefore applies the absolute pan only when `pan_seq` *changes*,
    /// so a re-serialised stale value is idempotent but a genuine new
    /// absolute (even one re-issuing the same value) still lands. Rate
    /// commands and the disconnect deadman do NOT bump it.
    pub pan_seq: u32,
    /// As `pan_seq`, for absolute FoV (`apply_fov_change`).
    pub fov_seq: u32,
    /// Viewer-requested quality clamp: an index into the plugin's
    /// `QualityClamp.ViewerScales` table (0 = full, 3 = quarter), mapped
    /// from the protocol's `QualityPreset` by `viewer_level()`. `None` =
    /// auto, no viewer clamp. Last write wins across peers. The plugin
    /// combines it as max(adaptive shed level scale-wise, viewer level):
    /// it can only lower quality below the operator ceiling, never
    /// raise it, and never touches the adaptive machinery.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub viewer_level: Option<u32>,
    /// Server-authoritative auto-track mode for a pan+zoom camera (the
    /// operator's persistent intent). `None` = not tracking. Flushed to the
    /// control block for the plugin, and published in the protocol
    /// `CameraState.track_mode` so every browser reflects it. A browser track
    /// overrides a kOS aim on the same camera; `None` hands aiming back to kOS.
    #[serde(skip_serializing_if = "track_mode_is_none")]
    pub track_mode: TrackMode,
    /// Monotonic counter bumped on every authoritative `track_mode` change (a
    /// browser `SetTrackTarget` OR the sidecar adopting a kOS report). Flushed
    /// to the control block; the plugin applies `track_mode` only when this
    /// changes (edge-trigger), so the every-flush stale value can't revert a
    /// kOS-set mode. Same pattern as `pan_seq`/`fov_seq`.
    #[serde(default)]
    pub track_seq: u32,
    /// Requested capture rate in fps. `None` = capture at the primary rate,
    /// which is the behaviour predating background capture and stays the default. A low value is a
    /// background background capture: the camera is subscribed but nothing is displaying it at
    /// size, so it is paced far below primary to keep a recent frame available
    /// without paying full capture cost.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capture_fps: Option<f32>,
}

/// serde skip helper: keep the debug JSON clean for the common not-tracking case.
fn track_mode_is_none(m: &TrackMode) -> bool {
    *m == TrackMode::None
}

/// Status-echo int (0=none/1=active-vessel/2=target) -> TrackMode. Anything
/// unrecognised is treated as not-tracking. Mirrors the plugin's mapping.
fn track_mode_from_u32(v: u32) -> TrackMode {
    match v {
        1 => TrackMode::ActiveVessel,
        2 => TrackMode::Target,
        _ => TrackMode::None,
    }
}

/// Public shape returned by `GET /cameras` — what a browser sees before
/// it picks a subscription set. Operator-readable fields (`part_title`,
/// `camera_name`, `vessel_name`) come from the plugin's `<id>.info.json`
/// manifest; falling back to defaults if the manifest's missing or
/// unreadable. Capability fields tell clients which controls to render
/// per camera (zoom slider / pan stick).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraInfo {
    pub flight_id: u32,
    /// Part-destruction lifecycle. Reflects the camera's last-known
    /// state from `info.json`. Destroyed cameras remain in the list so
    /// the UI can show a "SIGNAL LOST" badge until the next vessel change
    /// clears the registry. `"active"` for live cameras.
    pub lifecycle: CameraLifecycle,
    /// Whether this is a Hullcam part camera or a per-kerbal face camera.
    pub kind: CameraKind,
    /// The kerbal's `ProtoCrewMember.persistentID`. `None` for part cameras.
    pub kerbal_persistent_id: Option<u32>,
    /// Which source a kerbal camera is currently rendering. `None` for
    /// part cameras.
    pub crew_location: Option<CrewLocation>,
    /// Server-authoritative auto-track mode for a pan+zoom camera. `None` =
    /// not tracking. Every browser reflects this.
    pub track_mode: TrackMode,
    pub max_width: u32,
    pub max_height: u32,
    pub part_name: String,
    pub part_title: String,
    pub camera_name: String,
    pub vessel_name: String,
    pub supports_zoom: bool,
    pub fov: f32,
    pub fov_min: f32,
    pub fov_max: f32,
    pub supports_pan: bool,
    pub pan_yaw_min: f32,
    pub pan_yaw_max: f32,
    pub pan_pitch_min: f32,
    pub pan_pitch_max: f32,
    pub encoder_bitrate_bps: u32,
    pub target_bitrate_bps: u32,
    pub degrade_level: f32,
}

/// Manifest the plugin writes alongside the ring file. Static for the
/// camera's lifetime — vessel renames mid-flight aren't reflected
/// until the next vessel change. Capability fields are read from the
/// Hullcam module on the plugin side: `supportsZoom = true` iff the
/// part is `MuMechModuleHullCameraZoom`; `supportsPan = true` only once
/// the planned mod extension adds steerable mounts.
///
/// When the plugin destroys a Hullcam part it rewrites this file with
/// `lifecycle: "destroyed"` and removes the `.ring` file. The sidecar
/// must detect the transition and clean up.
#[derive(Debug, Clone, Deserialize)]
struct InfoManifest {
    #[allow(dead_code)] // echo-only — we already know the flight_id from the filename
    flight_id: u32,
    /// Absent / unknown values treated as `Active` per the protocol spec.
    #[serde(default)]
    lifecycle: CameraLifecycle,
    #[serde(default)]
    part_name: String,
    #[serde(default)]
    part_title: String,
    #[serde(default)]
    camera_name: String,
    #[serde(default)]
    vessel_name: String,
    #[serde(default)]
    supports_zoom: bool,
    #[serde(default)]
    fov: f32,
    #[serde(default)]
    fov_min: f32,
    #[serde(default)]
    fov_max: f32,
    #[serde(default)]
    supports_pan: bool,
    #[serde(default)]
    pan_yaw_min: f32,
    #[serde(default)]
    pan_yaw_max: f32,
    #[serde(default)]
    pan_pitch_min: f32,
    #[serde(default)]
    pan_pitch_max: f32,
    /// `"part"` or `"kerbal"`. Empty/absent (existing part cameras predate
    /// this field) is treated as `"part"`: see `CameraKind`.
    #[serde(default)]
    kind: String,
    /// The kerbal's `ProtoCrewMember.persistentID`. `None` for part cameras.
    #[serde(default)]
    kerbal_persistent_id: Option<u32>,
    /// `"seat"` or `"eva"`. `None` for part cameras.
    #[serde(default)]
    crew_location: Option<String>,
}

pub struct CameraState {
    pub flight_id: u32,
    pub ring: MmapFrameRing,
    /// Filesystem identity (inode on unix, file index on windows) of the
    /// `.ring` file this entry attached to. `RebuildCameraList` on the
    /// plugin side can delete and recreate a ring at the same path within
    /// one Unity frame for a camera whose part persists across a vessel
    /// switch, without writing a `destroyed` tombstone (that's reserved for
    /// actual part destruction). A same-second delete+recreate can share an
    /// mtime, so identity — not mtime — is what `rescan` compares to notice
    /// the file underneath changed and reattach instead of leaving the mmap
    /// pointed at the unlinked original.
    pub ring_identity: u64,
    pub max_width: u32,
    pub max_height: u32,
    /// Whether this is a Hullcam part camera or a per-kerbal face camera.
    pub kind: CameraKind,
    /// The kerbal's `ProtoCrewMember.persistentID`. `None` for part cameras.
    pub kerbal_persistent_id: Option<u32>,
    /// Which source a kerbal camera is currently rendering. `None` for
    /// part cameras. Interior-mutable: a kerbal's feed reuses one ring
    /// across the seat<->EVA switch, so `rescan` updates this in place on
    /// the live `Arc<CameraState>` when the plugin rewrites the manifest
    /// (a fresh attach is never triggered by the switch). Read via
    /// `crew_location()`.
    crew_location: std::sync::Mutex<Option<CrewLocation>>,
    pub part_name: String,
    pub part_title: String,
    pub camera_name: String,
    pub vessel_name: String,
    pub supports_zoom: bool,
    pub fov_default: f32,
    pub fov_min: f32,
    pub fov_max: f32,
    pub supports_pan: bool,
    pub pan_yaw_min: f32,
    pub pan_yaw_max: f32,
    pub pan_pitch_min: f32,
    pub pan_pitch_max: f32,
    /// Current lifecycle state. Set once to `Destroyed` on first detection
    /// of `lifecycle: "destroyed"` in info.json; never flips back to `Active`.
    /// Stored as an `AtomicBool` (true = destroyed) for lock-free reads in
    /// the encode path.
    pub destroyed: AtomicBool,
    /// Tracks whether we've already sent the destruction notification to
    /// peers. Prevents duplicate broadcasts when the consume loop re-reads
    /// the tombstone on a subsequent tick before info.json is deleted.
    pub destruction_broadcast_sent: AtomicBool,
    /// Sidecar-side mirror of the plugin's control file. Mutated by
    /// data-channel messages (SetLayers / SetRenderSize); the registry's
    /// `write_control` flushes the full struct to disk on each change so
    /// fields stay in sync — setting layers doesn't clobber an
    /// already-set render size.
    pub control: Mutex<ControlState>,
    /// Persistent shared-memory control block this camera's state is written
    /// to (`<flight_id>.control.bin`, replacing the old `.control.json`).
    /// Lazily created on first flush and kept for the camera's life so the
    /// seqlock counter keeps advancing across writes (recreating it would
    /// reset the counter and the plugin's change detection would miss a write).
    /// A `std::sync::Mutex`, not the tokio one — the mmap write is synchronous
    /// and never held across an await.
    pub control_block: std::sync::Mutex<Option<ControlBlock>>,
    /// Lazy: created on first encoded frame so the encoder sees the
    /// actual frame dimensions, not the ring's max. Closed + reinit if
    /// the frame dimensions change (the plugin's adaptive downscale
    /// path triggers this).
    pub encoder: Mutex<Option<Box<dyn EncoderBackend>>>,
    /// Width/height the encoder is currently initialised for. The
    /// consume loop compares these against the incoming frame's
    /// dimensions to detect adaptive-downscale resolution changes.
    /// Both 0 when no encoder is running.
    pub encoder_width: AtomicU32,
    pub encoder_height: AtomicU32,
    /// Bitrate the current encoder session was initialised with.
    /// 0 = no encoder running yet. The consume loop compares against
    /// `target_bitrate_bps` and reinitialises the encoder when they
    /// diverge significantly (REMB-driven adaptation).
    pub encoder_bitrate: AtomicU32,
    /// Consecutive encode() failures. Reset on success; at the consume
    /// loop's threshold the encoder is closed + dropped so the next
    /// frame re-initialises it (hardware first, software fallback) —
    /// otherwise a wedged encoder session stalls subscribed peers
    /// forever while only emitting warn logs.
    pub encode_failure_streak: AtomicU32,
    /// Session-level escalation state: hardware sessions that stay
    /// silent (init fine, accept frames, never emit a NAL, the GPU
    /// concurrent-session-limit signature) or persistently error
    /// strike toward pinning this camera to the software fallback.
    /// std Mutex: only touched under the encoder lock, never across
    /// an await.
    pub session_health: std::sync::Mutex<SessionHealth>,
    /// Most-recent target bitrate, computed as the min across active
    /// subscribers' REMB estimates (so the slowest receiver doesn't
    /// drop the whole stream). 0 = no REMB received yet; consume loop
    /// falls back to the CLI default.
    pub target_bitrate_bps: AtomicU32,
    /// Per-SSRC REMB estimates from active subscribers. Updated by
    /// the peer's RTCP drain loop; consume loop reads + takes the min
    /// to produce `target_bitrate_bps`.
    pub bandwidth_estimates: Mutex<std::collections::HashMap<u32, u32>>,
    /// SetDegrade level (0.0..=1.0), last-writer-wins. Degrade is a
    /// property of the camera's game state (a vessel's comms strength),
    /// not of any one viewer, and the single shared encoder can only
    /// emit one degrade anyway — so this is a single per-camera scalar,
    /// not a per-peer reduction. Whichever subscriber wrote last owns it;
    /// a well-behaved driver (e.g. gonogo) re-asserts every tick.
    /// Stored as bits-of-f32 in an AtomicU32 to keep the hot path
    /// lock-free (encode_and_fan_out runs per-frame, the f32 is
    /// already bit-pattern-stable for our levels).
    pub effective_degrade: AtomicU32,
    /// Auto-track mode published to browsers (0=none/1=active-vessel/2=target),
    /// the cheap lock-free mirror of `ControlState.track_mode`. `ControlState`
    /// is the flush-to-plugin snapshot; this atomic is the publish source read
    /// by `list()`/`protocol_state` without locking. `apply_track_target` is the
    /// single writer and sets both, so they can't drift.
    pub track_mode_bits: AtomicU32,
    /// Last kOS-report seq the sidecar has consumed for this camera (from the
    /// plugin's status echo). `poll_status` adopts the reported track_mode when
    /// the incoming seq differs from this, then stores it — so a level-triggered
    /// echo is adopted exactly once per kOS set (no re-adopt loop). Starts 0.
    pub last_track_report_seq: AtomicU32,
    /// Last wall-clock instant we *encoded* (and emitted NALs to) a frame.
    /// The consume loop uses this to pace encodes against the configured
    /// `fps`, instead of running once per ring write at LateUpdate's
    /// native cadence (40-60 Hz on the Deck) and tagging samples with
    /// duration=1/fps that the receiver can't reconcile.
    pub last_encoded_at: Mutex<Option<Instant>>,
    pub last_sequence: AtomicU64,
    /// Count of peer-tracks currently subscribed. Encoder runs only when > 0.
    pub subscribers: AtomicUsize,
    /// Promoted out of background capture but not yet renderable — set when display demand
    /// appears, cleared when a keyframe is emitted.
    pub ramping: AtomicBool,
    /// Pending forced-IDR request, consumed by the encode path.
    pub keyframe_wanted: AtomicBool,
    /// One `TrackLocalStaticSample` per subscribed peer-track. Weak refs so
    /// dropped peers get GC'd from this list naturally — no manual unsub
    /// bookkeeping per peer needed.
    pub tracks: RwLock<Vec<Weak<TrackLocalStaticSample>>>,
    /// Per-consumer reported display size in px, keyed by `peer_id` (stable for
    /// the connection's lifetime, present at the report site AND every teardown
    /// site). Auto-resolution takes the per-dimension MAX across live entries;
    /// entries are FORGOTTEN on unsubscribe / disconnect / peer-reap so the max
    /// relaxes when a large-display consumer leaves (the v1.6.3 clear-on-
    /// departure lesson). Mirrors `bandwidth_estimates` (a per-consumer map that
    /// reduces), NOT the `effective_degrade` scalar — display size is a genuine
    /// per-consumer need, not a camera-global property.
    pub display_sizes: Mutex<std::collections::HashMap<u32, (u32, u32)>>,
    /// Operator `SetRenderSize` CAP (even, clamped to the ring max), or `None`
    /// = uncapped. The effective render size is min(auto MAX-across-consumers,
    /// this cap): a manual size can only LOWER what auto would pick, never raise
    /// it past what consumers actually need.
    pub manual_render_cap: Mutex<Option<(u32, u32)>>,
    /// Peers currently forcing this camera to the ring ceiling (e.g. a
    /// full-resolution recording), keyed by `peer_id`. OR-aggregated: forced
    /// while ANY entry is present, released once the set is empty. Mirrors
    /// `display_sizes` (per-peer, forgotten on unsubscribe / disconnect / peer
    /// reap), not `effective_degrade` (a camera-global scalar): forcing is a
    /// genuine per-consumer demand, not a camera-wide property.
    pub forced_full_res: Mutex<std::collections::HashSet<u32>>,
}

impl CameraState {
    /// Add a track to this camera and bump the subscriber count. Returns
    /// the count after the increment so the caller can request a keyframe
    /// on the 0→1 transition.
    pub async fn add_track(&self, track: Arc<TrackLocalStaticSample>) -> usize {
        let mut tracks = self.tracks.write().await;
        tracks.push(Arc::downgrade(&track));
        self.subscribers.fetch_add(1, Ordering::AcqRel) + 1
    }

    /// Drop the subscriber count by `n` (used when a peer goes away with
    /// multiple subscribed tracks). Stale weak refs get pruned by the
    /// consume loop on the next tick.
    pub fn release(&self, n: usize) {
        self.subscribers.fetch_sub(n, Ordering::AcqRel);
    }

    /// Remove a *specific, still-alive* track — the explicit `Unsubscribe`
    /// path of the dynamic slot model. Unlike the consume loop's pruner
    /// (which collects Weaks that have gone dead because a peer dropped),
    /// here the track Arc is still owned by the peer as a reusable slot, so
    /// it won't appear dead; we match it by pointer, drop its Weak, and
    /// decrement the subscriber count ourselves. The fan-out pruner therefore
    /// never double-counts it (it's already out of the list). Returns the
    /// subscriber count after the decrement; removing a track this camera
    /// isn't feeding is a no-op.
    pub async fn remove_track(&self, track: &Arc<TrackLocalStaticSample>) -> usize {
        let mut tracks = self.tracks.write().await;
        let before = tracks.len();
        tracks.retain(|w| !w.upgrade().is_some_and(|t| Arc::ptr_eq(&t, track)));
        let removed = before - tracks.len();
        drop(tracks);
        if removed > 0 {
            self.subscribers.fetch_sub(removed, Ordering::AcqRel);
        }
        self.subscribers.load(Ordering::Acquire)
    }

    /// How hard this camera is currently being captured, as published to
    /// consumers. With background capture off (the default) this is the binary
    /// it has always been: subscribed cameras are `Full`, the rest `Off`.
    ///
    /// `capturing in the background` is passed in rather than recomputed because it needs the
    /// plugin-published ceiling, which lives on the registry, and because the
    /// caller is already holding the answer.
    pub fn capture_state_with(&self, background_capturing: bool) -> CaptureState {
        if self.subscribers.load(Ordering::Acquire) == 0 {
            return CaptureState::Off;
        }
        if background_capturing {
            return CaptureState::Background;
        }
        // Displayed, but the promotion hasn't produced a keyframe yet: the
        // stream is live-but-not-yet-renderable, which is a different thing to
        // tell a consumer than "full".
        if self.ramping.load(Ordering::Acquire) {
            return CaptureState::Ramping;
        }
        CaptureState::Full
    }

    /// Mark this camera as promoted out of background capture: it is being displayed
    /// again, but nothing renderable has arrived yet. Cleared by the encode
    /// path once a keyframe is emitted.
    pub fn begin_ramp(&self) {
        self.ramping.store(true, Ordering::Release);
        self.keyframe_wanted.store(true, Ordering::Release);
    }

    /// Whether the encoder should force an IDR on its next encode, consuming
    /// the request. Promotion sets it: background capture stream's periodic IDR is counted
    /// in ENCODED FRAMES (`fps * 2`), so at 1fps the next natural keyframe can
    /// be ~60s away and a promoted camera would sit unrenderable until then.
    pub fn take_keyframe_request(&self) -> bool {
        self.keyframe_wanted.swap(false, Ordering::AcqRel)
    }

    /// The promotion completed: a keyframe went out, so the feed is renderable
    /// at full rate.
    pub fn finish_ramp(&self) {
        self.ramping.store(false, Ordering::Release);
    }

    /// Record a REMB bandwidth estimate from a subscriber. Identified
    /// by the receiving track's SSRC so per-peer estimates stay
    /// distinct. Recomputes `target_bitrate_bps` as the min across all
    /// known estimates so the encoder targets the slowest receiver.
    pub async fn record_bandwidth_estimate(&self, ssrc: u32, bps: u32) {
        let mut estimates = self.bandwidth_estimates.lock().await;
        estimates.insert(ssrc, bps);
        let min = estimates.values().copied().min().unwrap_or(0);
        self.target_bitrate_bps.store(min, Ordering::Release);
    }

    /// Forget estimates for an SSRC whose track has gone away (peer
    /// dropped). The consume loop will recompute the min on the next
    /// REMB packet; until then the stored target stays stale but the
    /// remaining peers' estimates dominate quickly.
    pub async fn forget_estimate(&self, ssrc: u32) {
        let mut estimates = self.bandwidth_estimates.lock().await;
        estimates.remove(&ssrc);
        let min = estimates.values().copied().min().unwrap_or(0);
        self.target_bitrate_bps.store(min, Ordering::Release);
    }

    /// Apply a SetDegrade request. Last-writer-wins: the level is a
    /// per-camera property (comms strength), so we store it directly
    /// rather than reduce across subscribers. No per-peer state means
    /// nothing to leak when a peer leaves — a departed peer's value is
    /// simply overwritten by the next subscriber's write.
    pub fn set_degrade(&self, level: f32) {
        self.effective_degrade
            .store(level.clamp(0.0, 1.0).to_bits(), Ordering::Release);
    }

    /// Snapshot of the current effective degrade level. Lock-free
    /// read for the per-frame encode path.
    pub fn current_degrade(&self) -> f32 {
        f32::from_bits(self.effective_degrade.load(Ordering::Acquire))
    }

    /// Current crew location (seat vs EVA) for a kerbal camera; `None` for
    /// part cameras. Cheap copy out of the interior-mutable cell.
    pub fn crew_location(&self) -> Option<CrewLocation> {
        *self.crew_location.lock().unwrap()
    }

    /// Current published auto-track mode (lock-free read of the atomic mirror).
    pub fn track_mode(&self) -> TrackMode {
        match self.track_mode_bits.load(Ordering::Acquire) {
            1 => TrackMode::ActiveVessel,
            2 => TrackMode::Target,
            _ => TrackMode::None,
        }
    }

    /// Set the published track-mode mirror. `apply_track_target` calls this
    /// alongside writing `ControlState.track_mode` so the publish + flush
    /// sources stay in lockstep.
    fn set_track_mode_bits(&self, mode: TrackMode) {
        let bits = match mode {
            TrackMode::None => 0,
            TrackMode::ActiveVessel => 1,
            TrackMode::Target => 2,
        };
        self.track_mode_bits.store(bits, Ordering::Release);
    }

    /// Overwrite the crew location on the live camera. Called by `rescan`
    /// when the plugin rewrites a kerbal manifest's `crew_location` across
    /// the seat<->EVA switch. Returns true when the value actually changed
    /// (the caller then marks the camera dirty to relabel subscribers).
    fn set_crew_location(&self, next: Option<CrewLocation>) -> bool {
        let mut cur = self.crew_location.lock().unwrap();
        if *cur == next {
            return false;
        }
        *cur = next;
        true
    }

    /// Record a consumer's reported display size (px) for auto-resolution,
    /// keyed by `peer_id`. A sub-2 report (a `display:none` / not-yet-laid-out
    /// tile reporting offsetWidth 0) is NO DEMAND, not a real 0x0 render
    /// target: drop the peer's entry so the sole-0x0-consumer case resolves to
    /// `None` (plugin default) rather than a 0x0 that could wedge the ring.
    pub async fn record_display_size(&self, peer_id: u32, width: u32, height: u32) {
        let mut sizes = self.display_sizes.lock().await;
        if width < 2 || height < 2 {
            sizes.remove(&peer_id);
        } else {
            sizes.insert(peer_id, (width, height));
        }
    }

    /// Forget a consumer's display size (on unsubscribe / disconnect / peer
    /// reap) so the MAX relaxes. Returns whether an entry was actually removed
    /// (so callers skip a redundant reflush). Idempotent — a second call, or
    /// one for a peer that never reported, returns false.
    pub async fn forget_display_size(&self, peer_id: u32) -> bool {
        self.display_sizes.lock().await.remove(&peer_id).is_some()
    }

    /// Set (or clear, with `None`) the operator `SetRenderSize` cap.
    pub async fn set_manual_render_cap(&self, cap: Option<(u32, u32)>) {
        *self.manual_render_cap.lock().await = cap;
    }

    /// Force (or release) this camera to the ring ceiling for one peer, keyed
    /// by `peer_id` (e.g. a full-resolution recording). OR-aggregated: see
    /// `forced_full_res`.
    pub async fn set_forced(&self, peer_id: u32, force: bool) {
        let mut forced = self.forced_full_res.lock().await;
        if force {
            forced.insert(peer_id);
        } else {
            forced.remove(&peer_id);
        }
    }

    /// Forget a peer's force (on unsubscribe / disconnect / peer reap) so the
    /// OR relaxes once no peer still forces it. Returns whether an entry was
    /// actually removed (so callers skip a redundant reflush).
    pub async fn forget_forced(&self, peer_id: u32) -> bool {
        self.forced_full_res.lock().await.remove(&peer_id)
    }

    /// Whether anyone is actually displaying this camera at size right now.
    /// `record_display_size` already drops sub-2px reports as "no demand", so a
    /// non-empty map means genuinely on screen somewhere. A forced feed (e.g. a
    /// full-resolution recording) counts as displayed even with no visible tile.
    ///
    /// This is background capture's discriminator: subscribed-and-displayed runs at the
    /// primary rate, subscribed-but-undisplayed runs background capture.
    pub async fn has_display_demand(&self) -> bool {
        if !self.forced_full_res.lock().await.is_empty() {
            return true;
        }
        !self.display_sizes.lock().await.is_empty()
    }

    /// Capture rate to ask the plugin for, given background capture ceiling the plugin
    /// published. `None` = the primary rate, which is both the displayed case
    /// and background capture-disabled case — so with background capture off this is always `None`
    /// and the plugin behaves exactly as it always has.
    pub async fn requested_capture_fps(&self, background_ceiling_fps: f32) -> Option<f32> {
        if background_ceiling_fps <= 0.0 || self.has_display_demand().await {
            return None;
        }
        Some(background_ceiling_fps)
    }

    /// Effective render size = min(demand, manual cap), clamped to the ring's
    /// max dims and made even (H.264 chroma). Demand is normally the auto MAX-
    /// across-consumers display size; while ANY peer forces this camera (see
    /// `forced_full_res`), demand is instead the ring ceiling, so a forced feed
    /// sizes up regardless of what's actually being displayed. `None` when
    /// there is neither a consumer demand nor a manual cap nor a force: the
    /// plugin then falls back to its settings.cfg default. This is what gets
    /// written into `ControlState.width/height`; the plugin's adaptive-shed
    /// min() still rides underneath (untouched by force).
    pub async fn effective_render_size(&self) -> Option<(u32, u32)> {
        let auto = if !self.forced_full_res.lock().await.is_empty() {
            Some((self.max_width, self.max_height))
        } else {
            let sizes = self.display_sizes.lock().await;
            sizes
                .values()
                .copied()
                .reduce(|(aw, ah), (w, h)| (aw.max(w), ah.max(h)))
        };
        let cap = *self.manual_render_cap.lock().await;
        let combined = match (auto, cap) {
            (Some((aw, ah)), Some((cw, ch))) => Some((aw.min(cw), ah.min(ch))),
            (Some(a), None) => Some(a),
            (None, Some(c)) => Some(c),
            (None, None) => None,
        };
        combined.map(|(w, h)| {
            (
                even_clamp(w, self.max_width),
                even_clamp(h, self.max_height),
            )
        })
    }
}

/// Clamp a requested dimension to the ring's allocated max and force it even
/// (H.264 chroma needs even dims; anything over the ring max would be rejected
/// by the plugin's `MmapFrameRing.Produce`).
fn even_clamp(v: u32, max: u32) -> u32 {
    (v.min(max)) & !1
}

/// Registry of cameras. Owns the rescan logic that discovers new rings
/// and forgets dead ones. Also caches the last-seen global status snapshot
/// from the plugin so the consume loop can diff against it.
pub struct CameraRegistry {
    shm_dir: PathBuf,
    pub cameras: RwLock<HashMap<u32, Arc<CameraState>>>,
    last_status: Mutex<Option<GlobalStatusFile>>,
    /// Per-consumer background-capture ("background capture") requests, keyed by `peer_id`.
    /// MAX-aggregated: background capture runs at the highest rate anyone asked for.
    ///
    /// Global rather than per-camera because it is a statement about how much
    /// background cost to spend, not about one camera. Entries MUST be dropped
    /// on disconnect and on peer reap — the identical per-peer-max shape leaked
    /// in v1.6.3, where a departed peer's degrade stayed latched forever and
    /// only a KSP restart cleared it, because the forget path ran after the
    /// bindings it iterated had already been taken.
    background_requests: Mutex<std::collections::HashMap<u32, f32>>,
    /// Last-seen value of the `global.inflight` file, cached so the consume
    /// loop broadcasts `scene-state-changed` only when the flag flips.
    last_in_flight: Mutex<Option<bool>>,
    /// Capped ring of every distinct `global.status.json` snapshot seen
    /// since the last `reset_run_logs()`. Powers the harness's
    /// `GET /dumpLogs` endpoint so perf runs can replay the full
    /// kspFps / shedLevel / per-camera-render-size timeline without
    /// polling during the measurement window.
    ///
    /// We dedupe on whole-struct equality so re-reads between plugin
    /// writes (the consume loop polls faster than the plugin writes)
    /// don't produce duplicate entries. Cap is generous (12k = ~3.5h
    /// at 1Hz) so a full test never overflows; in practice the harness
    /// resets before each run.
    status_log: Mutex<std::collections::VecDeque<StatusLogEntry>>,
    /// `Instant` anchor for `StatusLogEntry::t_ms`. Set at registry
    /// construction so timestamps are relative to sidecar startup —
    /// not wall-clock, immune to NTP slews mid-run.
    epoch: Instant,
    /// Profiling override: when true, every live camera is kept
    /// `subscribed` (so the plugin renders + reports telemetry) even with
    /// no peer attached. Lets `POST /profile/render` exercise the real
    /// per-camera render/readback cost from any scene without a streaming
    /// client. Render-only by design — no peer means no tracks, so the
    /// consume loop never encodes; we measure the plugin's KSP-frametime
    /// cost cleanly, not the sidecar encode path.
    force_render: AtomicBool,
    /*
     * Monotonic sequence counter for global.control.json writes. Seeded on
     * the first write from the on-disk file (max(on-disk seq, 0) + 1) so a
     * restarted sidecar doesn't re-issue a seq the plugin has already seen.
     * Subsequent writes bump atomically so concurrent peer handlers compose.
     */
    global_control_seq: AtomicU64,
    /// Cameras whose sidecar-side state (e.g. viewer quality preset)
    /// changed and needs a `camera-state-changed` broadcast to EVERY
    /// connected peer. The plugin-status diff in `poll_status` can't see
    /// these (they live in the sidecar's own `ControlState`, and the
    /// effective render dims may not move at all when a preset lands
    /// while shed already holds the camera lower), so the consume loop
    /// drains this set each tick and broadcasts directly.
    dirty_cameras: Mutex<std::collections::HashSet<u32>>,
}

const STATUS_LOG_CAP: usize = 12_288;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusLogEntry {
    /// Monotonic sidecar timestamp (millis since the sidecar's first
    /// status read). Stable across the test window even if wall-clock
    /// shifts; doesn't try to encode KSP mission time.
    pub t_ms: u64,
    pub status: GlobalStatusFileExport,
}

/// Public re-export of the on-disk status shape so external consumers
/// (the harness) can deserialize each `/dumpLogs` entry without
/// depending on internal field privacy. Same shape as the on-disk
/// `global.status.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalStatusFileExport {
    pub ksp_fps: f32,
    pub shed_level: u32,
    #[serde(default)]
    pub cameras: Vec<PerCameraStatusExport>,
    #[serde(default)]
    pub throttle_main_screen: bool,
    #[serde(default)]
    pub capture_ut: Option<f64>,
    #[serde(default)]
    pub capture_epoch: Option<u32>,
    #[serde(default)]
    pub time_warp_rate: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PerCameraStatusExport {
    pub flight_id: u32,
    pub render_width: u32,
    pub render_height: u32,
    pub operator_width: u32,
    pub operator_height: u32,
    #[serde(default)]
    pub layers: Vec<Layer>,
    #[serde(default)]
    pub operator_layers: Vec<Layer>,
    #[serde(default)]
    pub fov: f32,
    #[serde(default)]
    pub pan_yaw: f32,
    #[serde(default)]
    pub pan_pitch: f32,
}

impl From<&GlobalStatusFile> for GlobalStatusFileExport {
    fn from(s: &GlobalStatusFile) -> Self {
        Self {
            ksp_fps: s.ksp_fps,
            shed_level: s.shed_level,
            cameras: s
                .cameras
                .iter()
                .map(|c| PerCameraStatusExport {
                    flight_id: c.flight_id,
                    render_width: c.render_width,
                    render_height: c.render_height,
                    operator_width: c.operator_width,
                    operator_height: c.operator_height,
                    layers: c.layers.clone(),
                    operator_layers: c.operator_layers.clone(),
                    fov: c.fov,
                    pan_yaw: c.pan_yaw,
                    pan_pitch: c.pan_pitch,
                })
                .collect(),
            throttle_main_screen: s.throttle_main_screen,
            capture_ut: s.capture_ut,
            capture_epoch: s.capture_epoch,
            time_warp_rate: s.time_warp_rate,
        }
    }
}

/* On-disk shape written by `write_global_control`. */
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GlobalControlFile {
    throttle_main_screen: bool,
    seq: u64,
}

impl CameraRegistry {
    pub fn new(shm_dir: PathBuf) -> Self {
        Self {
            shm_dir,
            cameras: RwLock::new(HashMap::new()),
            last_status: Mutex::new(None),
            background_requests: Mutex::new(std::collections::HashMap::new()),
            last_in_flight: Mutex::new(None),
            status_log: Mutex::new(std::collections::VecDeque::new()),
            epoch: Instant::now(),
            force_render: AtomicBool::new(false),
            global_control_seq: AtomicU64::new(0),
            dirty_cameras: Mutex::new(std::collections::HashSet::new()),
        }
    }

    /// The shm directory the plugin writes rings + `global.status.json` into.
    /// Used by `GET /profile` to serve the latest telemetry snapshot.
    pub fn shm_dir(&self) -> &std::path::Path {
        self.shm_dir.as_path()
    }

    /// Fresh read of `global.inflight` (no caching). Used to prime a
    /// connecting peer on Hello.
    pub async fn read_in_flight(&self) -> Option<bool> {
        let path = self.shm_dir.join(INFLIGHT_FILE);
        match tokio::fs::read_to_string(&path).await {
            Ok(body) => parse_in_flight(&body),
            Err(_) => None,
        }
    }

    /// Poll `global.inflight`, diffing against the cached value. Returns
    /// `Some(new)` only when the flag changed (including the first
    /// observation), so the consume loop broadcasts only on change.
    pub async fn poll_in_flight(&self) -> Option<bool> {
        let current = self.read_in_flight().await;
        let mut last = self.last_in_flight.lock().await;
        if *last != current {
            *last = current;
            return current;
        }
        None
    }

    /*
     * Last-seen global settings snapshot from global.status.json, as the
     * wire payload. Throttle defaults to `false` and the capture clock to
     * `None` when no status has been received yet (plugin hasn't written).
     * Used by the Hello path to prime a freshly-connected peer.
     */
    pub async fn last_settings(&self) -> SettingsStatePayload {
        self.last_status
            .lock()
            .await
            .as_ref()
            .map(settings_from_status)
            .unwrap_or(SettingsStatePayload {
                throttle_main_screen: false,
                capture_ut: None,
                capture_epoch: None,
                time_warp_rate: None,
            })
    }

    /// Profiling override (see the field). `POST /profile/render` toggles it.
    pub fn set_force_render(&self, on: bool) {
        self.force_render.store(on, Ordering::Release);
    }

    pub fn force_render(&self) -> bool {
        self.force_render.load(Ordering::Acquire)
    }

    /// Per-tick subscription bookkeeping. Normally: a camera that has lost its
    /// last peer-track is flushed `subscribed=false` so the plugin sleeps it.
    /// Under the force-render profiling override, every live camera is instead
    /// kept `subscribed=true` so it renders without a peer. `set_subscribed` is
    /// idempotent (no flush without a transition), so calling this each consume
    /// tick is cheap. Replaces the old free-standing `maybe_sleep_idle_cameras`
    /// so the force-render branch is unit-testable.
    pub async fn refresh_idle_subscriptions(&self, cameras: &[Arc<CameraState>]) {
        let force = self.force_render();
        for cam in cameras {
            if cam.destroyed.load(Ordering::Acquire) {
                continue;
            }
            if force {
                self.set_subscribed(cam.flight_id, true).await;
            } else if cam.subscribers.load(Ordering::Acquire) == 0 {
                self.set_subscribed(cam.flight_id, false).await;
            }
        }
    }

    /// Clear the run-logs ring. The harness fires `POST /dumpLogs/reset`
    /// at the start of each run so it gets a clean window unaffected by
    /// pre-run sidecar warmup.
    pub async fn reset_run_logs(&self) {
        self.status_log.lock().await.clear();
    }

    /// Snapshot of every buffered status entry since the last reset.
    /// The harness fires `GET /dumpLogs` after `[BASELINE-DONE]` and
    /// writes the result alongside the Telemachus / kOS log slices.
    pub async fn dump_run_logs(&self) -> Vec<StatusLogEntry> {
        self.status_log.lock().await.iter().cloned().collect()
    }

    /// Walk `shm_dir`, attach any new `<flight_id>.ring` files, poll
    /// info.json for existing cameras (to catch `lifecycle: "destroyed"`
    /// tombstones written by the plugin), and drop rings that have
    /// disappeared under normal teardown. Tolerant of the directory not
    /// yet existing — the plugin may not have created it.
    ///
    /// Returns the tick's membership churn. `newly_destroyed` drives the
    /// destroyed-camera broadcast + `acknowledge_destruction`; `attached`
    /// and `removed` let the consume loop resync long-lived peers across
    /// a KSP scene change (the sidecar persists for the whole game
    /// session, so a flight exit/re-entry shows up here as every ring
    /// disappearing and then reappearing).
    pub async fn rescan(&self) -> RescanOutcome {
        let mut found: HashMap<u32, PathBuf> = HashMap::new();
        let mut entries = match tokio::fs::read_dir(&self.shm_dir).await {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return RescanOutcome::default(),
            Err(e) => {
                warn!(dir = %self.shm_dir.display(), error = %e, "rescan read_dir failed");
                return RescanOutcome::default();
            }
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("ring") {
                continue;
            }
            let stem = match path.file_stem().and_then(|s| s.to_str()) {
                Some(s) => s,
                None => continue,
            };
            if let Ok(id) = stem.parse::<u32>() {
                found.insert(id, path);
            }
        }

        let mut cameras = self.cameras.write().await;

        // --- Step 1: poll info.json for EXISTING cameras to catch destroyed
        // tombstones BEFORE the ring-disappearance retain runs.
        //
        // Ordering from the protocol doc:
        //   plugin writes `lifecycle: "destroyed"` → closes ring → deletes ring file
        //
        // The ring file is gone by the time we see it. If we checked ring
        // existence first, we'd drop the camera silently without ever reading
        // the tombstone. Re-reading info.json for every known camera at ~1Hz
        // is cheap (6 files, ~200 bytes each).
        let mut newly_destroyed: Vec<u32> = Vec::new();
        // Kerbal cameras whose crew_location flipped this pass — marked dirty
        // after the loop so subscribers get a fresh camera-state-changed.
        let mut crew_relabeled: Vec<u32> = Vec::new();
        for (id, cam) in cameras.iter() {
            if cam.destroyed.load(Ordering::Acquire) {
                // Already flagged — check if broadcast is still pending.
                if !cam.destruction_broadcast_sent.load(Ordering::Acquire) {
                    newly_destroyed.push(*id);
                }
                continue;
            }
            let manifest = read_manifest(&self.shm_dir, *id).await;
            if manifest.lifecycle == CameraLifecycle::Destroyed {
                cam.destroyed.store(true, Ordering::Release);
                warn!(
                    flight_id = id,
                    part_title = %cam.part_title,
                    "camera part destroyed — stopping encode, notifying peers",
                );
                newly_destroyed.push(*id);
                continue;
            }
            // A kerbal's feed reuses one ring across the seat<->EVA switch, so
            // no fresh attach fires; pick up a live crew_location flip from the
            // manifest (the plugin rewrites it on the switch) and update the
            // existing CameraState in place. Scoped to kerbal cameras: part
            // manifests never carry the field, and the manifest read above
            // already happened for destroyed detection, so this adds no extra
            // I/O.
            //
            // Defensive on a partial read: a well-formed kerbal manifest always
            // carries "seat" or "eva", so a parsed None means the re-read caught
            // a mid-write (the plugin's write is not guaranteed atomic). Keep the
            // last good value in that case — never clobber to null — so the
            // operator's label can't flicker blank and back.
            if cam.kind == CameraKind::Kerbal {
                if let Some(next) = crew_location_from_manifest(manifest.crew_location.as_deref()) {
                    if cam.set_crew_location(Some(next)) {
                        info!(
                            flight_id = id,
                            crew_location = ?next,
                            "kerbal crew_location changed — relabeling subscribers",
                        );
                        crew_relabeled.push(*id);
                    }
                }
            }
        }
        // Mark relabeled kerbal cameras dirty (independent lock from the
        // cameras guard held here) so the consume loop pushes a fresh
        // camera-state-changed and browser tiles update seat<->EVA live.
        for id in &crew_relabeled {
            self.mark_camera_dirty(*id).await;
        }

        // --- Step 2: attach new rings (skips destroyed cameras; they have
        // no ring file, so they won't appear in `found`).
        let mut attached: Vec<u32> = Vec::new();
        for (id, path) in &found {
            let found_identity = match tokio::fs::metadata(path).await {
                Ok(meta) => ring_file_identity(&meta),
                Err(_) => 0,
            };
            // A ring that reappears for a flight_id we already hold as a
            // destroyed tombstone means KSP reused that part.flightID for a
            // freshly spawned camera (it recycles ids across revert/recover),
            // so fall through and resurrect it: the insert below replaces the
            // tombstone with a fresh active entry and the attach is announced
            // to peers so their tiles rebind. A live entry with an unchanged
            // ring file identity is left untouched.
            //
            // A live (non-destroyed) entry whose ring identity *has* changed
            // means the plugin deleted and recreated the ring at this path
            // without a destroyed tombstone — e.g. RebuildCameraList tearing
            // down and rebuilding a camera on `onVesselChange` whose part
            // persisted across the switch. Without this check the old mmap
            // stays pointed at the unlinked file and the feed goes stale
            // forever, since nothing else in the registry ever changes to
            // signal a reattach is needed.
            let resurrecting = match cameras.get(id) {
                Some(existing) if existing.destroyed.load(Ordering::Acquire) => true,
                Some(existing) if existing.ring_identity != found_identity => {
                    info!(
                        flight_id = id,
                        "ring file identity changed with no destroyed tombstone — reattaching"
                    );
                    true
                }
                Some(_) => continue,
                None => false,
            };
            match MmapFrameRing::open_self_describing(path) {
                Ok(ring) => {
                    // Each ring self-describes its geometry; a kerbal face ring
                    // (512²) is smaller than a full-tier part-camera ring, so we
                    // take the dims from the ring, not from any global default.
                    let ring_dims = ring.config();
                    let manifest = read_manifest(&self.shm_dir, *id).await;
                    attached.push(*id);
                    info!(
                        flight_id = id,
                        path = %path.display(),
                        max_dims = format!("{}x{}", ring_dims.max_width, ring_dims.max_height),
                        part_title = %manifest.part_title,
                        vessel = %manifest.vessel_name,
                        resurrected = resurrecting,
                        "camera ring attached",
                    );
                    cameras.insert(
                        *id,
                        Arc::new(CameraState {
                            flight_id: *id,
                            ring,
                            ring_identity: found_identity,
                            max_width: ring_dims.max_width,
                            max_height: ring_dims.max_height,
                            kind: camera_kind_from_manifest(&manifest.kind),
                            kerbal_persistent_id: manifest.kerbal_persistent_id,
                            crew_location: std::sync::Mutex::new(crew_location_from_manifest(
                                manifest.crew_location.as_deref(),
                            )),
                            part_name: manifest.part_name,
                            part_title: manifest.part_title,
                            camera_name: manifest.camera_name,
                            vessel_name: manifest.vessel_name,
                            supports_zoom: manifest.supports_zoom,
                            fov_default: manifest.fov,
                            fov_min: manifest.fov_min,
                            fov_max: manifest.fov_max,
                            supports_pan: manifest.supports_pan,
                            pan_yaw_min: manifest.pan_yaw_min,
                            pan_yaw_max: manifest.pan_yaw_max,
                            pan_pitch_min: manifest.pan_pitch_min,
                            pan_pitch_max: manifest.pan_pitch_max,
                            destroyed: AtomicBool::new(false),
                            destruction_broadcast_sent: AtomicBool::new(false),
                            encoder: Mutex::new(None),
                            encoder_width: AtomicU32::new(0),
                            encoder_height: AtomicU32::new(0),
                            encoder_bitrate: AtomicU32::new(0),
                            encode_failure_streak: AtomicU32::new(0),
                            session_health: std::sync::Mutex::new(SessionHealth::new()),
                            target_bitrate_bps: AtomicU32::new(0),
                            bandwidth_estimates: Mutex::new(std::collections::HashMap::new()),
                            effective_degrade: AtomicU32::new(0),
                            track_mode_bits: AtomicU32::new(0),
                            last_track_report_seq: AtomicU32::new(0),
                            last_encoded_at: Mutex::new(None),
                            last_sequence: AtomicU64::new(0),
                            subscribers: AtomicUsize::new(0),
                            ramping: AtomicBool::new(false),
                            keyframe_wanted: AtomicBool::new(false),
                            tracks: RwLock::new(Vec::new()),
                            display_sizes: Mutex::new(std::collections::HashMap::new()),
                            manual_render_cap: Mutex::new(None),
                            forced_full_res: Mutex::new(std::collections::HashSet::new()),
                            control: Mutex::new(ControlState::default()),
                            control_block: std::sync::Mutex::new(None),
                        }),
                    );
                }
                Err(e) => {
                    warn!(flight_id = id, path = %path.display(), error = %e, "failed to open ring");
                }
            }
        }

        // --- Step 3: drop cameras that have disappeared under normal
        // teardown (ring file gone AND not a pending destroyed camera).
        // Destroyed cameras are retained so the UI can display SIGNAL LOST.
        let mut removed = Vec::new();
        cameras.retain(|id, cam| {
            if cam.destroyed.load(Ordering::Acquire) {
                // Destroyed — keep in registry (visible in /cameras as destroyed).
                return true;
            }
            let still = found.contains_key(id);
            if !still {
                removed.push(*id);
            }
            still
        });
        for id in &removed {
            info!(flight_id = id, "camera ring removed (normal teardown)");
        }

        RescanOutcome {
            newly_destroyed,
            attached,
            removed,
        }
    }

    /// Mark the destruction broadcast as sent and delete the info.json
    /// tombstone. Called by the consume loop after broadcasting
    /// `camera-state-changed` for a destroyed camera.
    ///
    /// Deleting the file is our acknowledgment to the plugin that we've
    /// seen the tombstone; the protocol requires this because the plugin
    /// may exit immediately after writing it.
    pub async fn acknowledge_destruction(&self, flight_id: u32) {
        if let Some(cam) = self.cameras.read().await.get(&flight_id) {
            cam.destruction_broadcast_sent
                .store(true, Ordering::Release);
        }
        let path = self.shm_dir.join(format!("{flight_id}.info.json"));
        match tokio::fs::remove_file(&path).await {
            Ok(()) => info!(flight_id, "info.json tombstone deleted"),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // Already deleted (e.g. by a previous sidecar instance).
            }
            Err(e) => {
                warn!(flight_id, error = %e, "failed to delete info.json tombstone");
            }
        }
    }

    pub async fn list(&self) -> Vec<CameraInfo> {
        let cams = self.cameras.read().await;
        let mut out: Vec<_> = cams
            .values()
            .map(|s| CameraInfo {
                flight_id: s.flight_id,
                lifecycle: if s.destroyed.load(Ordering::Acquire) {
                    CameraLifecycle::Destroyed
                } else {
                    CameraLifecycle::Active
                },
                kind: s.kind,
                kerbal_persistent_id: s.kerbal_persistent_id,
                crew_location: s.crew_location(),
                track_mode: s.track_mode(),
                max_width: s.max_width,
                max_height: s.max_height,
                part_name: s.part_name.clone(),
                part_title: s.part_title.clone(),
                camera_name: s.camera_name.clone(),
                vessel_name: s.vessel_name.clone(),
                supports_zoom: s.supports_zoom,
                fov: s.fov_default,
                fov_min: s.fov_min,
                fov_max: s.fov_max,
                supports_pan: s.supports_pan,
                pan_yaw_min: s.pan_yaw_min,
                pan_yaw_max: s.pan_yaw_max,
                pan_pitch_min: s.pan_pitch_min,
                pan_pitch_max: s.pan_pitch_max,
                encoder_bitrate_bps: s.encoder_bitrate.load(Ordering::Acquire),
                target_bitrate_bps: s.target_bitrate_bps.load(Ordering::Acquire),
                degrade_level: s.current_degrade(),
            })
            .collect();
        // Stable ordering for tests + UX (a refresh shouldn't shuffle).
        out.sort_by_key(|c| c.flight_id);
        out
    }

    pub async fn get(&self, flight_id: u32) -> Option<Arc<CameraState>> {
        self.cameras.read().await.get(&flight_id).cloned()
    }

    /// Read `global.status.json` and diff against the cached snapshot.
    /// Returns the set of changes that need broadcasting over the data
    /// channel — per-camera state deltas + adaptive-shed level changes.
    /// Tolerant of the file being absent (plugin hasn't written yet) or
    /// malformed (partial write — atomic rename normally prevents this,
    /// but better to skip a tick than crash).
    pub async fn poll_status(&self) -> StatusDelta {
        let path = self.shm_dir.join("global.status.json");
        let bytes = match tokio::fs::read(&path).await {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return StatusDelta::default(),
            Err(e) => {
                warn!(path = %path.display(), error = %e, "status read failed");
                return StatusDelta::default();
            }
        };
        let parsed: GlobalStatusFile = match serde_json::from_slice(&bytes) {
            Ok(s) => s,
            Err(e) => {
                warn!(error = %e, "status parse failed");
                return StatusDelta::default();
            }
        };

        let mut delta = StatusDelta::default();
        let cameras = self.cameras.read().await;
        let mut last = self.last_status.lock().await;

        // Shed-level changes are global — emit one adaptive-shed
        // message whenever the level moves.
        if last
            .as_ref()
            .map(|s| s.shed_level != parsed.shed_level)
            .unwrap_or(true)
        {
            delta.adaptive_shed = Some((parsed.shed_level, parsed.ksp_fps));
        }

        /* Background capture ceiling moves when the plugin sheds or restores the
        background rung, and every background_capturing camera's requested rate is derived
        from it — so a move has to be pushed back down to the control blocks.
        Reported rather than flushed here because `cameras` is read-locked;
        the consume loop reflushes once the borrow ends. */
        if last
            .as_ref()
            .map(|s| s.background_capture_fps != parsed.background_capture_fps)
            .unwrap_or(parsed.background_capture_fps > 0.0)
        {
            delta.background_ceiling_changed = true;
        }

        /*
         * Global settings are broadcast as one SettingsState whenever any of
         * them moves (or on first poll, when `last` is None). The mission-time
         * capture_ut advances on every ~1Hz plugin write, so in a live scene
         * this is the intended ~1Hz clock heartbeat; when KSP is paused UT
         * holds steady and nothing is emitted.
         */
        let settings_changed = last
            .as_ref()
            .map(|s| {
                s.throttle_main_screen != parsed.throttle_main_screen
                    || s.capture_ut != parsed.capture_ut
                    || s.capture_epoch != parsed.capture_epoch
                    || s.time_warp_rate != parsed.time_warp_rate
            })
            .unwrap_or(true);
        if settings_changed {
            delta.settings = Some(settings_from_status(&parsed));
        }

        // kOS track-mode proposals echoed up the status channel: adopt a
        // camera's reported track_mode when its track_report_seq advances
        // (exactly once per kOS SetTrackMode). Collected here, applied after the
        // guards drop — adopt re-locks the cameras map, so it can't run while
        // this read guard is held. Independent of the render-state diff below (a
        // kOS set need not move render state).
        let mut adopts: Vec<(u32, TrackMode)> = Vec::new();

        // Per-camera diffs. Only flag cameras whose effective state moved.
        for cam_status in &parsed.cameras {
            if let Some(cam) = cameras.get(&cam_status.flight_id) {
                let reported_seq = cam_status.track_report_seq;
                if reported_seq != 0
                    && reported_seq != cam.last_track_report_seq.load(Ordering::Acquire)
                {
                    // Consume this report exactly once (a level-triggered echo
                    // keeps reporting the same seq until the next kOS set).
                    cam.last_track_report_seq
                        .store(reported_seq, Ordering::Release);
                    adopts.push((
                        cam_status.flight_id,
                        track_mode_from_u32(cam_status.track_mode),
                    ));
                }
            }
            let prev = last.as_ref().and_then(|s| {
                s.cameras
                    .iter()
                    .find(|c| c.flight_id == cam_status.flight_id)
            });
            let changed = match prev {
                None => true,
                Some(p) => {
                    p.render_width != cam_status.render_width
                        || p.render_height != cam_status.render_height
                        || p.operator_width != cam_status.operator_width
                        || p.operator_height != cam_status.operator_height
                        || p.layers != cam_status.layers
                        || p.operator_layers != cam_status.operator_layers
                        || (p.fov - cam_status.fov).abs() > 0.01
                        || (p.pan_yaw - cam_status.pan_yaw).abs() > 0.01
                        || (p.pan_pitch - cam_status.pan_pitch).abs() > 0.01
                }
            };
            if !changed {
                continue;
            }
            let Some(cam) = cameras.get(&cam_status.flight_id) else {
                continue;
            };
            let (viewer_quality, background_capturing) = {
                let ctrl = cam.control.lock().await;
                (
                    ctrl.viewer_level.and_then(QualityPreset::from_viewer_level),
                    // "Humming" is simply "we asked this camera for a reduced
                    // rate" — the same fact the plugin was told, so the state we
                    // publish can't drift from the state we commanded.
                    ctrl.capture_fps.is_some(),
                )
            };
            delta.changed_cameras.push(ProtocolCameraState {
                flight_id: cam_status.flight_id,
                lifecycle: if cam.destroyed.load(Ordering::Acquire) {
                    CameraLifecycle::Destroyed
                } else {
                    CameraLifecycle::Active
                },
                kind: cam.kind,
                kerbal_persistent_id: cam.kerbal_persistent_id,
                capture_state: cam.capture_state_with(background_capturing),
                crew_location: cam.crew_location(),
                track_mode: cam.track_mode(),
                part_name: cam.part_name.clone(),
                part_title: cam.part_title.clone(),
                camera_name: cam.camera_name.clone(),
                vessel_name: cam.vessel_name.clone(),
                layers: cam_status.layers.clone(),
                operator_layers: cam_status.operator_layers.clone(),
                render_width: cam_status.render_width,
                render_height: cam_status.render_height,
                operator_width: cam_status.operator_width,
                operator_height: cam_status.operator_height,
                supports_zoom: cam.supports_zoom,
                fov: cam_status.fov,
                fov_min: cam.fov_min,
                fov_max: cam.fov_max,
                supports_pan: cam.supports_pan,
                pan_yaw: cam_status.pan_yaw,
                pan_pitch: cam_status.pan_pitch,
                pan_yaw_min: cam.pan_yaw_min,
                pan_yaw_max: cam.pan_yaw_max,
                pan_pitch_min: cam.pan_pitch_min,
                pan_pitch_max: cam.pan_pitch_max,
                encoder_bitrate_bps: cam.encoder_bitrate.load(Ordering::Acquire),
                target_bitrate_bps: cam.target_bitrate_bps.load(Ordering::Acquire),
                degrade_level: cam.current_degrade(),
                viewer_quality,
                quality_limited_by: quality_limited_reason(
                    cam_status.operator_width,
                    cam_status.render_width,
                    viewer_quality,
                ),
            });
        }

        // Push the snapshot to the run-log ring iff it's actually new
        // (the consume loop polls way faster than the plugin writes).
        // Capped at STATUS_LOG_CAP entries; oldest evicted when full.
        if last.as_ref() != Some(&parsed) {
            let entry = StatusLogEntry {
                t_ms: self.epoch.elapsed().as_millis() as u64,
                status: GlobalStatusFileExport::from(&parsed),
            };
            // VecDeque: pop_front is O(1); a Vec::remove(0) here would
            // shift 12k entries on every append once the cap is hit.
            let mut log = self.status_log.lock().await;
            if log.len() >= STATUS_LOG_CAP {
                log.pop_front();
            }
            log.push_back(entry);
        }

        *last = Some(parsed);

        // Drop the poll locks before adopting: adopt_track_report re-locks the
        // cameras map + the camera's control mutex, which must not nest under
        // the read guard held above.
        drop(last);
        drop(cameras);
        for (flight_id, mode) in adopts {
            self.adopt_track_report(flight_id, mode).await;
        }
        delta
    }

    /// Flush a camera's in-memory `ControlState` into its shared-memory
    /// control block (`<flight_id>.control.bin`), published under a seqlock
    /// the plugin reads each frame. Replaces the old JSON-file-and-rename
    /// path; the block is collision-proof (a monotonic seq, not mtime) so a
    /// rapid rate=0 stop right after a drag can't be missed. The block is
    /// created on first flush and persists for the camera's life so the
    /// seqlock counter keeps advancing. No-op if the camera is gone.
    pub async fn flush_control(&self, flight_id: u32, state: &ControlState) -> std::io::Result<()> {
        let Some(cam) = self.get(flight_id).await else {
            return Ok(());
        };
        let mut guard = cam.control_block.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_none() {
            let path = self.shm_dir.join(format!("{flight_id}.control.bin"));
            *guard = Some(ControlBlock::create(&path)?);
        }
        guard.as_mut().expect("just created if absent").write(state);
        Ok(())
    }

    /*
     * Write global.control.json with the requested throttle state and a
     * monotonic seq. The seq is seeded on first write from the on-disk file
     * so a restarted sidecar doesn't re-issue a seq the plugin has already
     * seen; subsequent calls bump atomically. The plugin acts only when seq
     * increases, so concurrent peer handlers composing cleanly is safe.
     */
    pub async fn write_global_control(&self, throttle_main_screen: bool) -> std::io::Result<()> {
        let path = self.shm_dir.join("global.control.json");

        /* Seed from on-disk seq on first write (compare-and-swap 0 -> seed). */
        if self.global_control_seq.load(Ordering::Acquire) == 0 {
            let seed = match tokio::fs::read(&path).await {
                Ok(b) => serde_json::from_slice::<GlobalControlFile>(&b)
                    .map(|f| f.seq)
                    .unwrap_or(0),
                Err(_) => 0,
            };
            /* Only write if still 0; another concurrent call may have won. */
            let _ = self.global_control_seq.compare_exchange(
                0,
                seed,
                Ordering::AcqRel,
                Ordering::Acquire,
            );
        }

        let seq = self.global_control_seq.fetch_add(1, Ordering::AcqRel) + 1;
        let payload = GlobalControlFile {
            throttle_main_screen,
            seq,
        };
        let json = serde_json::to_string(&payload)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        let tmp = path.with_extension("json.tmp");
        tokio::fs::write(&tmp, json.as_bytes()).await?;
        tokio::fs::rename(&tmp, &path).await?;
        Ok(())
    }

    /// Update the `subscribed` flag in the cam's ControlState and flush
    /// the whole struct to `<flight_id>.control.json`. Called from the
    /// peer subscribe path (true on add_track) and the consume loop's
    /// dead-track pruner (false on last-release). The plugin polls
    /// control.json by mtime, so the next tick after this flush is
    /// when the camera wakes / sleeps.
    pub async fn set_subscribed(&self, flight_id: u32, subscribed: bool) {
        let Some(cam) = self.get(flight_id).await else {
            return;
        };
        let snapshot = {
            let mut ctrl = cam.control.lock().await;
            if ctrl.subscribed == subscribed {
                return; // no transition, no flush
            }
            ctrl.subscribed = subscribed;
            ctrl.clone()
        };
        if let Err(e) = self.flush_control(flight_id, &snapshot).await {
            warn!(flight_id, error = %e, "set_subscribed flush failed");
        }
    }

    /// Zero a camera's persistent pan/zoom rates (the disconnect deadman).
    /// Called from the dead-peer cleanup so a browser that dropped mid-hold
    /// doesn't leave the camera drifting to its travel limit. Writes
    /// `Some(0.0)` (an explicit stop) rather than `None` (which the plugin
    /// reads as "unchanged" and would leave the last non-zero rate running).
    /// Leaves the absolute `pan_yaw`/`fov` untouched so the camera holds its
    /// last framed position. No-op + no flush if all three are already
    /// stopped (`Some(0.0)` or `None`).
    pub async fn zero_rates(&self, flight_id: u32) {
        let Some(cam) = self.get(flight_id).await else {
            return;
        };
        let snapshot = {
            let mut ctrl = cam.control.lock().await;
            let already_stopped = |r: Option<f32>| r.unwrap_or(0.0) == 0.0;
            if already_stopped(ctrl.pan_yaw_rate)
                && already_stopped(ctrl.pan_pitch_rate)
                && already_stopped(ctrl.zoom_rate)
            {
                return; // nothing to stop, no flush
            }
            ctrl.pan_yaw_rate = Some(0.0);
            ctrl.pan_pitch_rate = Some(0.0);
            ctrl.zoom_rate = Some(0.0);
            ctrl.clone()
        };
        if let Err(e) = self.flush_control(flight_id, &snapshot).await {
            warn!(flight_id, error = %e, "zero_rates flush failed");
        }
    }

    /// Snapshot of all camera Arcs — used by the consume loop to iterate
    /// without holding the registry's RwLock while encoding.
    pub async fn snapshot(&self) -> Vec<Arc<CameraState>> {
        self.cameras.read().await.values().cloned().collect()
    }

    /// Apply a viewer's quality request: store the preset (last write
    /// wins across peers; there is one server-wide slot, not one per
    /// subscriber) and flush the mapped viewer level to the plugin's
    /// control block. `None` clears the clamp (auto). The plugin folds
    /// the level into the SAME resolution path the adaptive shed uses,
    /// as min(operator ceiling, shed scale, viewer scale); this method
    /// never touches the adaptive controller's state. Marks the camera
    /// dirty so the consume loop broadcasts the new authoritative state
    /// to every peer. Errors only on an unknown camera.
    pub async fn apply_viewer_quality(
        &self,
        flight_id: u32,
        preset: Option<QualityPreset>,
    ) -> Result<(), String> {
        let Some(cam) = self.get(flight_id).await else {
            return Err(format!("no camera with flight_id={flight_id}"));
        };
        let snapshot = {
            let mut ctrl = cam.control.lock().await;
            ctrl.viewer_level = preset.map(|p| p.viewer_level());
            ctrl.clone()
        };
        if let Err(e) = self.flush_control(flight_id, &snapshot).await {
            warn!(flight_id, error = %e, "viewer quality flush failed");
            return Err(format!("control flush failed: {e}"));
        }
        self.mark_camera_dirty(flight_id).await;
        Ok(())
    }

    /// Apply a browser auto-track request: store the mode (server-authoritative,
    /// last write wins across peers), mirror it to the publish atomic, flush it
    /// to the plugin's control block, and mark the camera dirty so every browser
    /// reflects the new tracking state. The plugin only acts on it for a pan+zoom
    /// camera; `None` stops tracking. A browser track overrides a kOS aim on the
    /// same camera. Errors only on an unknown camera.
    pub async fn apply_track_target(&self, flight_id: u32, mode: TrackMode) -> Result<(), String> {
        if self.get(flight_id).await.is_none() {
            return Err(format!("no camera with flight_id={flight_id}"));
        }
        self.set_track_mode_authoritative(flight_id, mode).await
    }

    /// The single authoritative track_mode write, serialized per camera by the
    /// `cam.control` lock. Sets `ControlState.track_mode`, bumps `track_seq`
    /// (so the plugin applies it on the edge and a later stale flush can't
    /// revert it), mirrors the lock-free publish atom, flushes to the control
    /// block, and marks the camera dirty (every browser reflects it). Called by
    /// BOTH a browser `SetTrackTarget` and the sidecar adopting a kOS report; a
    /// near-simultaneous pair is serialized here (last to take the lock wins the
    /// mode, both sides converge to it). Errors only on a flush failure.
    async fn set_track_mode_authoritative(
        &self,
        flight_id: u32,
        mode: TrackMode,
    ) -> Result<(), String> {
        let Some(cam) = self.get(flight_id).await else {
            return Ok(()); // camera gone this tick — nothing to write
        };
        let snapshot = {
            let mut ctrl = cam.control.lock().await;
            ctrl.track_mode = mode;
            ctrl.track_seq = ctrl.track_seq.wrapping_add(1);
            ctrl.clone()
        };
        // Mirror to the lock-free publish source BEFORE the broadcast so
        // list()/protocol_state read the new value.
        cam.set_track_mode_bits(mode);
        if let Err(e) = self.flush_control(flight_id, &snapshot).await {
            warn!(flight_id, error = %e, "track target flush failed");
            return Err(format!("control flush failed: {e}"));
        }
        self.mark_camera_dirty(flight_id).await;
        Ok(())
    }

    /// Adopt a kOS-originated track_mode PROPOSAL reported up the status channel.
    /// Called from `poll_status` when a camera's `track_report_seq` advances.
    /// Routes through the same authoritative write as a browser set, so the two
    /// converge to whichever the sidecar serializes last. The per-camera
    /// last-consumed report seq (checked in `poll_status`) makes this fire
    /// exactly once per kOS set — no re-adopt loop.
    pub async fn adopt_track_report(&self, flight_id: u32, mode: TrackMode) {
        if let Err(e) = self.set_track_mode_authoritative(flight_id, mode).await {
            warn!(flight_id, error = %e, "adopt kOS track report failed");
        }
    }

    /// Recompute a camera's effective render size (auto MAX-across-consumers ∩
    /// manual cap) and flush it into `ControlState.width/height` → the plugin.
    /// Background-capture CEILING last published by the plugin, in fps. 0 when the
    /// operator forbade it, when the plugin has shed it under load, or when
    /// talking to a plugin too old to report it.
    pub async fn background_ceiling_fps(&self) -> f32 {
        self.last_status
            .lock()
            .await
            .as_ref()
            .map(|s| s.background_capture_fps)
            .unwrap_or(0.0)
    }

    /// Record a consumer's background-capture request. A rate of 0 (or less)
    /// withdraws it. Returns whether the aggregate changed, so callers skip a
    /// redundant reflush.
    pub async fn set_background_request(&self, peer_id: u32, fps: f32) -> bool {
        let before = self.requested_background_fps().await;
        {
            let mut reqs = self.background_requests.lock().await;
            if fps > 0.0 && fps.is_finite() {
                reqs.insert(peer_id, fps);
            } else {
                reqs.remove(&peer_id);
            }
        }
        self.requested_background_fps().await != before
    }

    /// Drop a consumer's request on unsubscribe / disconnect / peer reap.
    /// Returns whether an entry was actually removed. Idempotent.
    ///
    /// Not optional: leaving an entry behind pins background capture on for the rest of
    /// the session with nobody watching, which is the v1.6.3 degrade leak
    /// reproduced exactly.
    pub async fn forget_background_request(&self, peer_id: u32) -> bool {
        self.background_requests
            .lock()
            .await
            .remove(&peer_id)
            .is_some()
    }

    /// Highest background rate any connected consumer is asking for. 0 when
    /// nobody asked — the stock case, which costs nothing.
    pub async fn requested_background_fps(&self) -> f32 {
        self.background_requests
            .lock()
            .await
            .values()
            .copied()
            .fold(0.0f32, f32::max)
    }

    /// Background rate actually in force: what consumers asked for, bounded by
    /// what the plugin permits. Both terms must be non-zero — a request with no
    /// operator headroom, or headroom nobody asked for, means no background capture.
    pub async fn effective_background_fps(&self) -> f32 {
        let requested = self.requested_background_fps().await;
        if requested <= 0.0 {
            return 0.0;
        }
        requested.min(self.background_ceiling_fps().await)
    }

    /// Push a recomputed capture rate to every camera. Needed whenever the
    /// AGGREGATE moves rather than one camera's demand: a consumer changing or
    /// withdrawing its background request, a consumer disconnecting, or the plugin
    /// shedding its ceiling. Reuses the render-size flush because that path
    /// already recomputes and writes the whole control block.
    pub async fn reflush_all_capture_rates(&self) {
        let ids: Vec<u32> = self.cameras.read().await.keys().copied().collect();
        for flight_id in ids {
            if let Err(e) = self.flush_effective_render_size(flight_id).await {
                tracing::warn!(flight_id, error = %e, "capture-rate reflush failed");
            }
        }
    }

    /// Called after any display-size report, forget, or manual-cap change. The
    /// plugin's adaptive-shed min() still rides underneath on the game side.
    pub async fn flush_effective_render_size(&self, flight_id: u32) -> std::io::Result<()> {
        let Some(cam) = self.get(flight_id).await else {
            return Ok(()); // camera gone this tick — nothing to flush
        };
        let eff = cam.effective_render_size().await;
        /* Demand drives the capture RATE as well as the size: a subscribed
        camera nobody is displaying runs background capture instead of running at full rate.
        Recomputed here because this is exactly the path every display-size
        change already flows through. */
        let fps = cam
            .requested_capture_fps(self.effective_background_fps().await)
            .await;
        /* Promotion: this camera was in background capture and is now being displayed. Force
        an IDR, because background capture stream's periodic keyframe is counted in encoded
        frames (fps * 2), so at 1fps the next natural one can be ~60 seconds
        away — the feed would stay unrenderable long past the point the
        operator expects it. */
        {
            let was_background = cam.control.lock().await.capture_fps.is_some();
            if was_background && fps.is_none() {
                cam.begin_ramp();
            }
        }
        let snapshot = {
            let mut ctrl = cam.control.lock().await;
            let (w, h) = match eff {
                Some((w, h)) => (Some(w), Some(h)),
                None => (None, None),
            };
            ctrl.width = w;
            ctrl.height = h;
            ctrl.capture_fps = fps;
            ctrl.clone()
        };
        self.flush_control(flight_id, &snapshot).await?;
        self.mark_camera_dirty(flight_id).await;
        Ok(())
    }

    /// A consumer reported its display size for a camera: record it (keyed by
    /// `peer_id`) and reflush the effective size. See `ReportDisplaySize`.
    pub async fn record_display_size(&self, flight_id: u32, peer_id: u32, width: u32, height: u32) {
        match self.get(flight_id).await {
            Some(cam) => cam.record_display_size(peer_id, width, height).await,
            None => return,
        }
        if let Err(e) = self.flush_effective_render_size(flight_id).await {
            warn!(flight_id, error = %e, "display-size record flush failed");
        }
    }

    /// A consumer stopped displaying ONE camera (explicit unsubscribe /
    /// rebind-away): forget its display size for that camera and reflush so the
    /// MAX relaxes. Idempotent; skips the reflush when nothing was held.
    pub async fn forget_display_size(&self, flight_id: u32, peer_id: u32) {
        let removed = match self.get(flight_id).await {
            Some(cam) => cam.forget_display_size(peer_id).await,
            None => return,
        };
        if removed {
            if let Err(e) = self.flush_effective_render_size(flight_id).await {
                warn!(flight_id, error = %e, "display-size forget flush failed");
            }
        }
    }

    /// Forget a peer's reported display size across EVERY camera, reflushing the
    /// ones that held the key. The report (ReportDisplaySize) is NOT
    /// binding-gated — a consumer can report a size for a camera it never bound
    /// a slot to — so the clear must be PEER-scoped, not binding-scoped. A
    /// binding-scoped clear would leave such an entry pinning the effective size
    /// high forever (the v1.6.3 pin-high leak class). Called on graceful
    /// Disconnect and in the dead-peer reaper.
    pub async fn forget_display_size_all(&self, peer_id: u32) {
        let flight_ids: Vec<u32> = self.cameras.read().await.keys().copied().collect();
        for flight_id in flight_ids {
            let removed = match self.get(flight_id).await {
                Some(cam) => cam.forget_display_size(peer_id).await,
                None => continue,
            };
            if removed {
                if let Err(e) = self.flush_effective_render_size(flight_id).await {
                    warn!(flight_id, error = %e, "display-size forget-all flush failed");
                }
            }
        }
    }

    /// A peer forced (or released) this camera to the ring ceiling: record it
    /// (keyed by `peer_id`) and reflush the effective size. See
    /// `SetForceFullResolution`.
    pub async fn set_forced_full_res(&self, flight_id: u32, peer_id: u32, force: bool) {
        match self.get(flight_id).await {
            Some(cam) => cam.set_forced(peer_id, force).await,
            None => return,
        }
        if let Err(e) = self.flush_effective_render_size(flight_id).await {
            warn!(flight_id, error = %e, "force-full-res flush failed");
        }
    }

    /// A consumer stopped displaying ONE camera (explicit unsubscribe /
    /// rebind-away): forget its force for that camera and reflush so the
    /// ceiling relaxes if it was the last peer forcing it. Mirrors
    /// `forget_display_size`. Idempotent; skips the reflush when nothing was
    /// held.
    pub async fn forget_forced(&self, flight_id: u32, peer_id: u32) {
        let removed = match self.get(flight_id).await {
            Some(cam) => cam.forget_forced(peer_id).await,
            None => return,
        };
        if removed {
            if let Err(e) = self.flush_effective_render_size(flight_id).await {
                warn!(flight_id, error = %e, "force-full-res forget flush failed");
            }
        }
    }

    /// Forget a peer's force across EVERY camera, reflushing the ones that
    /// held the key. Peer-scoped for the same reason as
    /// `forget_display_size_all`: a force can exist for a camera the peer
    /// never bound a slot to, so a binding-scoped clear would leak it forever.
    /// Called on graceful Disconnect and in the dead-peer reaper.
    pub async fn forget_forced_all(&self, peer_id: u32) {
        let flight_ids: Vec<u32> = self.cameras.read().await.keys().copied().collect();
        for flight_id in flight_ids {
            let removed = match self.get(flight_id).await {
                Some(cam) => cam.forget_forced(peer_id).await,
                None => continue,
            };
            if removed {
                if let Err(e) = self.flush_effective_render_size(flight_id).await {
                    warn!(flight_id, error = %e, "force-full-res forget-all flush failed");
                }
            }
        }
    }

    /// Operator `SetRenderSize`: set (or clear) the manual cap and reflush the
    /// effective size (min(auto, cap)).
    pub async fn set_manual_render_size(
        &self,
        flight_id: u32,
        cap: Option<(u32, u32)>,
    ) -> std::io::Result<()> {
        match self.get(flight_id).await {
            Some(cam) => cam.set_manual_render_cap(cap).await,
            None => return Ok(()),
        }
        self.flush_effective_render_size(flight_id).await
    }

    /// Flag a camera for a state broadcast on the consume loop's next tick.
    pub async fn mark_camera_dirty(&self, flight_id: u32) {
        self.dirty_cameras.lock().await.insert(flight_id);
    }

    /// Drain the dirty set (cameras needing a state broadcast to all peers).
    pub async fn take_dirty_cameras(&self) -> Vec<u32> {
        let mut dirty = self.dirty_cameras.lock().await;
        dirty.drain().collect()
    }

    /// Authoritative protocol-shape snapshot of one camera, merging the
    /// last plugin-reported effective state (render dims, layers, fov,
    /// pan, when the status file has been seen) with the sidecar-owned
    /// control state (viewer quality preset). Used for every
    /// `camera-state-changed` push so each consumer sees the same view.
    /// Falls back to optimistic defaults (effective == requested) before
    /// the first status write, exactly like the Hello snapshot always did.
    pub async fn protocol_state(&self, flight_id: u32) -> Option<ProtocolCameraState> {
        let cam = self.get(flight_id).await?;
        let ctrl = cam.control.lock().await.clone();
        let per = {
            let status = self.last_status.lock().await;
            status
                .as_ref()
                .and_then(|s| s.cameras.iter().find(|c| c.flight_id == flight_id).cloned())
        };

        let all_layers = || vec![Layer::Near, Layer::Scaled, Layer::Galaxy];
        let fallback_layers = if ctrl.layers.is_empty() {
            all_layers()
        } else {
            ctrl.layers.clone()
        };
        let (layers, operator_layers) = match &per {
            Some(p) => (p.layers.clone(), p.operator_layers.clone()),
            None => (fallback_layers.clone(), fallback_layers),
        };
        let operator_width = per
            .as_ref()
            .map(|p| p.operator_width)
            .unwrap_or_else(|| ctrl.width.unwrap_or(cam.max_width));
        let operator_height = per
            .as_ref()
            .map(|p| p.operator_height)
            .unwrap_or_else(|| ctrl.height.unwrap_or(cam.max_height));
        let render_width = per
            .as_ref()
            .map(|p| p.render_width)
            .unwrap_or(operator_width);
        let render_height = per
            .as_ref()
            .map(|p| p.render_height)
            .unwrap_or(operator_height);
        let fov = per
            .as_ref()
            .map(|p| p.fov)
            .filter(|f| *f != 0.0)
            .unwrap_or_else(|| ctrl.fov.unwrap_or(cam.fov_default));
        let pan_yaw = per
            .as_ref()
            .map(|p| p.pan_yaw)
            .unwrap_or_else(|| ctrl.pan_yaw.unwrap_or(0.0));
        let pan_pitch = per
            .as_ref()
            .map(|p| p.pan_pitch)
            .unwrap_or_else(|| ctrl.pan_pitch.unwrap_or(0.0));

        let viewer_quality = ctrl.viewer_level.and_then(QualityPreset::from_viewer_level);
        let background_capturing = ctrl.capture_fps.is_some();
        let quality_limited_by =
            quality_limited_reason(operator_width, render_width, viewer_quality);

        Some(ProtocolCameraState {
            flight_id,
            lifecycle: if cam.destroyed.load(Ordering::Acquire) {
                CameraLifecycle::Destroyed
            } else {
                CameraLifecycle::Active
            },
            kind: cam.kind,
            kerbal_persistent_id: cam.kerbal_persistent_id,
            capture_state: cam.capture_state_with(background_capturing),
            crew_location: cam.crew_location(),
            track_mode: cam.track_mode(),
            part_name: cam.part_name.clone(),
            part_title: cam.part_title.clone(),
            camera_name: cam.camera_name.clone(),
            vessel_name: cam.vessel_name.clone(),
            layers,
            operator_layers,
            render_width,
            render_height,
            operator_width,
            operator_height,
            supports_zoom: cam.supports_zoom,
            fov,
            fov_min: cam.fov_min,
            fov_max: cam.fov_max,
            supports_pan: cam.supports_pan,
            pan_yaw,
            pan_pitch,
            pan_yaw_min: cam.pan_yaw_min,
            pan_yaw_max: cam.pan_yaw_max,
            pan_pitch_min: cam.pan_pitch_min,
            pan_pitch_max: cam.pan_pitch_max,
            encoder_bitrate_bps: cam.encoder_bitrate.load(Ordering::Acquire),
            target_bitrate_bps: cam.target_bitrate_bps.load(Ordering::Acquire),
            degrade_level: cam.current_degrade(),
            viewer_quality,
            quality_limited_by,
        })
    }
}

/// Why the effective resolution differs from the viewer's request, if it
/// does. Expected width = the operator ceiling scaled by the viewer's
/// preset (1.0 when auto), floored to even exactly like the plugin's
/// `QualityClamp` does. Anything below that means the adaptive perf
/// machinery is holding the camera down: report `"throttled"` so UIs can
/// mark the feed. The viewer request itself can never push the effective
/// size ABOVE the expectation, so render > expected is impossible by
/// construction (and treated as "not limited" if it ever shows up).
pub fn quality_limited_reason(
    operator_width: u32,
    render_width: u32,
    viewer_quality: Option<QualityPreset>,
) -> Option<String> {
    let scale = viewer_quality.map(|p| p.scale()).unwrap_or(1.0);
    let expected = (((operator_width as f32) * scale) as u32 & !1).max(2);
    if render_width < expected {
        Some("throttled".to_string())
    } else {
        None
    }
}

/// Read the plugin's `<flight_id>.info.json` next to the ring file.
/// Returns a manifest with empty fields if missing or unparseable —
/// callers fall back to "(no label)" displays. Logging the parse
/// error makes a malformed manifest discoverable without crashing.
async fn read_manifest(shm_dir: &std::path::Path, flight_id: u32) -> InfoManifest {
    let path = shm_dir.join(format!("{flight_id}.info.json"));
    let empty = InfoManifest {
        flight_id,
        lifecycle: CameraLifecycle::Active,
        part_name: String::new(),
        part_title: String::new(),
        camera_name: String::new(),
        vessel_name: String::new(),
        supports_zoom: false,
        fov: 0.0,
        fov_min: 0.0,
        fov_max: 0.0,
        supports_pan: false,
        pan_yaw_min: 0.0,
        pan_yaw_max: 0.0,
        pan_pitch_min: 0.0,
        pan_pitch_max: 0.0,
        kind: String::new(),
        kerbal_persistent_id: None,
        crew_location: None,
    };
    let bytes = match tokio::fs::read(&path).await {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return empty,
        Err(e) => {
            warn!(flight_id, path = %path.display(), error = %e, "info manifest read failed");
            return empty;
        }
    };
    match serde_json::from_slice::<InfoManifest>(&bytes) {
        Ok(m) => m,
        Err(e) => {
            warn!(flight_id, path = %path.display(), error = %e, "info manifest parse failed");
            empty
        }
    }
}

/// Manifest `kind` string -> protocol enum. Empty/unrecognised (existing
/// part cameras predate this field) maps to `Part`.
fn camera_kind_from_manifest(kind: &str) -> CameraKind {
    match kind {
        "kerbal" => CameraKind::Kerbal,
        _ => CameraKind::Part,
    }
}

/// Manifest `crew_location` string -> protocol enum. Absent/unrecognised
/// maps to `None` (part cameras never set this field).
fn crew_location_from_manifest(location: Option<&str>) -> Option<CrewLocation> {
    match location {
        Some("seat") => Some(CrewLocation::Seat),
        Some("eva") => Some(CrewLocation::Eva),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared_mem::MmapRingConfig;

    #[test]
    fn parse_in_flight_reads_one_zero() {
        assert_eq!(parse_in_flight("1"), Some(true));
        assert_eq!(parse_in_flight("0\n"), Some(false));
        assert_eq!(parse_in_flight(""), None);
        assert_eq!(parse_in_flight("true"), None);
    }

    #[tokio::test]
    async fn poll_in_flight_fires_only_on_change() {
        let dir = tempfile::tempdir().expect("tempdir");
        let shm = dir.path();
        let reg = CameraRegistry::new(shm.to_path_buf());
        let path = shm.join(INFLIGHT_FILE);

        // No file yet => None, no change from the initial None cache.
        assert_eq!(reg.poll_in_flight().await, None);

        tokio::fs::write(&path, "1").await.unwrap();
        assert_eq!(reg.poll_in_flight().await, Some(true));
        // Same value re-read => no broadcast.
        assert_eq!(reg.poll_in_flight().await, None);

        tokio::fs::write(&path, "0").await.unwrap();
        assert_eq!(reg.poll_in_flight().await, Some(false));
    }

    /// A status write whose `captureUt` advanced produces a `settings`
    /// delta carrying the mission-time clock; an identical re-poll produces
    /// no settings (the ~1Hz heartbeat only fires when the clock moves).
    #[tokio::test]
    async fn poll_status_emits_capture_clock_on_change() {
        let dir = tempfile::tempdir().expect("tempdir");
        let shm = dir.path();
        let registry = CameraRegistry::new(shm.to_path_buf());
        let status_path = shm.join("global.status.json");

        let write = |ut: f64| {
            std::fs::write(
                &status_path,
                format!(
                    r#"{{"kspFps":60.0,"shedLevel":0,"cameras":[],"throttleMainScreen":false,"captureUt":{ut},"captureEpoch":3,"timeWarpRate":4.0}}"#
                ),
            )
            .unwrap();
        };

        write(1000.0);
        let delta = registry.poll_status().await;
        let settings = delta.settings.expect("first poll emits settings");
        assert_eq!(settings.capture_ut, Some(1000.0));
        assert_eq!(settings.capture_epoch, Some(3));
        assert_eq!(settings.time_warp_rate, Some(4.0));

        /* Identical re-poll: nothing moved, so no settings. */
        let delta = registry.poll_status().await;
        assert!(
            delta.settings.is_none(),
            "unchanged status emits no settings"
        );

        /* UT advances: settings fire again with the new clock. */
        write(1004.0);
        let delta = registry.poll_status().await;
        assert_eq!(
            delta
                .settings
                .expect("advanced UT emits settings")
                .capture_ut,
            Some(1004.0)
        );
    }

    /// The linked track_mode contract: a kOS proposal echoed up the status
    /// channel is adopted into the authoritative ControlState (UP convergence);
    /// the same report is consumed exactly once (no re-adopt loop); a browser
    /// set supersedes and a STALE kOS echo can't revert it (no oscillation); a
    /// genuinely NEW kOS report is adopted (last-setter wins the mode).
    #[tokio::test]
    async fn poll_status_adopts_kos_track_report_with_no_oscillation() {
        let dir = tempfile::tempdir().expect("tempdir");
        let shm = dir.path();
        let flight_id: u32 = 5_001;
        let cfg = MmapRingConfig {
            slot_count: 4,
            max_width: 64,
            max_height: 64,
        };
        MmapFrameRing::create(&shm.join(format!("{flight_id}.ring")), cfg).expect("ring");
        let registry = CameraRegistry::new(shm.to_path_buf());
        registry.rescan().await;
        let status_path = shm.join("global.status.json");
        let cam = registry.get(flight_id).await.expect("attached");

        let write = |track_mode: u32, seq: u32| {
            std::fs::write(
                &status_path,
                format!(
                    r#"{{"kspFps":60.0,"shedLevel":0,"throttleMainScreen":false,"cameras":[{{"flightId":{flight_id},"renderWidth":64,"renderHeight":64,"operatorWidth":64,"operatorHeight":64,"trackMode":{track_mode},"trackReportSeq":{seq}}}]}}"#
                ),
            )
            .unwrap();
        };

        // No report yet (seq 0): not tracking.
        write(0, 0);
        registry.poll_status().await;
        assert_eq!(cam.track_mode(), TrackMode::None);

        // kOS reports active-vessel (seq 1): adopted, published, track_seq bumped.
        write(1, 1);
        registry.poll_status().await;
        assert_eq!(
            cam.track_mode(),
            TrackMode::ActiveVessel,
            "kOS report adopted"
        );
        let seq_after_adopt = cam.control.lock().await.track_seq;
        assert!(
            seq_after_adopt >= 1,
            "adopt bumps track_seq (plugin edge-trigger)"
        );

        // Same report re-polled: consumed once, no re-adopt, no extra bump.
        write(1, 1);
        registry.poll_status().await;
        assert_eq!(
            cam.control.lock().await.track_seq,
            seq_after_adopt,
            "an already-consumed report must not re-adopt"
        );

        // Browser set: authoritative, supersedes.
        registry
            .apply_track_target(flight_id, TrackMode::Target)
            .await
            .unwrap();
        assert_eq!(cam.track_mode(), TrackMode::Target);

        // The plugin keeps echoing the STALE kOS report (seq 1) until its next
        // kOS set; re-polling must NOT revert the browser's Target. No oscillation.
        write(1, 1);
        registry.poll_status().await;
        assert_eq!(
            cam.track_mode(),
            TrackMode::Target,
            "a stale kOS echo must not revert a browser set"
        );

        // A genuinely NEW kOS report (seq 2) IS adopted (last-setter wins).
        write(1, 2);
        registry.poll_status().await;
        assert_eq!(
            cam.track_mode(),
            TrackMode::ActiveVessel,
            "a new kOS report is adopted after the browser set"
        );
    }

    /// `read_manifest` returns `Destroyed` when info.json has
    /// `lifecycle: "destroyed"` — the tombstone the plugin writes on part
    /// destruction. This is the primitive the rescan detection loop calls
    /// on every existing camera at ~1Hz.
    #[tokio::test]
    async fn read_manifest_detects_destroyed_lifecycle() {
        let dir = tempfile::tempdir().expect("tempdir");
        let shm = dir.path();
        let flight_id: u32 = 9_001;

        let content = format!(
            r#"{{"lifecycle":"destroyed","flight_id":{flight_id},"part_name":"testPart","part_title":"Test Camera","camera_name":"Cam 1","vessel_name":"Kerbal X","supports_zoom":false,"fov":60.0,"fov_min":10.0,"fov_max":90.0,"supports_pan":false,"pan_yaw_min":0.0,"pan_yaw_max":0.0,"pan_pitch_min":0.0,"pan_pitch_max":0.0}}"#,
        );
        tokio::fs::write(shm.join(format!("{flight_id}.info.json")), content)
            .await
            .unwrap();

        let manifest = read_manifest(shm, flight_id).await;
        assert_eq!(
            manifest.lifecycle,
            CameraLifecycle::Destroyed,
            "read_manifest should return Destroyed when info.json has lifecycle=destroyed"
        );
    }

    /// Missing info.json (normal teardown — plugin deletes it entirely)
    /// defaults to `Active`. The sidecar then drops the camera silently
    /// via the ring-disappearance retain path; no broadcast needed.
    #[tokio::test]
    async fn read_manifest_missing_defaults_to_active() {
        let dir = tempfile::tempdir().expect("tempdir");
        let shm = dir.path();
        // No file written.
        let manifest = read_manifest(shm, 9_002).await;
        assert_eq!(
            manifest.lifecycle,
            CameraLifecycle::Active,
            "missing info.json should default to Active (normal teardown path)"
        );
    }

    /// Unknown / future lifecycle values that serde can't map to a known
    /// variant cause a parse error. The error path returns the `empty`
    /// manifest (lifecycle = Active) for forward compatibility.
    #[tokio::test]
    async fn unknown_lifecycle_defaults_to_active() {
        let dir = tempfile::tempdir().expect("tempdir");
        let shm = dir.path();
        let flight_id: u32 = 9_003;

        let content = format!(
            r#"{{"lifecycle":"future-unknown-value","flight_id":{flight_id},"part_name":"","part_title":"","camera_name":"","vessel_name":"","supports_zoom":false,"fov":0.0,"fov_min":0.0,"fov_max":0.0,"supports_pan":false,"pan_yaw_min":0.0,"pan_yaw_max":0.0,"pan_pitch_min":0.0,"pan_pitch_max":0.0}}"#,
        );
        tokio::fs::write(shm.join(format!("{flight_id}.info.json")), content)
            .await
            .unwrap();

        let manifest = read_manifest(shm, flight_id).await;
        assert_eq!(
            manifest.lifecycle,
            CameraLifecycle::Active,
            "unknown lifecycle in info.json should be treated as Active"
        );
    }

    /// Helper: attach one camera with a large max so display reports up to
    /// 512 fit without the max-dim clamp, and hand back the live CameraState.
    /// Keeps the TempDir alive for the caller's lifetime.
    async fn attach_camera_for_tracker(flight_id: u32) -> (tempfile::TempDir, Arc<CameraState>) {
        let dir = tempfile::tempdir().expect("tempdir");
        let shm = dir.path();
        let cfg = MmapRingConfig {
            slot_count: 4,
            max_width: 1024,
            max_height: 1024,
        };
        MmapFrameRing::create(&shm.join(format!("{flight_id}.ring")), cfg).expect("create ring");
        let registry = CameraRegistry::new(shm.to_path_buf());
        registry.rescan().await;
        let cam = registry.get(flight_id).await.expect("camera attached");
        (dir, cam)
    }

    /// Auto-resolution aggregates each consumer's reported display size as the
    /// per-dimension MAX across live consumers (meet-the-minimum-need).
    #[tokio::test]
    async fn display_size_tracker_takes_max_across_consumers() {
        let (_dir, cam) = attach_camera_for_tracker(7_001).await;
        cam.record_display_size(1, 40, 40).await;
        cam.record_display_size(2, 512, 512).await;
        assert_eq!(cam.effective_render_size().await, Some((512, 512)));
    }

    /// THE clear-on-departure regression guard (the v1.6.3 leak was a missed
    /// clear): forgetting the large consumer must RELAX the effective size back
    /// down, not leave it pinned high.
    #[tokio::test]
    async fn display_size_relaxes_when_large_consumer_departs() {
        let (_dir, cam) = attach_camera_for_tracker(7_002).await;
        cam.record_display_size(1, 40, 40).await;
        cam.record_display_size(2, 512, 512).await;
        assert_eq!(cam.effective_render_size().await, Some((512, 512)));

        cam.forget_display_size(2).await;
        assert_eq!(
            cam.effective_render_size().await,
            Some((40, 40)),
            "effective size must relax after the large consumer departs (clear-on-departure)"
        );

        // Last consumer gone -> no auto demand at all.
        cam.forget_display_size(1).await;
        assert_eq!(cam.effective_render_size().await, None);
    }

    /// CRITICAL clear-on-departure guard for the UNBOUND path: a consumer can
    /// report a display size for a camera it never bound a slot to (the report
    /// is not binding-gated), so the clear MUST be peer-scoped, not
    /// binding-scoped — otherwise that entry pins the effective size high
    /// forever (the v1.6.3 leak class). `forget_display_size_all(peer)` sweeps
    /// EVERY camera holding the peer's key.
    #[tokio::test]
    async fn forget_display_size_all_sweeps_every_camera_for_the_peer() {
        let dir = tempfile::tempdir().expect("tempdir");
        let shm = dir.path();
        let cfg = MmapRingConfig {
            slot_count: 4,
            max_width: 1024,
            max_height: 1024,
        };
        for id in [7_101u32, 7_102u32] {
            MmapFrameRing::create(&shm.join(format!("{id}.ring")), cfg).expect("create ring");
        }
        let registry = CameraRegistry::new(shm.to_path_buf());
        registry.rescan().await;
        let cam_a = registry.get(7_101).await.expect("cam a");
        let cam_b = registry.get(7_102).await.expect("cam b");

        // Peer 1 reported a size on BOTH cameras (as if via the data channel);
        // neither is necessarily a bound slot.
        cam_a.record_display_size(1, 512, 512).await;
        cam_b.record_display_size(1, 256, 256).await;
        assert_eq!(cam_a.effective_render_size().await, Some((512, 512)));
        assert_eq!(cam_b.effective_render_size().await, Some((256, 256)));

        // Peer 1 departs — the peer-scoped sweep must clear it everywhere.
        registry.forget_display_size_all(1).await;
        assert_eq!(
            cam_a.effective_render_size().await,
            None,
            "unbound-camera report must be cleared by the peer sweep (no pin-high leak)"
        );
        assert_eq!(cam_b.effective_render_size().await, None);
    }

    /// A degenerate 0x0 (or sub-2) report — a display:none / not-yet-laid-out
    /// tile reporting offsetWidth 0 — is NO DEMAND, not a real 0x0 render
    /// target. As the sole consumer it must resolve to None (plugin default),
    /// never Some((0,0)).
    #[tokio::test]
    async fn zero_size_report_is_no_demand() {
        let (_dir, cam) = attach_camera_for_tracker(7_004).await;
        cam.record_display_size(1, 0, 0).await;
        assert_eq!(cam.effective_render_size().await, None);

        // A prior real size followed by a 0x0 report relaxes back to no demand.
        cam.record_display_size(1, 512, 512).await;
        assert_eq!(cam.effective_render_size().await, Some((512, 512)));
        cam.record_display_size(1, 0, 0).await;
        assert_eq!(cam.effective_render_size().await, None);
    }

    /// With background capture disabled (ceiling 0 — the default, and what an older plugin
    /// reports) NO camera is ever asked for a reduced rate, displayed or not.
    /// This is the "default changes nothing" guarantee.
    #[tokio::test]
    async fn background_disabled_never_requests_a_reduced_rate() {
        let (_dir, cam) = attach_camera_for_tracker(7_101).await;
        assert_eq!(cam.requested_capture_fps(0.0).await, None, "undisplayed");
        cam.record_display_size(1, 512, 512).await;
        assert_eq!(cam.requested_capture_fps(0.0).await, None, "displayed");
    }

    /// Background capture's discriminator is DISPLAY DEMAND, not subscription: a
    /// subscribed camera nobody is showing runs background capture, and showing it promotes it
    /// back to the primary rate.
    #[tokio::test]
    async fn undisplayed_camera_runs_background_and_promotes_on_demand() {
        let (_dir, cam) = attach_camera_for_tracker(7_102).await;

        assert_eq!(
            cam.requested_capture_fps(2.0).await,
            Some(2.0),
            "nothing displaying it -> background capture at the ceiling"
        );

        cam.record_display_size(1, 640, 360).await;
        assert_eq!(
            cam.requested_capture_fps(2.0).await,
            None,
            "displayed -> primary rate"
        );

        cam.record_display_size(1, 0, 0).await;
        assert_eq!(
            cam.requested_capture_fps(2.0).await,
            Some(2.0),
            "display gone -> back to background capture"
        );
    }

    /// A forced feed (e.g. a full-resolution recording) has no visible tile but
    /// must NOT be background-captured — it is genuinely being consumed.
    #[tokio::test]
    async fn forced_feed_counts_as_displayed() {
        let (_dir, cam) = attach_camera_for_tracker(7_103).await;
        assert_eq!(cam.requested_capture_fps(2.0).await, Some(2.0));
        cam.set_forced(1, true).await;
        assert_eq!(
            cam.requested_capture_fps(2.0).await,
            None,
            "a forced feed is being consumed, so it runs at the primary rate"
        );
        cam.set_forced(1, false).await;
        assert_eq!(cam.requested_capture_fps(2.0).await, Some(2.0));
    }

    /// Published state: Off when nobody subscribes, Hum when capturing in the background, Ramping
    /// between promotion and the keyframe, Full once renderable.
    #[tokio::test]
    async fn capture_state_reports_the_promotion_sequence() {
        let (_dir, cam) = attach_camera_for_tracker(7_104).await;

        assert_eq!(
            cam.capture_state_with(false),
            CaptureState::Off,
            "no subscribers -> Off, whatever else is true"
        );

        use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
        let track = Arc::new(TrackLocalStaticSample::new(
            RTCRtpCodecCapability {
                mime_type: "video/H264".to_owned(),
                ..Default::default()
            },
            "video".to_owned(),
            "kerbcast-7104".to_owned(),
        ));
        cam.add_track(track).await;

        assert_eq!(cam.capture_state_with(true), CaptureState::Background);
        assert_eq!(cam.capture_state_with(false), CaptureState::Full);

        // Promotion: renderable only once a keyframe has actually gone out, so
        // the state stays honest instead of claiming Full while undecodable.
        cam.begin_ramp();
        assert_eq!(cam.capture_state_with(false), CaptureState::Ramping);
        assert!(cam.take_keyframe_request(), "promotion asks for an IDR");
        assert!(
            !cam.take_keyframe_request(),
            "the request is consumed, not re-armed every encode"
        );
        assert_eq!(
            cam.capture_state_with(false),
            CaptureState::Ramping,
            "still ramping until the keyframe is actually emitted"
        );
        cam.finish_ramp();
        assert_eq!(cam.capture_state_with(false), CaptureState::Full);
    }

    /// Nobody asking = no background capture, whatever headroom the operator permits. This is
    /// what lets one install serve a plain viewer and background capture-wanting consumer
    /// with no configuration on either side.
    #[tokio::test]
    async fn no_request_means_no_background_however_generous_the_ceiling() {
        let dir = tempfile::tempdir().expect("tempdir");
        let reg = CameraRegistry::new(dir.path().to_path_buf());
        assert_eq!(reg.requested_background_fps().await, 0.0);
        assert_eq!(
            reg.effective_background_fps().await,
            0.0,
            "no consumer asked, so nothing runs background capture"
        );
    }

    /// MAX across consumers, and the operator ceiling caps the result.
    #[tokio::test]
    async fn background_requests_aggregate_by_max_and_clamp_to_the_ceiling() {
        let dir = tempfile::tempdir().expect("tempdir");
        let reg = CameraRegistry::new(dir.path().to_path_buf());

        assert!(
            reg.set_background_request(1, 1.0).await,
            "first request changes it"
        );
        assert!(
            reg.set_background_request(2, 4.0).await,
            "a higher request wins"
        );
        assert_eq!(reg.requested_background_fps().await, 4.0);

        assert!(
            !reg.set_background_request(3, 2.0).await,
            "a lower request doesn't move the max"
        );
        assert_eq!(reg.requested_background_fps().await, 4.0);

        // Ceiling unset (no plugin status yet) means no headroom, so nothing
        // runs background capture no matter how loudly consumers ask.
        assert_eq!(reg.background_ceiling_fps().await, 0.0);
        assert_eq!(reg.effective_background_fps().await, 0.0);
    }

    /// Zero withdraws a request rather than pinning it at zero.
    #[tokio::test]
    async fn zero_withdraws_a_background_request() {
        let dir = tempfile::tempdir().expect("tempdir");
        let reg = CameraRegistry::new(dir.path().to_path_buf());
        reg.set_background_request(1, 3.0).await;
        assert_eq!(reg.requested_background_fps().await, 3.0);
        assert!(reg.set_background_request(1, 0.0).await, "0 withdraws");
        assert_eq!(reg.requested_background_fps().await, 0.0);
    }

    /// The v1.6.3 pin-high class, guarded directly: a departed consumer must
    /// not leave background capture running for the rest of the session. That
    /// bug shipped once already because a per-peer max was never cleared on
    /// teardown, and only a KSP restart recovered it.
    #[tokio::test]
    async fn a_departed_consumer_cannot_pin_background_on() {
        let dir = tempfile::tempdir().expect("tempdir");
        let reg = CameraRegistry::new(dir.path().to_path_buf());

        reg.set_background_request(1, 2.0).await;
        reg.set_background_request(2, 5.0).await;
        assert_eq!(reg.requested_background_fps().await, 5.0);

        assert!(reg.forget_background_request(2).await, "the loud peer left");
        assert_eq!(
            reg.requested_background_fps().await,
            2.0,
            "max relaxes to the remaining consumer, not stuck at 5"
        );

        assert!(reg.forget_background_request(1).await);
        assert_eq!(
            reg.requested_background_fps().await,
            0.0,
            "last consumer gone -> background capture fully off"
        );
        assert!(
            !reg.forget_background_request(1).await,
            "forgetting is idempotent, so a double teardown is harmless"
        );
    }

    /// A manual SetRenderSize acts as a CAP: effective = min(auto_max, manual).
    #[tokio::test]
    async fn manual_render_cap_bounds_the_auto_max() {
        let (_dir, cam) = attach_camera_for_tracker(7_003).await;
        cam.record_display_size(1, 512, 512).await;
        cam.set_manual_render_cap(Some((256, 256))).await;
        assert_eq!(cam.effective_render_size().await, Some((256, 256)));

        // Clearing the cap frees it back to the auto max.
        cam.set_manual_render_cap(None).await;
        assert_eq!(cam.effective_render_size().await, Some((512, 512)));
    }

    /// A forced feed sizes to the ring ceiling regardless of demand: even the
    /// only reported display size being tiny doesn't shrink it back down.
    #[tokio::test]
    async fn forced_full_res_sizes_to_the_ceiling_over_tiny_demand() {
        let (_dir, cam) = attach_camera_for_tracker(7_005).await;
        cam.record_display_size(1, 40, 40).await;
        assert_eq!(cam.effective_render_size().await, Some((40, 40)));

        cam.set_forced(1, true).await;
        assert_eq!(
            cam.effective_render_size().await,
            Some((1024, 1024)),
            "forcing must size to the ring ceiling, not the tiny display demand"
        );
    }

    /// Force is OR-aggregated across peers: still forced while ANY peer holds
    /// it, released only once the last one clears (mirrors the display-size
    /// MAX-across-consumers relax-on-departure shape, but with an OR instead
    /// of a MAX).
    #[tokio::test]
    async fn forced_full_res_or_aggregates_across_peers() {
        let (_dir, cam) = attach_camera_for_tracker(7_006).await;
        cam.record_display_size(1, 40, 40).await;

        cam.set_forced(1, true).await;
        cam.set_forced(2, true).await;
        assert_eq!(cam.effective_render_size().await, Some((1024, 1024)));

        cam.set_forced(1, false).await;
        assert_eq!(
            cam.effective_render_size().await,
            Some((1024, 1024)),
            "still forced while peer 2 holds it"
        );

        cam.set_forced(2, false).await;
        assert_eq!(
            cam.effective_render_size().await,
            Some((40, 40)),
            "released back to demand once every peer clears"
        );
    }

    /// `registry.forget_forced(flight_id, peer_id)` mirrors
    /// `registry.forget_display_size(flight_id, peer_id)`: the single-camera
    /// clear used on an explicit Unsubscribe. Regression coverage for the
    /// leak where `handle_unsubscribe` cleared the display-size report but
    /// never the force pin, so a feed a peer had forced to the ring ceiling
    /// stayed pinned there forever once that peer unsubscribed without a
    /// full Disconnect (e.g. switching feeds mid-recording).
    #[tokio::test]
    async fn forget_forced_relaxes_the_ceiling_for_one_camera_on_unsubscribe() {
        let dir = tempfile::tempdir().expect("tempdir");
        let shm = dir.path();
        let cfg = MmapRingConfig {
            slot_count: 4,
            max_width: 1024,
            max_height: 1024,
        };
        for id in [7_301u32, 7_302u32] {
            MmapFrameRing::create(&shm.join(format!("{id}.ring")), cfg).expect("create ring");
        }
        let registry = CameraRegistry::new(shm.to_path_buf());
        registry.rescan().await;
        let cam_a = registry.get(7_301).await.expect("cam a");
        let cam_b = registry.get(7_302).await.expect("cam b");

        cam_a.set_forced(1, true).await;
        cam_b.set_forced(1, true).await;
        assert_eq!(cam_a.effective_render_size().await, Some((1024, 1024)));
        assert_eq!(cam_b.effective_render_size().await, Some((1024, 1024)));

        registry.forget_forced(7_301, 1).await;

        assert_eq!(
            cam_a.effective_render_size().await,
            None,
            "unsubscribing from camera A must release peer 1's force on A"
        );
        assert_eq!(
            cam_b.effective_render_size().await,
            Some((1024, 1024)),
            "camera B is untouched -- the clear is single-camera scoped, not peer-wide"
        );
    }

    /// `forget_forced_all(peer_id)` sweeps every camera, mirroring
    /// `forget_display_size_all`: a peer disconnecting must not leave a
    /// force pinned on a camera it forgot to explicitly release.
    #[tokio::test]
    async fn forget_forced_all_sweeps_every_camera_for_the_peer() {
        let dir = tempfile::tempdir().expect("tempdir");
        let shm = dir.path();
        let cfg = MmapRingConfig {
            slot_count: 4,
            max_width: 1024,
            max_height: 1024,
        };
        for id in [7_201u32, 7_202u32] {
            MmapFrameRing::create(&shm.join(format!("{id}.ring")), cfg).expect("create ring");
        }
        let registry = CameraRegistry::new(shm.to_path_buf());
        registry.rescan().await;
        let cam_a = registry.get(7_201).await.expect("cam a");
        let cam_b = registry.get(7_202).await.expect("cam b");

        cam_a.set_forced(1, true).await;
        cam_b.set_forced(1, true).await;
        assert_eq!(cam_a.effective_render_size().await, Some((1024, 1024)));
        assert_eq!(cam_b.effective_render_size().await, Some((1024, 1024)));

        registry.forget_forced_all(1).await;
        assert_eq!(
            cam_a.effective_render_size().await,
            None,
            "peer sweep must clear the force on every camera it touched"
        );
        assert_eq!(cam_b.effective_render_size().await, None);
    }

    /// Regression: an unforced feed's effective size is unaffected by the
    /// force branch existing at all.
    #[tokio::test]
    async fn unforced_feed_is_unchanged() {
        let (_dir, cam) = attach_camera_for_tracker(7_007).await;
        assert_eq!(cam.effective_render_size().await, None);

        cam.record_display_size(1, 512, 512).await;
        assert_eq!(cam.effective_render_size().await, Some((512, 512)));

        cam.set_manual_render_cap(Some((256, 256))).await;
        assert_eq!(cam.effective_render_size().await, Some((256, 256)));
    }

    /// A kerbal-camera manifest (`kind:"kerbal"`, a persistent id, a crew
    /// location) threads through `rescan` into both the internal
    /// `CameraState` and the `GET /cameras` `CameraInfo` shape.
    #[tokio::test]
    async fn rescan_populates_kerbal_camera_kind_from_manifest() {
        let dir = tempfile::tempdir().expect("tempdir");
        let shm = dir.path();
        let flight_id: u32 = 9_010;
        let cfg = MmapRingConfig {
            slot_count: 4,
            max_width: 64,
            max_height: 64,
        };
        MmapFrameRing::create(&shm.join(format!("{flight_id}.ring")), cfg).expect("create ring");

        let content = format!(
            r#"{{"flight_id":{flight_id},"kind":"kerbal","kerbal_persistent_id":42,"crew_location":"seat","part_name":"","part_title":"","camera_name":"Jeb's Face","vessel_name":"Kerbal X","supports_zoom":false,"fov":60.0,"fov_min":60.0,"fov_max":60.0,"supports_pan":false,"pan_yaw_min":0.0,"pan_yaw_max":0.0,"pan_pitch_min":0.0,"pan_pitch_max":0.0}}"#,
        );
        tokio::fs::write(shm.join(format!("{flight_id}.info.json")), content)
            .await
            .unwrap();

        let registry = CameraRegistry::new(shm.to_path_buf());
        registry.rescan().await;

        let cam = registry.get(flight_id).await.expect("camera attached");
        assert_eq!(cam.kind, CameraKind::Kerbal);
        assert_eq!(cam.kerbal_persistent_id, Some(42));
        assert_eq!(cam.crew_location(), Some(CrewLocation::Seat));

        let info = registry
            .list()
            .await
            .into_iter()
            .find(|c| c.flight_id == flight_id)
            .expect("camera in list");
        assert_eq!(info.kind, CameraKind::Kerbal);
        assert_eq!(info.kerbal_persistent_id, Some(42));
        assert_eq!(info.crew_location, Some(CrewLocation::Seat));
    }

    /// A kerbal camera's `crew_location` updates LIVE when the plugin
    /// rewrites the manifest across the seat<->EVA switch. The feed reuses
    /// one ring (no destroyed tombstone, unchanged ring identity), so a
    /// fresh attach never fires; `rescan` must re-read the manifest for the
    /// live camera, update the existing `CameraState` in place, mark it
    /// dirty so subscribers relabel, and surface the new value in
    /// `/cameras`.
    #[tokio::test]
    async fn rescan_updates_kerbal_crew_location_live_across_eva_switch() {
        let dir = tempfile::tempdir().expect("tempdir");
        let shm = dir.path();
        let flight_id: u32 = 9_012;
        let cfg = MmapRingConfig {
            slot_count: 4,
            max_width: 64,
            max_height: 64,
        };
        MmapFrameRing::create(&shm.join(format!("{flight_id}.ring")), cfg).expect("create ring");

        let manifest = |loc: &str| {
            format!(
                r#"{{"flight_id":{flight_id},"kind":"kerbal","kerbal_persistent_id":42,"crew_location":"{loc}","part_name":"","part_title":"","camera_name":"Jeb's Face","vessel_name":"Kerbal X","supports_zoom":false,"fov":0.0,"fov_min":0.0,"fov_max":0.0,"supports_pan":false,"pan_yaw_min":0.0,"pan_yaw_max":0.0,"pan_pitch_min":0.0,"pan_pitch_max":0.0}}"#,
            )
        };
        let info_path = shm.join(format!("{flight_id}.info.json"));
        tokio::fs::write(&info_path, manifest("seat"))
            .await
            .unwrap();

        let registry = CameraRegistry::new(shm.to_path_buf());
        registry.rescan().await;
        // Hold a handle to the live camera; interior mutability means this
        // same Arc must observe the update below.
        let cam = registry.get(flight_id).await.expect("camera attached");
        assert_eq!(cam.crew_location(), Some(CrewLocation::Seat));
        // Drain any attach-driven dirty state so we can isolate the relabel.
        let _ = registry.take_dirty_cameras().await;

        // Plugin flips the SAME manifest to EVA (same ring, no tombstone).
        tokio::fs::write(&info_path, manifest("eva")).await.unwrap();
        registry.rescan().await;

        // Live CameraState reflects the flip in place...
        assert_eq!(cam.crew_location(), Some(CrewLocation::Eva));
        // ...the `/cameras` shape carries it...
        let info = registry
            .list()
            .await
            .into_iter()
            .find(|c| c.flight_id == flight_id)
            .expect("camera in list");
        assert_eq!(info.crew_location, Some(CrewLocation::Eva));
        // ...and the camera is marked dirty so subscribers relabel live.
        assert!(registry.take_dirty_cameras().await.contains(&flight_id));
    }

    /// A partial/failed manifest read (no `crew_location` parsed) must NOT
    /// clobber a live kerbal camera's value. The plugin never writes null for
    /// a kerbal, so a parsed `None` means the re-read caught a mid-write; the
    /// last good value is kept and the camera is NOT marked dirty (no spurious
    /// blank relabel / flicker).
    #[tokio::test]
    async fn rescan_keeps_kerbal_crew_location_on_partial_manifest_read() {
        let dir = tempfile::tempdir().expect("tempdir");
        let shm = dir.path();
        let flight_id: u32 = 9_013;
        let cfg = MmapRingConfig {
            slot_count: 4,
            max_width: 64,
            max_height: 64,
        };
        MmapFrameRing::create(&shm.join(format!("{flight_id}.ring")), cfg).expect("create ring");
        let info_path = shm.join(format!("{flight_id}.info.json"));

        // Attach on EVA.
        let eva = format!(
            r#"{{"flight_id":{flight_id},"kind":"kerbal","kerbal_persistent_id":42,"crew_location":"eva","part_name":"","part_title":"","camera_name":"Jeb's Face","vessel_name":"Kerbal X","supports_zoom":false,"fov":0.0,"fov_min":0.0,"fov_max":0.0,"supports_pan":false,"pan_yaw_min":0.0,"pan_yaw_max":0.0,"pan_pitch_min":0.0,"pan_pitch_max":0.0}}"#,
        );
        tokio::fs::write(&info_path, eva).await.unwrap();
        let registry = CameraRegistry::new(shm.to_path_buf());
        registry.rescan().await;
        let cam = registry.get(flight_id).await.expect("camera attached");
        assert_eq!(cam.crew_location(), Some(CrewLocation::Eva));
        let _ = registry.take_dirty_cameras().await;

        // A re-read that yields no crew_location (partial write / mid-rewrite):
        // valid JSON, field absent -> parses to None.
        let no_loc = format!(
            r#"{{"flight_id":{flight_id},"kind":"kerbal","kerbal_persistent_id":42,"part_name":"","part_title":"","camera_name":"Jeb's Face","vessel_name":"Kerbal X","supports_zoom":false,"fov":0.0,"fov_min":0.0,"fov_max":0.0,"supports_pan":false,"pan_yaw_min":0.0,"pan_yaw_max":0.0,"pan_pitch_min":0.0,"pan_pitch_max":0.0}}"#,
        );
        tokio::fs::write(&info_path, no_loc).await.unwrap();
        registry.rescan().await;

        // Value kept, not cleared; no spurious relabel.
        assert_eq!(cam.crew_location(), Some(CrewLocation::Eva));
        assert!(
            registry.take_dirty_cameras().await.is_empty(),
            "partial read must not mark the camera dirty",
        );
    }

    /// A part manifest with no `kind` field at all (every manifest written
    /// before this feature) defaults to `Part`/`None`/`None`: additive,
    /// existing cameras are unaffected.
    #[tokio::test]
    async fn rescan_defaults_to_part_camera_kind_when_manifest_omits_kind() {
        let dir = tempfile::tempdir().expect("tempdir");
        let shm = dir.path();
        let flight_id: u32 = 9_011;
        let cfg = MmapRingConfig {
            slot_count: 4,
            max_width: 64,
            max_height: 64,
        };
        MmapFrameRing::create(&shm.join(format!("{flight_id}.ring")), cfg).expect("create ring");

        let content = format!(
            r#"{{"flight_id":{flight_id},"part_name":"testPart","part_title":"Test Camera","camera_name":"Cam 1","vessel_name":"Kerbal X","supports_zoom":false,"fov":60.0,"fov_min":10.0,"fov_max":90.0,"supports_pan":false,"pan_yaw_min":0.0,"pan_yaw_max":0.0,"pan_pitch_min":0.0,"pan_pitch_max":0.0}}"#,
        );
        tokio::fs::write(shm.join(format!("{flight_id}.info.json")), content)
            .await
            .unwrap();

        let registry = CameraRegistry::new(shm.to_path_buf());
        registry.rescan().await;

        let cam = registry.get(flight_id).await.expect("camera attached");
        assert_eq!(cam.kind, CameraKind::Part);
        assert_eq!(cam.kerbal_persistent_id, None);
        assert_eq!(cam.crew_location(), None);

        let info = registry
            .list()
            .await
            .into_iter()
            .find(|c| c.flight_id == flight_id)
            .expect("camera in list");
        assert_eq!(info.kind, CameraKind::Part);
        assert_eq!(info.kerbal_persistent_id, None);
        assert_eq!(info.crew_location, None);
    }

    /// `add_track` / `remove_track` drive the subscriber count that gates
    /// encoding — the efficiency premise of the dynamic slot model. The
    /// transitions the slot pool relies on: subscribe -> 1, a second slot on
    /// the same camera -> 2, unsubscribe one -> 1, last viewer -> 0; and
    /// removing a track the camera isn't feeding is a no-op.
    #[tokio::test]
    async fn subscriber_count_transitions() {
        use webrtc::api::media_engine::MIME_TYPE_H264;
        use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;

        let dir = tempfile::tempdir().expect("tempdir");
        let cfg = MmapRingConfig {
            slot_count: 4,
            max_width: 64,
            max_height: 64,
        };
        MmapFrameRing::create(&dir.path().join("1.ring"), cfg).expect("create ring");
        let registry = CameraRegistry::new(dir.path().to_path_buf());
        registry.rescan().await;
        let cam = registry.get(1).await.expect("camera attached from ring");

        let mk = || {
            Arc::new(TrackLocalStaticSample::new(
                RTCRtpCodecCapability {
                    mime_type: MIME_TYPE_H264.to_owned(),
                    ..Default::default()
                },
                "video".to_owned(),
                "stream".to_owned(),
            ))
        };
        let a = mk();
        let b = mk();

        assert_eq!(cam.add_track(a.clone()).await, 1, "first subscribe");
        assert_eq!(
            cam.add_track(b.clone()).await,
            2,
            "second slot, same camera"
        );
        assert_eq!(cam.remove_track(&a).await, 1, "unsubscribe one slot");
        assert_eq!(cam.remove_track(&b).await, 0, "last viewer leaves");
        assert_eq!(
            cam.remove_track(&a).await,
            0,
            "removing an unbound track is a no-op"
        );
    }

    // KSP reuses part.flightID across revert/recover, so a camera can be torn
    // down (tombstoned as destroyed for the SIGNAL LOST UI) and then spawned
    // again under the SAME flight_id. The rescan must resurrect the tombstone
    // to active when a fresh ring reappears for it, or the camera is stuck
    // destroyed and unsubscribable forever (peer.rs rejects destroyed cameras).
    #[tokio::test]
    async fn destroyed_camera_resurrects_when_ring_reappears_for_reused_flight_id() {
        let dir = tempfile::tempdir().expect("tempdir");
        let cfg = MmapRingConfig {
            slot_count: 4,
            max_width: 64,
            max_height: 64,
        };
        let shm = dir.path();
        let id: u32 = 42;
        let write_manifest = |lifecycle: &str| {
            let content = format!(
                r#"{{"lifecycle":"{lifecycle}","flight_id":{id},"part_name":"hc.launchcam","part_title":"KSC Launchpad Camera","camera_name":"LaunchCam","vessel_name":"vmod test","supports_zoom":false,"fov":60.0,"fov_min":10.0,"fov_max":90.0,"supports_pan":false,"pan_yaw_min":0.0,"pan_yaw_max":0.0,"pan_pitch_min":0.0,"pan_pitch_max":0.0}}"#,
            );
            std::fs::write(shm.join(format!("{id}.info.json")), content).unwrap();
        };
        let ring_path = shm.join(format!("{id}.ring"));
        let registry = CameraRegistry::new(shm.to_path_buf());

        // 1. Fresh camera attaches active.
        MmapFrameRing::create(&ring_path, cfg).expect("create ring");
        write_manifest("active");
        registry.rescan().await;
        assert!(
            !registry
                .get(id)
                .await
                .expect("camera attached")
                .destroyed
                .load(Ordering::Acquire),
            "fresh camera is active"
        );

        // 2. Part destroyed: plugin writes lifecycle=destroyed then deletes ring.
        write_manifest("destroyed");
        std::fs::remove_file(&ring_path).unwrap();
        registry.rescan().await;
        assert!(
            registry
                .get(id)
                .await
                .expect("destroyed camera retained as tombstone")
                .destroyed
                .load(Ordering::Acquire),
            "tombstoned after part destroyed"
        );
        // The destruction notification has gone out to peers by now.
        registry.acknowledge_destruction(id).await;

        // 3. Revert reuses the same flight_id: fresh ring + active manifest.
        MmapFrameRing::create(&ring_path, cfg).expect("recreate ring");
        write_manifest("active");
        let outcome = registry.rescan().await;
        assert!(
            !registry
                .get(id)
                .await
                .expect("camera present after resurrect")
                .destroyed
                .load(Ordering::Acquire),
            "camera must resurrect to active when its ring reappears (flight_id reuse after revert)"
        );
        assert!(
            outcome.attached.contains(&id),
            "resurrection must be announced as an attach so peers rebind"
        );
    }

    // Reproduces the vessel-switch stale-feed bug (kerbcast#2): a camera
    // whose part persists across `onVesselChange` gets torn down and rebuilt
    // by RebuildCameraList without a destroyed tombstone (that path is
    // reserved for actual part destruction), deleting and recreating the
    // ring at the same flight_id within one frame. Before the ring_identity
    // check this was silently ignored by rescan (the entry wasn't flagged
    // destroyed) and the old mmap stayed pointed at the unlinked file
    // forever — no browser refresh could recover it.
    //
    // unix-only: the identity check is exact there (inode). The non-unix
    // fallback (mtime) can't distinguish two files created back-to-back
    // within the same tick, which is exactly what this test does — that's
    // an inherent limit of the tier-2 fallback, not something to assert on.
    #[cfg(unix)]
    #[tokio::test]
    async fn live_camera_reattaches_when_ring_recreated_without_destroyed_tombstone() {
        let dir = tempfile::tempdir().expect("tempdir");
        let cfg = MmapRingConfig {
            slot_count: 4,
            max_width: 64,
            max_height: 64,
        };
        let shm = dir.path();
        let id: u32 = 7;
        let write_manifest = || {
            let content = format!(
                r#"{{"lifecycle":"active","flight_id":{id},"part_name":"hc.navcam","part_title":"NavCam","camera_name":"NavCam","vessel_name":"booster","supports_zoom":false,"fov":60.0,"fov_min":10.0,"fov_max":90.0,"supports_pan":false,"pan_yaw_min":0.0,"pan_yaw_max":0.0,"pan_pitch_min":0.0,"pan_pitch_max":0.0}}"#,
            );
            std::fs::write(shm.join(format!("{id}.info.json")), content).unwrap();
        };
        let ring_path = shm.join(format!("{id}.ring"));
        let registry = CameraRegistry::new(shm.to_path_buf());

        // 1. Fresh camera attaches active.
        MmapFrameRing::create(&ring_path, cfg).expect("create ring");
        write_manifest();
        registry.rescan().await;
        let first = registry.get(id).await.expect("camera attached");
        assert!(!first.destroyed.load(Ordering::Acquire));

        // 2. Vessel switch: plugin's normal (non-destroyed) teardown deletes
        // the ring and info.json with no tombstone, then RebuildCameraList
        // immediately recreates the same flight_id — all within one frame,
        // well before the sidecar's next ~1Hz rescan tick.
        std::fs::remove_file(&ring_path).unwrap();
        std::fs::remove_file(shm.join(format!("{id}.info.json"))).unwrap();
        MmapFrameRing::create(&ring_path, cfg).expect("recreate ring");
        write_manifest();

        let outcome = registry.rescan().await;
        assert!(
            outcome.attached.contains(&id),
            "reattach must be announced so peers rebind and stop reading the stale mmap"
        );
        let second = registry.get(id).await.expect("camera still present");
        assert!(
            !std::sync::Arc::ptr_eq(&first, &second),
            "the registry entry must be replaced, not left pointing at the unlinked ring"
        );
    }

    // The force-render profiling override keeps a peerless camera subscribed
    // (so the plugin renders + reports telemetry), and clearing it releases the
    // camera again — the cleanup path POST /profile/render?on=false relies on.
    #[tokio::test]
    async fn force_render_overrides_idle_subscription() {
        let dir = tempfile::tempdir().expect("tempdir");
        let cfg = MmapRingConfig {
            slot_count: 4,
            max_width: 64,
            max_height: 64,
        };
        MmapFrameRing::create(&dir.path().join("1.ring"), cfg).expect("create ring");
        let registry = CameraRegistry::new(dir.path().to_path_buf());
        registry.rescan().await;
        let cam = registry.get(1).await.expect("camera attached from ring");
        let cams = vec![cam.clone()];

        // Default: no force, no peer-tracks → camera stays unsubscribed.
        registry.refresh_idle_subscriptions(&cams).await;
        assert!(
            !cam.control.lock().await.subscribed,
            "idle camera is not subscribed by default"
        );

        // Force-render on → subscribed even with zero subscribers (renders for
        // profiling, no peer needed).
        registry.set_force_render(true);
        registry.refresh_idle_subscriptions(&cams).await;
        assert!(
            cam.control.lock().await.subscribed,
            "force_render keeps the camera subscribed without a peer"
        );

        // Force-render off → cleanup releases the camera again.
        registry.set_force_render(false);
        registry.refresh_idle_subscriptions(&cams).await;
        assert!(
            !cam.control.lock().await.subscribed,
            "clearing force_render releases the camera (cleanup path)"
        );
    }

    /// The persistent rate fields serialise to the camelCase keys the
    /// plugin parses (`panYawRate`/`panPitchRate`/`zoomRate`), and `None`
    /// (the "unchanged" sentinel) is omitted so the plugin keeps the last
    /// rate rather than reading a spurious zero.
    #[test]
    fn control_state_serialises_rate_fields_camel_case() {
        let ctrl = ControlState {
            subscribed: true,
            pan_yaw_rate: Some(0.5),
            pan_pitch_rate: Some(-1.0),
            zoom_rate: Some(0.0),
            ..Default::default()
        };
        let s = serde_json::to_string(&ctrl).unwrap();
        assert!(s.contains("\"panYawRate\":0.5"), "got {s}");
        assert!(s.contains("\"panPitchRate\":-1"), "got {s}");
        assert!(s.contains("\"zoomRate\":0"), "got {s}");

        // None on every rate => keys omitted (plugin treats absence as
        // "rate unchanged"). The seq counters are always present (the
        // plugin keys absolute-apply off their *change*, so absence would
        // be ambiguous).
        let blank = ControlState::default();
        let s = serde_json::to_string(&blank).unwrap();
        assert!(!s.contains("panYawRate"), "got {s}");
        assert!(!s.contains("zoomRate"), "got {s}");
        assert!(s.contains("\"panSeq\":0"), "got {s}");
        assert!(s.contains("\"fovSeq\":0"), "got {s}");
    }

    /// The disconnect deadman: `zero_rates` writes an explicit `Some(0.0)`
    /// stop on every rate axis (not `None`, which the plugin would read as
    /// "unchanged" and keep running), flushes it to the control file, and
    /// leaves the absolute pan/fov targets untouched.
    #[tokio::test]
    async fn zero_rates_writes_explicit_stop() {
        let dir = tempfile::tempdir().expect("tempdir");
        let cfg = MmapRingConfig {
            slot_count: 4,
            max_width: 64,
            max_height: 64,
        };
        MmapFrameRing::create(&dir.path().join("1.ring"), cfg).expect("create ring");
        let registry = CameraRegistry::new(dir.path().to_path_buf());
        registry.rescan().await;
        let cam = registry.get(1).await.expect("camera attached from ring");

        // Arrange: a camera mid-hold with a non-zero rate and a framed
        // absolute pan we expect to survive the deadman.
        {
            let mut ctrl = cam.control.lock().await;
            ctrl.pan_yaw_rate = Some(0.8);
            ctrl.zoom_rate = Some(-0.5);
            ctrl.pan_yaw = Some(12.0);
            ctrl.pan_seq = 3;
            ctrl.fov_seq = 4;
        }

        registry.zero_rates(1).await;

        let ctrl = cam.control.lock().await;
        assert_eq!(ctrl.pan_yaw_rate, Some(0.0));
        assert_eq!(ctrl.pan_pitch_rate, Some(0.0));
        assert_eq!(ctrl.zoom_rate, Some(0.0));
        assert_eq!(ctrl.pan_yaw, Some(12.0), "absolute pan must be untouched");
        // The deadman must NOT bump the absolute seqs — otherwise the plugin
        // would re-apply the stale absolute and snap back to it on the very
        // stop the deadman is issuing.
        assert_eq!(ctrl.pan_seq, 3, "deadman must not bump pan_seq");
        assert_eq!(ctrl.fov_seq, 4, "deadman must not bump fov_seq");

        // The stop reached the shared-memory control block (the plugin reads
        // it each frame). Decode the raw bytes and confirm the zeroed rates
        // and the surviving absolute pan / seqs.
        let bytes = tokio::fs::read(dir.path().join("1.control.bin"))
            .await
            .expect("control block flushed");
        let snap = crate::shared_mem::control::decode(&bytes).expect("decodes");
        assert_eq!(snap.pan_yaw_rate, Some(0.0));
        assert_eq!(snap.pan_pitch_rate, Some(0.0));
        assert_eq!(snap.zoom_rate, Some(0.0));
        assert_eq!(snap.pan_yaw, Some(12.0), "absolute pan must be untouched");
        assert_eq!(snap.pan_seq, 3, "deadman must not bump pan_seq");
        assert_eq!(snap.fov_seq, 4, "deadman must not bump fov_seq");
    }

    async fn registry_with_one_camera(
        dir: &tempfile::TempDir,
    ) -> (CameraRegistry, Arc<CameraState>) {
        let cfg = MmapRingConfig {
            slot_count: 4,
            max_width: 64,
            max_height: 64,
        };
        MmapFrameRing::create(&dir.path().join("1.ring"), cfg).expect("create ring");
        let registry = CameraRegistry::new(dir.path().to_path_buf());
        registry.rescan().await;
        let cam = registry.get(1).await.expect("camera attached from ring");
        (registry, cam)
    }

    /// `apply_viewer_quality` stores the preset's viewer level, flushes it
    /// to the plugin's control block, and marks the camera dirty for the
    /// all-peers broadcast. Multi-peer policy is last write wins: a second
    /// apply (from any peer) replaces the first, and clearing (auto)
    /// removes the field from the block entirely.
    #[tokio::test]
    async fn apply_viewer_quality_flushes_and_marks_dirty() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (registry, cam) = registry_with_one_camera(&dir).await;

        registry
            .apply_viewer_quality(1, Some(QualityPreset::Half))
            .await
            .expect("apply");
        assert_eq!(cam.control.lock().await.viewer_level, Some(2));
        let bytes = tokio::fs::read(dir.path().join("1.control.bin"))
            .await
            .expect("control block flushed");
        let snap = crate::shared_mem::control::decode(&bytes).expect("decodes");
        assert_eq!(snap.viewer_level, Some(2), "half preset = viewer level 2");
        assert_eq!(registry.take_dirty_cameras().await, vec![1]);
        assert!(
            registry.take_dirty_cameras().await.is_empty(),
            "dirty set drains"
        );

        // Last write wins: another peer's quarter replaces half.
        registry
            .apply_viewer_quality(1, Some(QualityPreset::Quarter))
            .await
            .expect("apply");
        let bytes = tokio::fs::read(dir.path().join("1.control.bin"))
            .await
            .unwrap();
        let snap = crate::shared_mem::control::decode(&bytes).expect("decodes");
        assert_eq!(snap.viewer_level, Some(3));

        // Auto clears the clamp (absent in the block, not zero).
        registry.apply_viewer_quality(1, None).await.expect("apply");
        let bytes = tokio::fs::read(dir.path().join("1.control.bin"))
            .await
            .unwrap();
        let snap = crate::shared_mem::control::decode(&bytes).expect("decodes");
        assert_eq!(snap.viewer_level, None);
    }

    #[tokio::test]
    async fn apply_viewer_quality_rejects_unknown_camera() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (registry, _cam) = registry_with_one_camera(&dir).await;
        let err = registry
            .apply_viewer_quality(999, Some(QualityPreset::Full))
            .await
            .expect_err("unknown camera must error");
        assert!(err.contains("999"), "got {err}");
        assert!(
            registry.take_dirty_cameras().await.is_empty(),
            "a rejected request must not broadcast"
        );
    }

    /// The state pushed for a viewer-quality change carries the preset and
    /// preserves the viewer's other control state (a quality request must
    /// not clobber subscriptions / layers / fov, mirroring how every other
    /// setter composes through the shared ControlState).
    #[tokio::test]
    async fn protocol_state_carries_viewer_quality() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (registry, cam) = registry_with_one_camera(&dir).await;
        {
            let mut ctrl = cam.control.lock().await;
            ctrl.subscribed = true;
            ctrl.fov = Some(42.0);
        }

        registry
            .apply_viewer_quality(1, Some(QualityPreset::ThreeQuarter))
            .await
            .expect("apply");

        let state = registry.protocol_state(1).await.expect("state");
        assert_eq!(state.viewer_quality, Some(QualityPreset::ThreeQuarter));
        // No plugin status yet: effective == requested, so nothing is limited.
        assert_eq!(state.quality_limited_by, None);
        let ctrl = cam.control.lock().await;
        assert!(ctrl.subscribed, "quality apply must not clobber subscribed");
        assert_eq!(ctrl.fov, Some(42.0), "quality apply must not clobber fov");
    }

    /// Once the plugin reports effective dims below the viewer's target,
    /// the broadcast flags `qualityLimitedBy: "throttled"`; when the
    /// adaptive controller recovers to (or above) the viewer target the
    /// flag clears. The viewer request itself never *causes* the flag.
    #[tokio::test]
    async fn protocol_state_reports_throttled_from_status() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (registry, _cam) = registry_with_one_camera(&dir).await;
        registry
            .apply_viewer_quality(1, Some(QualityPreset::Half))
            .await
            .expect("apply");

        let write_status = |render_w: u32, render_h: u32| {
            let path = dir.path().join("global.status.json");
            let body = format!(
                r#"{{"kspFps":60.0,"shedLevel":0,"cameras":[{{"flightId":1,"renderWidth":{render_w},"renderHeight":{render_h},"operatorWidth":1024,"operatorHeight":576,"layers":["NEAR"],"operatorLayers":["NEAR"],"fov":60.0,"panYaw":0.0,"panPitch":0.0}}]}}"#
            );
            std::fs::write(path, body).unwrap();
        };

        // Plugin honors the half preset exactly (1024 * 0.5 = 512): not limited.
        write_status(512, 288);
        registry.poll_status().await;
        let state = registry.protocol_state(1).await.expect("state");
        assert_eq!(state.render_width, 512);
        assert_eq!(state.quality_limited_by, None, "request honored");

        // Adaptive shed demotes below the viewer target: throttled.
        write_status(256, 144);
        registry.poll_status().await;
        let state = registry.protocol_state(1).await.expect("state");
        assert_eq!(state.viewer_quality, Some(QualityPreset::Half));
        assert_eq!(state.quality_limited_by.as_deref(), Some("throttled"));
    }

    /// The pure expected-width computation: viewer scale applied to the
    /// operator ceiling, floored to even like the plugin's QualityClamp.
    #[test]
    fn quality_limited_reason_thresholds() {
        use QualityPreset::*;
        // Auto: limited only below the operator ceiling.
        assert_eq!(quality_limited_reason(1024, 1024, None), None);
        assert_eq!(
            quality_limited_reason(1024, 768, None).as_deref(),
            Some("throttled")
        );
        // Half of 1024 = 512: exact match honored, below = throttled.
        assert_eq!(quality_limited_reason(1024, 512, Some(Half)), None);
        assert_eq!(
            quality_limited_reason(1024, 510, Some(Half)).as_deref(),
            Some("throttled")
        );
        // Render above the target (shed gentler than the preset) is fine.
        assert_eq!(quality_limited_reason(1024, 768, Some(Half)), None);
        // Odd products floor to even, matching the plugin's MakeEven.
        assert_eq!(quality_limited_reason(1030, 772, Some(ThreeQuarter)), None);
    }
}
