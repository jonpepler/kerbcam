//! Shared-memory **control block** — the sidecar (writer) → KSP plugin (reader)
//! control channel. It replaces `<flight_id>.control.json` + the plugin's
//! file-poll-and-JSON-parse with a fixed-layout mmap synced by a seqlock.
//!
//! This is the mirror image of the frame ring (`mmap.rs` ↔ `MmapFrameRing.cs`):
//! there the plugin writes and the sidecar reads; here the sidecar writes and
//! the plugin reads. The binary layout is a hard cross-language contract — it
//! MUST stay byte-for-byte in lockstep with `Plugin/Kerbcast/ControlBlock.cs`.
//! Any field reorder / addition is a `CONTROL_LAYOUT_VERSION` bump on both
//! sides. `control_block_v2.bin` (in `testdata/`) is the golden fixture both
//! sides validate against so they can't silently drift.
//!
//! ```text
//! HEADER (4096 B, page-aligned — matches the frame ring)
//!   0    8   u64 magic = 0x004B435452_4C42_31xx?  see CONTROL_MAGIC
//!   8    4   u32 version (= CONTROL_LAYOUT_VERSION)
//!   12   4   padding
//!   16   8   u64 seq  (seqlock: even = stable, odd = write in progress)
//!   24 .. 4096  padding
//!
//! BODY (at offset 4096; 256 B reserved, ~52 used)
//!   +0   4   u32 fields_present  (bitmask — which Option fields are set;
//!                                 mirrors serde skip_serializing_if=None)
//!   +4   1   u8  subscribed
//!   +5   3   padding
//!   +8   4   u32 layers_mask     (Near=1, Scaled=2, Far=8, Galaxy=4)
//!   +12  4   u32 width
//!   +16  4   u32 height
//!   +20  4   f32 fov
//!   +24  4   f32 pan_yaw
//!   +28  4   f32 pan_pitch
//!   +32  4   f32 pan_yaw_rate
//!   +36  4   f32 pan_pitch_rate
//!   +40  4   f32 zoom_rate
//!   +44  4   u32 pan_seq
//!   +48  4   u32 fov_seq
//!   +52  4   u32 viewer_level   (viewer quality clamp: index into the
//!                                plugin's QualityClamp.ViewerScales; absent
//!                                = auto, no viewer clamp)
//!   +56  4   u32 track_mode     (auto-track: 0=none, 1=active-vessel,
//!                                2=target. Present-bit CLEAR = none/off; the
//!                                sidecar always writes full state, so "absent"
//!                                unambiguously means not-tracking here, unlike
//!                                the leave-untouched semantics of the fields
//!                                above.)
//!   +60  4   u32 track_seq      (FIXED field, always read — like pan_seq /
//!                                fov_seq. Bumped by the sidecar on ANY
//!                                authoritative track_mode change; the plugin
//!                                applies track_mode only on a change, so the
//!                                every-flush stale value can't revert a kOS-set
//!                                mode. Append -> no version bump.)
//!   +64  4   f32 capture_fps    (requested capture rate. Present-bit CLEAR =
//!                                capture at the primary rate, which is what a
//!                                sidecar predating background capture writes. A low value is a
//!                                background background capture. Append -> no version bump.)
//! ```
//!
//! NOTE: this field is an APPEND with its own `fields_present` bit, NOT a layout
//! version bump. The bitmask is forward-compatible by construction: an old
//! reader ignores a bit it doesn't know and never touches +56 (previously-zero
//! reserved body space), so v2 and v3-with-track_mode interoperate. Only a
//! field REORDER or a body-size change needs a `CONTROL_LAYOUT_VERSION` bump.
//! The golden fixture stays byte-identical (its `fixture_state` leaves
//! track_mode = None, so the bit is clear and +56 is zero).
//!
//! Seqlock (single writer / single reader): the writer stores `seq` odd
//! (Release), writes the body, then stores `seq` even (Release). The reader
//! loads `seq` (Acquire); if odd it's mid-write (retry); reads the body;
//! re-loads `seq` (Acquire) and retries if it changed. `seq` is also the
//! reader's change detector — a published (even) value it has already applied
//! means nothing changed, so it skips. Monotonic, so collision-proof (unlike
//! the mtime/content-compare it replaces).

use std::fs::OpenOptions;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use memmap2::{MmapMut, MmapOptions};

use crate::cameras::ControlState;
use crate::protocol::{Layer, TrackMode};

