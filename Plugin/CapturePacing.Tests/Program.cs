// Unit tests for CapturePacing: the per-camera capture-rate decisions, both the
// primary rate and the reduced background-capture rate.
//
// What these guard, in order of importance:
//
// 1. THE RATE CAP. No camera captures faster than MaxCaptureFps, whatever the
//    game fps is and whatever the other cameras are doing. Pacing is where that
//    cap lives, because the stagger budget provably cannot hold it: permits are
//    whole numbers shared over the eligible cameras, so the rate it yields
//    (budget/count x gameFps) overshoots by more and more as the set shrinks.
//    Section 10 measures the achieved rate through the whole per-tick loop.
// 2. Background capture keeps a subscribed-but-undisplayed camera ticking over
//    slowly so switching to it promotes an already-flowing stream instead of
//    cold-starting from black, and it draws stagger permits in proportion to its
//    rate rather than competing head-on with the feed being watched.
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

const float Primary = 30f;

// --- 1. No request = primary rate, and the primary rate is paced like any
//        other: due at once, then once per primary interval. ---
{
    var p = new CapturePacing();
    Check(p.Effective(Primary, 0f) == Primary, "no request -> primary rate");
    Check(p.Due(0f, Primary), "no request -> due immediately");
    p.MarkGranted(0f, Primary);
    Check(!p.Due(0.001f, Primary), "primary is NOT due again the next tick");
    Check(p.Due(1f / Primary, Primary), "primary is due one primary interval later");
    Check(!p.IsBackground(Primary, Primary), "primary is not capturing in the background");
}

// --- 2. Hum off (ceiling 0) refuses every request. The default must be free. ---
{
    var p = new CapturePacing { RequestedFps = 1f };
    Check(p.Effective(Primary, 0f) == 0f, "ceiling 0 -> effective 0 (background capture disabled)");
    Check(!p.Due(0f, 0f), "effective 0 -> never due");
    Check(!p.IsBackground(0f, Primary), "not capturing is not capturing in the background");
}

// --- 3. A background request is clamped by the operator ceiling. ---
{
    var p = new CapturePacing { RequestedFps = 10f };
    Check(p.Effective(Primary, 2f) == 2f, "request above ceiling clamps to ceiling");

    var q = new CapturePacing { RequestedFps = 1f };
    Check(q.Effective(Primary, 5f) == 1f, "request below ceiling is honoured as-is");
}

// --- 4. Background capture can slow a camera, never speed it past primary. ---
{
    var p = new CapturePacing { RequestedFps = 120f };
    Check(p.Effective(Primary, 60f) == Primary, "request above primary clamps to primary");
    var q = new CapturePacing { RequestedFps = Primary };
    Check(q.Effective(Primary, 60f) == Primary, "request equal to primary is primary");
}

// --- 5. Pacing: a 1fps background capture is due about once a second, not every tick. ---
{
    var p = new CapturePacing { RequestedFps = 1f };
    float eff = p.Effective(Primary, 5f);
    Check(eff == 1f, "1fps background capture honoured under a 5fps ceiling");

    Check(p.Due(100f, eff), "first capture is due immediately");
    p.MarkGranted(100f, eff);
    Check(!p.Due(100.5f, eff), "not due half an interval later");
    Check(p.Due(101f, eff), "due once the full interval has elapsed");
}

// --- 6. Proportional weight: the whole point of eligibility-based pacing.
//        A 1fps background capture among 30fps ticks should ask for ~1 slot in 30. ---
{
    var p = new CapturePacing { RequestedFps = 1f };
    float eff = p.Effective(Primary, 5f);
    int due = 0;
    for (int tick = 0; tick < 300; tick++)
    {
        float now = tick / Primary; // 30 ticks per second, 10 seconds
        if (p.Due(now, eff)) { due++; p.MarkGranted(now, eff); }
    }
    // 10 seconds at 1fps: 10 captures, plus the immediate first one.
    Check(due >= 9 && due <= 11, $"1fps background capture due ~10x over 10s at 30fps (got {due})");
}

// --- 7. A granted capture, not mere eligibility, restarts the interval. So a
//        camera that loses the draw stays due rather than silently skipping a
//        whole interval. ---
{
    var p = new CapturePacing { RequestedFps = 1f };
    float eff = p.Effective(Primary, 5f);
    Check(p.Due(50f, eff), "due at t=50");
    // Simulate losing the stagger draw: no MarkGranted call.
    Check(p.Due(50.1f, eff), "still due after losing the draw");
    p.MarkGranted(50.1f, eff);
    Check(!p.Due(50.2f, eff), "interval restarts from the GRANT");
}

// --- 8. Reset makes a resubscribing camera due at once. ---
{
    var p = new CapturePacing { RequestedFps = 1f };
    float eff = p.Effective(Primary, 5f);
    p.MarkGranted(1000f, eff);
    Check(!p.Due(1000.1f, eff), "mid-interval, not due");
    p.Reset();
    Check(p.Due(1000.1f, eff), "reset -> due immediately (resubscribe)");
}

