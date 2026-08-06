// CapturePacing — how often a subscribed camera is allowed to capture.
//
// Two rates are in play. The PRIMARY rate is what a camera someone is actually
// watching gets. The BACKGROUND rate (the "background capture") is what a camera keeps ticking
// over at when it is still subscribed but nothing is displaying it at size, so
// that switching to it promotes an already-flowing stream instead of
// cold-starting from black.
//
// Pacing is expressed as ELIGIBILITY rather than as a capture budget, and that
// choice is load-bearing. EVERY camera, primary included, joins a tick's capture
// set only once its own interval has elapsed, so each consumes stagger permits
// in proportion to its rate: a 1fps background camera among 30fps primaries
// takes about 1/30th of the slots. Since background capture varies rate and
// never resolution, a background capture costs exactly what a primary capture
// costs, so the existing per-camera cost model stays honest with no
// special-casing anywhere.
//
// The primary rate is paced here too because the stagger budget cannot cap it:
// permits are whole numbers shared over the eligible cameras, so the rate that
// falls out is budget/count x gameFps, which overshoots the cap by more and more
// as the set gets smaller. Measured on the Deck at 53fps: 5 cameras ran 31.8fps,
// 4 plus one in background capture ran 39.5fps, one alone ran the full 53fps.
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
        /// capture at the primary rate. That is what a predating background capture sidecar writes,
        /// which is why an old sidecar with a new plugin behaves as before.</summary>
        public float? RequestedFps;

        /// <summary>Unscaled time this camera's next capture is due. Zero (the
        /// struct default) and negative infinity both mean "immediately", so a
        /// camera that has just started capturing is not made to wait.</summary>
        private float _nextDueTime;

        /// <summary>Effective rate: the request clamped to the operator's
        /// background ceiling, or the primary rate when nothing was requested.
        /// Zero means do not capture at all.
        /// </summary>
        /// <remarks>
        /// The ceiling is why an operator who left background capture off (0, the default)
        /// never pays for one however the sidecar asks. A request at or above
        /// the primary rate is simply the primary rate — background capture can slow a
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

        /// <summary>Whether this camera may capture on this tick: only once its
        /// own interval has elapsed, primary rate included.</summary>
        /// <remarks>
        /// This IS the rate cap (see the header for why the stagger budget cannot
        /// be). Measuring the camera's own elapsed time caps it by construction:
        /// independent of how many other cameras are eligible, and independent of
        /// the fps estimate the budget divides by.
        /// </remarks>
        public bool Due(float now, float effectiveFps)
        {
            if (effectiveFps <= 0f) return false;
            return now >= Deadline(now, 1f / effectiveFps);
        }

        /// <summary>Seconds past this camera's capture deadline, negative while it
        /// is not yet due. The scheduler grants the most overdue cameras first when
        /// more come due than the frame's concurrency bound allows, so this is the
        /// priority: a camera that keeps losing keeps growing this, and overtakes
        /// the cameras that won.</summary>
        public float Overdue(float now, float effectiveFps)
        {
            if (effectiveFps <= 0f) return float.NegativeInfinity;
            return now - Deadline(now, 1f / effectiveFps);
        }

        /* The deadline in force. That is the stored one, unless the rate has gone
           UP since it was set: then the stored deadline is stale and the camera is
           due now. Promoting a 1fps background camera must show a frame at once,
           not after the remaining second of the slow interval, since that is the
           exact case background capture exists to prevent. Derived from the rate in
           force rather than from what changed, so it catches a client raising its
           request and the operator ceiling lifting alike. The margin is float
           slack: a same-rate deadline is never more than one interval out, and a
           long session's clock is coarse enough that an exact comparison would
           read false-stale. */
        private float Deadline(float now, float interval)
            => _nextDueTime - now > 1.5f * interval ? now : _nextDueTime;

        /// <summary>Record a granted capture and schedule the next one.</summary>
        /// <remarks>
        /// The next deadline advances from the deadline just met, not from the
        /// grant, so a cap that does not divide the frame grid still averages
        /// out: 30fps on a 53fps game alternates one- and two-frame gaps instead
        /// of settling on the slower two-frame cadence and losing 12% of the
        /// rate. The schedule is only kept while it is no more than one interval
        /// behind; anything else (the first capture, a resume, a stall, a rate
        /// that just went up, so the deadline sits in the future) resyncs to now.
        /// So lateness is never repaid as a burst of back-to-back captures, and a
        /// promotion is never charged the old slow rate's remaining wait.
        /// </remarks>
        public void MarkGranted(float now, float effectiveFps)
        {
            if (effectiveFps <= 0f) return;
            float interval = 1f / effectiveFps;
            float lateness = now - _nextDueTime;
            float anchor = lateness >= 0f && lateness < interval ? _nextDueTime : now;
            _nextDueTime = anchor + interval;
        }

        /// <summary>Whether this camera is currently capturing in the background: subscribed, being
        /// captured, but below the primary rate.</summary>
        public bool IsBackground(float effectiveFps, float primaryFps)
            => effectiveFps > 0f && effectiveFps < primaryFps;

        /// <summary>Reset pacing state so a camera resuming from unsubscribed
        /// (or from a shed background capture) is due immediately rather than waiting out a
        /// stale interval.</summary>
        public void Reset() => _nextDueTime = float.NegativeInfinity;
    }
}