/// "KCTRLB1\0" little-endian. Distinct from the frame ring's "KERBCAST1".
pub const CONTROL_MAGIC: u64 = 0x0031_424C_5254_434B;
pub const CONTROL_LAYOUT_VERSION: u32 = 2;
pub const CONTROL_HEADER_SIZE: usize = 4096;
/// Reserved body region — far larger than the ~52 bytes used, leaving slack
/// for future fields without a file-size change.
pub const CONTROL_BODY_SIZE: usize = 256;
pub const CONTROL_TOTAL_SIZE: usize = CONTROL_HEADER_SIZE + CONTROL_BODY_SIZE;

// Header offsets.
const H_MAGIC: usize = 0;
const H_VERSION: usize = 8;
const H_SEQ: usize = 16;

// Body offsets, relative to CONTROL_HEADER_SIZE.
const B_FIELDS_PRESENT: usize = 0;
const B_SUBSCRIBED: usize = 4;
const B_LAYERS_MASK: usize = 8;
const B_WIDTH: usize = 12;
const B_HEIGHT: usize = 16;
const B_FOV: usize = 20;
const B_PAN_YAW: usize = 24;
const B_PAN_PITCH: usize = 28;
const B_PAN_YAW_RATE: usize = 32;
const B_PAN_PITCH_RATE: usize = 36;
const B_ZOOM_RATE: usize = 40;
const B_PAN_SEQ: usize = 44;
const B_FOV_SEQ: usize = 48;
const B_VIEWER_LEVEL: usize = 52;
const B_TRACK_MODE: usize = 56;
// track_seq (+60): a monotonic counter the SIDECAR bumps on ANY authoritative
// track_mode change (a browser SetTrackTarget OR adopting a kOS report). A FIXED
// field, always written / always read — exactly like pan_seq / fov_seq, NOT
// present-bit-gated. The plugin applies the control-block track_mode ONLY when
// track_seq changes (edge-trigger), so the every-flush stale track_mode can't
// revert a kOS-set mode. Appended within the reserved body -> no version bump.
const B_TRACK_SEQ: usize = 60;
// capture_fps (+64): the rate the plugin should capture this camera at, in
// frames per second. Present-bit gated: clear = capture at the primary rate,
// which is what a sidecar predating background capture writes and what the plugin already did. A low
// value is a background "background capture" — subscribed, but paced far below primary because
// nothing is displaying it at size. Appended within the reserved body, so the
// golden fixture stays byte-identical and old/new builds interoperate.
const B_CAPTURE_FPS: usize = 64;

// `fields_present` bits — one per Option/Vec field that can be "unset".
pub const FP_LAYERS: u32 = 1 << 0;
pub const FP_WIDTH: u32 = 1 << 1;
pub const FP_HEIGHT: u32 = 1 << 2;
pub const FP_FOV: u32 = 1 << 3;
pub const FP_PAN_YAW: u32 = 1 << 4;
pub const FP_PAN_PITCH: u32 = 1 << 5;
pub const FP_PAN_YAW_RATE: u32 = 1 << 6;
pub const FP_PAN_PITCH_RATE: u32 = 1 << 7;
pub const FP_ZOOM_RATE: u32 = 1 << 8;
pub const FP_VIEWER_LEVEL: u32 = 1 << 9;
pub const FP_TRACK_MODE: u32 = 1 << 10;
pub const FP_CAPTURE_FPS: u32 = 1 << 11;

/// Auto-track mode → the u32 the plugin decodes (0=none, 1=active-vessel,
/// 2=target). Keep in lockstep with ControlBlock.cs's SetTrackMode mapping.
pub fn track_mode_to_u32(m: TrackMode) -> u32 {
    match m {
        TrackMode::None => 0,
        TrackMode::ActiveVessel => 1,
        TrackMode::Target => 2,
    }
}

pub fn layers_to_mask(layers: &[Layer]) -> u32 {
    let mut mask = 0u32;
    for l in layers {
        mask |= match l {
            Layer::Near => 1,
            Layer::Scaled => 2,
            Layer::Far => 8,
            Layer::Galaxy => 4,
        };
    }
    mask
}

/// Writer side. Owns the mmap for one camera's control block and keeps the
/// seqlock counter advancing across writes (so it must be persisted per
/// camera, not recreated per flush — recreating would reset `seq` and the
/// plugin's change detection would miss the write).
pub struct ControlBlock {
    mmap: MmapMut,
}

