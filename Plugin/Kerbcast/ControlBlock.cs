// ControlBlock — C# reader side of the sidecar→plugin control channel. The
// sidecar (Rust) writes a per-camera <flightId>.control.bin; the plugin reads
// it each frame. Replaces the old <flightId>.control.json poll-and-parse.
//
// Binary layout is the cross-language contract; this MUST stay byte-for-byte
// in lockstep with `sidecar/src/shared_mem/control.rs`. Any field reorder /
// addition is a LAYOUT_VERSION bump on both sides. `control_block_v2.bin` (the
// golden fixture committed under the sidecar's testdata/) is what both sides'
// tests validate against so they can't silently drift.
//
//   HEADER (4096 B, page-aligned):
//     [0..8]   u64 magic = 0x0031424C_5254434B  ("KCTRLB1\0" little-endian)
//     [8..12]  u32 version = 2
//     [12..16] padding
//     [16..24] u64 seq  (seqlock: even = stable, odd = write in progress)
//   BODY (at 4096; 256 B reserved):
//     [+0..4]  u32 fields_present  (bitmask of which Option fields are set)
//     [+4]     u8  subscribed       (+3 pad)
//     [+8..12] u32 layers_mask      (Near=1, Scaled=2, Far=8, Galaxy=4)
//     [+12]    u32 width
//     [+16]    u32 height
//     [+20]    f32 fov
//     [+24]    f32 pan_yaw
//     [+28]    f32 pan_pitch
//     [+32]    f32 pan_yaw_rate
//     [+36]    f32 pan_pitch_rate
//     [+40]    f32 zoom_rate
//     [+44]    u32 pan_seq
//     [+48]    u32 fov_seq
//     [+52]    u32 viewer_level  (viewer quality clamp: index into
//                                 QualityClamp.ViewerScales; absent = auto)
//     [+56]    u32 track_mode    (auto-track: 0=none, 1=active-vessel,
//                                 2=target. Present-bit CLEAR = none/off; the
//                                 sidecar always writes full state so absence
//                                 means not-tracking, not leave-untouched.)
//     [+60]    u32 track_seq     (FIXED field, always read — like pan_seq/
//                                 fov_seq. Sidecar bumps it on any authoritative
//                                 track_mode change; the plugin applies
//                                 track_mode only on a change (edge-trigger).)
//
// track_mode (+56) is an APPEND with its own fields_present bit — NOT a
// LAYOUT_VERSION bump. The bitmask is forward-compatible: an old reader ignores
// the bit and never touches +56 (previously-zero reserved body), so a v2 build
// and a track_mode-aware build interoperate, and the golden fixture stays
// byte-identical (its state leaves track_mode = none). Only a reorder / body
// resize needs a version bump.
//
// Seqlock read: load seq (Interlocked = acquire barrier); if odd the writer is
// mid-write — retry; if it matches the last applied seq nothing changed — skip;
// read the body; re-load seq and retry if it moved. `seq` doubles as a
// monotonic change detector (collision-proof, unlike the mtime/content compare
// it replaces).
//
// Deliberately depends ONLY on System.* (no UnityEngine) so a standalone
// dotnet test project can compile + run this file with no KSP assemblies.

using System;
using System.IO;
using System.IO.MemoryMappedFiles;
using System.Threading;

namespace Kerbcast
{
    /// <summary>Decoded control-block body. Option fields are null when their
    /// `fields_present` bit is clear (the sidecar didn't set them — leave the
    /// plugin's current value untouched).</summary>
    public struct ControlSnapshot
    {
        public uint FieldsPresent;
        public bool Subscribed;
        public bool HasLayers;
        public uint LayersMask;
        public uint? Width;
        public uint? Height;
        public float? Fov;
        public float? PanYaw;
        public float? PanPitch;
        public float? PanYawRate;
        public float? PanPitchRate;
        public float? ZoomRate;
        public uint PanSeq;
        public uint FovSeq;
        /// <summary>Viewer-requested quality clamp (index into
        /// QualityClamp.ViewerScales). Null = auto, no viewer clamp.</summary>
        public uint? ViewerLevel;
        /// <summary>Auto-track mode (0=none, 1=active-vessel, 2=target). Null
        /// when the present bit is clear = not tracking. A browser track
        /// overrides a kOS aim on the same camera.</summary>
        public uint? TrackMode;
        /// <summary>Monotonic counter the sidecar bumps on any authoritative
        /// track_mode change. The plugin applies track_mode only when this
        /// moves (edge-trigger), so a stale flush can't revert a kOS-set mode.
        /// Always read (fixed field), like PanSeq/FovSeq.</summary>
        public uint TrackSeq;
        /// <summary>Requested capture rate in frames per second. Null = capture
        /// at the primary rate (today's behaviour, and what a predating background capture sidecar
        /// leaves clear). A low value is a background capture: the camera stays
        /// subscribed but is paced far below the primary rate because nothing
        /// is displaying it at size.</summary>
        public float? CaptureFps;
        /// <summary>The seqlock value this snapshot was read at (even).</summary>
        public long Seq;
    }

