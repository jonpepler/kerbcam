//! Encoder backend trait + factory + stub implementations per OS tier.
//!
//! See the gonogo repo's `local_docs/ocisly_state_and_rebuild.md` §2.3.
//! Tier-1 is libva (Steam Deck Linux). Tier-2 is VideoToolbox (macOS),
//! NVENC (Windows/NVIDIA, stub) and Media Foundation (Windows, vendor-
//! generic hardware MFTs). Software fallback (OpenH264 / x264) ships
//! always to guarantee any host can encode at reduced quality.

use clap::ValueEnum;
use thiserror::Error;

mod annexb;
mod convert;
mod escalation;
mod libva;
mod mediafoundation;
mod nvenc;
mod software;
mod videotoolbox;

pub use escalation::{
    record_init_failure, SessionHealth, SessionVerdict, SILENT_SESSION_FRAME_LIMIT,
};
pub use libva::Libva;
pub use mediafoundation::MediaFoundation;
pub use nvenc::Nvenc;
pub use software::Software;
pub use videotoolbox::VideoToolbox;

/// CLI/registry-friendly enum of backends. `Auto` picks the best
/// available at construction time.
#[derive(Copy, Clone, Debug, ValueEnum)]
pub enum EncoderChoice {
    Auto,
    Libva,
    Videotoolbox,
    Nvenc,
    Mediafoundation,
    Software,
}

/// Construct a fresh backend for an `EncoderChoice`. One call per
/// per-camera encoder session — each camera gets its own backend
/// instance with its own SPS/PPS + keyframe state.
pub fn select_backend(choice: EncoderChoice) -> Box<dyn EncoderBackend> {
    match choice {
        EncoderChoice::Auto => auto_select(),
        EncoderChoice::Libva => Box::new(Libva::new()),
        EncoderChoice::Videotoolbox => Box::new(VideoToolbox::new()),
        EncoderChoice::Nvenc => Box::new(Nvenc::new()),
        EncoderChoice::Mediafoundation => Box::new(MediaFoundation::new()),
        EncoderChoice::Software => Box::new(Software::new()),
    }
}

/// A single encoded NAL unit. The exact slicing is encoder-specific; consumers
/// (the WebRTC packetiser) should treat each Nal as one bytestring to feed
/// into the H.264 depacketiser without further parsing.
#[derive(Debug, Clone)]
pub struct Nal(pub Vec<u8>);

impl Nal {
    /// Whether this NAL is an IDR slice (`nal_unit_type == 5`) — the unit a
    /// decoder can start cleanly from. Used to tell when a forced keyframe has
    /// actually gone out, rather than assuming it did because one was asked for.
    pub fn is_keyframe(&self) -> bool {
        let b = &self.0;
        let hdr = if b.len() > 4 && b[..4] == [0, 0, 0, 1] {
            b[4]
        } else if b.len() > 3 && b[..3] == [0, 0, 1] {
            b[3]
        } else {
            return false;
        };
        hdr & 0x1F == 5
    }
}

/// One frame's worth of raw input pixels. RGBA8, top-down, tightly packed.
/// `width * height * 4 == data.len()` is a documented invariant; encoders
/// must validate on init.
#[derive(Debug)]
pub struct RawFrame<'a> {
    pub width: u32,
    pub height: u32,
    pub data: &'a [u8],
    /// Capture timestamp from KSP's `Time.unscaledTime * 1000` (ms). Carried
    /// end-to-end so receivers can compute glass-to-glass latency.
    pub capture_ts_ms: f64,
}

/// Configuration for one encode session, applied at `init` and immutable for
/// the session's lifetime. Resolution changes mean `close + init` to a new
/// session at a keyframe boundary.
#[derive(Debug, Clone)]
pub struct EncodeConfig {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate_bps: u32,
}

#[derive(Debug, Error)]
pub enum EncodeError {
    #[error("encoder backend not available on this platform")]
    Unavailable,
    #[error("invalid input: {0}")]
    Invalid(String),
    #[error("encoder runtime error: {0}")]
    Runtime(String),
}

/// Common surface every backend implements. Backends own the lifecycle of
/// their underlying encoder session (e.g. libva context, VTCompressionSession,
/// NvencEncoder handle).
pub trait EncoderBackend: Send {
    /// Human-readable identifier for logs and `/metrics`.
    fn name(&self) -> &'static str;

    /// True if the underlying encoder can be initialised on this host. Used
    /// at `--encoder=auto` enumeration; backends with `false` are skipped.
    fn is_available(&self) -> bool;

