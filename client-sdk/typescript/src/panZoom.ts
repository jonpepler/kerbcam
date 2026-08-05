/**
 * Headless pan/zoom control state machine extracted from the CameraFeed
 * component. Manages rate deduplication, analog deadzone, optimistic
 * accumulators for discrete nudges, debounced FoV slider, and echo-sync
 * while idle and settled -- all without any DOM or React dependency.
 *
 * `KerbcastCameraHandle` satisfies `PanZoomCommandSink` structurally: pass a
 * camera handle directly as the sink and the controller will drive it.
 *
 * ```ts
 * const cam = client.camera(flightId);
 * const ctrl = new PanZoomController(cam);
 *
 * // Analog stick input
 * ctrl.setPanRate(stickX, stickY);
 *
 * // Discrete nudge buttons
 * ctrl.nudgePan(1, 0);   // pan right one step
 * ctrl.nudgeZoom(-1);    // zoom in one step
 *
 * // FoV slider
 * ctrl.setFovSliderDragging(true);
 * ctrl.fovSliderInput(newFov);
 * ctrl.setFovSliderDragging(false); // flushes immediately
 *
 * // Sync echoed state (call from camera "change" listener)
 * ctrl.syncFromState({ fov, panYaw, panPitch, fovMin, fovMax,
 *                      panYawMin, panYawMax, panPitchMin, panPitchMax });
 *
 * // Cleanup on unmount
 * ctrl.stop();
 * ```
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Command sink that the controller writes to. `KerbcastCameraHandle`
 * satisfies this interface structurally -- no adapter needed.
 */
export interface PanZoomCommandSink {
  setPan(yaw: number, pitch: number): Promise<void> | void;
  setPanRate(yawRate: number, pitchRate: number): Promise<void> | void;
  setFov(fov: number): Promise<void> | void;
  setZoomRate(rate: number): Promise<void> | void;
}

/** Camera FoV and pan bounds for clamping. */
export interface PanZoomBounds {
  fovMin: number;
  fovMax: number;
  panYawMin: number;
  panYawMax: number;
  panPitchMin: number;
  panPitchMax: number;
}

/** Tuning knobs for {@link PanZoomController}. All have safe defaults. */
export interface PanZoomControllerOptions {
  /**
   * Degrees moved per discrete pan nudge (arrow buttons, keyboard).
   * Default: 5.
   */
  panNudgeDeg?: number;
  /**
   * Degrees moved per discrete zoom nudge (zoom buttons, keyboard).
   * Default: 5.
   */
  fovNudgeDeg?: number;
  /**
   * Debounce window (ms) for the FoV slider. Only the settled value is
   * sent; intermediate drag positions do not stream commands.
   * Default: 120.
   */
  fovSliderDebounceMs?: number;
  /**
   * Magnitude below which an analog axis is snapped to 0. Prevents tiny
   * dithering near centre from emitting a stream of non-zero rate commands.
   * Default: 0.05.
   */
  analogDeadzone?: number;
  /**
   * How close an echo has to get to an outstanding setpoint (degrees) before
   * the camera counts as having arrived. Wider than the plugin's own 0.01
   * degree reporting threshold so a rounding difference does not hold the
   * setpoint open.
   * Default: 0.5.
   */
  settleEpsilonDeg?: number;
  /**
   * How many consecutive *moving* echoes may fail to close on an outstanding
   * setpoint before the controller gives up and adopts what the camera
   * reports. Catches something else owning the camera (another operator, or
   * auto-track) without waiting out the full timeout.
   * Default: 2.
   */
  settleStallEchoes?: number;
  /**
   * Hard cap (ms) on how long a setpoint is held against echoes. Backstop for
   * a camera that parks short of the setpoint and then reports the same
   * position forever (a bounds mismatch would do it), which no
   * progress-based rule can detect. Sized for the worst real case: 360
   * degrees of yaw at 90 deg/s plus the plugin's ~1Hz status write.
   * Default: 6000.
   */
  settleTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function applyDeadzone(v: number, deadzone: number): number {
  return Math.abs(v) < deadzone ? 0 : v;
}

/*
  Bookkeeping for an absolute setpoint the camera has been asked for but has
  not been observed to reach. The plugin slews toward a setpoint at a fixed
  rate (90 deg/s of yaw, 60 deg/s of FoV) and reports its position at ~1Hz, so
  echoes arriving during the slew carry positions the camera has already left.
  Feeding those to the accumulator would re-base the next nudge on a stale
  position and lose travel.
*/
interface Settling {
  /* Remaining distance measured at the previous echo; null before the first. */
  lastDistance: number | null;
  /* Consecutive moving echoes that failed to close on the setpoint. */
  stalls: number;
  /* Wall clock at issue, for the timeout backstop. */
  issuedAt: number;
}

function newSettling(): Settling {
  return { lastDistance: null, stalls: 0, issuedAt: Date.now() };
}

// ---------------------------------------------------------------------------
// PanZoomController
// ---------------------------------------------------------------------------

/**
 * Headless pan/zoom state machine. Manages rate deduplication, analog
 * deadzone, optimistic accumulators, FoV slider debounce, and echo-sync
 * idle rules. Mirrors the behaviour of the CameraFeed component in gonogo
 * (CameraFeed.tsx lines 323-592) without any React or DOM coupling.
 */
export class PanZoomController {
  private readonly sink: PanZoomCommandSink;
  private readonly panNudgeDeg: number;
  private readonly fovNudgeDeg: number;
  private readonly fovSliderDebounceMs: number;
  private readonly analogDeadzone: number;
  private readonly settleEpsilonDeg: number;
  private readonly settleStallEchoes: number;
  private readonly settleTimeoutMs: number;

