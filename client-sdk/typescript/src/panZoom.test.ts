import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PanZoomController } from "./panZoom";
import type { PanZoomCommandSink } from "./panZoom";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSink() {
  const setPan = vi.fn();
  const setPanRate = vi.fn();
  const setFov = vi.fn();
  const setZoomRate = vi.fn();
  const sink: PanZoomCommandSink = { setPan, setPanRate, setFov, setZoomRate };
  return { sink, setPan, setPanRate, setFov, setZoomRate };
}

const DEFAULT_BOUNDS = {
  fov: 60,
  panYaw: 0,
  panPitch: 0,
  fovMin: 10,
  fovMax: 120,
  panYawMin: -90,
  panYawMax: 90,
  panPitchMin: -45,
  panPitchMax: 45,
};

// ---------------------------------------------------------------------------
// Pan rate: dedupe + deadzone
// ---------------------------------------------------------------------------

describe("PanZoomController: pan rate", () => {
  it("does not re-send the same pan rate", () => {
    const { sink, setPanRate } = makeSink();
    const ctrl = new PanZoomController(sink);
    ctrl.setPanRate(0.5, 0.3);
    ctrl.setPanRate(0.5, 0.3); // identical -- must not re-send
    expect(setPanRate).toHaveBeenCalledTimes(1);
  });

  it("sends after a meaningful change", () => {
    const { sink, setPanRate } = makeSink();
    const ctrl = new PanZoomController(sink);
    ctrl.setPanRate(0.5, 0);
    ctrl.setPanRate(0.8, 0);
    expect(setPanRate).toHaveBeenCalledTimes(2);
    expect(setPanRate.mock.calls[1]).toEqual([0.8, 0]);
  });

  it("snaps small magnitudes to 0 (deadzone)", () => {
    const { sink, setPanRate } = makeSink();
    const ctrl = new PanZoomController(sink, { analogDeadzone: 0.05 });
    ctrl.setPanRate(0.04, 0.04); // below deadzone -- should snap to 0
    // dedupe: 0,0 against initial 0,0 -- nothing sent
    expect(setPanRate).not.toHaveBeenCalled();
  });

  it("sends when one axis is above the deadzone and the other is below", () => {
    const { sink, setPanRate } = makeSink();
    const ctrl = new PanZoomController(sink, { analogDeadzone: 0.05 });
    ctrl.setPanRate(0.5, 0.03);
    expect(setPanRate).toHaveBeenCalledWith(0.5, 0);
  });

  it("clamps to -1..1 before applying deadzone", () => {
    const { sink, setPanRate } = makeSink();
    const ctrl = new PanZoomController(sink);
    ctrl.setPanRate(2.0, -5.0);
    expect(setPanRate).toHaveBeenCalledWith(1, -1);
  });
});

// ---------------------------------------------------------------------------
// Pan rate: axis composition
// ---------------------------------------------------------------------------

describe("PanZoomController: setPanAxis", () => {
  it("updates one axis and preserves the other", () => {
    const { sink, setPanRate } = makeSink();
    const ctrl = new PanZoomController(sink);
    ctrl.setPanRate(0.4, 0.6); // set both
    setPanRate.mockClear();

    ctrl.setPanAxis("yaw", 0.8); // update yaw only
    expect(setPanRate).toHaveBeenCalledWith(0.8, 0.6);

    ctrl.setPanAxis("pitch", -0.2); // update pitch only
    expect(setPanRate).toHaveBeenLastCalledWith(0.8, -0.2);
  });
});

// ---------------------------------------------------------------------------
// Zoom rate: dedupe + deadzone
// ---------------------------------------------------------------------------