impl ControlBlock {
    /// Create (or truncate) the block file, zero it, and stamp magic+version.
    /// `seq` starts at 0 (even) = "no write published yet".
    pub fn create(path: &Path) -> std::io::Result<Self> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(true)
            .open(path)?;
        file.set_len(CONTROL_TOTAL_SIZE as u64)?;
        let mut mmap = unsafe { MmapOptions::new().len(CONTROL_TOTAL_SIZE).map_mut(&file)? };
        for b in mmap.iter_mut() {
            *b = 0;
        }
        mmap[H_MAGIC..H_MAGIC + 8].copy_from_slice(&CONTROL_MAGIC.to_le_bytes());
        mmap[H_VERSION..H_VERSION + 4].copy_from_slice(&CONTROL_LAYOUT_VERSION.to_le_bytes());
        Ok(Self { mmap })
    }

    fn seq_atomic(&self) -> &AtomicU64 {
        // H_SEQ (16) is 8-aligned; the mmap base is page-aligned.
        let ptr = self.mmap.as_ptr() as *const AtomicU64;
        unsafe { &*ptr.add(H_SEQ / 8) }
    }

    /// Publish a full `ControlState` snapshot under the seqlock. The atomic
    /// accesses are inlined (not held in a binding) so the immutable seq borrow
    /// never overlaps the `&mut self` body write.
    pub fn write(&mut self, state: &ControlState) {
        // base is always even after a completed write (starts 0). Go odd.
        let base = self.seq_atomic().load(Ordering::Relaxed);
        self.seq_atomic()
            .store(base.wrapping_add(1), Ordering::Release);
        self.write_body(state);
        // Back to even — Release so the body bytes are visible before the
        // reader's Acquire load sees the new even value.
        self.seq_atomic()
            .store(base.wrapping_add(2), Ordering::Release);
    }

    fn put_u32(&mut self, rel: usize, v: u32) {
        let at = CONTROL_HEADER_SIZE + rel;
        self.mmap[at..at + 4].copy_from_slice(&v.to_le_bytes());
    }
    fn put_f32(&mut self, rel: usize, v: f32) {
        let at = CONTROL_HEADER_SIZE + rel;
        self.mmap[at..at + 4].copy_from_slice(&v.to_le_bytes());
    }

    fn write_body(&mut self, s: &ControlState) {
        let mut present = 0u32;
        if !s.layers.is_empty() {
            present |= FP_LAYERS;
        }
        if s.width.is_some() {
            present |= FP_WIDTH;
        }
        if s.height.is_some() {
            present |= FP_HEIGHT;
        }
        if s.fov.is_some() {
            present |= FP_FOV;
        }
        if s.pan_yaw.is_some() {
            present |= FP_PAN_YAW;
        }
        if s.pan_pitch.is_some() {
            present |= FP_PAN_PITCH;
        }
        if s.pan_yaw_rate.is_some() {
            present |= FP_PAN_YAW_RATE;
        }
        if s.pan_pitch_rate.is_some() {
            present |= FP_PAN_PITCH_RATE;
        }
        if s.zoom_rate.is_some() {
            present |= FP_ZOOM_RATE;
        }
        if s.viewer_level.is_some() {
            present |= FP_VIEWER_LEVEL;
        }
        // track_mode: bit set only when actively tracking. Bit CLEAR = none/off
        // (the sidecar always writes full state, so the plugin reads absence as
        // "stop tracking", not "leave untouched"). Keeps the golden fixture
        // byte-identical while none is the default.
        if s.capture_fps.is_some() {
            present |= FP_CAPTURE_FPS;
        }
        if s.track_mode != TrackMode::None {
            present |= FP_TRACK_MODE;
        }

        self.put_u32(B_FIELDS_PRESENT, present);
        // subscribed (u8) + 3 pad bytes.
        let at = CONTROL_HEADER_SIZE + B_SUBSCRIBED;
        self.mmap[at] = u8::from(s.subscribed);
        self.mmap[at + 1] = 0;
        self.mmap[at + 2] = 0;
        self.mmap[at + 3] = 0;

        self.put_u32(B_LAYERS_MASK, layers_to_mask(&s.layers));
        self.put_u32(B_WIDTH, s.width.unwrap_or(0));
        self.put_u32(B_HEIGHT, s.height.unwrap_or(0));
        self.put_f32(B_FOV, s.fov.unwrap_or(0.0));
        self.put_f32(B_PAN_YAW, s.pan_yaw.unwrap_or(0.0));
        self.put_f32(B_PAN_PITCH, s.pan_pitch.unwrap_or(0.0));
        self.put_f32(B_PAN_YAW_RATE, s.pan_yaw_rate.unwrap_or(0.0));
        self.put_f32(B_PAN_PITCH_RATE, s.pan_pitch_rate.unwrap_or(0.0));
        self.put_f32(B_ZOOM_RATE, s.zoom_rate.unwrap_or(0.0));
        self.put_u32(B_PAN_SEQ, s.pan_seq);
        self.put_u32(B_FOV_SEQ, s.fov_seq);
        self.put_u32(B_VIEWER_LEVEL, s.viewer_level.unwrap_or(0));
        self.put_u32(B_TRACK_MODE, track_mode_to_u32(s.track_mode));
        self.put_u32(B_TRACK_SEQ, s.track_seq);
        self.put_f32(B_CAPTURE_FPS, s.capture_fps.unwrap_or(0.0));
    }
}