  // Last-sent rates (dedupe against re-sending the same value).
  private sentPanRate = { yaw: 0, pitch: 0 };
  private sentZoomRate = 0;

  // Optimistic accumulators for discrete nudges.
  private localPan = { yaw: 0, pitch: 0 };
  private localFov = 0;

  /*
    Outstanding absolute setpoints. Non-null from the moment a setPan / setFov
    goes out until an echo shows the camera got there (or one of `settled`'s
    give-up rules fires). While one is outstanding the accumulator holds the
    setpoint and echoes do not touch it.
  */
  private panSetpoint: (Settling & { yaw: number; pitch: number }) | null =
    null;
  private fovSetpoint: (Settling & { fov: number }) | null = null;

  // FoV slider state.
  private _sliderFov = 0;
  private sliderDragging = false;
  private fovDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingFov: number | null = null;

  // Drag-ball flag (used only for the idle rule; pixel math lives in the UI).
  private ballDragging = false;

  // Last-known bounds for clamping.
  private bounds: PanZoomBounds = {
    fovMin: 0,
    fovMax: 180,
    panYawMin: -180,
    panYawMax: 180,
    panPitchMin: -90,
    panPitchMax: 90,
  };

  // sliderFov change subscribers.
  private readonly sliderFovListeners = new Set<(fov: number) => void>();

  constructor(sink: PanZoomCommandSink, opts: PanZoomControllerOptions = {}) {
    this.sink = sink;
    this.panNudgeDeg = opts.panNudgeDeg ?? 5;
    this.fovNudgeDeg = opts.fovNudgeDeg ?? 5;
    this.fovSliderDebounceMs = opts.fovSliderDebounceMs ?? 120;
    this.analogDeadzone = opts.analogDeadzone ?? 0.05;
    this.settleEpsilonDeg = opts.settleEpsilonDeg ?? 0.5;
    this.settleStallEchoes = opts.settleStallEchoes ?? 2;
    this.settleTimeoutMs = opts.settleTimeoutMs ?? 6000;
  }

  // ---------------------------------------------------------------------------
  // Public getters
  // ---------------------------------------------------------------------------

  /**
   * Optimistic FoV value tracked by the slider. Follows the pointer while
   * dragging, then the camera echo when idle. Reactive via
   * {@link onSliderFov}.
   */
  get sliderFov(): number {
    return this._sliderFov;
  }

  // ---------------------------------------------------------------------------
  // Echo-sync
  // ---------------------------------------------------------------------------

  /**
   * Sync from the camera's echoed state (call from the camera's `"change"`
   * event listener). Applies the echoed pan to the pan accumulator only when
   * the controller is pan-idle (no active pan rate, no active ball drag).
   * Applies the echoed FoV to the accumulator and slider only when the
   * controller is zoom-idle (zoom rate 0, slider not dragging, no pending
   * debounced send). Mirrors CameraFeed.tsx:370-387.
   *
   * An echo is also held off while an absolute setpoint we sent is still
   * outstanding: the plugin slews toward a setpoint and reports its position
   * at ~1Hz, so echoes in that window carry positions the camera has already
   * left, and adopting one would re-base the next nudge behind where the
   * camera is going.
   */
  syncFromState(
    state: { fov: number; panYaw: number; panPitch: number } & PanZoomBounds,
  ): void {
    this.bounds = {
      fovMin: state.fovMin,
      fovMax: state.fovMax,
      panYawMin: state.panYawMin,
      panYawMax: state.panYawMax,
      panPitchMin: state.panPitchMin,
      panPitchMax: state.panPitchMax,
    };

    const panIdle =
      !this.ballDragging &&
      this.sentPanRate.yaw === 0 &&
      this.sentPanRate.pitch === 0;
    if (panIdle && this.panEchoWins(state.panYaw, state.panPitch)) {
      this.localPan = { yaw: state.panYaw, pitch: state.panPitch };
    }

    const zoomIdle =
      this.sentZoomRate === 0 &&
      !this.sliderDragging &&
      this.pendingFov === null;
    if (zoomIdle && this.fovEchoWins(state.fov)) {
      this.localFov = state.fov;
      this.setSliderFovInternal(state.fov);
    }
  }

