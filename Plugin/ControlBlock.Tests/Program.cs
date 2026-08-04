// Contract test: read the golden fixture the Rust sidecar emits
// (sidecar/testdata/control_block_v2.bin) through the C# ControlBlock reader
// and assert it decodes to the exact values the Rust `fixture_state()` wrote.
// Both sides validating the same bytes is what stops the hand-maintained binary
// layout from drifting. Exit code 0 = pass, 1 = fail.

using System;
using System.IO;
using Kerbcast;

int failures = 0;
void Check(bool cond, string msg)
{
    if (cond)
    {
        Console.WriteLine("  ok   " + msg);
    }
    else
    {
        Console.Error.WriteLine("  FAIL " + msg);
        failures++;
    }
}

string fixture = Path.Combine(AppContext.BaseDirectory, "control_block_v2.bin");
Console.WriteLine($"fixture: {fixture}");
Check(File.Exists(fixture), "golden fixture present");

ControlBlock block = ControlBlock.Open(fixture, out ControlBlock.OpenResult result);
Check(result == ControlBlock.OpenResult.Ok, $"open result Ok (got {result})");
Check(block != null, "ControlBlock.Open returned a reader");

if (block != null)
{
    bool got = block.TryReadChanged(out ControlSnapshot s);
    Check(got, "TryReadChanged returned a published snapshot");

    // These MUST match sidecar/src/shared_mem/control.rs `fixture_state()`.
    Check(s.Subscribed, "subscribed == true");
    Check(s.HasLayers && s.LayersMask == 5u, "layers present, mask == 5 (Near|Galaxy)");
    Check(s.Width == 640u, "width == 640");
    Check(s.Height == 360u, "height == 360");
    Check(s.Fov == 35.5f, "fov == 35.5");
    Check(s.PanYaw == -12.25f, "panYaw == -12.25");
    Check(s.PanPitch == 7.5f, "panPitch == 7.5");
    Check(s.PanYawRate == 0.0f, "panYawRate == 0 (a present stop, not absent)");
    Check(s.PanPitchRate == null, "panPitchRate absent (None -> null)");
    Check(s.ZoomRate == 1.0f, "zoomRate == 1.0");
    Check(s.PanSeq == 9u, "panSeq == 9");
    Check(s.FovSeq == 4u, "fovSeq == 4");
    Check(s.ViewerLevel == 2u, "viewerLevel == 2 (the half preset)");
    // track_mode is an append: the v2 golden fixture predates it, so its
    // present bit is clear and the reader decodes it as null (not tracking).
    Check(s.TrackMode == null, "trackMode == null (fixture predates the append)");
    Check(s.TrackSeq == 0u, "trackSeq == 0 (fixed field, fixture not tracking)");
    // capture_fps is a later append on the same terms: the fixture predates it,
    // so the bit is clear and null means "capture at the primary rate".
    Check(s.CaptureFps == null, "captureFps == null (fixture predates the append)");
    Check(s.Seq == 2L, "seqlock seq == 2 (exactly one published write)");

    // Change detection: re-reading the same (unchanged) block yields nothing.
    Check(!block.TryReadChanged(out _), "second read returns false (unchanged)");
    block.Dispose();
}

Console.WriteLine();
if (failures == 0)
{
    Console.WriteLine("ALL CONTRACT CHECKS PASSED");
    return 0;
}
Console.Error.WriteLine($"{failures} CONTRACT CHECK(S) FAILED");
return 1;
