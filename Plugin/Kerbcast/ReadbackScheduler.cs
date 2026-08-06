// ReadbackScheduler: bounds how many cameras issue a GPU render +
// AsyncGPUReadback on the same frame, so they don't all pile onto one. Bounding
// the number of simultaneous in-flight readbacks is what keeps the render-thread
// readback pump cheap (each in-flight task is walked / waited on every frame).
//
// It does NOT cap the capture rate. That lives in CapturePacing, per camera,
// because a whole number of permits shared over the eligible cameras yields
// budget/count x gameFps, which only lands on the cap when the division comes out
// even. See CapturePacing for the measurements.
//
// When more cameras come due than the bound allows, the ones granted are the ones
// furthest past their deadline: the caller orders the eligible set that way, so
// this class is stateless. A cursor-rotated window used to do that job and could
// not, because ranks are positions in an eligible set that changes membership
// every tick, so the rotation stopped tracking cameras and starved whoever landed
// at the wrong rank (measured: one feed of five at 0.6fps while the rest held 26).
//
// Deliberately Unity-free (same approach as ControlBlock.cs / ShedController.cs)
// so the scheduling decision is unit-tested without KSP.

using System;

namespace Kerbcast
{
    public static class ReadbackScheduler
    {
        /// <summary>
        /// How many of <paramref name="count"/> cameras should capture this
        /// frame, ON AVERAGE, to sustain <paramref name="captureFps"/> given the
        /// current <paramref name="gameFps"/>. When the game is at or below the
        /// target fps we can't stagger (every camera must capture every frame to
        /// keep up) so the budget is the full count.
        /// </summary>
        /// <remarks>
        /// An average, so not a bound to enforce directly: see <see
        /// cref="ConcurrencyBudget"/>. And not a rate cap either, however much it
        /// looks like one, because it is a whole number shared over the eligible
        /// cameras.
        /// </remarks>
        public static int Budget(int count, double captureFps, double gameFps)
        {
            if (count <= 0) return 0;
            if (captureFps <= 0.0) return count;        // pacing disabled
            if (gameFps <= captureFps) return count;    // can't stagger; need every frame
            int b = (int)Math.Ceiling(count * captureFps / gameFps);
            if (b < 1) b = 1;
            if (b > count) b = count;
            return b;
        }

        /// <summary>
        /// The per-frame concurrency bound: <see cref="Budget"/> plus one slot.
        /// </summary>
        /// <remarks>
        /// Budget is the AVERAGE number of captures per frame the set needs to
        /// hold its rate. Demand is not flat, though: cameras are paced
        /// independently (CapturePacing), so their intervals sometimes come due
        /// on the same frame. A bound set at the average clips those ticks, and a
        /// clipped camera cannot make the slot up later (pacing refuses to repay
        /// lateness as a burst), so it loses rate outright: measured at 26.2fps
        /// against a 30fps cap with 3 cameras on a 45fps game, where the average
        /// comes out at exactly 2.0 and leaves nothing spare. One slot of
        /// headroom absorbs the clustering. The rate cap does not depend on this
        /// number being tight: it is each camera's own interval.
        /// </remarks>
        public static int ConcurrencyBudget(int count, double captureFps, double gameFps)
        {
            int b = Budget(count, captureFps, gameFps);
            if (b <= 0) return b;
            b++;
            return b > count ? count : b;
        }

        // Fraction of cameras allowed to capture per frame at each degrade
        // level. Level 0 = no cut; higher levels (driven by ShedController as
        // fps drops below the shed thresholds) progressively *temporally*
        // degrade — fewer cameras captured per frame, so each updates less often
        // but at full quality. This is the default adaptive response now that
        // quality shedding is opt-in. Index clamps to the last entry.
        private static readonly double[] DegradeFraction =
            { 1.0, 0.66, 0.5, 0.33, 0.25, 0.12 };

        /// <summary>
        /// Capture budget from the degrade level alone: as fps falls and the
        /// level rises, fewer cameras capture per frame. Floored at 1 so feeds
        /// never freeze entirely.
        /// </summary>
        public static int DegradeBudget(int count, int level)
        {
            if (count <= 0) return 0;
            if (level < 0) level = 0;
            if (level >= DegradeFraction.Length) level = DegradeFraction.Length - 1;
            int b = (int)Math.Ceiling(count * DegradeFraction[level]);
            if (b < 1) b = 1;
            if (b > count) b = count;
            return b;
        }

        /// <summary>
        /// The per-frame capture budget: the tighter of what the set needs for its
        /// rate (<see cref="Budget"/>) and the degrade budget (cut captures as
        /// performance degrades). At level 0 with a healthy game this is just the
        /// former; under load the degrade term dominates.
        /// </summary>
        public static int EffectiveBudget(int count, double captureFps, double gameFps, int level)
        {
            int rate = Budget(count, captureFps, gameFps);
            int degrade = DegradeBudget(count, level);
            return rate < degrade ? rate : degrade;
        }

        /// <summary>
        /// Fill <paramref name="permit"/>[0..count) with the <paramref
        /// name="budget"/> cameras allowed to capture this tick: the first ones in
        /// rank order. <paramref name="permit"/> must have length &gt;= count.
        /// </summary>
        /// <remarks>
        /// The caller ranks the eligible cameras most-overdue-first, so rank order
        /// IS priority order and no rotation state is needed. Starvation is
        /// impossible by construction: a camera that loses a draw keeps its
        /// deadline and so falls further behind every tick, while every camera
        /// that wins has its lateness reset, so the loser overtakes them within a
        /// tick or two and must be granted.
        /// </remarks>
        public static void GrantByPriority(int count, int budget, bool[] permit)
        {
            for (int i = 0; i < count; i++) permit[i] = i < budget;
        }
    }
}
