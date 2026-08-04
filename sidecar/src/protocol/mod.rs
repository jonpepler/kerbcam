//! WebRTC data-channel protocol between the sidecar and a streaming
//! client (browser / gonogo / future Kotlin or Swift consumer).
//!
//! Wire format: JSON-per-message over an `RTCDataChannel` opened by the
//! browser *after* the SDP exchange and track negotiation are complete.
//! The data channel exists for per-camera operational state — layer
//! masks, render-size, keyframe requests, future zoom — that the
//! receiving client wants to influence in real time without
//! renegotiating SDP.
//!
//! Single source of truth: this module's types carry `#[typeshare]`
//! annotations. The `typeshare` CLI reads them and emits TypeScript
//! (and Kotlin / Swift / Scala / Go when those consumers materialise)
//! into `client-sdk/`. The CI workflow runs typeshare on every push to
//! `sidecar/src/protocol/**` and publishes the resulting npm package as
//! `@kerbcast/protocol`.
//!
//! All types use camelCase JSON keys to match TypeScript convention.
//! Enums use adjacent tagging (`tag = "type", content = "content"`)
//! because that's the discriminator form `typeshare` can faithfully
//! mirror in TypeScript:
//!
//!   { "type": "set-layers", "content": { "flightId": 123, "layers": [...] } }
//!
//! Unit variants (e.g. `Hello`) emit just `{ "type": "hello" }`.

use serde::{Deserialize, Serialize};
use typeshare::typeshare;

/// Layer mask. Mirrors `Kerbcast.CameraLayers` on the plugin side.
/// Receiving clients use this for both the rendered-layer status reports
/// and per-camera layer requests.
#[typeshare]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Layer {
    Near,
    Scaled,
    Far,
    Galaxy,
}

/// Viewer-selectable resolution preset. Each maps to a fraction of the
/// operator-configured render size (the settings.cfg Width/Height ceiling):
/// full = 1.0, threeQuarter = 0.75, half = 0.5, quarter = 0.25. The steps
/// mirror the plugin's shed-table resolution ladder so the viewer clamp and
/// the adaptive controller move on the same grid, and a preset can never
/// exceed the ring's allocated max (every scale is <= 1.0 of the ceiling).
///
/// Presets, not freeform WxH: a fixed menu keeps the unauthenticated
/// viewer-writable surface tiny and aspect-correct by construction.
#[typeshare]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum QualityPreset {
    Full,
    ThreeQuarter,
    Half,
    Quarter,
}

impl QualityPreset {
    /// Plugin-side viewer level this preset maps to (index into the
    /// plugin's `QualityClamp.ViewerScales` table).
    pub fn viewer_level(self) -> u32 {
        match self {
            QualityPreset::Full => 0,
            QualityPreset::ThreeQuarter => 1,
            QualityPreset::Half => 2,
            QualityPreset::Quarter => 3,
        }
    }

    pub fn from_viewer_level(level: u32) -> Option<Self> {
        match level {
            0 => Some(QualityPreset::Full),
            1 => Some(QualityPreset::ThreeQuarter),
            2 => Some(QualityPreset::Half),
            3 => Some(QualityPreset::Quarter),
            _ => None,
        }
    }

    /// Fraction of the operator render size this preset targets.
    pub fn scale(self) -> f32 {
        match self {
            QualityPreset::Full => 1.0,
            QualityPreset::ThreeQuarter => 0.75,
            QualityPreset::Half => 0.5,
            QualityPreset::Quarter => 0.25,
        }
    }
}

/// Lifecycle state of a camera. Transmitted in `CameraState` so clients
/// can react to part destruction without a new message type.
///
/// Destroyed is a terminal state — the sidecar never transitions a camera
/// back to Active after writing the tombstone.
#[typeshare]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum CameraLifecycle {
    #[default]
    Active,
    Destroyed,
}

/// How hard a camera is currently being captured. Reported per camera in
/// `CameraState` so a consumer renders what is actually happening rather than
/// predicting it from delay arithmetic.
///
/// `Hum` and `Off` only occur when background capture is enabled; with it off
/// (the default) a subscribed camera is `Full` and an unsubscribed one is `Off`,
/// which is exactly today's behaviour under the new names.
#[typeshare]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum CaptureState {
    /// Capturing at the primary rate: an ordinary live feed.
    #[default]
    Full,
    /// Promoted and on the way to the primary rate, but not there yet — either
    /// awaiting the forced keyframe or still rate-limited by the capture budget.
    Ramping,
    /// Background capture: recent but sparse. A consumer should present this as
    /// a reduced-rate channel, not as a live feed.
    Hum,
    /// Not being captured at all — unsubscribed, or the background layer has
    /// been shed under load. A consumer must NOT keep presenting the last frame
    /// as though it were a live low-rate channel.
    Off,
}

/// Distinguishes an existing Hullcam part camera (`Part`) from a
/// per-kerbal face camera (`Kerbal`).
#[typeshare]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum CameraKind {
    #[default]
    Part,
    Kerbal,
}

/// Which source a kerbal camera is currently rendering: a seated IVA
/// portrait, or the kerbal's own view while on EVA. Only meaningful when
/// `CameraState.kind == Kerbal`.
#[typeshare]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CrewLocation {
    Seat,
    Eva,
}

