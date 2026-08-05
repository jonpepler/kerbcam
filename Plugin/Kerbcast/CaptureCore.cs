/* Reusable frame-capture tail shared by every kerbcast camera type.

   Owns the pooled capture/readback RenderTexture pair, the in-flight
   readback bookkeeping, the ReadbackTargetTracker and the mmap ring
   write. A camera renders its own layer stack into CaptureRt, then hands
   the tail here: Publish blits CaptureRt -> ReadbackRt (via the caller's
   filter/nightvision/plain blit), applies the vertical-flip correction,
   and issues one AsyncGPUReadback with the one-in-flight invariant; Drain
   copies a completed readback straight into the ring.

   Deck-critical details preserved verbatim from KerbcastCamera: the
   readback RT is depth=0 (clean GL_TEXTURE_2D handle on Mesa), the flip
   gate is SystemInfo.graphicsUVStartsAtTop, and the drain takes the
   zero-copy TryGetRawPtr path before the GetData fallback. */

using System;
using System.Diagnostics;
using Unity.Collections.LowLevel.Unsafe;
using UnityEngine;
using Yangrc.OpenGLAsyncReadback;

namespace Kerbcast
{
    internal sealed class CaptureCore : IDisposable
    {
        // The *current* render-target pair (also held in _rtPool). The owning
        // camera renders + blits + issues new readbacks against these.
        private RenderTexture _captureRt;
        private RenderTexture _readbackRt; // depth=0, GL_TEXTURE_2D-clean

        private struct RenderTargetSet
        {
            public RenderTexture Capture;
            public RenderTexture Readback;
        }

        // RenderTexture pool keyed by render size (RenderSizeKey.Pack). Adaptive
        // shedding switches between pooled sets instead of destroying and
        // reallocating: destroying a RenderTexture while an AsyncGPUReadback is
        // still in flight against it orphans the native readback task (the
        // bundled OpenGL plugin exposes no cancel/free API), and that orphan is
        // then walked every frame by the DontDestroyOnLoad updater for the rest
        // of the process. Pooling never destroys mid-flight (so nothing is
        // orphaned) and removes the per-change realloc hitch.
        private readonly System.Collections.Generic.Dictionary<long, RenderTargetSet> _rtPool =
            new System.Collections.Generic.Dictionary<long, RenderTargetSet>();

        // The in-flight readback is described independently of the *current*
        // target so a resolution change mid-readback still drains the pending
        // frame at its original dimensions before switching.
        private readonly ReadbackTargetTracker _targets = new ReadbackTargetTracker();

        private readonly MmapFrameRing _ring;
        private UniversalAsyncGPUReadbackRequest _pendingRequest;
        private bool _readbackInFlight;
        private double _pendingCaptureTsMs;

        // Shared telemetry sink (owned by the camera) plus the failure-streak
        // callbacks: the camera keeps _consecutiveErrors and LogRateLimited, we
        // just invoke them so a readback error and a render error share one
        // rate-limit counter.
        private readonly PhaseTimings _phaseTimings;
        private readonly Action<string> _logRateLimited;
        private readonly Action _resetErrorStreak;

        // Cached per Refresh tick via BeginTick. When false every timing bracket
        // is skipped so the OFF path makes zero GetTimestamp calls. When true the
        // drain (ProcessReadback) timing accumulates here so it can be combined
        // with the Request-issue timing into one Readback sample per tick.
        private bool _telemetry;
        private double _readbackDrainMs;
        private static readonly double _msPerTick =
            1000.0 / Stopwatch.Frequency;

        internal CaptureCore(
            MmapFrameRing ring,
            PhaseTimings phaseTimings,
            Action<string> logRateLimited,
            Action resetErrorStreak)
        {
            _ring = ring;
            _phaseTimings = phaseTimings;
            _logRateLimited = logRateLimited;
            _resetErrorStreak = resetErrorStreak;
        }

        internal RenderTexture CaptureRt => _captureRt;
        internal RenderTexture ReadbackRt => _readbackRt;
        internal bool ReadbackInFlight => _readbackInFlight;
        internal bool ReadbackReady => _readbackInFlight && _pendingRequest.done;

        // Select (or lazily create) the pooled render-target set for this size
        // and make it current. Never destroys — see the _rtPool comment.
        internal void BuildTargets(int width, int height)
        {
            long key = RenderSizeKey.Pack(width, height);
            if (!_rtPool.TryGetValue(key, out var set))
            {
                var capture = new RenderTexture(width, height, 24, RenderTextureFormat.ARGB32, RenderTextureReadWrite.Linear)
                {
                    antiAliasing = 1,
                };
                capture.Create();

                // depth=0 so GetNativeTexturePtr returns a vanilla GL_TEXTURE_2D
                // handle on Mesa OpenGL. With depth=24 (the capture RT) the
                // yangrc plugin's glGetTexLevelParameteriv reads back zero
                // dimensions and silently does nothing.
                var readback = new RenderTexture(width, height, 0, RenderTextureFormat.ARGB32);
                readback.Create();

                set = new RenderTargetSet { Capture = capture, Readback = readback };
                _rtPool[key] = set;
            }
            _captureRt = set.Capture;
            _readbackRt = set.Readback;
            _targets.SetCurrent(width, height);
        }

        // Reset the per-tick drain accumulator and snapshot the telemetry gate,
        // mirroring the top-of-Refresh reset so a mid-tick settings flip cannot
        // split the recording within one tick.
        internal void BeginTick(bool telemetry)
        {
            _telemetry = telemetry;
            _readbackDrainMs = 0.0;
        }