    /// True when encoding runs on dedicated hardware (VAAPI, NVENC,
    /// VideoToolbox) rather than the CPU. Drives the default bitrate:
    /// hardware sessions default higher than the software fallback.
    /// Deliberately no default impl, so every new backend has to
    /// classify itself.
    fn is_hardware(&self) -> bool;

    /// Allocate the encoder session for `cfg`. Must be called before `encode`.
    fn init(&mut self, cfg: EncodeConfig) -> Result<(), EncodeError>;

    /// Push one raw frame and return any NAL units produced. May return zero
    /// NALs (e.g. encoder is buffering) — that's fine and not an error.
    fn encode(&mut self, frame: &RawFrame<'_>) -> Result<Vec<Nal>, EncodeError>;

    /// Hint to the encoder that the next emitted frame should be an IDR.
    /// Useful when a new subscriber attaches; called by the WebRTC peer.
    fn request_keyframe(&mut self);

    /// Release encoder resources. Must be idempotent.
    fn close(&mut self);
}

/// Pick the best available backend for the current platform. Tier-1 first
/// (libva on Linux), tier-2 next (VideoToolbox / NVENC / Media
/// Foundation), software last. Media Foundation sits after NVENC so a
/// future NVIDIA-specific path still wins where present, while
/// vendor-generic hardware MF encode beats software everywhere else.
pub fn auto_select() -> Box<dyn EncoderBackend> {
    let candidates: [Box<dyn EncoderBackend>; 5] = [
        Box::new(Libva::new()),
        Box::new(VideoToolbox::new()),
        Box::new(Nvenc::new()),
        Box::new(MediaFoundation::new()),
        Box::new(Software::new()),
    ];
    for b in candidates {
        if b.is_available() {
            return b;
        }
    }
    // Software backend always reports available so this is unreachable in
    // practice, but the type checker doesn't know that.
    Box::new(Software::new())
}

/// Default encode bitrate (bps) for hardware backends when the operator
/// passes no `--bitrate-bps`. Hardware encode is cheap enough per frame
/// that we can spend the extra bits on picture quality.
pub const DEFAULT_HARDWARE_BITRATE_BPS: u32 = 4_000_000;

/// Default encode bitrate (bps) for the software fallback. The
/// long-standing conservative default the CPU budget was tuned around.
pub const DEFAULT_SOFTWARE_BITRATE_BPS: u32 = 1_500_000;

/// Backend-classified default bitrate: hardware backends get headroom,
/// the software fallback stays conservative.
pub fn default_bitrate_bps(backend: &dyn EncoderBackend) -> u32 {
    if backend.is_hardware() {
        DEFAULT_HARDWARE_BITRATE_BPS
    } else {
        DEFAULT_SOFTWARE_BITRATE_BPS
    }
}

/// Resolve the effective session bitrate: an explicit operator value
/// always wins; otherwise the default derives from the selected backend.
pub fn resolve_bitrate_bps(explicit: Option<u32>, backend: &dyn EncoderBackend) -> u32 {
    explicit.unwrap_or_else(|| default_bitrate_bps(backend))
}

/// Return the name of the backend that `auto_select` would choose. Defers
/// to `auto_select` so the candidate list lives in exactly one place; only
/// called off the hot path (startup / `/metrics`), so the throwaway probe
/// allocation is fine.
pub fn selected_backend_name() -> &'static str {
    auto_select().name()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classification_matches_backend_tier() {
        assert!(!Software::new().is_hardware());
        assert!(Libva::new().is_hardware());
        assert!(VideoToolbox::new().is_hardware());
        assert!(Nvenc::new().is_hardware());
    }

    #[test]
    fn software_backend_defaults_to_the_conservative_bitrate() {
        assert_eq!(
            default_bitrate_bps(&Software::new()),
            DEFAULT_SOFTWARE_BITRATE_BPS
        );
        assert_eq!(resolve_bitrate_bps(None, &Software::new()), 1_500_000);
    }

    #[test]
    fn hardware_backends_default_higher() {
        // Classification is static per type, so no real hardware (or even
        // an available backend) is needed here.
        assert_eq!(resolve_bitrate_bps(None, &Libva::new()), 4_000_000);
        assert_eq!(resolve_bitrate_bps(None, &VideoToolbox::new()), 4_000_000);
        assert_eq!(resolve_bitrate_bps(None, &Nvenc::new()), 4_000_000);
    }

    #[test]
    fn explicit_bitrate_wins_over_any_backend_default() {
        assert_eq!(
            resolve_bitrate_bps(Some(2_000_000), &Libva::new()),
            2_000_000
        );
        assert_eq!(
            resolve_bitrate_bps(Some(2_000_000), &Software::new()),
            2_000_000
        );
    }
}
