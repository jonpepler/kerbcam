// Unit tests for CapturePacing — the background-"hum" capture-rate decisions.
//
// What these guard: the hum keeps a subscribed-but-undisplayed camera ticking
// over slowly so switching to it promotes an already-flowing stream instead of
// cold-starting from black. The load-bearing property is that pacing is
// expressed as ELIGIBILITY — a hum camera joins a tick's capture set only when
// its interval is due — so it draws stagger permits in proportion to its rate
// rather than competing head-on with the feed being watched.
//
// The regression that matters most: with the hum OFF (the default), behaviour
// must be byte-for-byte what it always was. Every subscribed camera eligible
// every tick, no exceptions, whatever the sidecar asks for.
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

// --- 1. No request = primary rate, always due. Today's behaviour. ---
{
    var p = new CapturePacing();
    Check(p.Effective(Primary, 0f) == Primary, "no request -> primary rate");
    Check(p.Due(0f, Primary, Primary), "no request -> due immediately");
    p.MarkGranted(0f);
    Check(p.Due(0.001f, Primary, Primary), "primary stays due every tick");
    Check(!p.IsHumming(Primary, Primary), "primary is not humming");
}

// --- 2. Hum off (ceiling 0) refuses every request. The default must be free. ---
{
    var p = new CapturePacing { RequestedFps = 1f };
    Check(p.Effective(Primary, 0f) == 0f, "ceiling 0 -> effective 0 (hum disabled)");
    Check(!p.Due(0f, 0f, Primary), "effective 0 -> never due");
    Check(!p.IsHumming(0f, Primary), "not capturing is not humming");
}

// --- 3. A hum request is clamped by the operator ceiling. ---
{
    var p = new CapturePacing { RequestedFps = 10f };
    Check(p.Effective(Primary, 2f) == 2f, "request above ceiling clamps to ceiling");

    var q = new CapturePacing { RequestedFps = 1f };
    Check(q.Effective(Primary, 5f) == 1f, "request below ceiling is honoured as-is");
}

// --- 4. The hum can slow a camera, never speed it past primary. ---
{
    var p = new CapturePacing { RequestedFps = 120f };
    Check(p.Effective(Primary, 60f) == Primary, "request above primary clamps to primary");
    var q = new CapturePacing { RequestedFps = Primary };
    Check(q.Effective(Primary, 60f) == Primary, "request equal to primary is primary");
}

// --- 5. Pacing: a 1fps hum is due about once a second, not every tick. ---
{
    var p = new CapturePacing { RequestedFps = 1f };
    float eff = p.Effective(Primary, 5f);
    Check(eff == 1f, "1fps hum honoured under a 5fps ceiling");

    Check(p.Due(100f, eff, Primary), "first capture is due immediately");
    p.MarkGranted(100f);
    Check(!p.Due(100.5f, eff, Primary), "not due half an interval later");
    Check(p.Due(101f, eff, Primary), "due once the full interval has elapsed");
}

// --- 6. Proportional weight: the whole point of eligibility-based pacing.
//        A 1fps hum among 30fps ticks should ask for ~1 slot in 30. ---
{
    var p = new CapturePacing { RequestedFps = 1f };
    float eff = p.Effective(Primary, 5f);
    int due = 0;
    for (int tick = 0; tick < 300; tick++)
    {
        float now = tick / Primary; // 30 ticks per second, 10 seconds
        if (p.Due(now, eff, Primary)) { due++; p.MarkGranted(now); }
    }
    // 10 seconds at 1fps: 10 captures, plus the immediate first one.
    Check(due >= 9 && due <= 11, $"1fps hum due ~10x over 10s at 30fps (got {due})");
}

// --- 7. A granted capture, not mere eligibility, restarts the interval. So a
//        hum camera that loses the round-robin stays due rather than silently
//        skipping a whole interval. ---
{
    var p = new CapturePacing { RequestedFps = 1f };
    float eff = p.Effective(Primary, 5f);
    Check(p.Due(50f, eff, Primary), "due at t=50");
    // Simulate losing the stagger draw: no MarkGranted call.
    Check(p.Due(50.1f, eff, Primary), "still due after losing the round-robin");
    p.MarkGranted(50.1f);
    Check(!p.Due(50.2f, eff, Primary), "interval restarts from the GRANT");
}

// --- 8. Reset makes a resubscribing camera due at once. ---
{
    var p = new CapturePacing { RequestedFps = 1f };
    float eff = p.Effective(Primary, 5f);
    p.MarkGranted(1000f);
    Check(!p.Due(1000.1f, eff, Primary), "mid-interval, not due");
    p.Reset();
    Check(p.Due(1000.1f, eff, Primary), "reset -> due immediately (resubscribe)");
}

// --- 9. IsHumming only when genuinely between off and primary. ---
{
    var p = new CapturePacing();
    Check(p.IsHumming(1f, Primary), "1fps of 30 is humming");
    Check(!p.IsHumming(Primary, Primary), "primary is not humming");
    Check(!p.IsHumming(0f, Primary), "off is not humming");
}

Console.WriteLine(failures == 0 ? "\nALL CAPTURE-PACING CHECKS PASSED" : $"\n{failures} CHECK(S) FAILED");
return failures == 0 ? 0 : 1;