    public sealed class ControlBlock : IDisposable
    {
        public const ulong Magic = 0x0031_424C_5254_434BUL; // "KCTRLB1\0" LE
        public const uint LayoutVersion = 2;
        public const int HeaderSize = 4096;
        public const int BodySize = 256;
        public const long TotalSize = HeaderSize + BodySize;

        private const int HMagic = 0;
        private const int HVersion = 8;
        private const int HSeq = 16;

        // Body offsets (absolute = HeaderSize + relative).
        private const int BFieldsPresent = HeaderSize + 0;
        private const int BSubscribed = HeaderSize + 4;
        private const int BLayersMask = HeaderSize + 8;
        private const int BWidth = HeaderSize + 12;
        private const int BHeight = HeaderSize + 16;
        private const int BFov = HeaderSize + 20;
        private const int BPanYaw = HeaderSize + 24;
        private const int BPanPitch = HeaderSize + 28;
        private const int BPanYawRate = HeaderSize + 32;
        private const int BPanPitchRate = HeaderSize + 36;
        private const int BZoomRate = HeaderSize + 40;
        private const int BPanSeq = HeaderSize + 44;
        private const int BFovSeq = HeaderSize + 48;
        private const int BViewerLevel = HeaderSize + 52;
        private const int BTrackMode = HeaderSize + 56;
        // track_seq (+60): FIXED field (always read, like BPanSeq/BFovSeq). The
        // sidecar bumps it on any authoritative track_mode change; we apply the
        // control-block track_mode only when it moves (edge-trigger), so a stale
        // flush can't revert a kOS-set mode. Append -> no LayoutVersion bump.
        private const int BTrackSeq = HeaderSize + 60;
        // Another APPEND, same forward-compatible rules as track_mode above: an
        // old reader ignores the bit and never touches +64, so the golden
        // fixture stays byte-identical and a predating background capture sidecar interoperates.
        private const int BCaptureFps = HeaderSize + 64;

        // fields_present bits — one per Option/Vec field.
        public const uint FpLayers = 1u << 0;
        public const uint FpWidth = 1u << 1;
        public const uint FpHeight = 1u << 2;
        public const uint FpFov = 1u << 3;
        public const uint FpPanYaw = 1u << 4;
        public const uint FpPanPitch = 1u << 5;
        public const uint FpPanYawRate = 1u << 6;
        public const uint FpPanPitchRate = 1u << 7;
        public const uint FpZoomRate = 1u << 8;
        public const uint FpViewerLevel = 1u << 9;
        public const uint FpTrackMode = 1u << 10;
        public const uint FpCaptureFps = 1u << 11;

        private readonly MemoryMappedFile _mmf;
        private readonly MemoryMappedViewAccessor _view;
        private long _lastSeq = -1;

        private ControlBlock(MemoryMappedFile mmf, MemoryMappedViewAccessor view)
        {
            _mmf = mmf;
            _view = view;
        }

        public enum OpenResult { Ok, NotReady, VersionMismatch }

        /// <summary>
        /// Open a control block for reading. Returns null when the file is not
        /// yet ready (missing / still being created at size 0 / wrong magic — a
        /// stale or mid-creation file). A VERSION mismatch (correct magic, wrong
        /// layout version) sets <paramref name="result"/> to VersionMismatch so
        /// the caller can log it loudly — that means the sidecar and plugin are
        /// out of sync and control will not work until they match.
        /// </summary>
        public static ControlBlock Open(string path, out OpenResult result)
        {
            result = OpenResult.NotReady;
            if (!File.Exists(path)) return null;
            var info = new FileInfo(path);
            if (info.Length < TotalSize) return null; // sidecar mid-creation

            MemoryMappedFile mmf = MemoryMappedFile.CreateFromFile(
                new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.ReadWrite),
                mapName: null,
                capacity: TotalSize,
                access: MemoryMappedFileAccess.ReadWrite,
                inheritability: HandleInheritability.None,
                leaveOpen: false);
            var view = mmf.CreateViewAccessor(0, TotalSize, MemoryMappedFileAccess.ReadWrite);

