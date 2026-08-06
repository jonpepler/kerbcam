// Unit test for ReadbackScheduler: the budget formulas that bound how many
// cameras capture on one frame, and the priority-ordered permit grant.
//
// The scheduler does NOT cap the capture rate: that is per-camera pacing
// (CapturePacing, and CapturePacing.Tests measures the achieved rate through the
// whole loop). Here we only guard the counting.
//
// Exit code 0 = pass, 1 = fail.

using System;
using Kerbcast;

int failures = 0;
void Check(bool cond, string msg)
{
    if (cond) Console.WriteLine("  ok   " + msg);
    else { Console.Error.WriteLine("  FAIL " + msg); failures++; }
}

// --- Budget formula. ---
Check(ReadbackScheduler.Budget(8, 30, 60) == 4, "8 cams, 30fps stream, 60fps game -> 4/frame");
Check(ReadbackScheduler.Budget(8, 30, 30) == 8, "game at stream fps -> no stagger (all 8)");
Check(ReadbackScheduler.Budget(8, 30, 15) == 8, "game below stream fps -> all 8 (can't stagger)");
Check(ReadbackScheduler.Budget(1, 30, 60) == 1, "single camera -> budget 1");
Check(ReadbackScheduler.Budget(0, 30, 60) == 0, "no cameras -> budget 0");
Check(ReadbackScheduler.Budget(8, 0, 60) == 8, "captureFps 0 (pacing off) -> all 8");

// --- Concurrency bound = budget + one slot of headroom for demand that
//     clusters, clamped to the count. Independently derived in the doc comment;
//     the reason it is not the plain budget is measured in CapturePacing.Tests. ---
Check(ReadbackScheduler.ConcurrencyBudget(8, 30, 60) == 5, "8 cams @60fps -> 4 needed, 5 allowed");
Check(ReadbackScheduler.ConcurrencyBudget(3, 30, 45) == 3, "3 cams @45fps -> 2 needed, 3 allowed");
Check(ReadbackScheduler.ConcurrencyBudget(1, 30, 60) == 1, "single camera -> clamped to 1, not 2");
Check(ReadbackScheduler.ConcurrencyBudget(8, 30, 30) == 8, "game at stream fps -> all 8, no more");
Check(ReadbackScheduler.ConcurrencyBudget(0, 30, 60) == 0, "no cameras -> 0, not 1");
for (int c = 1; c <= 8; c++)
    Check(ReadbackScheduler.ConcurrencyBudget(c, 30, 53) >= ReadbackScheduler.Budget(c, 30, 53),
        $"{c} cams @53fps: the bound never sits below what the set needs");

// --- The grant takes the front of the rank order: the caller has already sorted
//     the eligible cameras most-overdue-first, so priority is the order. ---
{
    var permit = new bool[8];
    ReadbackScheduler.GrantByPriority(8, 3, permit);
    Check(permit[0] && permit[1] && permit[2]
        && !permit[3] && !permit[4] && !permit[5] && !permit[6] && !permit[7],
        "budget 3 of 8 grants the three highest-priority ranks");

    ReadbackScheduler.GrantByPriority(3, 5, permit);
    Check(permit[0] && permit[1] && permit[2], "budget >= count grants all");

    ReadbackScheduler.GrantByPriority(3, 0, permit);
    Check(!permit[0] && !permit[1] && !permit[2], "budget 0 grants nobody");

    /* Stateless: the same inputs must give the same answer, so nothing carries
       between ticks. The rotation state this replaced was what starved a camera
       whose rank moved as the eligible set changed size. */
    ReadbackScheduler.GrantByPriority(8, 3, permit);
    bool same = permit[0] && permit[1] && permit[2] && !permit[3];
    ReadbackScheduler.GrantByPriority(8, 3, permit);
    same = same && permit[0] && permit[1] && permit[2] && !permit[3];
    Check(same, "the grant carries no state from tick to tick");
}

// --- Degrade budget: scales cuts up as the level rises, floored at 1. ---
Check(ReadbackScheduler.DegradeBudget(8, 0) == 8, "level 0 -> no temporal cut (all 8)");
Check(ReadbackScheduler.DegradeBudget(8, 1) < 8, "level 1 -> some cameras cut");
{
    int prev = 9;
    bool monotonic = true;
    for (int lvl = 0; lvl <= 5; lvl++)
    {
        int b = ReadbackScheduler.DegradeBudget(8, lvl);
        if (b > prev) monotonic = false;
        if (b < 1) monotonic = false;
        prev = b;
    }
    Check(monotonic, "degrade budget is monotonically non-increasing and never < 1 across levels");
}
Check(ReadbackScheduler.DegradeBudget(8, 99) >= 1, "level clamps past the cascade end (floored at 1)");

// --- EffectiveBudget = min(rate-cap, degrade). ---
// Healthy game above stream fps: rate-cap dominates, degrade (level 0) is full.
Check(ReadbackScheduler.EffectiveBudget(8, 20, 60, 0) == ReadbackScheduler.Budget(8, 20, 60),
    "healthy + level 0 -> just what the set needs");
// Overloaded (game below stream fps so rate-cap = all) but degraded: the level cut wins.
Check(ReadbackScheduler.EffectiveBudget(8, 20, 12, 3) == ReadbackScheduler.DegradeBudget(8, 3),
    "overloaded + level 3 -> degrade budget dominates (temporal cut engages)");
Check(ReadbackScheduler.EffectiveBudget(8, 20, 12, 3) < 8,
    "overloaded + level 3 actually cuts below all-8");

Console.WriteLine(failures == 0 ? "ALL PASS" : $"{failures} FAILURE(S)");
return failures == 0 ? 0 : 1;