/// Per-camera snapshot pushed by the sidecar on every state change
/// (operator API call, adaptive shed, vessel change). Same shape served
/// by `GET /cameras` so client UIs can treat the two interchangeably.
///
/// Capability fields (`supports_zoom`, `supports_pan`) let clients
/// render controls only for features each part actually offers — a
/// fixed-FoV camera shouldn't get a zoom slider, a non-steerable one
/// shouldn't get a pan stick.
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraState {
    pub flight_id: u32,
    /// Part-destruction lifecycle. `Active` for live cameras. `Destroyed`
    /// when the plugin reports the Hullcam part was destroyed in-flight
    /// (collision, overheating, decoupling beyond physics range). Once
    /// destroyed the sidecar stops forwarding frames; the client should
    /// surface a "SIGNAL LOST" overlay and keep the last frame visible.
    #[serde(default)]
    pub lifecycle: CameraLifecycle,
    /// Whether this is a Hullcam part camera or a per-kerbal face camera.
    /// Defaults to `Part` so existing payloads are unaffected.
    #[serde(default)]
    pub kind: CameraKind,
    /// How hard this camera is currently being captured. Defaults to `Full` so
    /// existing payloads and pre-hum plugins are unaffected.
    #[serde(default)]
    pub capture_state: CaptureState,
    /// The kerbal's real `ProtoCrewMember.persistentID`: the stable key a
    /// consumer correlates against. `None` for part cameras. Distinct from
    /// `flight_id`, which identifies the camera instance, not the kerbal.
    #[serde(default)]
    pub kerbal_persistent_id: Option<u32>,
    /// Which source a kerbal camera is currently rendering. `None` for
    /// part cameras.
    #[serde(default)]
    pub crew_location: Option<CrewLocation>,
    /// Server-authoritative auto-track state for a pan+zoom camera (the
    /// operator's persistent intent). `None` (the default) = not tracking.
    /// Every browser reflects this; a browser track overrides a kOS aim on the
    /// same camera (send `SetTrackTarget` with `none` to hand back to kOS).
    #[serde(default)]
    pub track_mode: TrackMode,
    pub part_name: String,
    pub part_title: String,
    pub camera_name: String,
    pub vessel_name: String,
    /// Currently-rendered layers (effective after adaptive shedding).
    pub layers: Vec<Layer>,
    /// Operator-requested layer mask — the ceiling adaptive shedding
    /// can reduce below. UIs use this to show "scaled is *requested* but
    /// not *active* right now due to fps".
    pub operator_layers: Vec<Layer>,
    /// Currently-rendered dimensions (effective after adaptive
    /// resolution downscale). Equal to `operatorWidth` × `operatorHeight`
    /// when no auto-shed is in effect.
    pub render_width: u32,
    pub render_height: u32,
    /// Operator-requested render size — ceiling adaptive downscale can
    /// reduce below.
    pub operator_width: u32,
    pub operator_height: u32,
    /// Whether the part's Hullcam module supports runtime FoV changes
    /// (i.e. it's a `MuMechModuleHullCameraZoom`, not the fixed base
    /// `MuMechModuleHullCamera`). 19 of 21 stock parts do.
    pub supports_zoom: bool,
    /// Current effective FoV in degrees.
    pub fov: f32,
    /// FoV bounds the operator can choose between. Wider than the
    /// camera's "default" — these come from the Hullcam part config.
    /// Equal to `fov` when `supports_zoom == false`.
    pub fov_min: f32,
    pub fov_max: f32,
    /// Whether the part supports pan/tilt. True on parts with a steerable
    /// mount in the plugin's `PartCapabilities` table (today: `DC.TurretCam`,
    /// yaw-only; `hc.launchcam`, yaw+pitch); false on fixed-mount parts, which
    /// are the majority. Clients hide pan controls when false.
    pub supports_pan: bool,
    pub pan_yaw: f32,
    pub pan_pitch: f32,
    pub pan_yaw_min: f32,
    pub pan_yaw_max: f32,
    pub pan_pitch_min: f32,
    pub pan_pitch_max: f32,
    /// Current encoder bitrate target in bits per second. Equals
    /// `target_bitrate_bps` after the consume loop applies receiver
    /// feedback; the two diverge briefly between a REMB arriving and
    /// the consume loop's next tick. Zero when no encoder is running
    /// yet (no subscribers).
    pub encoder_bitrate_bps: u32,
    /// Bandwidth target derived from receivers' REMB feedback (min
    /// across active subscribers). Drives the encoder when
    /// significantly diverged. Zero until the first REMB packet
    /// arrives — encoder falls back to the sidecar's CLI default.
    pub target_bitrate_bps: u32,
    /// Effective degrade level (last-writer-wins across subscribers'
    /// SetDegrade requests). 0.0 = perfect, 1.0 = max degradation. Applied
    /// alongside operator render-size + adaptive shed; the encoder
    /// multiplies its effective bitrate by `(1 - 0.7 * level)` and
    /// skips fan-out for a fraction of frames at high levels.
    pub degrade_level: f32,
    /// Viewer-requested resolution preset for this camera. Last write
    /// wins across all connected peers; this broadcast is what keeps
    /// every UI consistent. Absent/None = auto: no viewer clamp, the
    /// operator ceiling and the adaptive controller alone decide.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viewer_quality: Option<QualityPreset>,
    /// Why the effective resolution sits below what the viewer asked
    /// for (or below the operator ceiling when no preset is set).
    /// `"throttled"` = the adaptive perf machinery is holding the
    /// camera down; the viewer target is honored again on recovery.
    /// Absent/None = the request is fully honored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quality_limited_by: Option<String>,
}

// Wrapper structs for the algebraic-enum content payloads. typeshare's
// TS codegen names them after the variants so the generated TypeScript
// stays readable. Hand-defined Serde attrs put fields in camelCase to
// match the rest of the wire format.

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetLayersPayload {
    pub flight_id: u32,
    pub layers: Vec<Layer>,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetRenderSizePayload {
    pub flight_id: u32,
    pub width: u32,
    pub height: u32,
}

/// Forces a camera to render at the operator ceiling regardless of
/// display-size demand. Per-viewer, OR-aggregated by the sidecar: a feed
/// stays forced while any connected viewer forces it, and releases when
/// the last one clears it (or disconnects). Still yields to the adaptive
/// framerate shed; overrides only the demand term.
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetForceFullResolutionPayload {
    pub flight_id: u32,
    pub force: bool,
}

/// Consumer's background-capture ("hum") request. Global rather than
/// per-camera: it is a statement about how much background cost this consumer
/// wants spent, not about one camera. Zero stops asking.
#[typeshare]
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetBackgroundCaptureFpsPayload {
    /// Requested rate in fps for cameras this consumer is not displaying.
    /// Clamped to the operator ceiling; 0 means no background capture.
    pub fps: f32,
}

/// Which moving thing a pan+zoom camera should auto-aim at. `None` = tracking
/// off (manual pan resumes). `ActiveVessel` and `Target` resolve to a world
/// position from `FlightGlobals` (the active vessel, or its target) with no
/// orbit math. Only surfaces on cameras with BOTH pan and zoom.
#[typeshare]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum TrackMode {
    #[default]
    None,
    ActiveVessel,
    Target,
}

/// Ask a pan+zoom camera to auto-track a moving vessel (or stop). Mirrors
/// `SetRenderSizePayload` in shape. Server-authoritative: the sidecar holds the
/// chosen mode per camera and publishes it in `CameraState.track_mode`, so
/// every browser reflects the same tracking state (never optimistic-local).
///
/// Precedence note (for operators): a browser track OVERRIDES a kOS aim on the
/// same camera; set `mode: none` to hand aiming back to kOS. While tracking, the
/// camera also AUTO-ZOOMS to keep the target framed (distance-driven), owning the
/// zoom over any manual FoV; `mode: none` restores manual zoom untouched.
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetTrackTargetPayload {
    pub flight_id: u32,
    pub mode: TrackMode,
}