            ulong magic = view.ReadUInt64(HMagic);
            if (magic != Magic)
            {
                view.Dispose();
                mmf.Dispose();
                return null; // not our file / stale
            }
            uint version = view.ReadUInt32(HVersion);
            if (version != LayoutVersion)
            {
                view.Dispose();
                mmf.Dispose();
                result = OpenResult.VersionMismatch;
                return null;
            }
            result = OpenResult.Ok;
            return new ControlBlock(mmf, view);
        }

        /// <summary>
        /// Seqlock read. Returns a snapshot only when a NEW, consistent state is
        /// published (seq even, changed since the last applied seq); returns
        /// false when nothing has changed / the writer is mid-write / it has
        /// never been written / a pathological retry-storm. The caller re-polls
        /// next frame.
        /// </summary>
        public bool TryReadChanged(out ControlSnapshot snap)
        {
            snap = default;
            for (int retry = 0; retry < 4; retry++)
            {
                long s1 = ReadSeqAcquire();
                if (s1 == 0) return false;          // never written
                if ((s1 & 1) != 0) continue;        // writer mid-write (odd)
                if (s1 == _lastSeq) return false;   // unchanged since last apply

                var candidate = ReadBody(s1);

                long s2 = ReadSeqAcquire();
                if (s1 == s2)
                {
                    _lastSeq = s1;
                    snap = candidate;
                    return true;
                }
                // Writer raced us mid-read — retry against the fresh seq.
            }
            return false;
        }

        private ControlSnapshot ReadBody(long seq)
        {
            uint present = _view.ReadUInt32(BFieldsPresent);

            return new ControlSnapshot
            {
                FieldsPresent = present,
                Subscribed = _view.ReadByte(BSubscribed) != 0,
                HasLayers = (present & FpLayers) != 0,
                LayersMask = _view.ReadUInt32(BLayersMask),
                Width = (present & FpWidth) != 0 ? _view.ReadUInt32(BWidth) : (uint?)null,
                Height = (present & FpHeight) != 0 ? _view.ReadUInt32(BHeight) : (uint?)null,
                Fov = (present & FpFov) != 0 ? _view.ReadSingle(BFov) : (float?)null,
                PanYaw = (present & FpPanYaw) != 0 ? _view.ReadSingle(BPanYaw) : (float?)null,
                PanPitch = (present & FpPanPitch) != 0 ? _view.ReadSingle(BPanPitch) : (float?)null,
                PanYawRate = (present & FpPanYawRate) != 0 ? _view.ReadSingle(BPanYawRate) : (float?)null,
                PanPitchRate = (present & FpPanPitchRate) != 0 ? _view.ReadSingle(BPanPitchRate) : (float?)null,
                ZoomRate = (present & FpZoomRate) != 0 ? _view.ReadSingle(BZoomRate) : (float?)null,
                PanSeq = _view.ReadUInt32(BPanSeq),
                FovSeq = _view.ReadUInt32(BFovSeq),
                ViewerLevel = (present & FpViewerLevel) != 0 ? _view.ReadUInt32(BViewerLevel) : (uint?)null,
                TrackMode = (present & FpTrackMode) != 0 ? _view.ReadUInt32(BTrackMode) : (uint?)null,
                CaptureFps = (present & FpCaptureFps) != 0 ? _view.ReadSingle(BCaptureFps) : (float?)null,
                TrackSeq = _view.ReadUInt32(BTrackSeq),
                Seq = seq,
            };
        }

        // Atomic acquire-load of the seqlock counter via the raw mapped pointer
        // — same Interlocked-over-mmap technique as MmapFrameRing. Interlocked
        // issues a full barrier so the body reads bracketed by two of these are
        // ordered. We never ReleasePointer: the accessor lives for the life of
        // the ControlBlock (single-reader use).
        private unsafe long ReadSeqAcquire()
        {
            byte* basePtr = null;
            _view.SafeMemoryMappedViewHandle.AcquirePointer(ref basePtr);
            long* p = (long*)(basePtr + HSeq);
            return Interlocked.Read(ref *p);
        }

        public void Dispose()
        {
            _view.Dispose();
            _mmf.Dispose();
        }
    }
}