// --- 9. IsBackground only when genuinely between off and primary. ---
{
    var p = new CapturePacing();
    Check(p.IsBackground(1f, Primary), "1fps of 30 is capturing in the background");
    Check(!p.IsBackground(Primary, Primary), "primary is not capturing in the background");
    Check(!p.IsBackground(0f, Primary), "off is not capturing in the background");
}

// --- 10. THE RATE CAP. Per-camera capture rate must never exceed MaxCaptureFps,
//         whatever the game fps and whatever the rest of the set is doing.
//
//         This runs KerbcastCore's per-tick loop in miniature: eligibility
//         (CapturePacing.Due) picks the tick's capture set, ReadbackScheduler
//         bounds it, the most overdue get the permits, granted cameras stamp
//         their pacing. The cap is a property of that whole loop, which is why
//         it is tested through the loop rather than on Due alone. ---
{
    /* Achieved capture rate per camera, in fps. requestedFps[i] <= 0 means "no
       request", i.e. a primary camera; anything else is a background request.
       shedBudget > 0 stands in for the stagger controller having cut the budget
       under load, which the concurrency bound would otherwise never do. */
    double[] Simulate(float[] requestedFps, float gameFps, float ceiling, double seconds,
                      int shedBudget = 0)
    {
        int n = requestedFps.Length;
        var pacing = new CapturePacing[n];
        for (int i = 0; i < n; i++)
            pacing[i] = requestedFps[i] > 0f
                ? new CapturePacing { RequestedFps = requestedFps[i] }
                : new CapturePacing();

        var permit = new bool[n];
        var rankIdx = new int[n];
        var rankEff = new float[n];
        var rankOverdue = new float[n];
        var grants = new int[n];

        int ticks = (int)Math.Round(seconds * gameFps);
        for (int tick = 0; tick < ticks; tick++)
        {
            float now = (float)(tick / (double)gameFps);
            int streamCount = 0;      // eligible this tick
            int subscribedCount = 0;  // capturing at all, due or not
            for (int i = 0; i < n; i++)
            {
                float eff = pacing[i].Effective(Primary, ceiling);
                if (eff <= 0f) continue;
                subscribedCount++;
                if (!pacing[i].Due(now, eff)) continue;
                // Most-overdue-first, as the core orders it.
                float overdue = pacing[i].Overdue(now, eff);
                int at = streamCount;
                while (at > 0 && rankOverdue[at - 1] < overdue)
                {
                    rankOverdue[at] = rankOverdue[at - 1];
                    rankIdx[at] = rankIdx[at - 1];
                    rankEff[at] = rankEff[at - 1];
                    at--;
                }
                rankOverdue[at] = overdue;
                rankIdx[at] = i;
                rankEff[at] = eff;
                streamCount++;
            }
            if (streamCount == 0) continue;

            int budget = ReadbackScheduler.ConcurrencyBudget(subscribedCount, Primary, gameFps);
            if (shedBudget > 0 && shedBudget < budget) budget = shedBudget;
            ReadbackScheduler.GrantByPriority(streamCount, budget, permit);
            for (int rank = 0; rank < streamCount; rank++)
            {
                if (!permit[rank]) continue;
                grants[rankIdx[rank]]++;
                pacing[rankIdx[rank]].MarkGranted(now, rankEff[rank]);
            }
        }

        var rates = new double[n];
        for (int i = 0; i < n; i++) rates[i] = grants[i] / seconds;
        return rates;
    }

    const float DeckFps = 53f;   // the fps the overshoot was measured at

    /* Every primary in the set holds the cap: at it, not over it, and no camera
       left behind (an unfair scheduler shows up as one slow feed among fast
       ones, which is how a cursor-reset bug in the round-robin was caught). */
    void CheckPrimaries(double[] rates, int primaries, string what)
    {
        double min = double.MaxValue, max = 0.0;
        for (int i = 0; i < primaries; i++)
        {
            if (rates[i] < min) min = rates[i];
            if (rates[i] > max) max = rates[i];
        }
        Check(max <= Primary * 1.02, $"{what}: fastest {max:F1}fps is within the 30fps cap");
        Check(min >= Primary * 0.95, $"{what}: slowest {min:F1}fps is not left short of it");
        Check(max - min <= 1.5, $"{what}: spread {max - min:F1}fps across cameras is fair");
    }

    // (a) Five primaries, the shape that measured 33.6ms (cap held) on the Deck.
    CheckPrimaries(Simulate(new float[5], DeckFps, 0f, 20.0), 5, "5 primaries @53fps");

    // (b) The reported regression: a camera in background capture shrinks the
    //     eligible set, and the remaining primaries must NOT speed up to fill
    //     the gap (they ran 39.5fps when the budget alone was the cap).
    {
        var rates = Simulate(new[] { 0f, 0f, 0f, 0f, 1f }, DeckFps, 5f, 20.0);
        CheckPrimaries(rates, 4, "4 primaries + 1 background @53fps");
        Check(rates[4] >= 0.5 && rates[4] <= 2.0,
            $"the background camera stays at ~1fps (got {rates[4]:F1})");
    }

    // (c) A single camera: no other camera exists to divide the budget with, so
    //     the cap can only come from the camera's own pacing (it ran 53fps).
    CheckPrimaries(Simulate(new float[1], DeckFps, 0f, 20.0), 1, "1 primary @53fps");

    // (d) A Deck-sized set, and one where most cameras are in background capture.
    CheckPrimaries(Simulate(new float[8], DeckFps, 0f, 20.0), 8, "8 primaries @53fps");
    CheckPrimaries(Simulate(new[] { 0f, 0f, 1f, 1f, 1f, 1f }, DeckFps, 5f, 20.0), 2,
        "2 primaries + 4 background @53fps");

    // (e) Cap holds across game rates that don't divide it evenly, which is the
    //     general case the budget arithmetic could only get right by luck.
    foreach (float g in new[] { 31f, 45f, 53f, 60f, 72f, 90f, 144f })
        CheckPrimaries(Simulate(new float[3], g, 0f, 20.0), 3, $"3 primaries @{g}fps");

    // (f) Below the cap the game frame rate is the limit: every camera captures
    //     every tick, as before.
    {
        var rates = Simulate(new float[4], 20f, 0f, 20.0);
        for (int i = 0; i < rates.Length; i++)
            Check(rates[i] >= 19.0 && rates[i] <= 20.0,
                $"4 primaries @20fps (below cap): cam{i} captures every tick (got {rates[i]:F1})");
    }

    // (g) Under load the stagger controller cuts the budget below what the set
    //     needs. That is the intended lossless temporal degrade, so cameras go
    //     SLOWER than the cap (never faster), and they share the cut evenly.
    {
        var rates = Simulate(new float[5], DeckFps, 0f, 20.0, shedBudget: 2);
        double min = double.MaxValue, max = 0.0, total = 0.0;
        for (int i = 0; i < rates.Length; i++)
        {
            if (rates[i] < min) min = rates[i];
            if (rates[i] > max) max = rates[i];
            total += rates[i];
        }
        Check(max <= Primary * 1.02, $"shed to 2/tick: fastest {max:F1}fps still within the cap");
        Check(total <= 2.0 * DeckFps * 1.02,
            $"shed to 2/tick: {total:F1} captures/s total respects the 2-per-tick budget");
        /* The cut has to fall on everyone, not on one unlucky feed: before the
           scheduler granted by lateness, this set measured 26.4, 26.4, 0.6, 26.4,
           26.3 fps. Judged against the share each camera can have (the budget
           spread five ways) rather than against the cap, which nobody can reach
           while shedding. */
        double share = total / rates.Length;
        Check(max - min <= share * 0.15,
            $"shed to 2/tick: spread {max - min:F1}fps is fair on a {share:F1}fps share");
    }
}