        // Blit CaptureRt -> ReadbackRt (caller supplies the filter/nightvision/
        // plain pass), apply the vertical-flip correction, then issue one
        // readback under the one-in-flight invariant. Records the Blit and
        // Readback phase timings into the shared PhaseTimings.
        internal void Publish(double captureTsMs, Action<RenderTexture, RenderTexture> blit)
        {
            // Blit phase: the filter/nv/plain capture->readback blit AND the
            // vertical-flip correction below, all the main-thread Blit dispatch
            // this tick.
            long blitStart = _telemetry ? Stopwatch.GetTimestamp() : 0;
            blit(_captureRt, _readbackRt);

            // Vertical-flip correction, in CaptureOrientation so the headless
            // orientation proof compiles the same source. Behaviour unchanged:
            // bottom-left-origin APIs (OpenGL, the Deck) read back inverted and
            // get one mirroring blit; top-left-origin APIs are a no-op here.
            CaptureOrientation.ApplyReadbackFlip(_readbackRt);
            if (_telemetry)
                _phaseTimings.Record(RenderPhase.Blit,
                    (Stopwatch.GetTimestamp() - blitStart) * _msPerTick);

            // INVARIANT: at most one readback is in flight per camera. The drain
            // guards in the caller early-return until _pendingRequest.done and
            // clear the flag before we reach here, so this Request only runs when
            // none is pending. The pending-dims snapshot below relies on this — if
            // a second request were ever issued before the first drained,
            // _targets' pending dims would be clobbered and Drain would corrupt
            // the in-flight frame.
            _readbackInFlight = true;
            // Snapshot the target this readback belongs to, so a resolution change
            // before it completes doesn't make Drain use the new (mismatched)
            // dimensions.
            _targets.CapturePending();
            _pendingCaptureTsMs = captureTsMs;
            long reqStart = _telemetry ? Stopwatch.GetTimestamp() : 0;
            _pendingRequest = UniversalAsyncGPUReadbackRequest.Request(_readbackRt, 0);
            if (_telemetry)
            {
                // Readback phase = this tick's drain of the PREVIOUS frame's
                // capture (the ring memcpy in Drain, accumulated into
                // _readbackDrainMs) + the cheap Request() issue here. Recording
                // them combined keeps the single "readback" column meaningful even
                // though the work straddles two frames.
                double issueMs = (Stopwatch.GetTimestamp() - reqStart) * _msPerTick;
                _phaseTimings.Record(RenderPhase.Readback, _readbackDrainMs + issueMs);
                _phaseTimings.FrameComplete();
            }
        }

        // Drain a completed readback into the ring and clear the in-flight flag.
        // No-op while none is pending or the pending one isn't done yet.
        internal void Drain()
        {
            if (!_readbackInFlight || !_pendingRequest.done) return;
            ProcessReadback(_pendingRequest);
            _readbackInFlight = false;
        }

        // Reset the in-flight flag after a throw in the capture pipeline so a new
        // readback can be issued next tick (mirrors the camera's catch block).
        internal void AbortInFlight()
        {
            _readbackInFlight = false;
        }

        private unsafe void ProcessReadback(UniversalAsyncGPUReadbackRequest request)
        {
            // Time the drain (the full-frame ring memcpy in Produce) and
            // accumulate into the per-tick drain total. The Readback-phase sample
            // is recorded once at the Request site, combining this with the issue.
            long drainStart = _telemetry ? Stopwatch.GetTimestamp() : 0;
            try
            {
                if (request.hasError)
                {
                    _logRateLimited("AsyncGPUReadback returned hasError");
                    return;
                }

                // Write the readback bytes straight into the ring — no
                // intermediate Texture2D, no pointless GPU Apply(). The readback
                // target is RGBA32, so the bytes are already the exact pixel
                // layout the ring expects. Dimensions come from the snapshot taken
                // when the readback was issued, since the current render size may
                // have changed in the meantime (pooled-set switch).
                //
                // On the OpenGL plugin path (the Deck), read the native plugin
                // buffer pointer directly — skipping GetData's Allocator.Temp
                // NativeArray + MemMove (one of two full-frame copies per
                // readback). Pointer is valid only until the next readback Update,
                // so Produce (which copies into the ring) runs now. On the
                // Unity-native path GetData is already a zero-copy view — use it.
                byte* src;
                int length;
                if (request.TryGetRawPtr(out var rawPtr, out length))
                {
                    src = (byte*)rawPtr;
                }
                else
                {
                    var data = request.GetData<byte>();
                    src = (byte*)NativeArrayUnsafeUtility.GetUnsafeReadOnlyPtr(data);
                    length = data.Length;
                }
                _ring.Produce(_targets.PendingWidth, _targets.PendingHeight, _pendingCaptureTsMs, src, length);
                _resetErrorStreak();
            }
            catch (Exception ex)
            {
                _logRateLimited($"readback callback threw: {ex.GetType().Name}: {ex.Message}");
            }
            finally
            {
                if (_telemetry)
                    _readbackDrainMs +=
                        (Stopwatch.GetTimestamp() - drainStart) * _msPerTick;
            }
        }

        // Destroy every pooled render-target set (the current _captureRt /
        // _readbackRt are members of one of these, so this covers them). Safe
        // only at teardown — no further readbacks will be issued. The ring is
        // owned and disposed by the camera, not here.
        public void Dispose()
        {
            foreach (var set in _rtPool.Values)
            {
                if (set.Capture != null) { set.Capture.Release(); UnityEngine.Object.Destroy(set.Capture); }
                if (set.Readback != null) { set.Readback.Release(); UnityEngine.Object.Destroy(set.Readback); }
            }
            _rtPool.Clear();
        }
    }
}
