//! Software H.264 encoder via Cisco OpenH264 (bundled source, no system
//! deps). The "always available" fallback in the EncoderBackend tier
//! ladder — every host can encode here, just at lower performance than
//! the hardware backends (libva on Linux, VideoToolbox on macOS, Media
//! Foundation on Windows).
//!
//! Input is RGBA8888 (4 bytes/pixel, top-down, tightly packed) per the
//! `RawFrame` contract. We convert to YUV420P (I420) for OpenH264, which
//! is the only colour format the encoder accepts. Conversion uses
//! openh264's bundled `YUVBuffer::from_rgb_source` helper after stripping
//! the alpha channel (OpenH264 doesn't ingest RGBA directly).

use openh264::encoder::{BitRate, Encoder, EncoderConfig, FrameRate};
use openh264::formats::{RgbSliceU8, YUVBuffer};
use openh264::OpenH264API;
use tracing::{debug, warn};

use super::{EncodeConfig, EncodeError, EncoderBackend, Nal, RawFrame};

pub struct Software {
    cfg: Option<EncodeConfig>,
    encoder: Option<Encoder>,
    keyframe_requested: bool,
    /// Reusable RGB scratch buffer — RGBA → RGB strip lives here per frame
    /// to avoid per-frame allocation in the hot path.
    rgb_scratch: Vec<u8>,
    frames_encoded: u64,
    /// Force an IDR every N encoded frames so a decoder that lost the
    /// reference chain (packet loss / heavy degrade) always recovers within a
    /// bounded window. OpenH264 emits no periodic intra on its own; libva
    /// sets an equivalent GOP. 0 disables (pre-init).
    intra_period: u64,
}

impl Software {
    pub fn new() -> Self {
        Self {
            cfg: None,
            encoder: None,
            keyframe_requested: false,
            rgb_scratch: Vec::new(),
            frames_encoded: 0,
            intra_period: 0,
        }
    }
}

impl Default for Software {
    fn default() -> Self {
        Self::new()
    }
}