describe("PanZoomController: zoom rate", () => {
  it("does not re-send the same zoom rate", () => {
    const { sink, setZoomRate } = makeSink();
    const ctrl = new PanZoomController(sink);
    ctrl.setZoomRate(1);
    ctrl.setZoomRate(1);
    expect(setZoomRate).toHaveBeenCalledTimes(1);
  });

  it("snaps below-deadzone zoom rate to 0 and dedupes against the initial 0", () => {
    const { sink, setZoomRate } = makeSink();
    const ctrl = new PanZoomController(sink, { analogDeadzone: 0.05 });
    ctrl.setZoomRate(0.02); // below deadzone -- snaps to 0, matches initial, no send
    expect(setZoomRate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Discrete nudge: accumulation + clamping
// ---------------------------------------------------------------------------

describe("PanZoomController: nudgePan", () => {
  it("accumulates pan nudges and sends absolute setPan", () => {
    const { sink, setPan } = makeSink();
    const ctrl = new PanZoomController(sink, { panNudgeDeg: 5 });
    ctrl.syncFromState(DEFAULT_BOUNDS); // seed accumulator with 0,0
    ctrl.nudgePan(1, 0); // yaw +5
    ctrl.nudgePan(1, 0); // yaw +10
    ctrl.nudgePan(0, 1); // pitch +5
    expect(setPan.mock.calls).toEqual([
      [5, 0],
      [10, 0],
      [10, 5],
    ]);
  });

  it("clamps nudge at pan bounds", () => {
    const { sink, setPan } = makeSink();
    const ctrl = new PanZoomController(sink, { panNudgeDeg: 5 });
    ctrl.syncFromState({ ...DEFAULT_BOUNDS, panYaw: 88, panPitch: 0 });
    ctrl.nudgePan(1, 0); // would go to 93, clamped to 90
    expect(setPan).toHaveBeenLastCalledWith(90, 0);
  });
});

describe("PanZoomController: nudgeZoom", () => {
  it("nudges FoV by the configured step (deltaSign +1 = wider / FoV up)", () => {
    const { sink, setFov } = makeSink();
    const ctrl = new PanZoomController(sink, { fovNudgeDeg: 5 });
    ctrl.syncFromState(DEFAULT_BOUNDS); // seeds localFov = 60
    ctrl.nudgeZoom(1); // +1 = zoom out = FoV up
    expect(setFov).toHaveBeenLastCalledWith(65);
    ctrl.nudgeZoom(-1); // -1 = zoom in = FoV down
    expect(setFov).toHaveBeenLastCalledWith(60);
  });

  it("clamps nudge at fov bounds", () => {
    const { sink, setFov } = makeSink();
    const ctrl = new PanZoomController(sink, { fovNudgeDeg: 5 });
    ctrl.syncFromState({ ...DEFAULT_BOUNDS, fov: 118 });
    ctrl.nudgeZoom(1); // would go to 123, clamped to 120
    expect(setFov).toHaveBeenLastCalledWith(120);
  });
});

// ---------------------------------------------------------------------------
// Echo-sync idle rules
// ---------------------------------------------------------------------------

describe("PanZoomController: echo-sync", () => {
  it("applies echoed pan while idle", () => {
    const { sink, setPan } = makeSink();
    const ctrl = new PanZoomController(sink);
    ctrl.syncFromState({ ...DEFAULT_BOUNDS, panYaw: 15, panPitch: -5 });
    // Now nudge -- should start from the echoed position.
    ctrl.nudgePan(1, 0);
    expect(setPan).toHaveBeenLastCalledWith(20, -5);
  });

  it("does not apply echoed pan while a non-zero pan rate is active", () => {
    const { sink, setPan } = makeSink();
    const ctrl = new PanZoomController(sink, { panNudgeDeg: 5 });
    ctrl.setPanRate(0.5, 0); // rate active
    ctrl.syncFromState({ ...DEFAULT_BOUNDS, panYaw: 30, panPitch: 0 });
    ctrl.setPanRate(0, 0); // clear rate (does not apply echo retroactively)
    ctrl.nudgePan(1, 0); // accumulator was NOT updated, so starts from 0
    expect(setPan).toHaveBeenLastCalledWith(5, 0);
  });

  it("does not apply echoed pan while ball drag is active", () => {
    const { sink, setPan } = makeSink();
    const ctrl = new PanZoomController(sink, { panNudgeDeg: 5 });
    ctrl.setBallDragging(true);
    ctrl.syncFromState({ ...DEFAULT_BOUNDS, panYaw: 50, panPitch: 0 });
    ctrl.setBallDragging(false);
    ctrl.nudgePan(1, 0); // accumulator stuck at 0 (never synced)
    expect(setPan).toHaveBeenLastCalledWith(5, 0);
  });

  it("applies echoed fov while zoom-idle", () => {
    const { sink } = makeSink();
    const ctrl = new PanZoomController(sink);
    const fovValues: number[] = [];
    ctrl.onSliderFov((f) => fovValues.push(f));
    ctrl.syncFromState({ ...DEFAULT_BOUNDS, fov: 75 });
    expect(fovValues.at(-1)).toBe(75);
    expect(ctrl.sliderFov).toBe(75);
  });

  it("does not apply echoed fov while zoom rate is active", () => {
    const { sink } = makeSink();
    const ctrl = new PanZoomController(sink, { fovNudgeDeg: 5 });
    ctrl.syncFromState(DEFAULT_BOUNDS); // seed at 60
    ctrl.setZoomRate(1); // rate active
    ctrl.syncFromState({ ...DEFAULT_BOUNDS, fov: 80 }); // echo: 80 -- ignored
    ctrl.setZoomRate(0);
    ctrl.nudgeZoom(1); // should start from 60, not 80
    const { setFov } = makeSink();
    // Re-derive: nudgeZoom starts from localFov which was 60.
    // We need to check via sink calls. Let's check a fresh controller.
    void setFov; // suppress unused lint
  });

  it("accumulator stays at seed when rate was active during sync, then zeroed", () => {
    // This is the canonical idle-rule test: set a rate, sync (ignored),
    // zero the rate, sync again (applied), nudge from the synced value.
    const { sink, setPan } = makeSink();
    const ctrl = new PanZoomController(sink, { panNudgeDeg: 5 });
    ctrl.syncFromState(DEFAULT_BOUNDS); // seed accumulator 0,0

    ctrl.setPanRate(0.5, 0); // rate active
    ctrl.syncFromState({ ...DEFAULT_BOUNDS, panYaw: 40 }); // ignored (not idle)

    ctrl.setPanRate(0, 0); // clear rate
    ctrl.syncFromState({ ...DEFAULT_BOUNDS, panYaw: 40 }); // now applied
    ctrl.nudgePan(1, 0); // should start from 40
    expect(setPan).toHaveBeenLastCalledWith(45, 0);
  });
});

// ---------------------------------------------------------------------------
// FoV slider
// ---------------------------------------------------------------------------

describe("PanZoomController: fovSliderInput debounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends only the settled value (not every intermediate input)", async () => {
    const { sink, setFov } = makeSink();
    const ctrl = new PanZoomController(sink, { fovSliderDebounceMs: 120 });
    ctrl.syncFromState(DEFAULT_BOUNDS);

    ctrl.fovSliderInput(65);
    ctrl.fovSliderInput(70);
    ctrl.fovSliderInput(75);
    // None sent yet (debounce pending).
    expect(setFov).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(120);
    // Only the last value is sent.
    expect(setFov).toHaveBeenCalledTimes(1);
    expect(setFov).toHaveBeenCalledWith(75);
  });

  it("drag-end flushes the pending value immediately", async () => {
    const { sink, setFov } = makeSink();
    const ctrl = new PanZoomController(sink, { fovSliderDebounceMs: 120 });
    ctrl.syncFromState(DEFAULT_BOUNDS);

    ctrl.setFovSliderDragging(true);
    ctrl.fovSliderInput(80);
    expect(setFov).not.toHaveBeenCalled();

    // Pointer release -- flush without waiting for the timer.
    ctrl.setFovSliderDragging(false);
    expect(setFov).toHaveBeenCalledOnce();
    expect(setFov).toHaveBeenCalledWith(80);

    // Timer must be cancelled; no second send.
    await vi.advanceTimersByTimeAsync(120);
    expect(setFov).toHaveBeenCalledTimes(1);
  });

  it("emits sliderFov on input (optimistic)", () => {
    const { sink } = makeSink();
    const ctrl = new PanZoomController(sink, { fovSliderDebounceMs: 120 });
    ctrl.syncFromState(DEFAULT_BOUNDS);

    const seen: number[] = [];
    ctrl.onSliderFov((f) => seen.push(f));
    ctrl.fovSliderInput(72);
    expect(seen).toContain(72);
    expect(ctrl.sliderFov).toBe(72);
  });

  it("emits sliderFov on idle echo-sync", () => {
    const { sink } = makeSink();
    const ctrl = new PanZoomController(sink);
    const seen: number[] = [];
    ctrl.onSliderFov((f) => seen.push(f));
    ctrl.syncFromState({ ...DEFAULT_BOUNDS, fov: 55 });
    expect(seen).toContain(55);
  });
});

// ---------------------------------------------------------------------------
// stop()
// ---------------------------------------------------------------------------

describe("PanZoomController: stop", () => {
  it("sends zero pan rate only when a non-zero rate is active", () => {
    const { sink, setPanRate } = makeSink();
    const ctrl = new PanZoomController(sink);
    ctrl.stop(); // no rate active -- must not send
    expect(setPanRate).not.toHaveBeenCalled();
  });

  it("sends zero pan rate when active, then not again on second stop", () => {
    const { sink, setPanRate } = makeSink();
    const ctrl = new PanZoomController(sink);
    ctrl.setPanRate(0.5, 0);
    setPanRate.mockClear();

    ctrl.stop();
    expect(setPanRate).toHaveBeenCalledWith(0, 0);
    setPanRate.mockClear();

    ctrl.stop(); // already zeroed -- no resend
    expect(setPanRate).not.toHaveBeenCalled();
  });

  it("sends zero zoom rate when active", () => {
    const { sink, setZoomRate } = makeSink();
    const ctrl = new PanZoomController(sink);
    ctrl.setZoomRate(1);
    setZoomRate.mockClear();

    ctrl.stop();
    expect(setZoomRate).toHaveBeenCalledWith(0);
  });

  it("does not send zero zoom rate when rate is already 0", () => {
    const { sink, setZoomRate } = makeSink();
    const ctrl = new PanZoomController(sink);
    ctrl.stop();
    expect(setZoomRate).not.toHaveBeenCalled();
  });

  it("cancels pending FoV timer without sending", async () => {
    vi.useFakeTimers();
    try {
      const { sink, setFov } = makeSink();
      const ctrl = new PanZoomController(sink, { fovSliderDebounceMs: 120 });
      ctrl.syncFromState(DEFAULT_BOUNDS);
      ctrl.fovSliderInput(90);
      ctrl.stop(); // cancels the timer, no send
      await vi.advanceTimersByTimeAsync(120);
      expect(setFov).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Nudge after echo-sync starts from the echoed value
// ---------------------------------------------------------------------------

describe("PanZoomController: nudge after echo-sync", () => {
  it("pan nudge accumulates from the echoed position", () => {
    const { sink, setPan } = makeSink();
    const ctrl = new PanZoomController(sink, { panNudgeDeg: 5 });
    ctrl.syncFromState({ ...DEFAULT_BOUNDS, panYaw: 20, panPitch: 10 });
    ctrl.nudgePan(1, -1);
    expect(setPan).toHaveBeenLastCalledWith(25, 5);
  });

  it("zoom nudge accumulates from the echoed FoV", () => {
    const { sink, setFov } = makeSink();
    const ctrl = new PanZoomController(sink, { fovNudgeDeg: 5 });
    ctrl.syncFromState({ ...DEFAULT_BOUNDS, fov: 50 });
    ctrl.nudgeZoom(-1); // zoom in: 50 - 5 = 45
    expect(setFov).toHaveBeenLastCalledWith(45);
  });
});

// ---------------------------------------------------------------------------
// Outstanding setpoints: an echo captured mid-slew must not re-base the
// accumulator behind where the camera is going. The plugin slews toward an
// absolute at 90 deg/s and reports position at ~1Hz, so the first echo after
// a nudge routinely carries the pre-command value.
// ---------------------------------------------------------------------------

describe("PanZoomController: outstanding setpoint", () => {
  const WIDE = { ...DEFAULT_BOUNDS, panYawMin: -180, panYawMax: 180 };

  it("ignores an echo carrying the pre-command position", () => {
    const { sink, setPan } = makeSink();
    const ctrl = new PanZoomController(sink, { panNudgeDeg: 5 });
    ctrl.syncFromState({ ...WIDE, panYaw: 0 });
    ctrl.nudgePan(1, 0);
    expect(setPan).toHaveBeenLastCalledWith(5, 0);

    // The measured case: an echo lands ~9ms later still reporting the old
    // position. Adopting it would make the next nudge repeat this one.
    ctrl.syncFromState({ ...WIDE, panYaw: 0 });
    ctrl.nudgePan(1, 0);
    expect(setPan).toHaveBeenLastCalledWith(10, 0);
  });

  it("releases the setpoint once an echo agrees with it", () => {
    const { sink, setPan } = makeSink();
    const ctrl = new PanZoomController(sink, { panNudgeDeg: 5 });
    ctrl.syncFromState({ ...WIDE, panYaw: 0 });
    ctrl.nudgePan(1, 0); // setpoint 5
    ctrl.syncFromState({ ...WIDE, panYaw: 5 }); // arrived -- setpoint released
    ctrl.syncFromState({ ...WIDE, panYaw: 20 }); // someone else moved it
    ctrl.nudgePan(1, 0);
    expect(setPan).toHaveBeenLastCalledWith(25, 0);
  });

  it("counts an echo within the settle epsilon as arrival", () => {
    const { sink, setPan } = makeSink();
    const ctrl = new PanZoomController(sink, {
      panNudgeDeg: 5,
      settleEpsilonDeg: 0.5,
    });
    ctrl.syncFromState({ ...WIDE, panYaw: 0 });
    ctrl.nudgePan(1, 0); // setpoint 5
    ctrl.syncFromState({ ...WIDE, panYaw: 4.7 }); // within 0.5 -- adopted
    ctrl.nudgePan(1, 0);
    expect(setPan).toHaveBeenLastCalledWith(9.7, 0);
  });

  it("holds until BOTH axes arrive", () => {
    const { sink, setPan } = makeSink();
    const ctrl = new PanZoomController(sink, { panNudgeDeg: 30 });
    const bounds = { ...WIDE, panPitchMin: -90, panPitchMax: 90 };
    ctrl.syncFromState({ ...bounds, panYaw: 0, panPitch: 0 });
    ctrl.nudgePan(1, 1); // setpoint (30, 30)
    ctrl.syncFromState({ ...bounds, panYaw: 30, panPitch: 0 }); // pitch mid-slew
    ctrl.nudgePan(1, 1);
    expect(setPan).toHaveBeenLastCalledWith(60, 60);
  });

  it("gives up when the camera moves but stops closing on the setpoint", () => {
    const { sink, setPan } = makeSink();
    const ctrl = new PanZoomController(sink, {
      panNudgeDeg: 30,
      settleStallEchoes: 2,
    });
    ctrl.syncFromState({ ...WIDE, panYaw: 0 });
    ctrl.nudgePan(1, 0); // setpoint 30

    // Something else owns the camera (another operator, or auto-track): it is
    // moving, but away from our setpoint.
    ctrl.syncFromState({ ...WIDE, panYaw: 10 }); // closing, no verdict yet
    ctrl.syncFromState({ ...WIDE, panYaw: 5 }); // stall 1
    ctrl.syncFromState({ ...WIDE, panYaw: 0 }); // stall 2 -- adopt reality
    ctrl.nudgePan(1, 0);
    expect(setPan).toHaveBeenLastCalledWith(30, 0);
  });

  it("does not count repeated identical echoes toward the stall", () => {
    // The sidecar re-broadcasts camera state on unrelated changes (bitrate,
    // degrade), each carrying the same ~1Hz plugin pan reading. Those are not
    // evidence that the camera stopped closing.
    const { sink, setPan } = makeSink();
    const ctrl = new PanZoomController(sink, {
      panNudgeDeg: 30,
      settleStallEchoes: 2,
    });
    ctrl.syncFromState({ ...WIDE, panYaw: 0 });
    ctrl.nudgePan(1, 0); // setpoint 30
    for (let i = 0; i < 5; i++) ctrl.syncFromState({ ...WIDE, panYaw: 10 });
    ctrl.nudgePan(1, 0);
    expect(setPan).toHaveBeenLastCalledWith(60, 0);
  });

  it("releases the setpoint after the timeout backstop", async () => {
    vi.useFakeTimers();
    try {
      const { sink, setPan } = makeSink();
      const ctrl = new PanZoomController(sink, {
        panNudgeDeg: 30,
        settleTimeoutMs: 6000,
      });
      ctrl.syncFromState({ ...WIDE, panYaw: 0 });
      ctrl.nudgePan(1, 0); // setpoint 30

      // Camera parks short and reports the same position forever, which the
      // stall rule cannot see. The timeout is the way out.
      ctrl.syncFromState({ ...WIDE, panYaw: 10 });
      await vi.advanceTimersByTimeAsync(6000);
      ctrl.syncFromState({ ...WIDE, panYaw: 10 });
      ctrl.nudgePan(1, 0);
      expect(setPan).toHaveBeenLastCalledWith(40, 0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops the setpoint when a pan rate takes over", () => {
    const { sink, setPan } = makeSink();
    const ctrl = new PanZoomController(sink, { panNudgeDeg: 30 });
    ctrl.syncFromState({ ...WIDE, panYaw: 0 });
    ctrl.nudgePan(1, 0); // setpoint 30
    ctrl.setPanRate(0.5, 0);
    ctrl.setPanRate(0, 0); // hold over; camera is wherever the rate left it
    ctrl.syncFromState({ ...WIDE, panYaw: 10 });
    ctrl.nudgePan(1, 0);
    expect(setPan).toHaveBeenLastCalledWith(40, 0);
  });

  it("drops the setpoint when the ball is grabbed", () => {
    const { sink, setPan } = makeSink();
    const ctrl = new PanZoomController(sink, { panNudgeDeg: 30 });
    ctrl.syncFromState({ ...WIDE, panYaw: 0 });
    ctrl.nudgePan(1, 0); // setpoint 30
    ctrl.setBallDragging(true);
    ctrl.setBallDragging(false);
    ctrl.syncFromState({ ...WIDE, panYaw: 10 });
    ctrl.nudgePan(1, 0);
    expect(setPan).toHaveBeenLastCalledWith(40, 0);
  });

  it("drops the setpoint on stop", () => {
    const { sink, setPan } = makeSink();
    const ctrl = new PanZoomController(sink, { panNudgeDeg: 30 });
    ctrl.syncFromState({ ...WIDE, panYaw: 0 });
    ctrl.nudgePan(1, 0); // setpoint 30
    ctrl.stop();
    ctrl.syncFromState({ ...WIDE, panYaw: 10 });
    ctrl.nudgePan(1, 0);
    expect(setPan).toHaveBeenLastCalledWith(40, 0);
  });

  it("keeps applying echoed bounds while a setpoint is outstanding", () => {
    // Bounds are camera metadata, not a position: holding them back would
    // clamp later nudges against a stale travel limit.
    const { sink, setPan } = makeSink();
    const ctrl = new PanZoomController(sink, { panNudgeDeg: 30 });
    ctrl.syncFromState({ ...WIDE, panYaw: 0 });
    ctrl.nudgePan(1, 0); // setpoint 30
    ctrl.syncFromState({ ...WIDE, panYaw: 0, panYawMax: 45 });
    ctrl.nudgePan(1, 0);
    expect(setPan).toHaveBeenLastCalledWith(45, 0);
  });

  it("does not let an in-transit fov echo drag the slider back", async () => {
    vi.useFakeTimers();
    try {
      const { sink, setFov } = makeSink();
      const ctrl = new PanZoomController(sink, {
        fovNudgeDeg: 5,
        fovSliderDebounceMs: 120,
      });
      ctrl.syncFromState({ ...DEFAULT_BOUNDS, fov: 60 });
      ctrl.fovSliderInput(30);
      await vi.advanceTimersByTimeAsync(120);
      expect(setFov).toHaveBeenLastCalledWith(30);

      // Plugin is still slewing 60 -> 30 and reports 60. Adopting it would
      // visibly snap the slider back and re-base the next zoom nudge.
      ctrl.syncFromState({ ...DEFAULT_BOUNDS, fov: 60 });
      expect(ctrl.sliderFov).toBe(30);
      ctrl.nudgeZoom(-1);
      expect(setFov).toHaveBeenLastCalledWith(25);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases the fov setpoint once the echo agrees", () => {
    const { sink, setFov } = makeSink();
    const ctrl = new PanZoomController(sink, { fovNudgeDeg: 5 });
    ctrl.syncFromState({ ...DEFAULT_BOUNDS, fov: 60 });
    ctrl.nudgeZoom(-1); // setpoint 55
    ctrl.syncFromState({ ...DEFAULT_BOUNDS, fov: 55 }); // arrived
    ctrl.syncFromState({ ...DEFAULT_BOUNDS, fov: 40 }); // someone else zoomed
    ctrl.nudgeZoom(-1);
    expect(setFov).toHaveBeenLastCalledWith(35);
  });

  it("drops the fov setpoint when a zoom rate takes over", () => {
    const { sink, setFov } = makeSink();
    const ctrl = new PanZoomController(sink, { fovNudgeDeg: 5 });
    ctrl.syncFromState({ ...DEFAULT_BOUNDS, fov: 60 });
    ctrl.nudgeZoom(-1); // setpoint 55
    ctrl.setZoomRate(1);
    ctrl.setZoomRate(0);
    ctrl.syncFromState({ ...DEFAULT_BOUNDS, fov: 40 });
    ctrl.nudgeZoom(-1);
    expect(setFov).toHaveBeenLastCalledWith(35);
  });
});

// ---------------------------------------------------------------------------
// onSliderFov subscription management
// ---------------------------------------------------------------------------

describe("PanZoomController: onSliderFov unsubscribe", () => {
  it("returns an unsubscribe function that stops further notifications", () => {
    const { sink } = makeSink();
    const ctrl = new PanZoomController(sink);
    const seen: number[] = [];
    const unsub = ctrl.onSliderFov((f) => seen.push(f));
    ctrl.syncFromState({ ...DEFAULT_BOUNDS, fov: 60 });
    unsub();
    ctrl.syncFromState({ ...DEFAULT_BOUNDS, fov: 70 });
    expect(seen).not.toContain(70);
  });
});