/// A consumer reporting its OWN current display size in px for one camera.
/// Unlike `SetRenderSizePayload` (an operator command that sets the shared
/// render size directly, last-writer-wins), this is a per-consumer input the
/// sidecar aggregates MAX-across-consumers to drive auto-resolution
/// (meet-the-minimum-need). Shape mirrors `SetRenderSizePayload`; `width` and
/// `height` are the consumer's display px for this feed.
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportDisplaySizePayload {
    pub flight_id: u32,
    pub width: u32,
    pub height: u32,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetFovPayload {
    pub flight_id: u32,
    pub fov: f32,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetPanPayload {
    pub flight_id: u32,
    pub yaw: f32,
    pub pitch: f32,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetPanRatePayload {
    pub flight_id: u32,
    /// Normalised yaw velocity, -1..=1. +1 = pan right at the part's
    /// full `PanRateDegPerSec`. Persistent until superseded (a new rate,
    /// including zero, replaces it); the plugin integrates it into the
    /// pan target every frame.
    pub yaw_rate: f32,
    /// Normalised pitch velocity, -1..=1. +1 = pan up. Persistent until
    /// superseded.
    pub pitch_rate: f32,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetZoomRatePayload {
    pub flight_id: u32,
    /// Normalised zoom velocity, -1..=1. +1 = zoom IN (FoV decreasing)
    /// at the part's full `ZoomRateDegPerSec`. Persistent until
    /// superseded; the plugin integrates it into the FoV target every
    /// frame.
    pub rate: f32,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetDegradePayload {
    pub flight_id: u32,
    /// 0.0 = perfect quality, 1.0 = maximum degradation. Clamped.
    /// Last-writer-wins: degrade is a property of the camera's game
    /// state (comms strength), shared by all viewers of the single
    /// encoded stream, so the sidecar stores the latest value rather
    /// than reducing across subscribers. A well-behaved driver
    /// re-asserts every tick.
    pub level: f32,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetQualityPayload {
    pub flight_id: u32,
    /// Requested resolution preset, or absent/null for auto (clear the
    /// viewer clamp). Future viewer-quality knobs are added here as
    /// optional fields with serde defaults, so older clients keep
    /// parsing; richer controls (bitrate, ladder toggles) stay
    /// operator-only until deliberately opened up.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset: Option<QualityPreset>,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlightIdPayload {
    pub flight_id: u32,
}

/// Slot↔camera assignment for the dynamic-subscription model. The sidecar
/// negotiates a pool of recv-only video transceivers up front; `Subscribe`
/// binds a camera to a free one and the sidecar announces the binding here.
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotMapPayload {
    /// Transceiver `mid` carrying this slot's track. Stable for the
    /// connection's life, so the client keys off it rather than the
    /// fragile `onTrack` arrival order — match against
    /// `RTCTrackEvent.transceiver.mid`.
    pub mid: String,
    /// Camera now carried by the slot, or `None` when the slot was freed
    /// by `Unsubscribe`. Serialised as `null` (not omitted) so "freed" is
    /// unambiguous on the wire.
    pub flight_id: Option<u32>,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloPayload {
    pub sidecar_version: String,
    pub encoder_backend: String,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraSnapshotPayload {
    pub cameras: Vec<CameraState>,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraStateChangedPayload {
    pub state: CameraState,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdaptiveShedPayload {
    pub level: u32,
    pub ksp_fps: f32,
    pub reason: String,
}

/// Scene-state change: whether KSP is currently in a flight scene. Sent
/// after `Hello` (priming) and whenever the polled in-flight flag flips,
/// so clients can show a calm out-of-flight standby instead of per-camera
/// SIGNAL LOST when the whole scene unloads.
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneStateChangedPayload {
    pub in_flight: bool,
}

#[typeshare]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ErrorSource {
    #[default]
    Sidecar,
    Client,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorPayload {
    pub message: String,
    #[serde(default)]
    pub source: ErrorSource,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetThrottleMainScreenPayload {
    /// When `true`, disable the KSP main flight cameras to free GPU for
    /// kerbcast streams. Persists via the per-save difficulty parameter,
    /// matching the in-game Difficulty Settings toggle.
    pub enabled: bool,
}

#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsStatePayload {
    /// Effective value of the "Throttle KSP main render" setting as last
    /// reported by the plugin's `global.status.json`. Reflects what the
    /// plugin has *applied*, not just what was last requested.
    pub throttle_main_screen: bool,
    /// KSP mission time (`Planetarium.GetUniversalTime()`, seconds) at
    /// which the video currently being produced was captured. `None` =
    /// no clock yet (old plugin/sidecar, or first status not seen); a
    /// consumer treats that as "unknown" and keeps a live passthrough.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capture_ut: Option<f64>,
    /// Monotonic counter bumped only on a non-monotonic UT jump (revert,
    /// quickload, scene reload). Consumers resynchronise on any change;
    /// the absolute value is meaningless.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capture_epoch: Option<u32>,
    /// Current KSP time-warp multiplier, so a consumer can interpolate
    /// `capture_ut` between ~1Hz samples. `None` => treat as 1.0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_warp_rate: Option<f64>,
}

/// Messages sent FROM the client TO the sidecar.
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "content", rename_all = "kebab-case")]
pub enum ClientMessage {
    /// First message on a new data channel. Sidecar replies with `Hello`
    /// + a `CameraSnapshot` so the client gets server version + every
    /// camera's full state on one round-trip.
    Hello,
    /// Override the operator layer mask for one camera. Server-wide
    /// state — all consumers see the change.
    SetLayers(SetLayersPayload),
    /// Cap the auto-resolution for one camera. As of Stage 6 this is a
    /// CEILING on the demand-driven size (effective = min(auto max-across-
    /// consumers, this cap)), NOT an authoritative set: it cannot force a
    /// camera larger than current consumers report, only smaller. Even
    /// pixels only (H.264 chroma); server caps at the ring's allocated max.
    SetRenderSize(SetRenderSizePayload),
    /// Auto-track a moving vessel with a pan+zoom camera (or stop). The sidecar
    /// holds the chosen `mode` per camera and publishes it in
    /// `CameraState.track_mode`, so tracking state is server-authoritative and
    /// consistent across browsers. A browser track OVERRIDES a kOS aim on the
    /// same camera; send `mode: none` to hand aiming back to kOS.
    SetTrackTarget(SetTrackTargetPayload),
    /// A consumer reporting its OWN current display size in px; the sidecar
    /// aggregates MAX-across-consumers to drive auto-resolution
    /// (meet-the-minimum-need). Distinct from the operator `SetRenderSize`
    /// command: this is a per-consumer input, not a shared override — a
    /// departing consumer's size is cleared so the max relaxes.
    ReportDisplaySize(ReportDisplaySizePayload),
    /// Force a camera to render at the operator ceiling regardless of
    /// display-size demand. Per-viewer, OR-aggregated by the sidecar: a
    /// feed stays forced while any connected viewer forces it, and
    /// releases when the last one clears it (or disconnects). Still
    /// yields to the adaptive framerate shed; overrides only the demand
    /// term, never the perf-protection ceiling.
    SetForceFullResolution(SetForceFullResolutionPayload),
    /// Ask for background capture (the "hum"): subscribed cameras that this
    /// consumer is NOT displaying keep capturing at a low rate instead of
    /// stopping, so switching to one promotes an already-flowing stream rather
    /// than cold-starting from black.
    ///
    /// Per-consumer and MAX-aggregated, like `ReportDisplaySize`: the hum runs
    /// at the highest rate any connected consumer asked for, and relaxes when
    /// they lower it or disconnect. A consumer that never sends this pays
    /// nothing, which is why a stock install needs no configuration to serve
    /// both a plain viewer and a consumer that wants the hum.
    ///
    /// The rate is a REQUEST, not a guarantee. It is clamped to the operator's
    /// `BackgroundCaptureFps` ceiling and is the first thing dropped when the
    /// game approaches its framerate floor — watch `CameraState.capture_state`
    /// for what is actually happening. Send 0 to stop asking.
    ///
    /// Receiving the frames is not the same as keeping them: a consumer that
    /// wants history for a camera it isn't showing has to buffer the humming
    /// feed itself.
    SetBackgroundCaptureFps(SetBackgroundCaptureFpsPayload),
    /// Set the camera's field-of-view (degrees). Silently ignored for
    /// parts whose Hullcam module is the fixed base (`supportsZoom ==
    /// false`); clients are expected to clamp to `fovMin / fovMax`
    /// from the camera's `CameraState` before sending.
    SetFov(SetFovPayload),
    /// Pan/tilt the camera (yaw and pitch, both degrees from the
    /// part's resting forward). Honored by parts with a steerable mount
    /// (`supportsPan == true`, e.g. `DC.TurretCam` / `hc.launchcam`);
    /// silently ignored for fixed-mount parts. Clients should hide pan
    /// controls until `supportsPan == true` for the camera.
    SetPan(SetPanPayload),
    /// Set a *persistent* pan/tilt velocity (normalised yaw + pitch,
    /// -1..=1). Unlike `SetPan` (a one-shot absolute target), the rate
    /// holds until a new rate — including zero, which stops — supersedes
    /// it; the plugin integrates it into the pan target every frame so
    /// smoothness lives in KSP's frame loop rather than the control-poll
    /// cadence. +yaw = pan right, +pitch = pan up. Ignored (sidecar
    /// replies `Error`) when `supportsPan == false`. Composes with
    /// `SetPan`: an absolute command jumps the target, integration then
    /// continues from there.
    SetPanRate(SetPanRatePayload),
    /// Set a *persistent* zoom velocity (normalised, -1..=1). +1 = zoom
    /// IN (FoV decreasing). Holds until a new rate — including zero —
    /// supersedes it; the plugin integrates it into the FoV target every
    /// frame. Ignored (sidecar replies `Error`) when `supportsZoom ==
    /// false`. Composes with the absolute `SetFov` the same way
    /// `SetPanRate` composes with `SetPan`.
    SetZoomRate(SetZoomRatePayload),
    /// Request artificial signal degradation. 0.0 = perfect quality,
    /// 1.0 = maximum degradation. Last-writer-wins: the sidecar stores
    /// the latest value on the camera (degrade is shared across all
    /// viewers of the one encoded stream), so a departed peer can't
    /// pin it. Lets consumers signal to the sidecar "I want to look
    /// like the in-game CommNet antenna is struggling"; sidecar takes
    /// the opportunity to
    /// reduce bitrate + skip frames, which both creates the
    /// signal-loss aesthetic AND saves encoder CPU.
    SetDegrade(SetDegradePayload),
    /// Set (or clear, with `preset: null`) a camera's viewer-requested
    /// resolution preset. Server-wide, last write wins across peers; the
    /// resulting `CameraStateChanged` broadcast keeps every UI
    /// consistent. The effective resolution is always
    /// min(operator ceiling, adaptive level, viewer preset): a preset
    /// can never raise quality past the operator's settings.cfg
    /// Width/Height, and the adaptive controller's demotes keep
    /// winning until it recovers. Viewers can NOT change bitrate or
    /// toggle the adaptive machinery through this message.
    SetQuality(SetQualityPayload),
    /// Request an IDR (keyframe) on the next encode tick. Browsers send
    /// this when they've dropped enough frames to be unable to decode
    /// the current P-frame chain. Sidecar forwards to the camera's
    /// encoder.
    RequestKeyframe(FlightIdPayload),
    /// Dynamically subscribe to a camera on an already-connected peer. The
    /// sidecar binds it to a free pre-negotiated slot (one of the recv-only
    /// video transceivers from the offer), starts encoding it, forces a
    /// keyframe, and replies with `SlotMap` naming the transceiver `mid` now
    /// carrying it — no renegotiation. Replies with `Error` if no slot is
    /// free (the client should have negotiated enough transceivers up front).
    Subscribe(FlightIdPayload),
    /// Release a camera's slot. The sidecar stops feeding that slot (the
    /// camera sleeps if it has no other subscribers) and replies with
    /// `SlotMap { flightId: null }` for the freed transceiver `mid`.
    Unsubscribe(FlightIdPayload),
    /// Response to `Ping`. Browser sends this immediately on receiving each Ping.
    Pong,
    /// Graceful teardown. The canonical way for a client to leave: the sidecar
    /// immediately releases every camera this peer is feeding (so they sleep
    /// without waiting for ICE to time out), after which the client may close
    /// the connection. The drop-detection reaper remains the fallback for
    /// ungraceful exits (crash / tab close / network loss) that can't send this.
    Disconnect,
    /// Enable or disable the KSP main render throttle globally. Persists
    /// across saves (writes the per-save difficulty parameter). Server-wide:
    /// all peers see the resulting `SettingsState` broadcast.
    SetThrottleMainScreen(SetThrottleMainScreenPayload),
}

/// Messages sent FROM the sidecar TO the client.
#[typeshare]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "content", rename_all = "kebab-case")]
/* CameraState carries per-camera state (now including the kerbal-camera
 * fields), dwarfing the other variants. Boxing it would ripple across
 * every construction site for no behaviour change, so allow the size
 * skew instead. */
#[allow(clippy::large_enum_variant)]
pub enum ServerMessage {
    /// Reply to `Hello`. Carries server version + the active encoder
    /// backend's name.
    Hello(HelloPayload),
    /// Full snapshot of every currently-attached camera. Sent in reply
    /// to `Hello` and on any structural change (vessel switch, ring
    /// added/removed).
    CameraSnapshot(CameraSnapshotPayload),
    /// Single-camera state change. Sent when an operator request applies
    /// or adaptive shedding kicks in. Lets clients update their UI
    /// without re-fetching the whole snapshot.
    CameraStateChanged(CameraStateChangedPayload),
    /// Slot↔camera assignment for the dynamic-subscription model. Sent in
    /// reply to `Subscribe`/`Unsubscribe`: `flightId` is the camera now
    /// carried by transceiver `mid`, or `null` when the slot was freed. The
    /// client maps `mid` to the track it received via `onTrack` and routes
    /// that track to (or away from) the camera's stream — no renegotiation.
    SlotMap(SlotMapPayload),
    /// Adaptive shedding level changed. Reason is human-readable
    /// ("ksp-fps-low", "ksp-fps-recovered") so client UIs can show
    /// *why* quality changed rather than just *that* it did.
    AdaptiveShed(AdaptiveShedPayload),
    /// Malformed / unknown client message. Includes the offending
    /// payload so the client can log it.
    Error(ErrorPayload),
    /// Keepalive probe sent by the sidecar every 5 seconds. Browser responds
    /// with `Pong`; if no Ping arrives within 15s the browser tears down
    /// the connection.
    Ping,
    /// Current value of global settings (throttle state). Sent after `Hello`
    /// so a freshly-connected client shows correct state immediately, and
    /// re-broadcast whenever the polled plugin status shows a change.
    SettingsState(SettingsStatePayload),
    /// Whether KSP is in a flight scene. Primed after `Hello` and
    /// re-broadcast when the polled in-flight flag changes.
    SceneStateChanged(SceneStateChangedPayload),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_track_target_roundtrips() {
        let msg = ClientMessage::SetTrackTarget(SetTrackTargetPayload {
            flight_id: 7,
            mode: TrackMode::ActiveVessel,
        });
        let s = serde_json::to_string(&msg).unwrap();
        assert!(s.contains("\"type\":\"set-track-target\""));
        assert!(s.contains("\"content\":"));
        assert!(s.contains("\"flightId\":7"));
        assert!(s.contains("\"mode\":\"activeVessel\""));
        let back: ClientMessage = serde_json::from_str(&s).unwrap();
        match back {
            ClientMessage::SetTrackTarget(p) => {
                assert_eq!(p.flight_id, 7);
                assert_eq!(p.mode, TrackMode::ActiveVessel);
            }
            _ => panic!("wrong variant"),
        }

        // The wire tags for each mode + the default.
        assert_eq!(TrackMode::default(), TrackMode::None);
        for (mode, tag) in [
            (TrackMode::None, "none"),
            (TrackMode::ActiveVessel, "activeVessel"),
            (TrackMode::Target, "target"),
        ] {
            assert_eq!(serde_json::to_string(&mode).unwrap(), format!("\"{tag}\""));
        }
    }

    #[test]
    fn set_layers_roundtrips() {
        let msg = ClientMessage::SetLayers(SetLayersPayload {
            flight_id: 123,
            layers: vec![Layer::Near, Layer::Scaled],
        });
        let s = serde_json::to_string(&msg).unwrap();
        assert!(s.contains("\"type\":\"set-layers\""));
        assert!(s.contains("\"content\":"));
        assert!(s.contains("\"flightId\":123"));
        assert!(s.contains("\"NEAR\""));
        assert!(s.contains("\"SCALED\""));
        let back: ClientMessage = serde_json::from_str(&s).unwrap();
        match back {
            ClientMessage::SetLayers(p) => {
                assert_eq!(p.flight_id, 123);
                assert_eq!(p.layers, vec![Layer::Near, Layer::Scaled]);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn report_display_size_roundtrips() {
        // A consumer reporting its own display px (an aggregatable input for
        // auto-resolution), using the adjacently-tagged kebab-case + `content`
        // wrapper convention every ClientMessage variant shares.
        let msg = ClientMessage::ReportDisplaySize(ReportDisplaySizePayload {
            flight_id: 1,
            width: 40,
            height: 40,
        });
        let s = serde_json::to_string(&msg).unwrap();
        assert!(s.contains("\"type\":\"report-display-size\""));
        assert!(s.contains("\"content\":"));
        assert!(s.contains("\"flightId\":1"));
        assert!(s.contains("\"width\":40"));
        assert!(s.contains("\"height\":40"));
        let back: ClientMessage = serde_json::from_str(&s).unwrap();
        match back {
            ClientMessage::ReportDisplaySize(p) => {
                assert_eq!(p.flight_id, 1);
                assert_eq!(p.width, 40);
                assert_eq!(p.height, 40);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn set_force_full_resolution_roundtrips() {
        let s = r#"{"type":"set-force-full-resolution","content":{"flightId":7,"force":true}}"#;
        let back: ClientMessage = serde_json::from_str(s).unwrap();
        match &back {
            ClientMessage::SetForceFullResolution(p) => {
                assert_eq!(p.flight_id, 7);
                assert!(p.force);
            }
            _ => panic!("wrong variant"),
        }
        let re_serialized = serde_json::to_string(&back).unwrap();
        assert_eq!(re_serialized, s);
    }

    #[test]
    fn camera_state_snapshot_uses_camel_case_keys() {
        let snap = ServerMessage::CameraSnapshot(CameraSnapshotPayload {
            cameras: vec![CameraState {
                flight_id: 99,
                lifecycle: CameraLifecycle::Active,
                kind: CameraKind::Part,
                capture_state: CaptureState::Full,
                kerbal_persistent_id: None,
                crew_location: None,
                track_mode: TrackMode::None,
                part_name: "navCam1".into(),
                part_title: "NavCam".into(),
                camera_name: "NavCam".into(),
                vessel_name: "Perf Test 1".into(),
                layers: vec![Layer::Near, Layer::Scaled],
                operator_layers: vec![Layer::Near, Layer::Scaled, Layer::Galaxy],
                render_width: 384,
                render_height: 384,
                operator_width: 768,
                operator_height: 768,
                supports_zoom: true,
                fov: 60.0,
                fov_min: 30.0,
                fov_max: 100.0,
                supports_pan: false,
                pan_yaw: 0.0,
                pan_pitch: 0.0,
                pan_yaw_min: 0.0,
                pan_yaw_max: 0.0,
                pan_pitch_min: 0.0,
                pan_pitch_max: 0.0,
                encoder_bitrate_bps: 1_500_000,
                target_bitrate_bps: 1_200_000,
                degrade_level: 0.0,
                viewer_quality: Some(QualityPreset::Half),
                quality_limited_by: Some("throttled".into()),
            }],
        });
        let s = serde_json::to_string(&snap).unwrap();
        assert!(s.contains("\"type\":\"camera-snapshot\""));
        assert!(s.contains("\"flightId\":99"));
        assert!(s.contains("\"vesselName\":\"Perf Test 1\""));
        assert!(s.contains("\"operatorWidth\":768"));
        assert!(s.contains("\"renderWidth\":384"));
        assert!(s.contains("\"supportsZoom\":true"));
        assert!(s.contains("\"supportsPan\":false"));
        assert!(s.contains("\"fovMin\":30"));
        assert!(s.contains("\"fovMax\":100"));
        assert!(s.contains("\"viewerQuality\":\"half\""));
        assert!(s.contains("\"qualityLimitedBy\":\"throttled\""));
    }

    /// Unset quality fields are omitted (not null) so the TypeScript
    /// optional-field bindings match the wire, and old payloads without
    /// the fields still deserialize (serde defaults).
    #[test]
    fn camera_state_quality_fields_optional() {
        let state = CameraState {
            flight_id: 1,
            lifecycle: CameraLifecycle::Active,
            kind: CameraKind::Part,
            capture_state: CaptureState::Full,
            kerbal_persistent_id: None,
            crew_location: None,
            track_mode: TrackMode::None,
            part_name: String::new(),
            part_title: String::new(),
            camera_name: String::new(),
            vessel_name: String::new(),
            layers: vec![],
            operator_layers: vec![],
            render_width: 0,
            render_height: 0,
            operator_width: 0,
            operator_height: 0,
            supports_zoom: false,
            fov: 0.0,
            fov_min: 0.0,
            fov_max: 0.0,
            supports_pan: false,
            pan_yaw: 0.0,
            pan_pitch: 0.0,
            pan_yaw_min: 0.0,
            pan_yaw_max: 0.0,
            pan_pitch_min: 0.0,
            pan_pitch_max: 0.0,
            encoder_bitrate_bps: 0,
            target_bitrate_bps: 0,
            degrade_level: 0.0,
            viewer_quality: None,
            quality_limited_by: None,
        };
        let s = serde_json::to_string(&state).unwrap();
        assert!(!s.contains("viewerQuality"), "got {s}");
        assert!(!s.contains("qualityLimitedBy"), "got {s}");

        // Pre-quality-surface JSON (no fields at all) still parses.
        let old = s.clone();
        let back: CameraState = serde_json::from_str(&old).unwrap();
        assert_eq!(back.viewer_quality, None);
        assert_eq!(back.quality_limited_by, None);
    }

    #[test]
    fn set_quality_roundtrips() {
        let msg = ClientMessage::SetQuality(SetQualityPayload {
            flight_id: 7,
            preset: Some(QualityPreset::Quarter),
        });
        let s = serde_json::to_string(&msg).unwrap();
        assert!(s.contains("\"type\":\"set-quality\""));
        assert!(s.contains("\"flightId\":7"));
        assert!(s.contains("\"preset\":\"quarter\""));
        match serde_json::from_str::<ClientMessage>(&s).unwrap() {
            ClientMessage::SetQuality(p) => {
                assert_eq!(p.flight_id, 7);
                assert_eq!(p.preset, Some(QualityPreset::Quarter));
            }
            _ => panic!("wrong variant"),
        }

        // Auto: explicit null AND an absent field both clear the preset.
        let null_preset = r#"{"type":"set-quality","content":{"flightId":7,"preset":null}}"#;
        match serde_json::from_str::<ClientMessage>(null_preset).unwrap() {
            ClientMessage::SetQuality(p) => assert_eq!(p.preset, None),
            _ => panic!("wrong variant"),
        }
        let absent_preset = r#"{"type":"set-quality","content":{"flightId":7}}"#;
        match serde_json::from_str::<ClientMessage>(absent_preset).unwrap() {
            ClientMessage::SetQuality(p) => assert_eq!(p.preset, None),
            _ => panic!("wrong variant"),
        }

        // Garbage preset values are a parse error, not a silent default.
        let garbage = r#"{"type":"set-quality","content":{"flightId":7,"preset":"8k"}}"#;
        assert!(serde_json::from_str::<ClientMessage>(garbage).is_err());
    }

    #[test]
    fn quality_preset_levels_roundtrip() {
        for preset in [
            QualityPreset::Full,
            QualityPreset::ThreeQuarter,
            QualityPreset::Half,
            QualityPreset::Quarter,
        ] {
            assert_eq!(
                QualityPreset::from_viewer_level(preset.viewer_level()),
                Some(preset)
            );
            assert!(preset.scale() <= 1.0, "presets can only lower quality");
        }
        assert_eq!(QualityPreset::from_viewer_level(4), None);
    }

    #[test]
    fn set_degrade_roundtrips() {
        let msg = ClientMessage::SetDegrade(SetDegradePayload {
            flight_id: 7,
            level: 0.65,
        });
        let s = serde_json::to_string(&msg).unwrap();
        assert!(s.contains("\"type\":\"set-degrade\""));
        assert!(s.contains("\"flightId\":7"));
        assert!(s.contains("\"level\":0.65"));
        let back: ClientMessage = serde_json::from_str(&s).unwrap();
        match back {
            ClientMessage::SetDegrade(p) => {
                assert_eq!(p.flight_id, 7);
                assert!((p.level - 0.65).abs() < f32::EPSILON);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn set_fov_roundtrips() {
        let msg = ClientMessage::SetFov(SetFovPayload {
            flight_id: 42,
            fov: 35.5,
        });
        let s = serde_json::to_string(&msg).unwrap();
        assert!(s.contains("\"type\":\"set-fov\""));
        assert!(s.contains("\"flightId\":42"));
        assert!(s.contains("\"fov\":35.5"));
        let back: ClientMessage = serde_json::from_str(&s).unwrap();
        match back {
            ClientMessage::SetFov(p) => {
                assert_eq!(p.flight_id, 42);
                assert!((p.fov - 35.5).abs() < f32::EPSILON);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn set_pan_rate_roundtrips() {
        let msg = ClientMessage::SetPanRate(SetPanRatePayload {
            flight_id: 42,
            yaw_rate: 0.5,
            pitch_rate: -1.0,
        });
        let s = serde_json::to_string(&msg).unwrap();
        assert!(s.contains("\"type\":\"set-pan-rate\""));
        assert!(s.contains("\"flightId\":42"));
        assert!(s.contains("\"yawRate\":0.5"));
        assert!(s.contains("\"pitchRate\":-1"));
        let back: ClientMessage = serde_json::from_str(&s).unwrap();
        match back {
            ClientMessage::SetPanRate(p) => {
                assert_eq!(p.flight_id, 42);
                assert!((p.yaw_rate - 0.5).abs() < f32::EPSILON);
                assert!((p.pitch_rate - -1.0).abs() < f32::EPSILON);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn set_zoom_rate_roundtrips() {
        let msg = ClientMessage::SetZoomRate(SetZoomRatePayload {
            flight_id: 7,
            rate: 1.0,
        });
        let s = serde_json::to_string(&msg).unwrap();
        assert!(s.contains("\"type\":\"set-zoom-rate\""));
        assert!(s.contains("\"flightId\":7"));
        assert!(s.contains("\"rate\":1"));
        let back: ClientMessage = serde_json::from_str(&s).unwrap();
        match back {
            ClientMessage::SetZoomRate(p) => {
                assert_eq!(p.flight_id, 7);
                assert!((p.rate - 1.0).abs() < f32::EPSILON);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn ping_pong_roundtrip() {
        let ping = serde_json::to_string(&ServerMessage::Ping).unwrap();
        assert_eq!(ping, r#"{"type":"ping"}"#);
        let pong = serde_json::to_string(&ClientMessage::Pong).unwrap();
        assert_eq!(pong, r#"{"type":"pong"}"#);
        // Pong should parse back
        let back: ClientMessage = serde_json::from_str(&pong).unwrap();
        assert!(matches!(back, ClientMessage::Pong));
    }

    #[test]
    fn disconnect_roundtrip() {
        let s = serde_json::to_string(&ClientMessage::Disconnect).unwrap();
        assert_eq!(s, r#"{"type":"disconnect"}"#);
        let back: ClientMessage = serde_json::from_str(&s).unwrap();
        assert!(matches!(back, ClientMessage::Disconnect));
    }

    #[test]
    fn unknown_client_variants_fail_cleanly() {
        let bad = r#"{"type":"nonexistent","content":{}}"#;
        let parsed: Result<ClientMessage, _> = serde_json::from_str(bad);
        assert!(parsed.is_err());
    }

    #[test]
    fn hello_unit_variant_omits_content() {
        let msg = ClientMessage::Hello;
        let s = serde_json::to_string(&msg).unwrap();
        // Adjacent-tagged unit variants don't emit a content field.
        assert_eq!(s, r#"{"type":"hello"}"#);
    }

    #[test]
    fn adaptive_shed_serialises_kebab_type() {
        let msg = ServerMessage::AdaptiveShed(AdaptiveShedPayload {
            level: 2,
            ksp_fps: 16.5,
            reason: "ksp-fps-low".into(),
        });
        let s = serde_json::to_string(&msg).unwrap();
        assert!(s.contains("\"type\":\"adaptive-shed\""));
        assert!(s.contains("\"kspFps\":16.5"));
    }

    #[test]
    fn subscribe_roundtrips() {
        let msg = ClientMessage::Subscribe(FlightIdPayload { flight_id: 7 });
        let s = serde_json::to_string(&msg).unwrap();
        assert!(s.contains("\"type\":\"subscribe\""));
        assert!(s.contains("\"flightId\":7"));
        assert!(matches!(
            serde_json::from_str::<ClientMessage>(&s).unwrap(),
            ClientMessage::Subscribe(FlightIdPayload { flight_id: 7 })
        ));
    }

    #[test]
    fn unsubscribe_roundtrips() {
        let msg = ClientMessage::Unsubscribe(FlightIdPayload { flight_id: 7 });
        let s = serde_json::to_string(&msg).unwrap();
        assert!(s.contains("\"type\":\"unsubscribe\""));
        assert!(s.contains("\"flightId\":7"));
        assert!(matches!(
            serde_json::from_str::<ClientMessage>(&s).unwrap(),
            ClientMessage::Unsubscribe(FlightIdPayload { flight_id: 7 })
        ));
    }

    #[test]
    fn slot_map_assigned_and_freed_roundtrip() {
        let assigned = ServerMessage::SlotMap(SlotMapPayload {
            mid: "1".into(),
            flight_id: Some(42),
        });
        let s = serde_json::to_string(&assigned).unwrap();
        assert!(s.contains("\"type\":\"slot-map\""));
        assert!(s.contains("\"mid\":\"1\""));
        assert!(s.contains("\"flightId\":42"));

        // Freed: flightId serialises as null (not omitted) so the client
        // distinguishes "slot freed" from a malformed message.
        let freed = ServerMessage::SlotMap(SlotMapPayload {
            mid: "1".into(),
            flight_id: None,
        });
        let s = serde_json::to_string(&freed).unwrap();
        assert!(s.contains("\"flightId\":null"));
        match serde_json::from_str::<ServerMessage>(&s).unwrap() {
            ServerMessage::SlotMap(p) => {
                assert_eq!(p.mid, "1");
                assert_eq!(p.flight_id, None);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn set_throttle_main_screen_roundtrips() {
        let msg =
            ClientMessage::SetThrottleMainScreen(SetThrottleMainScreenPayload { enabled: true });
        let s = serde_json::to_string(&msg).unwrap();
        assert!(s.contains("\"type\":\"set-throttle-main-screen\""));
        assert!(s.contains("\"enabled\":true"));
        let back: ClientMessage = serde_json::from_str(&s).unwrap();
        match back {
            ClientMessage::SetThrottleMainScreen(p) => assert!(p.enabled),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn settings_state_roundtrips() {
        let msg = ServerMessage::SettingsState(SettingsStatePayload {
            throttle_main_screen: false,
            capture_ut: None,
            capture_epoch: None,
            time_warp_rate: None,
        });
        let s = serde_json::to_string(&msg).unwrap();
        assert!(s.contains("\"type\":\"settings-state\""));
        assert!(s.contains("\"throttleMainScreen\":false"));
        let back: ServerMessage = serde_json::from_str(&s).unwrap();
        match back {
            ServerMessage::SettingsState(p) => assert!(!p.throttle_main_screen),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn scene_state_changed_roundtrips() {
        let msg = ServerMessage::SceneStateChanged(SceneStateChangedPayload { in_flight: false });
        let s = serde_json::to_string(&msg).unwrap();
        assert!(s.contains("\"type\":\"scene-state-changed\""));
        assert!(s.contains("\"inFlight\":false"));
        let back: ServerMessage = serde_json::from_str(&s).unwrap();
        match back {
            ServerMessage::SceneStateChanged(p) => assert!(!p.in_flight),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn settings_state_omits_absent_capture_fields() {
        /* No clock present => the three optional fields never hit the wire. */
        let msg = ServerMessage::SettingsState(SettingsStatePayload {
            throttle_main_screen: true,
            capture_ut: None,
            capture_epoch: None,
            time_warp_rate: None,
        });
        let s = serde_json::to_string(&msg).unwrap();
        assert!(!s.contains("captureUt"));
        assert!(!s.contains("captureEpoch"));
        assert!(!s.contains("timeWarpRate"));
    }

    #[test]
    fn settings_state_without_capture_fields_deserializes_to_none() {
        /* Old-sidecar shape: only throttleMainScreen present. */
        let json = r#"{"type":"settings-state","content":{"throttleMainScreen":false}}"#;
        let back: ServerMessage = serde_json::from_str(json).unwrap();
        match back {
            ServerMessage::SettingsState(p) => {
                assert_eq!(p.capture_ut, None);
                assert_eq!(p.capture_epoch, None);
                assert_eq!(p.time_warp_rate, None);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn settings_state_capture_fields_roundtrip() {
        let msg = ServerMessage::SettingsState(SettingsStatePayload {
            throttle_main_screen: false,
            capture_ut: Some(12345.5),
            capture_epoch: Some(7),
            time_warp_rate: Some(4.0),
        });
        let s = serde_json::to_string(&msg).unwrap();
        assert!(s.contains("\"captureUt\":12345.5"));
        assert!(s.contains("\"captureEpoch\":7"));
        assert!(s.contains("\"timeWarpRate\":4.0"));
        let back: ServerMessage = serde_json::from_str(&s).unwrap();
        match back {
            ServerMessage::SettingsState(p) => {
                assert_eq!(p.capture_ut, Some(12345.5));
                assert_eq!(p.capture_epoch, Some(7));
                assert_eq!(p.time_warp_rate, Some(4.0));
            }
            _ => panic!("wrong variant"),
        }
    }

    /// Pre-kerbal-camera JSON (none of `kind` / `kerbalPersistentId` /
    /// `crewLocation` present) still deserialises, defaulting to a part
    /// camera. Back-compat guarantee for the sidecar's own history and
    /// any consumer built against the pre-Stage-2 wire shape.
    #[test]
    fn camera_state_without_kerbal_fields_defaults_to_part() {
        let json = r#"{
            "flightId": 1,
            "partName": "",
            "partTitle": "",
            "cameraName": "",
            "vesselName": "",
            "layers": [],
            "operatorLayers": [],
            "renderWidth": 0,
            "renderHeight": 0,
            "operatorWidth": 0,
            "operatorHeight": 0,
            "supportsZoom": false,
            "fov": 0.0,
            "fovMin": 0.0,
            "fovMax": 0.0,
            "supportsPan": false,
            "panYaw": 0.0,
            "panPitch": 0.0,
            "panYawMin": 0.0,
            "panYawMax": 0.0,
            "panPitchMin": 0.0,
            "panPitchMax": 0.0,
            "encoderBitrateBps": 0,
            "targetBitrateBps": 0,
            "degradeLevel": 0.0
        }"#;
        let back: CameraState = serde_json::from_str(json).unwrap();
        assert_eq!(back.kind, CameraKind::Part);
        assert_eq!(back.kerbal_persistent_id, None);
        assert_eq!(back.crew_location, None);
    }

    /// A kerbal face camera round-trips its `kind`, `kerbalPersistentId`
    /// and `crewLocation` intact, honoring the camelCase wire names.
    #[test]
    fn kerbal_camera_state_roundtrips() {
        let state = CameraState {
            flight_id: 42,
            lifecycle: CameraLifecycle::Active,
            kind: CameraKind::Kerbal,
            capture_state: CaptureState::Full,
            kerbal_persistent_id: Some(123456),
            crew_location: Some(CrewLocation::Eva),
            track_mode: TrackMode::None,
            part_name: String::new(),
            part_title: String::new(),
            camera_name: "Jebediah Kerman".into(),
            vessel_name: "Perf Test 1".into(),
            layers: vec![],
            operator_layers: vec![],
            render_width: 0,
            render_height: 0,
            operator_width: 0,
            operator_height: 0,
            supports_zoom: false,
            fov: 0.0,
            fov_min: 0.0,
            fov_max: 0.0,
            supports_pan: false,
            pan_yaw: 0.0,
            pan_pitch: 0.0,
            pan_yaw_min: 0.0,
            pan_yaw_max: 0.0,
            pan_pitch_min: 0.0,
            pan_pitch_max: 0.0,
            encoder_bitrate_bps: 0,
            target_bitrate_bps: 0,
            degrade_level: 0.0,
            viewer_quality: None,
            quality_limited_by: None,
        };
        let s = serde_json::to_string(&state).unwrap();
        assert!(s.contains("\"kind\":\"kerbal\""));
        assert!(s.contains("\"kerbalPersistentId\":123456"));
        assert!(s.contains("\"crewLocation\":\"eva\""));

        let back: CameraState = serde_json::from_str(&s).unwrap();
        assert_eq!(back.kind, CameraKind::Kerbal);
        assert_eq!(back.kerbal_persistent_id, Some(123456));
        assert_eq!(back.crew_location, Some(CrewLocation::Eva));
    }
}