  // ---------------------------------------------------------------------------
  // Pan rate
  // ---------------------------------------------------------------------------

  /**
   * Set a persistent normalised pan velocity (-1..1 per axis). Clamps,
   * applies the analog deadzone, and deduplicates against the last-sent
   * value before forwarding to the sink. Mirrors sendPanRate.
   */
  setPanRate(yaw: number, pitch: number): void {
    const y = applyDeadzone(clamp(yaw, -1, 1), this.analogDeadzone);
    const p = applyDeadzone(clamp(pitch, -1, 1), this.analogDeadzone);
    if (y === this.sentPanRate.yaw && p === this.sentPanRate.pitch) return;
    this.sentPanRate = { yaw: y, pitch: p };
    // A rate supersedes any absolute we were still waiting on, including the
    // zero that ends the hold: the camera is wherever the rate left it.
    this.panSetpoint = null;
    void this.sink.setPanRate(y, p);
  }

  /**
   * Update one pan axis, preserving the other. Allows two independent inputs
   * (e.g. a serial stick axis and the ball) to compose rather than clobber
   * each other. Mirrors setPanAxis.
   */
  setPanAxis(axis: "yaw" | "pitch", value: number): void {
    const cur = this.sentPanRate;
    if (axis === "yaw") this.setPanRate(value, cur.pitch);
    else this.setPanRate(cur.yaw, value);
  }

  // ---------------------------------------------------------------------------
  // Zoom rate
  // ---------------------------------------------------------------------------

  /**
   * Set a persistent normalised zoom velocity (-1..1; +1 = zoom in, FoV
   * decreasing). Clamps, applies deadzone, deduplicates. Mirrors sendZoomRate.
   */
  setZoomRate(rate: number): void {
    const r = applyDeadzone(clamp(rate, -1, 1), this.analogDeadzone);
    if (r === this.sentZoomRate) return;
    this.sentZoomRate = r;
    this.fovSetpoint = null; // same reasoning as setPanRate
    void this.sink.setZoomRate(r);
  }

  // ---------------------------------------------------------------------------
  // Discrete nudges
  // ---------------------------------------------------------------------------

  /**
   * Discrete pan step (+1/-1 per axis sign). Moves the pan accumulator by
   * `panNudgeDeg`, clamped to bounds, then sends an absolute `setPan`.
   * Mirrors nudgePan.
   */
  nudgePan(yawSign: number, pitchSign: number): void {
    const b = this.bounds;
    this.localPan.yaw = clamp(
      this.localPan.yaw + yawSign * this.panNudgeDeg,
      b.panYawMin,
      b.panYawMax,
    );
    this.localPan.pitch = clamp(
      this.localPan.pitch + pitchSign * this.panNudgeDeg,
      b.panPitchMin,
      b.panPitchMax,
    );
    this.panSetpoint = {
      yaw: this.localPan.yaw,
      pitch: this.localPan.pitch,
      ...newSettling(),
    };
    void this.sink.setPan(this.localPan.yaw, this.localPan.pitch);
  }

  /**
   * Discrete FoV step. `deltaSign: -1` = zoom in (FoV decreases by
   * `fovNudgeDeg`), `+1` = zoom out (FoV increases). Clamped to fov bounds.
   * Mirrors nudgeZoom (which calls onFovChange internally).
   */
  nudgeZoom(deltaSign: number): void {
    const b = this.bounds;
    const next = clamp(
      this.localFov + deltaSign * this.fovNudgeDeg,
      b.fovMin,
      b.fovMax,
    );
    this.localFov = next;
    this.fovSetpoint = { fov: next, ...newSettling() };
    void this.sink.setFov(next);
  }

  // ---------------------------------------------------------------------------
  // FoV slider
  // ---------------------------------------------------------------------------

  /**
   * Update the optimistic slider value and schedule a debounced `setFov`.
   * The settled (paused) value is what gets sent; rapid drag input does not
   * stream a command per pixel. Mirrors scheduleFovSlider.
   */
  fovSliderInput(fov: number): void {
    this.pendingFov = fov;
    this.setSliderFovInternal(fov);
    if (this.fovDebounceTimer !== null) clearTimeout(this.fovDebounceTimer);
    this.fovDebounceTimer = setTimeout(() => {
      this.fovDebounceTimer = null;
      this.flushFovSlider();
    }, this.fovSliderDebounceMs);
  }