// ── Reader (for round-trip / contract tests; the production reader is C#) ────

/// The decoded body — mirrors what `ControlBlock.cs` parses on the plugin side.
#[derive(Debug, Clone, PartialEq)]
pub struct ControlSnapshot {
    pub fields_present: u32,
    pub subscribed: bool,
    pub layers_mask: u32,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fov: Option<f32>,
    pub pan_yaw: Option<f32>,
    pub pan_pitch: Option<f32>,
    pub pan_yaw_rate: Option<f32>,
    pub pan_pitch_rate: Option<f32>,
    pub zoom_rate: Option<f32>,
    pub pan_seq: u32,
    pub fov_seq: u32,
    pub viewer_level: Option<u32>,
    /// Auto-track mode (0=none/1=active-vessel/2=target). `None` when the
    /// present bit is clear = not tracking.
    pub track_mode: Option<u32>,
    /// Monotonic counter the sidecar bumps on any authoritative track_mode
    /// change; the plugin applies track_mode only on a change (edge-trigger).
    pub track_seq: u32,
    /// Requested capture rate in fps. `None` when the present bit is clear =
    /// capture at the primary rate.
    pub capture_fps: Option<f32>,
}

fn rd_u32(buf: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(buf[at..at + 4].try_into().unwrap())
}
fn rd_f32(buf: &[u8], at: usize) -> f32 {
    f32::from_le_bytes(buf[at..at + 4].try_into().unwrap())
}