impl EncoderBackend for Software {
    fn name(&self) -> &'static str {
        "openh264 (software)"
    }

    fn is_available(&self) -> bool {
        // Bundled OpenH264 source builds at compile time, so this backend is
        // available on every host that the sidecar binary itself runs on.
        // That guarantees `auto_select` never returns None.
        true
    }

    fn is_hardware(&self) -> bool {
        false
    }

    fn init(&mut self, cfg: EncodeConfig) -> Result<(), EncodeError> {
        if cfg.width == 0 || cfg.height == 0 {
            return Err(EncodeError::Invalid("zero-sized dimensions".into()));
        }
        if cfg.fps == 0 {
            return Err(EncodeError::Invalid("fps == 0".into()));
        }
        // OpenH264 requires even dimensions for YUV420 chroma subsampling.
        if !cfg.width.is_multiple_of(2) || !cfg.height.is_multiple_of(2) {
            return Err(EncodeError::Invalid(format!(
                "dimensions must be even (got {}x{})",
                cfg.width, cfg.height
            )));
        }

        // EncoderConfig in openh264 0.9 takes no resolution — the encoder
        // picks it up from the first YUVBuffer fed to encode(). We just set
        // framerate + target bitrate here.
        let enc_cfg = EncoderConfig::new()
            .max_frame_rate(FrameRate::from_hz(cfg.fps as f32))
            .bitrate(BitRate::from_bps(cfg.bitrate_bps));

        let encoder = Encoder::with_api_config(OpenH264API::from_source(), enc_cfg)
            .map_err(|e| EncodeError::Runtime(format!("OpenH264 encoder init failed: {e}")))?;

        self.rgb_scratch
            .resize((cfg.width as usize) * (cfg.height as usize) * 3, 0);
        debug!(
            width = cfg.width,
            height = cfg.height,
            fps = cfg.fps,
            "Software encoder initialised"
        );
        // ~2s GOP, matching the libva backend's set_gop(fps*2).
        self.intra_period = (cfg.fps as u64).saturating_mul(2);
        self.cfg = Some(cfg);
        self.encoder = Some(encoder);
        self.keyframe_requested = false;
        self.frames_encoded = 0;
        Ok(())
    }

    fn encode(&mut self, frame: &RawFrame<'_>) -> Result<Vec<Nal>, EncodeError> {
        let cfg = self
            .cfg
            .as_ref()
            .ok_or_else(|| EncodeError::Runtime("encode before init".into()))?;
        let encoder = self
            .encoder
            .as_mut()
            .ok_or_else(|| EncodeError::Runtime("encoder dropped after init".into()))?;

        let expected = (frame.width as usize) * (frame.height as usize) * 4;
        if frame.data.len() != expected {
            return Err(EncodeError::Invalid(format!(
                "frame size {} != width*height*4 ({})",
                frame.data.len(),
                expected
            )));
        }
        if frame.width != cfg.width || frame.height != cfg.height {
            return Err(EncodeError::Invalid(format!(
                "frame dims {}x{} != configured {}x{}",
                frame.width, frame.height, cfg.width, cfg.height
            )));
        }

        // Strip RGBA → RGB into the reusable scratch buffer. OpenH264's
        // helper only accepts RGB; the alpha channel is lost (we don't
        // need it for video transport).
        let pixel_count = (frame.width as usize) * (frame.height as usize);
        for i in 0..pixel_count {
            let src = i * 4;
            let dst = i * 3;
            self.rgb_scratch[dst] = frame.data[src];
            self.rgb_scratch[dst + 1] = frame.data[src + 1];
            self.rgb_scratch[dst + 2] = frame.data[src + 2];
        }

        let rgb_source = RgbSliceU8::new(
            &self.rgb_scratch,
            (frame.width as usize, frame.height as usize),
        );
        let yuv = YUVBuffer::from_rgb_source(rgb_source);

        // Periodic IDR (every intra_period encoded frames) plus any on-demand
        // request. Frame 0 is already an IDR from OpenH264, so the periodic
        // check skips it. Keeps every backend recoverable within one GOP.
        let periodic = self.intra_period > 0
            && self.frames_encoded > 0
            && self.frames_encoded.is_multiple_of(self.intra_period);
        if self.keyframe_requested || periodic {
            encoder.force_intra_frame();
            self.keyframe_requested = false;
        }

        let bitstream = encoder
            .encode(&yuv)
            .map_err(|e| EncodeError::Runtime(format!("OpenH264 encode failed: {e}")))?;

        // EncodedBitStream is a layered structure: one or more layers, each
        // with one or more NAL units. Flatten to a Vec<Nal> for our
        // backend-agnostic interface.
        let mut nals = Vec::new();
        for layer_idx in 0..bitstream.num_layers() {
            let layer = match bitstream.layer(layer_idx) {
                Some(l) => l,
                None => {
                    warn!(layer_idx, "OpenH264 returned None for declared layer");
                    continue;
                }
            };
            for nal_idx in 0..layer.nal_count() {
                if let Some(nal_bytes) = layer.nal_unit(nal_idx) {
                    nals.push(Nal(nal_bytes.to_vec()));
                }
            }
        }

        self.frames_encoded += 1;
        Ok(nals)
    }

    fn request_keyframe(&mut self) {
        self.keyframe_requested = true;
    }

    fn close(&mut self) {
        self.encoder = None;
        self.cfg = None;
        self.keyframe_requested = false;
        self.rgb_scratch.clear();
        self.rgb_scratch.shrink_to_fit();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> EncodeConfig {
        EncodeConfig {
            width: 64,
            height: 64,
            fps: 30,
            bitrate_bps: 500_000,
        }
    }

    fn synthetic_rgba(width: u32, height: u32, frame_n: u32) -> Vec<u8> {
        let mut data = Vec::with_capacity((width * height * 4) as usize);
        let seed = (frame_n & 0xFF) as u8;
        for y in 0..height {
            for x in 0..width {
                data.push(((x * 255 / width) & 0xFF) as u8);
                data.push(((y * 255 / height) & 0xFF) as u8);
                data.push(seed);
                data.push(0xFF);
            }
        }
        data
    }

    #[test]
    fn always_available() {
        assert!(Software::new().is_available());
    }

    #[test]
    fn classified_as_software() {
        assert!(!Software::new().is_hardware());
    }

    #[test]
    fn odd_dims_rejected() {
        let mut e = Software::new();
        let err = e
            .init(EncodeConfig {
                width: 65,
                height: 64,
                fps: 30,
                bitrate_bps: 500_000,
            })
            .unwrap_err();
        assert!(matches!(err, EncodeError::Invalid(_)));
    }

    /// `Nal::is_keyframe` must actually recognise a real encoder's IDR. The hum
    /// promotion path depends on it: a promoted camera is published as
    /// `Ramping` until an IDR is seen in the output, so if this detection is
    /// wrong the camera never reports `Full` and a consumer's overlay sticks
    /// forever. Asserted against genuine encoder bytes rather than a
    /// hand-rolled fixture, since the whole risk is that the real NAL framing
    /// differs from what the parser assumes.
    #[test]
    fn is_keyframe_detects_a_real_encoders_idr() {
        let mut e = Software::new();
        e.init(cfg()).unwrap();

        let frame = synthetic_rgba(64, 64, 0);
        let nals = e
            .encode(&RawFrame {
                width: 64,
                height: 64,
                data: &frame,
                capture_ts_ms: 0.0,
            })
            .unwrap();
        assert!(
            nals.iter().any(|n| n.is_keyframe()),
            "the first frame is an IDR and must be detected as one"
        );

        // And it must not fire on every frame, or "promotion complete" would be
        // meaningless — it'd resolve instantly whether or not an IDR landed.
        let mut saw_non_keyframe_frame = false;
        for i in 1..5 {
            let f = synthetic_rgba(64, 64, i);
            let out = e
                .encode(&RawFrame {
                    width: 64,
                    height: 64,
                    data: &f,
                    capture_ts_ms: i as f64,
                })
                .unwrap();
            if !out.iter().any(|n| n.is_keyframe()) {
                saw_non_keyframe_frame = true;
            }
        }
        assert!(
            saw_non_keyframe_frame,
            "some later frame should be a non-IDR, else detection is vacuous"
        );

        // An explicit request produces a detectable IDR — the exact call the
        // promotion path makes.
        e.request_keyframe();
        let f = synthetic_rgba(64, 64, 99);
        let out = e
            .encode(&RawFrame {
                width: 64,
                height: 64,
                data: &f,
                capture_ts_ms: 99.0,
            })
            .unwrap();
        assert!(
            out.iter().any(|n| n.is_keyframe()),
            "request_keyframe() must yield an IDR the promotion path can see"
        );
    }

    #[test]
    fn init_then_encode_a_correctly_sized_frame_returns_real_nals() {
        let mut e = Software::new();
        e.init(cfg()).unwrap();
        let frame = synthetic_rgba(64, 64, 0);
        let nals = e
            .encode(&RawFrame {
                width: 64,
                height: 64,
                data: &frame,
                capture_ts_ms: 0.0,
            })
            .unwrap();
        // First frame is always a keyframe — OpenH264 emits at least one
        // NAL unit (SPS/PPS bundled into the first slice or as separate
        // NALs, depending on config). Either way, > 0.
        assert!(!nals.is_empty(), "first frame produced zero NALs");
        // Real NAL bytes start with 0x00 00 00 01 (4-byte start code) or
        // 0x00 00 01 (3-byte). First byte after start code is the NAL
        // header — never 0.
        let first = &nals[0].0;
        assert!(
            first.len() > 4,
            "NAL too short to contain a start code + payload: {} bytes",
            first.len()
        );
    }

    #[test]
    fn periodic_idr_fires_within_a_gop() {
        let mut e = Software::new();
        let c = cfg();
        let (w, h, fps) = (c.width, c.height, c.fps);
        e.init(c).unwrap();
        let gop = fps * 2; // matches init's intra_period
        let mut idr_at = Vec::new();
        for n in 0..(gop + 2) {
            let frame = synthetic_rgba(w, h, n);
            let nals = e
                .encode(&RawFrame {
                    width: w,
                    height: h,
                    data: &frame,
                    capture_ts_ms: 0.0,
                })
                .unwrap();
            if nals.iter().any(|nal| has_idr(&nal.0)) {
                idr_at.push(n);
            }
        }
        assert!(
            idr_at.contains(&0),
            "frame 0 should be an IDR, got {idr_at:?}"
        );
        assert!(
            idr_at.iter().any(|&n| n > 0 && n <= gop),
            "a periodic IDR should fire within one GOP, got {idr_at:?}"
        );
    }

    /// Annex-B scan for an IDR slice (nal_unit_type == 5).
    fn has_idr(bytes: &[u8]) -> bool {
        let mut i = 0;
        while i + 4 < bytes.len() {
            let (hdr, past) = if bytes[i..i + 4] == [0u8, 0, 0, 1] {
                (bytes[i + 4], i + 5)
            } else if bytes[i..i + 3] == [0u8, 0, 1] {
                (bytes[i + 3], i + 4)
            } else {
                i += 1;
                continue;
            };
            if hdr & 0x1F == 5 {
                return true;
            }
            i = past;
        }
        false
    }

    #[test]
    fn encode_before_init_errors() {
        let mut e = Software::new();
        let frame = synthetic_rgba(64, 64, 0);
        let err = e
            .encode(&RawFrame {
                width: 64,
                height: 64,
                data: &frame,
                capture_ts_ms: 0.0,
            })
            .unwrap_err();
        assert!(matches!(err, EncodeError::Runtime(_)));
    }

    #[test]
    fn wrong_dimensions_errors() {
        let mut e = Software::new();
        e.init(cfg()).unwrap();
        let frame = synthetic_rgba(128, 128, 0);
        let err = e
            .encode(&RawFrame {
                width: 128,
                height: 128,
                data: &frame,
                capture_ts_ms: 0.0,
            })
            .unwrap_err();
        assert!(matches!(err, EncodeError::Invalid(_)));
    }

    #[test]
    fn keyframe_request_doesnt_panic_and_continues_encoding() {
        let mut e = Software::new();
        e.init(cfg()).unwrap();
        // Encode a few frames, request a keyframe, encode more — all should succeed.
        for n in 0..5 {
            let frame = synthetic_rgba(64, 64, n);
            e.encode(&RawFrame {
                width: 64,
                height: 64,
                data: &frame,
                capture_ts_ms: n as f64 * 33.3,
            })
            .unwrap();
        }
        e.request_keyframe();
        for n in 5..10 {
            let frame = synthetic_rgba(64, 64, n);
            e.encode(&RawFrame {
                width: 64,
                height: 64,
                data: &frame,
                capture_ts_ms: n as f64 * 33.3,
            })
            .unwrap();
        }
    }
}