// --- 11. Promotion out of background capture takes effect at once. The whole
//         point of background capture is that switching to a camera shows a
//         flowing stream, so a camera whose rate goes UP must not sit out the
//         remainder of the slow rate's interval first. ---
{
    // Client raises its request: 1fps -> primary.
    {
        var p = new CapturePacing { RequestedFps = 1f };
        p.MarkGranted(10f, p.Effective(Primary, 5f));
        Check(!p.Due(10.1f, 1f), "still paced at 1fps mid-interval");
        p.RequestedFps = null;
        Check(p.Due(10.1f, Primary), "promoted to primary -> due at once, not in 0.9s");
        p.MarkGranted(10.1f, Primary);
        Check(!p.Due(10.11f, Primary), "and then paced at the primary rate");
        Check(p.Due(10.1f + 1f / Primary, Primary), "one primary interval later, due again");
    }

    // Operator ceiling lifts under the same request: 1fps -> 5fps. Nothing about
    // the camera changed, so only the rate in force can reveal it.
    {
        var p = new CapturePacing { RequestedFps = 5f };
        p.MarkGranted(10f, p.Effective(Primary, 1f));   // ceiling held it to 1fps
        Check(!p.Due(10.5f, 1f), "held at the 1fps ceiling mid-interval");
        Check(p.Due(10.5f, 5f), "ceiling lifted to 5fps -> due at once");
    }

    // A rate going DOWN must not pull a capture forward.
    {
        var p = new CapturePacing();
        p.MarkGranted(10f, Primary);
        Check(!p.Due(10.01f, 1f), "demotion to 1fps does not make the camera due early");
    }
}

Console.WriteLine(failures == 0 ? "\nALL CAPTURE-PACING CHECKS PASSED" : $"\n{failures} CHECK(S) FAILED");
return failures == 0 ? 0 : 1;