/// Decode raw block bytes (header + body) into a snapshot, validating the
/// magic+version. Returns `None` if the bytes don't carry our layout — the
/// reader's "not ready / wrong build" gate.
pub fn decode(buf: &[u8]) -> Option<ControlSnapshot> {
    if buf.len() < CONTROL_HEADER_SIZE + B_CAPTURE_FPS + 4 {
        return None;
    }
    if u64::from_le_bytes(buf[H_MAGIC..H_MAGIC + 8].try_into().unwrap()) != CONTROL_MAGIC {
        return None;
    }
    if rd_u32(buf, H_VERSION) != CONTROL_LAYOUT_VERSION {
        return None;
    }
    let b = CONTROL_HEADER_SIZE;
    let present = rd_u32(buf, b + B_FIELDS_PRESENT);
    let opt_u32 = |bit: u32, rel: usize| {
        if present & bit != 0 {
            Some(rd_u32(buf, b + rel))
        } else {
            None
        }
    };
    let opt_f32 = |bit: u32, rel: usize| {
        if present & bit != 0 {
            Some(rd_f32(buf, b + rel))
        } else {
            None
        }
    };
    Some(ControlSnapshot {
        fields_present: present,
        subscribed: buf[b + B_SUBSCRIBED] != 0,
        layers_mask: rd_u32(buf, b + B_LAYERS_MASK),
        width: opt_u32(FP_WIDTH, B_WIDTH),
        height: opt_u32(FP_HEIGHT, B_HEIGHT),
        fov: opt_f32(FP_FOV, B_FOV),
        pan_yaw: opt_f32(FP_PAN_YAW, B_PAN_YAW),
        pan_pitch: opt_f32(FP_PAN_PITCH, B_PAN_PITCH),
        pan_yaw_rate: opt_f32(FP_PAN_YAW_RATE, B_PAN_YAW_RATE),
        pan_pitch_rate: opt_f32(FP_PAN_PITCH_RATE, B_PAN_PITCH_RATE),
        zoom_rate: opt_f32(FP_ZOOM_RATE, B_ZOOM_RATE),
        pan_seq: rd_u32(buf, b + B_PAN_SEQ),
        fov_seq: rd_u32(buf, b + B_FOV_SEQ),
        viewer_level: opt_u32(FP_VIEWER_LEVEL, B_VIEWER_LEVEL),
        track_mode: opt_u32(FP_TRACK_MODE, B_TRACK_MODE),
        track_seq: rd_u32(buf, b + B_TRACK_SEQ),
        capture_fps: opt_f32(FP_CAPTURE_FPS, B_CAPTURE_FPS),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// A representative non-trivial state — the canonical fixture contents.
    /// Keep in lockstep with the C# contract test's expectations.
    fn fixture_state() -> ControlState {
        ControlState {
            subscribed: true,
            layers: vec![Layer::Near, Layer::Galaxy], // mask = 1 | 4 = 5
            width: Some(640),
            height: Some(360),
            fov: Some(35.5),
            pan_yaw: Some(-12.25),
            pan_pitch: Some(7.5),
            pan_yaw_rate: Some(0.0), // present-and-zero (a stop) ≠ absent
            pan_pitch_rate: None,
            zoom_rate: Some(1.0),
            pan_seq: 9,
            fov_seq: 4,
            viewer_level: Some(2), // viewer asked for the half preset
            // Left None so the golden fixture stays byte-identical (the append
            // is forward-compatible; track_mode has its own dedicated test).
            track_mode: TrackMode::None,
            // Left 0 so +60 stays zero and the golden fixture stays
            // byte-identical (track_seq has its own dedicated test below).
            track_seq: 0,
            // Left None for the same reason: bit clear, +64 zero, fixture
            // unchanged. Its own round-trip test covers the set case.
            capture_fps: None,
        }
    }

    // Unique temp path per call — tests run in parallel within one process, so
    // a shared (PID-only) name would have one test truncate a file another has
    // mapped (SIGBUS).
    static TMP_CTR: AtomicU64 = AtomicU64::new(0);
    fn unique_path(tag: &str) -> std::path::PathBuf {
        let n = TMP_CTR.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "kerbcast-ctrl-{tag}-{}-{n}.bin",
            std::process::id()
        ))
    }

    fn write_to_vec(state: &ControlState) -> Vec<u8> {
        let path = unique_path("rt");
        let mut blk = ControlBlock::create(&path).unwrap();
        blk.write(state);
        let bytes = blk.mmap[..].to_vec();
        let _ = std::fs::remove_file(&path);
        bytes
    }

    #[test]
    fn write_then_decode_roundtrips() {
        let s = fixture_state();
        let bytes = write_to_vec(&s);
        let snap = decode(&bytes).expect("decodes");
        assert!(snap.subscribed);
        assert_eq!(snap.layers_mask, 5);
        assert_eq!(snap.width, Some(640));
        assert_eq!(snap.height, Some(360));
        assert_eq!(snap.fov, Some(35.5));
        assert_eq!(snap.pan_yaw, Some(-12.25));
        assert_eq!(snap.pan_pitch, Some(7.5));
        assert_eq!(snap.pan_yaw_rate, Some(0.0));
        assert_eq!(snap.pan_pitch_rate, None); // absent stays None
        assert_eq!(snap.zoom_rate, Some(1.0));
        assert_eq!(snap.pan_seq, 9);
        assert_eq!(snap.fov_seq, 4);
        assert_eq!(snap.viewer_level, Some(2));

        // Auto (no viewer clamp): the field decodes as absent, not 0.
        let auto = ControlState {
            viewer_level: None,
            ..fixture_state()
        };
        let snap = decode(&write_to_vec(&auto)).expect("decodes");
        assert_eq!(snap.viewer_level, None);
    }

    #[test]
    fn seq_is_even_after_write_and_advances() {
        let path = unique_path("seq");
        let mut blk = ControlBlock::create(&path).unwrap();
        let seq0 = blk.seq_atomic().load(Ordering::Relaxed);
        assert_eq!(seq0, 0); // "no write yet"
        blk.write(&fixture_state());
        let seq1 = blk.seq_atomic().load(Ordering::Relaxed);
        assert_eq!(seq1, 2); // even, advanced by 2
        blk.write(&fixture_state());
        assert_eq!(blk.seq_atomic().load(Ordering::Relaxed), 4);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn track_mode_roundtrips_and_defaults_absent() {
        // Absent (None) when not tracking: bit clear, decodes as None.
        let snap = decode(&write_to_vec(&fixture_state())).expect("decodes");
        assert_eq!(snap.track_mode, None);
        assert_eq!(snap.fields_present & FP_TRACK_MODE, 0);

        // Present + value when tracking (2 = target).
        let tracking = ControlState {
            track_mode: TrackMode::Target,
            ..fixture_state()
        };
        let snap = decode(&write_to_vec(&tracking)).expect("decodes");
        assert_eq!(snap.track_mode, Some(2));
        assert_ne!(snap.fields_present & FP_TRACK_MODE, 0);

        // active-vessel = 1.
        let active = ControlState {
            track_mode: TrackMode::ActiveVessel,
            ..fixture_state()
        };
        assert_eq!(decode(&write_to_vec(&active)).unwrap().track_mode, Some(1));
    }

    #[test]
    fn capture_fps_roundtrips_and_defaults_absent() {
        // Absent by default: bit clear, +64 zero, golden fixture unchanged.
        let snap = decode(&write_to_vec(&fixture_state())).expect("decodes");
        assert_eq!(snap.capture_fps, None);
        assert_eq!(snap.fields_present & FP_CAPTURE_FPS, 0);

        // Background capture rate round-trips.
        let background_capturing = ControlState {
            capture_fps: Some(1.5),
            ..fixture_state()
        };
        let snap = decode(&write_to_vec(&background_capturing)).expect("decodes");
        assert_eq!(snap.capture_fps, Some(1.5));
        assert_ne!(snap.fields_present & FP_CAPTURE_FPS, 0);

        // Present-and-zero is distinct from absent: an explicit "capture
        // nothing" must not read back as "capture at the primary rate".
        let stopped = ControlState {
            capture_fps: Some(0.0),
            ..fixture_state()
        };
        let snap = decode(&write_to_vec(&stopped)).expect("decodes");
        assert_eq!(snap.capture_fps, Some(0.0));
        assert_ne!(snap.fields_present & FP_CAPTURE_FPS, 0);
    }

    #[test]
    fn track_seq_roundtrips_as_a_fixed_field() {
        // Default 0 (byte-compat with the golden fixture).
        assert_eq!(
            decode(&write_to_vec(&fixture_state())).unwrap().track_seq,
            0
        );
        // A bumped value round-trips at +60, independent of the present bits.
        let bumped = ControlState {
            track_seq: 7,
            ..fixture_state()
        };
        assert_eq!(decode(&write_to_vec(&bumped)).unwrap().track_seq, 7);
    }

    #[test]
    fn bad_magic_decodes_to_none() {
        let mut bytes = write_to_vec(&fixture_state());
        bytes[0] ^= 0xFF;
        assert!(decode(&bytes).is_none());
    }

    /// The cross-language contract: the writer's bytes for `fixture_state()`
    /// MUST equal the committed golden fixture that the C# reader also checks.
    /// If this fails after a layout change, regenerate the fixture (see
    /// `KERBCAST_EMIT_CONTROL_FIXTURE`) and update the C# expectations too.
    #[test]
    fn matches_golden_fixture() {
        let bytes = write_to_vec(&fixture_state());
        let fixture_path = concat!(env!("CARGO_MANIFEST_DIR"), "/testdata/control_block_v2.bin");

        // Opt-in regeneration so the fixture is reproducible from this test.
        if std::env::var("KERBCAST_EMIT_CONTROL_FIXTURE").is_ok() {
            if let Some(parent) = std::path::Path::new(fixture_path).parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            let mut f = std::fs::File::create(fixture_path).unwrap();
            f.write_all(&bytes).unwrap();
            return;
        }

        let golden = std::fs::read(fixture_path).unwrap_or_else(|_| {
            panic!(
                "missing golden fixture {fixture_path}; regenerate with \
                 KERBCAST_EMIT_CONTROL_FIXTURE=1 cargo test matches_golden_fixture"
            )
        });
        assert_eq!(
            bytes, golden,
            "control-block bytes diverged from the golden fixture — the C# \
             reader will mis-parse. Regenerate the fixture and update \
             ControlBlock.cs / its test."
        );
    }
}