  /**
   * Declare slider drag start/end. While dragging, echo-sync does not
   * override the slider (the user is in control). Setting `false` flushes
   * any pending debounced FoV immediately. Mirrors the pointer-up
   * flushFovSlider call.
   */
  setFovSliderDragging(dragging: boolean): void {
    this.sliderDragging = dragging;
    if (!dragging) this.flushFovSlider();
  }

  /**
   * Subscribe to slider FoV changes. The callback fires on `fovSliderInput`
   * and on idle echo-sync (when the camera echo updates the slider). Returns
   * an unsubscribe function.
   */
  onSliderFov(cb: (fov: number) => void): () => void {
    this.sliderFovListeners.add(cb);
    return () => {
      this.sliderFovListeners.delete(cb);
    };
  }

  // ---------------------------------------------------------------------------
  // Ball drag
  // ---------------------------------------------------------------------------

  /**
   * Declare ball-drag start/end. While dragging, echo-sync does not apply
   * the echoed pan to the local accumulator (the user is in control).
   * The pixel-deflection-to-rate conversion happens in the UI layer; the
   * UI calls `setPanRate` with the normalised result.
   */
  setBallDragging(dragging: boolean): void {
    this.ballDragging = dragging;
    // Taking the ball abandons any absolute we were waiting on.
    if (dragging) this.panSetpoint = null;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Send zero pan and zoom rates if (and only if) a non-zero rate is currently
   * active, and clear drag flags and any pending FoV timer without sending it.
   * Use on component unmount or camera hide -- mirrors the cleanup effects at
   * CameraFeed.tsx:477-508.
   */
  stop(): void {
    if (this.sentPanRate.yaw !== 0 || this.sentPanRate.pitch !== 0) {
      this.sentPanRate = { yaw: 0, pitch: 0 };
      void this.sink.setPanRate(0, 0);
    }
    if (this.sentZoomRate !== 0) {
      this.sentZoomRate = 0;
      void this.sink.setZoomRate(0);
    }
    this.ballDragging = false;
    this.sliderDragging = false;
    // Nothing is being commanded any more, so echoes win again.
    this.panSetpoint = null;
    this.fovSetpoint = null;
    if (this.fovDebounceTimer !== null) {
      clearTimeout(this.fovDebounceTimer);
      this.fovDebounceTimer = null;
    }
    this.pendingFov = null;
  }

  /**
   * Stop the controller and drop all slider-change subscribers. Call when
   * the owning component is permanently destroyed.
   */
  dispose(): void {
    this.stop();
    this.sliderFovListeners.clear();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private flushFovSlider(): void {
    if (this.fovDebounceTimer !== null) {
      clearTimeout(this.fovDebounceTimer);
      this.fovDebounceTimer = null;
    }
    if (this.pendingFov !== null) {
      const fov = clamp(this.pendingFov, this.bounds.fovMin, this.bounds.fovMax);
      this.localFov = fov;
      this.pendingFov = null;
      this.fovSetpoint = { fov, ...newSettling() };
      void this.sink.setFov(fov);
    }
  }

  /*
    Whether an echoed pan should be adopted into the accumulator. True when
    nothing is outstanding, or when the outstanding setpoint has been settled
    one way or another (in which case it is cleared and the camera's own
    reading wins from here).
  */
  private panEchoWins(yaw: number, pitch: number): boolean {
    const sp = this.panSetpoint;
    if (sp === null) return true;
    const distance = Math.max(
      Math.abs(yaw - sp.yaw),
      Math.abs(pitch - sp.pitch),
    );
    if (!this.settled(sp, distance)) return false;
    this.panSetpoint = null;
    return true;
  }

  /* `panEchoWins` for FoV. */
  private fovEchoWins(fov: number): boolean {
    const sp = this.fovSetpoint;
    if (sp === null) return true;
    if (!this.settled(sp, Math.abs(fov - sp.fov))) return false;
    this.fovSetpoint = null;
    return true;
  }

  /*
    Give up on an outstanding setpoint when the camera arrived, when it is
    moving but no longer closing on it (something else owns the camera: another
    operator, or auto-track), or when the timeout backstop expires (it parked
    short and is reporting the same position forever, which no progress-based
    rule can see). Mutates the settling bookkeeping.
  */
  private settled(sp: Settling, distance: number): boolean {
    const eps = this.settleEpsilonDeg;
    if (distance <= eps) return true;
    if (Date.now() - sp.issuedAt >= this.settleTimeoutMs) return true;
    const prev = sp.lastDistance;
    sp.lastDistance = distance;
    if (prev === null) return false;
    const moved = Math.abs(prev - distance) > eps;
    const closing = distance < prev - eps;
    if (!moved) return false;
    sp.stalls = closing ? 0 : sp.stalls + 1;
    return sp.stalls >= this.settleStallEchoes;
  }

  private setSliderFovInternal(fov: number): void {
    this._sliderFov = fov;
    for (const cb of this.sliderFovListeners) cb(fov);
  }
}
