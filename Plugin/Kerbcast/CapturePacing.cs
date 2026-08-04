// CapturePacing — how often a subscribed camera is allowed to capture.
//
// Two rates are in play. The PRIMARY rate is what a camera someone is actually
// watching gets. The BACKGROUND rate (the "hum") is what a camera keeps ticking
// over at when it is still subscribed but nothing is displaying it at size, so
// that switching to it promotes an already-flowing stream instead of
// cold-starting from black.
//
// Pacing is expressed as ELIGIBILITY rather than as a second capture budget,
// and that choice is load-bearing. A hum camera joins a tick's capture set only
// once its interval has elapsed, so it consumes stagger permits in proportion
// to its rate — a 1fps hum camera among 30fps primaries takes about 1/30th of
// the slots. Since the hum varies rate and never resolution, a hum capture
// costs exactly what a primary capture costs, so the existing per-camera cost
// model stays honest with no special-casing anywhere.
//
// Deliberately depends ONLY on System.* (no UnityEngine) so a standalone dotnet
// test project can compile + run this file with no KSP assemblies — same
// approach as ControlBlock.cs and ShedController.cs.

using System;

namespace Kerbcast
{
    /// <summary>
    /// Per-camera capture-rate pacing. Embedded by each camera; the decision
    /// logic lives here so it can be unit-tested without Unity.
    /// </summary>
    public struct CapturePacing
    {
        /// <summary>Rate the sidecar asked for, in fps. Null = no request, so
        /// capture at the primary rate. That is what a pre-hum sidecar writes,
        /// which is why an old sidecar with a new plugin behaves as before.</summary>
        public float? RequestedFps;

        /// <summary>Unscaled time of the last granted capture. Negative infinity
        /// until the first, so a newly-humming camera is due immediately.</summary>
        private float _lastCaptureTime;

        /// <summary>Effective rate: the request clamped to the operator's
        /// background ceiling, or the primary rate when nothing was requested.
        /// Zero means do not capture at all.
        /// </summary>
        /// <remarks>
        /// The ceiling is why an operator who left the hum off (0, the default)
        /// never pays for one however the sidecar asks. A request at or above
        /// the primary rate is simply the primary rate — the hum can slow a
        /// camera down, never speed it past its normal pace.
        /// </remarks>
        public float Effective(float primaryFps, float backgroundCeilingFps)
        {
            if (!RequestedFps.HasValue) return primaryFps;
            float want = RequestedFps.Value;
            if (want >= primaryFps) return primaryFps;
            if (want <= 0f) return 0f;
            float ceiling = Math.Min(backgroundCeilingFps, primaryFps);
            return want < ceiling ? want : ceiling;
        }

        /// <summary>Whether this camera may capture on this tick. Primaries are
        /// always eligible; a hum camera only once its interval has elapsed.</summary>
        public bool Due(float now, float effectiveFps, float primaryFps)
        {
            if (effectiveFps <= 0f) return false;
            if (effectiveFps >= primaryFps) return true;
            return now - _lastCaptureTime >= 1f / effectiveFps;
        }

        /// <summary>Record a granted capture, so the interval measures from the
        /// last actual capture rather than from a fixed phase.</summary>
        public void MarkGranted(float now) => _lastCaptureTime = now;

        /// <summary>Whether this camera is currently humming: subscribed, being
        /// captured, but below the primary rate.</summary>
        public bool IsHumming(float effectiveFps, float primaryFps)
            => effectiveFps > 0f && effectiveFps < primaryFps;

        /// <summary>Reset pacing state so a camera resuming from unsubscribed
        /// (or from a shed hum) is due immediately rather than waiting out a
        /// stale interval.</summary>
        public void Reset() => _lastCaptureTime = float.NegativeInfinity;
    }
}
