/*
 * Client-side recording controller.
 *
 * Drives the controller against a hand-rolled RecordingClient (the minimal
 * clock + camera + settings-change surface it needs) and the SDK's
 * StubMediaRecorder, so the whole start -> UT-sample -> stop -> handle ->
 * fetch -> Blob path runs headless. Covers the per-feed state machine, UT
 * sampling (incl. the no-UT fallback), mime negotiation, and the grouped
 * coverage-guarantee + commonUtWindow intersection.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CameraState } from "./__generated__/types";
import {
  ARM_TIMEOUT_MS,
  RecordingController,
  commonUtWindow,
  createMediabunnyTrimmerLoader,
  negotiateMimeType,
  utToRecordingTimeMs,
  type GroupTrimmer,
  type RecordingClient,
  type RecordingClientCamera,
  type RecordingHandle,
  type RecordingsSnapshot,
} from "./recording";
import { installDomStubs, StubMediaRecorder } from "./testing/index";

/**
 * A MediaRecorder stand-in whose stop() defers the "stop"/"dataavailable"
 * events to a later, manually-triggered tick -- modelling the real
 * MediaRecorder, where `state` flips to "inactive" synchronously on stop()
 * but the events fire asynchronously. StubMediaRecorder (the SDK's usual
 * test double) fires them synchronously, which can't exercise the
 * discard-while-settling race this file tests.
 */
class DeferredStubMediaRecorder {
  static supportedTypes: string[] | null = null;
  static isTypeSupported(type: string): boolean {
    return DeferredStubMediaRecorder.supportedTypes === null
      ? true
      : DeferredStubMediaRecorder.supportedTypes.includes(type);
  }
  /** Queued stop flushes, oldest first; call and pop to settle one. */
  static pendingStops: (() => void)[] = [];

  state: "inactive" | "recording" | "paused" = "inactive";
  readonly mimeType: string;
  private readonly listeners = new Map<string, Set<(e: { data?: Blob }) => void>>();

  constructor(_stream: MediaStream, options?: { mimeType?: string }) {
    this.mimeType = options?.mimeType ?? "";
  }

  addEventListener(type: string, cb: (e: { data?: Blob }) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(cb);
  }

  removeEventListener(type: string, cb: (e: { data?: Blob }) => void): void {
    this.listeners.get(type)?.delete(cb);
  }

  private emit(type: string, e: { data?: Blob }): void {
    this.listeners.get(type)?.forEach((cb) => cb(e));
  }

  start(): void {
    this.state = "recording";
  }

  stop(): void {
    if (this.state === "inactive") return;
    this.state = "inactive"; // flips synchronously, same as the real API
    DeferredStubMediaRecorder.pendingStops.push(() => {
      const data = new Blob([new Uint8Array(8)], { type: this.mimeType || "video/webm" });
      this.emit("dataavailable", { data });
      this.emit("stop", {});
    });
  }
}

installDomStubs();

/** A stream whose getVideoTracks() reports one live video track. */
function liveStream(): MediaStream {
  const track = { kind: "video" } as MediaStreamTrack;
  return {
    getVideoTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
}

/**
 * Minimal `CameraState` fixture with every required field filled in with a
 * plausible default; override just the fields a test cares about (usually
 * `renderWidth`/`renderHeight`/`operatorWidth`/`operatorHeight`).
 */
function makeCameraState(overrides: Partial<CameraState> = {}): CameraState {
  return {
    flightId: 0,
    partName: "part",
    partTitle: "Part",
    cameraName: "cam",
    vesselName: "Vessel",
    layers: [],
    operatorLayers: [],
    renderWidth: 320,
    renderHeight: 240,
    operatorWidth: 320,
    operatorHeight: 240,
    supportsZoom: false,
    fov: 60,
    fovMin: 10,
    fovMax: 90,
    supportsPan: false,
    panYaw: 0,
    panPitch: 0,
    panYawMin: 0,
    panYawMax: 0,
    panPitchMin: 0,
    panPitchMax: 0,
    encoderBitrateBps: 0,
    targetBitrateBps: 0,
    degradeLevel: 0,
    ...overrides,
  };
}

/**
 * A per-flight camera fake: a settable `mediaStream`/`maxRenderSize`, a
 * `setForceFullResolution` call log, and an `emitState` test hook that
 * mirrors a live `camera-state-changed` push (mutates `state`, notifies
 * `on("change")` subscribers). Stable per flightId across repeated
 * `client.camera(flightId)` calls, as the real client's handle is.
 */
class FakeCamera implements RecordingClientCamera {
  mediaStream: MediaStream | null;
  state: CameraState | null = null;
  maxRenderSize: { width: number; height: number } | null = null;
  readonly forceCalls: boolean[] = [];
  /** When > 0, the next N calls to setForceFullResolution reject instead of
   * resolving (consumed one per call), to simulate a dropped send. */
  forceRejectCount = 0;
  private readonly listeners = new Set<(state: CameraState) => void>();

  constructor(stream: MediaStream | null) {
    this.mediaStream = stream;
  }

  async setForceFullResolution(force: boolean): Promise<void> {
    this.forceCalls.push(force);
    if (this.forceRejectCount > 0) {
      this.forceRejectCount -= 1;
      throw new Error("simulated setForceFullResolution failure");
    }
  }

  on(_event: "change", handler: (state: CameraState) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  /** Test hook: push a new state and notify subscribers. */
  emitState(state: CameraState): void {
    this.state = state;
    for (const l of [...this.listeners]) l(state);
  }

  /** Live "change" subscription count, to assert a wait releases its listener. */
  get changeListenerCount(): number {
    return this.listeners.size;
  }
}

/**
 * Minimal RecordingClient: a settable global capture clock and a per-flight
 * media stream. `tick(ut)` sets the clock and fires settings-change, modelling
 * the sidecar's ~1Hz push.
 */
class FakeRecordingClient implements RecordingClient {
  captureUt: number | null = null;
  private readonly streams = new Map<number, MediaStream | null>();
  private readonly cams = new Map<number, FakeCamera>();
  private readonly listeners = new Set<(data: unknown) => void>();

  setStream(flightId: number, stream: MediaStream | null): void {
    this.streams.set(flightId, stream);
    const cam = this.cams.get(flightId);
    if (cam) cam.mediaStream = stream;
  }

  camera(flightId: number): FakeCamera {
    let cam = this.cams.get(flightId);
    if (!cam) {
      cam = new FakeCamera(this.streams.get(flightId) ?? null);
      this.cams.set(flightId, cam);
    }
    return cam;
  }

  get clock(): { readonly captureUt: number | null } {
    return { captureUt: this.captureUt };
  }

  on(_event: "settings-change", handler: (data: unknown) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  /** Advance the shared capture clock and fire a settings-change push. */
  tick(ut: number | null): void {
    this.captureUt = ut;
    for (const h of [...this.listeners]) h(undefined);
  }

  /** Live settings-change subscription count, to assert a wait releases its subscription. */
  get listenerCount(): number {
    return this.listeners.size;
  }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  StubMediaRecorder.supportedTypes = null;
});

describe("negotiateMimeType", () => {
  beforeEach(() => {
    StubMediaRecorder.supportedTypes = null;
  });

  it("prefers mp4/avc1 when supported", () => {
    expect(negotiateMimeType()).toBe("video/mp4;codecs=avc1");
  });

  it("falls back to webm/vp9 when mp4 is unsupported", () => {
    StubMediaRecorder.supportedTypes = ["video/webm;codecs=vp9", "video/webm"];
    expect(negotiateMimeType()).toBe("video/webm;codecs=vp9");
  });

  it("falls back to plain webm when only webm is supported", () => {
    StubMediaRecorder.supportedTypes = ["video/webm"];
    expect(negotiateMimeType()).toBe("video/webm");
  });

  it("tries a caller-supplied preferred type first", () => {
    StubMediaRecorder.supportedTypes = ["video/webm", "video/x-matroska"];
    expect(negotiateMimeType("video/x-matroska")).toBe("video/x-matroska");
  });

  it("skips the preferred type when it is unsupported", () => {
    StubMediaRecorder.supportedTypes = ["video/webm"];
    expect(negotiateMimeType("video/x-unsupported")).toBe("video/webm");
  });
});

describe("commonUtWindow", () => {
  const handle = (utStart?: number, utEnd?: number): RecordingHandle =>
    ({ utStart, utEnd } as RecordingHandle);

  it("intersects overlapping ranges to [max start, min end]", () => {
    expect(commonUtWindow([handle(100, 130), handle(102, 128)])).toEqual([102, 128]);
  });

  it("is undefined when a clip lacks a full range", () => {
    expect(commonUtWindow([handle(100, 130), handle(undefined, 128)])).toBeUndefined();
  });

  it("is undefined when the ranges do not overlap", () => {
    expect(commonUtWindow([handle(100, 110), handle(120, 130)])).toBeUndefined();
  });

  it("is undefined for an empty set", () => {
    expect(commonUtWindow([])).toBeUndefined();
  });
});

describe("RecordingController per-feed", () => {
  let client: FakeRecordingClient;
  let ctrl: RecordingController;

  beforeEach(() => {
    client = new FakeRecordingClient();
    client.setStream(42, liveStream());
    ctrl = new RecordingController(client);
  });

  it("records start -> stop -> fetch -> Blob", async () => {
    client.captureUt = 100;
    const id = ctrl.startRecording(42);
    expect(ctrl.isRecording(42)).toBe(true);

    client.captureUt = 103;
    const handle = await ctrl.stopRecording(id);

    expect(handle.recordingId).toBe(id);
    expect(handle.blob).toBeInstanceOf(Blob);
    expect(handle.byteSize).toBeGreaterThan(0);
    expect(handle.blob.size).toBe(handle.byteSize);
    expect(handle.mimeType).toBe("video/mp4;codecs=avc1");
    expect(handle.durationMs).toBeGreaterThanOrEqual(0);
    expect(ctrl.isRecording(42)).toBe(false);
    expect(ctrl.fetchRecording(id)).toBe(handle);
  });

  it("puts the negotiated mimeType on the handle and the blob", async () => {
    StubMediaRecorder.supportedTypes = ["video/webm"];
    const id = ctrl.startRecording(42);
    const handle = await ctrl.stopRecording(id);
    expect(handle.mimeType).toBe("video/webm");
    expect(handle.blob.type).toBe("video/webm");
  });

  it("rejects a second recording of a feed already recording", () => {
    ctrl.startRecording(42);
    expect(() => ctrl.startRecording(42)).toThrow(/already recording/);
  });

  it("rejects recording a feed with no live track", () => {
    client.setStream(7, null);
    expect(() => ctrl.startRecording(7)).toThrow(/no live track/);
  });

  it("allows re-recording a feed after it has stopped", async () => {
    const id1 = ctrl.startRecording(42);
    await ctrl.stopRecording(id1);
    const id2 = ctrl.startRecording(42);
    expect(id2).not.toBe(id1);
    await ctrl.stopRecording(id2);
  });

  it("captures utStart, utEnd, and a continuous utSamples series", async () => {
    client.captureUt = 100;
    const id = ctrl.startRecording(42);

    client.tick(101);
    client.tick(102);
    client.captureUt = 103;
    const handle = await ctrl.stopRecording(id);

    expect(handle.utStart).toBe(100);
    expect(handle.utEnd).toBe(103);
    /* start sample + two ticks + stop sample. */
    const uts = handle.utSamples.map((s) => s.ut);
    expect(uts).toEqual([100, 101, 102, 103]);
    /* t is ms-since-start and starts at 0. */
    expect(handle.utSamples[0].t).toBe(0);
    for (const s of handle.utSamples) expect(s.t).toBeGreaterThanOrEqual(0);
  });

  it("falls back to wall-clock when out of flight and upgrades when UT appears", async () => {
    /* No clock at start: utStart absent, samples carry t only. */
    client.captureUt = null;
    const id = ctrl.startRecording(42);
    client.tick(null);
    /* UT appears mid-recording: later samples carry it. */
    client.tick(200);
    const handle = await ctrl.stopRecording(id);

    expect(handle.utStart).toBeUndefined();
    expect(handle.utEnd).toBe(200);
    expect(handle.utSamples[0].ut).toBeUndefined();
    expect(handle.utSamples.some((s) => s.ut === 200)).toBe(true);
    /* Every sample still has a monotonic-ish recording time. */
    expect(handle.utSamples[0].t).toBe(0);
  });

  it("auto-stops at maxDurationMs and leaves the clip fetchable", async () => {
    client.captureUt = 50;
    const id = ctrl.startRecording(42, { maxDurationMs: 5 });
    await new Promise((r) => setTimeout(r, 30));
    expect(ctrl.isRecording(42)).toBe(false);
    const handle = ctrl.fetchRecording(id);
    expect(handle?.recordingId).toBe(id);
  });

  it("discards an active recording without producing a handle", () => {
    const id = ctrl.startRecording(42);
    ctrl.discardRecording(id);
    expect(ctrl.isRecording(42)).toBe(false);
    expect(ctrl.fetchRecording(id)).toBeUndefined();
  });

  it("discards a finished recording, freeing its handle", async () => {
    const id = ctrl.startRecording(42);
    await ctrl.stopRecording(id);
    ctrl.discardRecording(id);
    expect(ctrl.fetchRecording(id)).toBeUndefined();
  });

  it("stopping an unknown recording rejects", async () => {
    await expect(ctrl.stopRecording("nope")).rejects.toThrow(/no recording/);
  });

  it("carries the recording's flightId on the finished handle", async () => {
    const id = ctrl.startRecording(42);
    const handle = await ctrl.stopRecording(id);
    expect(handle.flightId).toBe(42);
  });

  it("does not resurrect a recording discarded while its stop event is still settling", async () => {
    const original = (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = DeferredStubMediaRecorder;
    try {
      const id = ctrl.startRecording(42);
      const stopPromise = ctrl.stopRecording(id);
      /* recorder.state is already "inactive" here (set synchronously by
         stop()), but the "stop" event hasn't fired yet -- exactly the window
         where a discard used to get silently undone. */
      ctrl.discardRecording(id);

      expect(DeferredStubMediaRecorder.pendingStops).toHaveLength(1);
      DeferredStubMediaRecorder.pendingStops.pop()!();
      await stopPromise;

      expect(ctrl.fetchRecording(id)).toBeUndefined();
      expect(ctrl.getSnapshot().recordings.some((r) => r.recordingId === id)).toBe(false);
    } finally {
      (globalThis as { MediaRecorder?: unknown }).MediaRecorder = original;
      DeferredStubMediaRecorder.pendingStops = [];
    }
  });
});

describe("RecordingController force-full-resolution", () => {
  let client: FakeRecordingClient;
  let ctrl: RecordingController;
  let trimCalls: { startMs: number; endMs: number; mimeType: string }[];
  let fakeTrimmer: GroupTrimmer;

  beforeEach(() => {
    client = new FakeRecordingClient();
    for (const flightId of [1, 2, 42, 43]) client.setStream(flightId, liveStream());
    trimCalls = [];
    fakeTrimmer = {
      async trim(_blob, mimeType, startMs, endMs): Promise<Blob> {
        trimCalls.push({ startMs, endMs, mimeType });
        return new Blob([new Uint8Array(16)], { type: mimeType });
      },
    };
    ctrl = new RecordingController(client, { loadTrimmer: () => Promise.resolve(fakeTrimmer) });
  });

  describe("single (arm-and-wait)", () => {
    it("sends force and shows arming immediately", () => {
      const cam = client.camera(42);
      const id = ctrl.startRecording(42, { forceFullResolution: true });

      expect(cam.forceCalls).toEqual([true]);
      expect(ctrl.getSnapshot().active.find((a) => a.recordingId === id)?.arming).toBe(true);
    });

    it("delays recorder.start() until the feed reaches full resolution, ignoring a stale pre-force snapshot (pitfall 1)", async () => {
      const cam = client.camera(42);
      cam.maxRenderSize = { width: 1920, height: 1080 };
      cam.emitState(
        makeCameraState({
          flightId: 42,
          renderWidth: 160,
          renderHeight: 120,
          operatorWidth: 160,
          operatorHeight: 120,
        }),
      );

      const id = ctrl.startRecording(42, { forceFullResolution: true });
      expect(ctrl.getSnapshot().active.find((a) => a.recordingId === id)?.arming).toBe(true);

      /* A stray broadcast still reflecting the pre-force (small) size must
         not be mistaken for readiness. */
      cam.emitState(
        makeCameraState({
          flightId: 42,
          renderWidth: 160,
          renderHeight: 120,
          operatorWidth: 160,
          operatorHeight: 120,
        }),
      );
      await flush();
      expect(ctrl.getSnapshot().active.find((a) => a.recordingId === id)?.arming).toBe(true);

      /* The genuine post-force broadcast: operator + render both at the
         ceiling. */
      cam.emitState(
        makeCameraState({
          flightId: 42,
          renderWidth: 1920,
          renderHeight: 1080,
          operatorWidth: 1920,
          operatorHeight: 1080,
        }),
      );
      await flush();

      expect(ctrl.getSnapshot().active.find((a) => a.recordingId === id)?.arming).toBe(false);
      const handle = await ctrl.stopRecording(id);
      /* The recorder actually started and captured frames. */
      expect(handle.byteSize).toBeGreaterThan(0);
    });

    it("ignores a stray duplicate of the baseline size even when the ceiling is unknown to the client (pitfall 1, no maxRenderSize)", async () => {
      const cam = client.camera(42);
      cam.maxRenderSize = null;
      cam.emitState(
        makeCameraState({
          flightId: 42,
          renderWidth: 160,
          renderHeight: 120,
          operatorWidth: 160,
          operatorHeight: 120,
        }),
      );

      const id = ctrl.startRecording(42, { forceFullResolution: true });

      /* Duplicate of the pre-force baseline: not an increase, must not ready. */
      cam.emitState(
        makeCameraState({
          flightId: 42,
          renderWidth: 160,
          renderHeight: 120,
          operatorWidth: 160,
          operatorHeight: 120,
        }),
      );
      await flush();
      expect(ctrl.getSnapshot().active.find((a) => a.recordingId === id)?.arming).toBe(true);

      /* A genuine increase past the baseline, caught up. */
      cam.emitState(
        makeCameraState({
          flightId: 42,
          renderWidth: 800,
          renderHeight: 600,
          operatorWidth: 800,
          operatorHeight: 600,
        }),
      );
      await flush();
      expect(ctrl.getSnapshot().active.find((a) => a.recordingId === id)?.arming).toBe(false);
    });

    it("does not treat the first post-force broadcast as ready when no state was observed before watch-start (unknown ceiling, no prior discover())", async () => {
      const cam = client.camera(42);
      cam.maxRenderSize = null;
      /* No emitState before startRecording: cam.state is genuinely null,
         unlike the "stray duplicate" test above where a pre-force state was
         already observed. This is the reachable no-discover() case: state
         (data channel) and the track (RTP) are independent transports with
         no ordering guarantee. */
      expect(cam.state).toBeNull();

      const id = ctrl.startRecording(42, { forceFullResolution: true });
      expect(ctrl.getSnapshot().active.find((a) => a.recordingId === id)?.arming).toBe(true);

      /* The FIRST state the client ever observes still reports the small
         pre-force size. A {0,0} placeholder baseline would treat any
         operatorWidth > 0 as "ready"; it must instead become the baseline. */
      cam.emitState(
        makeCameraState({
          flightId: 42,
          renderWidth: 160,
          renderHeight: 120,
          operatorWidth: 160,
          operatorHeight: 120,
        }),
      );
      await flush();
      expect(ctrl.getSnapshot().active.find((a) => a.recordingId === id)?.arming).toBe(true);

      /* A repeat of that same (now-baseline) size still must not ready. */
      cam.emitState(
        makeCameraState({
          flightId: 42,
          renderWidth: 160,
          renderHeight: 120,
          operatorWidth: 160,
          operatorHeight: 120,
        }),
      );
      await flush();
      expect(ctrl.getSnapshot().active.find((a) => a.recordingId === id)?.arming).toBe(true);

      /* A genuine increase past the established baseline, caught up. */
      cam.emitState(
        makeCameraState({
          flightId: 42,
          renderWidth: 800,
          renderHeight: 600,
          operatorWidth: 800,
          operatorHeight: 600,
        }),
      );
      await flush();
      expect(ctrl.getSnapshot().active.find((a) => a.recordingId === id)?.arming).toBe(false);
    });

    it("starts promptly when the feed is already at its ceiling when forced (pitfall 2)", async () => {
      const cam = client.camera(42);
      cam.maxRenderSize = { width: 1920, height: 1080 };
      cam.emitState(
        makeCameraState({
          flightId: 42,
          renderWidth: 1920,
          renderHeight: 1080,
          operatorWidth: 1920,
          operatorHeight: 1080,
        }),
      );

      const id = ctrl.startRecording(42, { forceFullResolution: true });
      /* Resolves on a microtask, not the multi-second arm timeout. */
      await flush();

      expect(ctrl.getSnapshot().active.find((a) => a.recordingId === id)?.arming).toBe(false);
      const handle = await ctrl.stopRecording(id);
      expect(handle.byteSize).toBeGreaterThan(0);
    });

    it("starts anyway after ARM_TIMEOUT_MS when the feed never reaches full resolution", async () => {
      vi.useFakeTimers();
      try {
        const cam = client.camera(42);
        cam.maxRenderSize = { width: 1920, height: 1080 };
        cam.emitState(
          makeCameraState({
            flightId: 42,
            renderWidth: 160,
            renderHeight: 120,
            operatorWidth: 160,
            operatorHeight: 120,
          }),
        );

        const id = ctrl.startRecording(42, { forceFullResolution: true });
        expect(ctrl.getSnapshot().active.find((a) => a.recordingId === id)?.arming).toBe(true);

        await vi.advanceTimersByTimeAsync(ARM_TIMEOUT_MS);

        expect(ctrl.getSnapshot().active.find((a) => a.recordingId === id)?.arming).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("grouped (record immediately)", () => {
    it("starts every member's recorder immediately, without arming", () => {
      const cam1 = client.camera(1);
      const cam2 = client.camera(2);

      const { recordingIds } = ctrl.startGroupedRecording([1, 2], {
        forceFullResolution: true,
      });

      expect(cam1.forceCalls).toEqual([true]);
      expect(cam2.forceCalls).toEqual([true]);
      const active = ctrl.getSnapshot().active;
      expect(active).toHaveLength(2);
      expect(active.every((a) => a.arming === false)).toBe(true);
      expect(recordingIds).toHaveLength(2);
    });

    it("captures each member's resolution-ready UT and folds it into the common trim window", async () => {
      client.captureUt = 500;
      /* maxRenderSize must be set BEFORE starting the group: watchResolutionReady
         reads it synchronously at watch-start, so setting it afterwards would
         silently exercise the (weaker) unknown-ceiling fallback instead of the
         known-ceiling path this test is meant to cover. */
      const cam1 = client.camera(1);
      const cam2 = client.camera(2);
      cam1.maxRenderSize = { width: 1920, height: 1080 };
      cam2.maxRenderSize = { width: 1920, height: 1080 };
      const { groupId, recordingIds } = ctrl.startGroupedRecording([1, 2], {
        forceFullResolution: true,
      });
      const [id1, id2] = recordingIds;

      /* Feed 1 reaches full resolution quickly. */
      client.tick(502);
      cam1.emitState(
        makeCameraState({
          flightId: 1,
          renderWidth: 1920,
          renderHeight: 1080,
          operatorWidth: 1920,
          operatorHeight: 1080,
        }),
      );
      await flush();

      /* Feed 2 reaches full resolution later; this later UT should win the fold. */
      client.tick(506);
      cam2.emitState(
        makeCameraState({
          flightId: 2,
          renderWidth: 1920,
          renderHeight: 1080,
          operatorWidth: 1920,
          operatorHeight: 1080,
        }),
      );
      await flush();

      client.captureUt = 510;
      const handle = await ctrl.stopGroupedRecording(groupId);

      expect(handle.commonUtWindow).toEqual([500, 510]);
      expect(trimCalls).toHaveLength(2);

      /* recordings/trimCalls preserve the [id1, id2] order Promise.all was
         given, regardless of which member's trim settles first. */
      const rec1 = handle.recordings.find((r) => r.recordingId === id1)!;
      const rec2 = handle.recordings.find((r) => r.recordingId === id2)!;
      const [call1, call2] = trimCalls;
      /* The window start used is the LATEST resolution-ready UT (506), not
         the raw common window start (500), for both clips alike (one common
         window, UT-synced). */
      expect(call1.startMs).toBe(utToRecordingTimeMs(rec1.utSamples, 506));
      expect(call2.startMs).toBe(utToRecordingTimeMs(rec2.utSamples, 506));
      /* Confirms the fold actually moved the start later than the untouched
         common window would have. */
      expect(call1.startMs).toBeGreaterThan(utToRecordingTimeMs(rec1.utSamples, 500)!);
    });

    it("leaves the lead-in untrimmed when no member ever reaches full resolution", async () => {
      client.captureUt = 100;
      const { groupId } = ctrl.startGroupedRecording([1, 2], { forceFullResolution: true });
      client.captureUt = 105;
      const handle = await ctrl.stopGroupedRecording(groupId);

      expect(handle.commonUtWindow).toEqual([100, 105]);
      expect(trimCalls).toHaveLength(2);
      for (const call of trimCalls) {
        expect(call.startMs).toBe(utToRecordingTimeMs(handle.recordings[0].utSamples, 100));
      }
    });
  });

  describe("release / ref-counting", () => {
    it("releases force on stopRecording", async () => {
      const cam = client.camera(42);
      cam.maxRenderSize = { width: 320, height: 240 };
      cam.emitState(makeCameraState({ flightId: 42 })); // matches the fixture's default (already "full")
      const id = ctrl.startRecording(42, { forceFullResolution: true });
      await flush();
      await ctrl.stopRecording(id);
      expect(cam.forceCalls).toEqual([true, false]);
    });

    it("releases force on discardRecording", async () => {
      const cam = client.camera(42);
      cam.maxRenderSize = { width: 320, height: 240 };
      cam.emitState(makeCameraState({ flightId: 42 }));
      const id = ctrl.startRecording(42, { forceFullResolution: true });
      await flush();
      ctrl.discardRecording(id);
      expect(cam.forceCalls).toEqual([true, false]);
    });

    it("releases force when a maxDurationMs auto-stop fires after the recorder has started", async () => {
      const cam = client.camera(42);
      cam.maxRenderSize = { width: 320, height: 240 };
      cam.emitState(makeCameraState({ flightId: 42 }));
      ctrl.startRecording(42, { forceFullResolution: true, maxDurationMs: 5 });
      await new Promise((r) => setTimeout(r, 30));

      expect(ctrl.isRecording(42)).toBe(false);
      expect(cam.forceCalls).toEqual([true, false]);
    });

    it("releases force cleanly when a maxDurationMs auto-stop fires while still arming", async () => {
      const cam = client.camera(42);
      cam.maxRenderSize = { width: 1920, height: 1080 };
      cam.emitState(
        makeCameraState({
          flightId: 42,
          renderWidth: 160,
          renderHeight: 120,
          operatorWidth: 160,
          operatorHeight: 120,
        }),
      ); // never reaches full on its own

      const id = ctrl.startRecording(42, {
        forceFullResolution: true,
        maxDurationMs: 5,
      });
      expect(ctrl.getSnapshot().active.find((a) => a.recordingId === id)?.arming).toBe(true);

      await new Promise((r) => setTimeout(r, 30));

      expect(ctrl.isRecording(42)).toBe(false);
      expect(cam.forceCalls).toEqual([true, false]);
      const handle = ctrl.fetchRecording(id);
      expect(handle?.recordingId).toBe(id);
      /* The recorder was never actually started. */
      expect(handle?.byteSize).toBe(0);
    });

    it("discarding mid-arm releases force and never starts the recorder", async () => {
      const cam = client.camera(42);
      cam.maxRenderSize = { width: 1920, height: 1080 };
      cam.emitState(
        makeCameraState({
          flightId: 42,
          renderWidth: 160,
          renderHeight: 120,
          operatorWidth: 160,
          operatorHeight: 120,
        }),
      );

      const id = ctrl.startRecording(42, { forceFullResolution: true });
      expect(ctrl.getSnapshot().active.find((a) => a.recordingId === id)?.arming).toBe(true);

      ctrl.discardRecording(id);

      expect(cam.forceCalls).toEqual([true, false]);
      expect(ctrl.isRecording(42)).toBe(false);
      /* The arm-wait's "change" subscription was cancelled, not leaked. */
      expect(cam.changeListenerCount).toBe(0);

      /* Even if the feed reaches full resolution after the discard, nothing
         resurrects this recording or starts its recorder. */
      cam.emitState(
        makeCameraState({
          flightId: 42,
          renderWidth: 1920,
          renderHeight: 1080,
          operatorWidth: 1920,
          operatorHeight: 1080,
        }),
      );
      await flush();
      expect(ctrl.fetchRecording(id)).toBeUndefined();
      expect(ctrl.getSnapshot().active).toHaveLength(0);
    });

    it("releases force only on the second stop of two overlapping recordings of the same feed", async () => {
      const original = (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
      (globalThis as { MediaRecorder?: unknown }).MediaRecorder = DeferredStubMediaRecorder;
      try {
        const cam = client.camera(42);
        cam.maxRenderSize = { width: 320, height: 240 };
        cam.emitState(makeCameraState({ flightId: 42 })); // already "full", so it arms instantly

        const id1 = ctrl.startRecording(42, { forceFullResolution: true });
        await flush();
        expect(cam.forceCalls).toEqual([true]);

        /* id1's recorder.state flips to "inactive" synchronously, but its
           "stop" event (and its force release) is deferred. */
        const stop1 = ctrl.stopRecording(id1);
        /* Discarding it (rather than awaiting stop1) frees byFlight/active
           immediately, same as the existing discard-while-settling case,
           while id1's own release stays pending until its deferred stop
           actually fires below. */
        ctrl.discardRecording(id1);

        /* A new recording of the same feed starts while id1's belated
           release is still outstanding: a genuine overlap. The ref-count is
           already at 1 (id1's, not yet released), so this second acquire
           (1 -> 2) sends no redundant `true`, since the feed is already
           forced. */
        const id2 = ctrl.startRecording(42, { forceFullResolution: true });
        await flush();
        expect(cam.forceCalls).toEqual([true]);

        /* id1's deferred stop finally fires: the FIRST release. The
           ref-count (2 -> 1) must not clear the force while id2 still holds it. */
        expect(DeferredStubMediaRecorder.pendingStops).toHaveLength(1);
        DeferredStubMediaRecorder.pendingStops.pop()!();
        await stop1;
        expect(cam.forceCalls).toEqual([true]);

        /* Only id2's stop, the SECOND release, actually clears it. */
        const stop2 = ctrl.stopRecording(id2);
        expect(DeferredStubMediaRecorder.pendingStops).toHaveLength(1);
        DeferredStubMediaRecorder.pendingStops.pop()!();
        await stop2;
        expect(cam.forceCalls).toEqual([true, false]);
      } finally {
        (globalThis as { MediaRecorder?: unknown }).MediaRecorder = original;
        DeferredStubMediaRecorder.pendingStops = [];
      }
    });

    it("retries the force-true send on a later overlapping acquire after the first send failed", async () => {
      const original = (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
      (globalThis as { MediaRecorder?: unknown }).MediaRecorder = DeferredStubMediaRecorder;
      try {
        const cam = client.camera(42);
        cam.maxRenderSize = { width: 320, height: 240 };
        cam.forceRejectCount = 1; // id1's force-true send fails silently
        cam.emitState(makeCameraState({ flightId: 42 })); // already "full", so it arms instantly

        const id1 = ctrl.startRecording(42, { forceFullResolution: true });
        await flush();
        /* The send was attempted (0 -> 1 acquire) but rejected: the feed
           was never actually forced. */
        expect(cam.forceCalls).toEqual([true]);

        const stop1 = ctrl.stopRecording(id1);
        ctrl.discardRecording(id1);

        /* A second, overlapping recording of the same feed acquires while
           id1's belated release is still outstanding (ref-count 1 -> 2).
           Because the first send failed, this acquire must retry the true
           send rather than assuming the feed is already forced. */
        const id2 = ctrl.startRecording(42, { forceFullResolution: true });
        await flush();
        expect(cam.forceCalls).toEqual([true, true]);

        /* id1's deferred stop finally fires: the FIRST release. The
           ref-count (2 -> 1) must not clear the force while id2 still
           holds it. */
        expect(DeferredStubMediaRecorder.pendingStops).toHaveLength(1);
        DeferredStubMediaRecorder.pendingStops.pop()!();
        await stop1;
        expect(cam.forceCalls).toEqual([true, true]);

        /* Only id2's stop, the SECOND release, actually clears it. */
        const stop2 = ctrl.stopRecording(id2);
        expect(DeferredStubMediaRecorder.pendingStops).toHaveLength(1);
        DeferredStubMediaRecorder.pendingStops.pop()!();
        await stop2;
        expect(cam.forceCalls).toEqual([true, true, false]);
      } finally {
        (globalThis as { MediaRecorder?: unknown }).MediaRecorder = original;
        DeferredStubMediaRecorder.pendingStops = [];
      }
    });
  });

  describe("not forced", () => {
    it("sends no force message and never arms", async () => {
      const cam = client.camera(42);
      const id = ctrl.startRecording(42);

      expect(cam.forceCalls).toEqual([]);
      expect(ctrl.getSnapshot().active.find((a) => a.recordingId === id)?.arming).toBe(false);

      await ctrl.stopRecording(id);
      expect(cam.forceCalls).toEqual([]);
    });
  });
});

describe("RecordingController grouped", () => {
  let client: FakeRecordingClient;
  let ctrl: RecordingController;
  /** Records every trim call and returns a short canned Blob. */
  let trimCalls: { startMs: number; endMs: number; mimeType: string }[];
  let fakeTrimmer: GroupTrimmer;
  let loadTrimmer: () => Promise<GroupTrimmer | null>;

  beforeEach(() => {
    client = new FakeRecordingClient();
    client.setStream(1, liveStream());
    client.setStream(2, liveStream());
    trimCalls = [];
    fakeTrimmer = {
      async trim(_blob, mimeType, startMs, endMs): Promise<Blob> {
        trimCalls.push({ startMs, endMs, mimeType });
        /* Stand in for a shorter, remuxed clip. */
        return new Blob([new Uint8Array(16)], { type: mimeType });
      },
    };
    loadTrimmer = () => Promise.resolve(fakeTrimmer);
    ctrl = new RecordingController(client, { loadTrimmer });
  });

  it("records a group and returns a handle per feed with a commonUtWindow", async () => {
    client.captureUt = 500;
    const { groupId: g } = ctrl.startGroupedRecording([1, 2]);
    expect(ctrl.isRecording(1)).toBe(true);
    expect(ctrl.isRecording(2)).toBe(true);

    client.captureUt = 510;
    const handle = await ctrl.stopGroupedRecording(g);

    expect(handle.groupId).toBe(g);
    expect(handle.recordings).toHaveLength(2);
    /* Feeds share the global clock, so the intersection is the common span. */
    expect(handle.commonUtWindow).toEqual([500, 510]);
    expect(ctrl.fetchGroupedRecording(g)).toBe(handle);
  });

  it("returns the real per-feed recording ids minted for each member, not a synthetic id", () => {
    const { groupId, recordingIds } = ctrl.startGroupedRecording([1, 2]);
    expect(recordingIds).toHaveLength(2);
    /* Each returned id is exactly what the controller minted internally: not
       derived from groupId/flightId, and each independently resolves via the
       single-recording surface (isRecording / discardRecording / stopRecording). */
    for (const id of recordingIds) {
      expect(id).not.toContain(groupId);
    }
    expect(new Set(recordingIds).size).toBe(2);
  });

  it("lets a single member of an active group be cancelled without disturbing the rest", async () => {
    client.captureUt = 100;
    const { groupId, recordingIds } = ctrl.startGroupedRecording([1, 2]);
    const [firstId, secondId] = recordingIds;

    ctrl.discardRecording(firstId);

    /* The cancelled feed's flightId unlocks and its recorder actually stops.. */
    expect(ctrl.isRecording(1)).toBe(false);
    /* The other member keeps recording. */
    expect(ctrl.isRecording(2)).toBe(true);

    /* A later stopGroupedRecording must not try to stop the discarded member
       (that used to reject with "no recording <id>" and corrupt the whole
       group): it resolves carrying only the survivor. */
    client.captureUt = 110;
    const handle = await ctrl.stopGroupedRecording(groupId);

    expect(handle.recordings).toHaveLength(1);
    expect(handle.recordings[0].recordingId).toBe(secondId);
    expect(ctrl.fetchGroupedRecording(groupId)).toBe(handle);
    /* The discarded member never resurfaces, standalone or otherwise. */
    expect(ctrl.fetchRecording(firstId)).toBeUndefined();
    expect(ctrl.getSnapshot().recordings.some((r) => r.recordingId === firstId)).toBe(false);
  });

  it("resolves an empty grouped handle, cleanly, when every member was discarded before stop", async () => {
    client.captureUt = 100;
    const { groupId, recordingIds } = ctrl.startGroupedRecording([1, 2]);
    for (const id of recordingIds) ctrl.discardRecording(id);

    expect(ctrl.isRecording(1)).toBe(false);
    expect(ctrl.isRecording(2)).toBe(false);

    const handle = await ctrl.stopGroupedRecording(groupId);

    expect(handle.recordings).toEqual([]);
    expect(handle.commonUtWindow).toBeUndefined();
    expect(ctrl.fetchGroupedRecording(groupId)).toBe(handle);
  });

  it("lets a single member of an active group be stopped individually", async () => {
    client.captureUt = 100;
    const { recordingIds } = ctrl.startGroupedRecording([1, 2]);
    const [firstId] = recordingIds;

    const handle = await ctrl.stopRecording(firstId);

    expect(handle.recordingId).toBe(firstId);
    expect(ctrl.isRecording(1)).toBe(false);
    expect(ctrl.isRecording(2)).toBe(true);
  });

  it("rolls back started feeds if one cannot start", () => {
    client.setStream(3, null);
    expect(() => ctrl.startGroupedRecording([1, 3])).toThrow(/no live track/);
    /* Feed 1 must have been rolled back. */
    expect(ctrl.isRecording(1)).toBe(false);
  });

  it("honors the coverage guarantee: does not finalize until every feed passes targetUt", async () => {
    client.captureUt = 100;
    const { groupId: g } = ctrl.startGroupedRecording([1, 2]);

    let resolved = false;
    const done = ctrl.stopGroupedRecording(g, { targetUt: 105 }).then((h) => {
      resolved = true;
      return h;
    });

    await flush();
    expect(resolved).toBe(false);

    client.tick(103); // still short of 105
    await flush();
    expect(resolved).toBe(false);

    client.tick(106); // every feed's latest sample now passes 105
    const handle = await done;
    expect(resolved).toBe(true);
    expect(handle.recordings).toHaveLength(2);
    /* Both feeds saw the covering sample, so utEnd is at/after the target. */
    for (const rec of handle.recordings) {
      expect(rec.utEnd).toBeGreaterThanOrEqual(105);
    }
  });

  it("gives up waiting for coverage after coverageTimeoutMs and finalizes with what's captured", async () => {
    client.captureUt = 100;
    const { groupId: g } = ctrl.startGroupedRecording([1, 2]);

    /* targetUt is never reached (sim frozen / out of flight / warp reversed);
       without a bound this would hang forever. */
    const handle = await ctrl.stopGroupedRecording(g, {
      targetUt: 999,
      coverageTimeoutMs: 20,
    });

    expect(handle.recordings).toHaveLength(2);
    for (const rec of handle.recordings) {
      expect(rec.utEnd).toBe(100);
    }
    /* Both feeds' clock subscriptions and the coverage wait's own subscription
       are released, not leaked. */
    expect(client.listenerCount).toBe(0);
  });

  it("does not wait out the full timeout once coverage arrives first", async () => {
    client.captureUt = 100;
    const { groupId: g } = ctrl.startGroupedRecording([1, 2]);

    const done = ctrl.stopGroupedRecording(g, { targetUt: 105, coverageTimeoutMs: 5000 });
    client.tick(106);
    const handle = await done;

    for (const rec of handle.recordings) {
      expect(rec.utEnd).toBeGreaterThanOrEqual(105);
    }
    expect(client.listenerCount).toBe(0);
  });

  it("finalizes immediately when no targetUt is given", async () => {
    client.captureUt = 100;
    const { groupId: g } = ctrl.startGroupedRecording([1, 2]);
    const handle = await ctrl.stopGroupedRecording(g);
    expect(handle.recordings).toHaveLength(2);
  });

  it("utSamples let a consumer map the common window to each clip's recording-time", async () => {
    client.captureUt = 100;
    const { groupId: g } = ctrl.startGroupedRecording([1, 2]);
    client.tick(101);
    client.tick(102);
    client.captureUt = 103;
    const handle = await ctrl.stopGroupedRecording(g);

    expect(handle.commonUtWindow).toBeDefined();
    const [winStart] = handle.commonUtWindow as [number, number];
    /* Linear UT<->recording-time interpolation off the samples. */
    for (const rec of handle.recordings) {
      const offset = interpolateT(rec.utSamples, winStart);
      expect(offset).not.toBeNull();
      expect(offset as number).toBeGreaterThanOrEqual(0);
      expect(offset as number).toBeLessThanOrEqual(rec.durationMs);
    }
  });

  it("physically trims each grouped clip to the common window", async () => {
    client.captureUt = 100;
    const { groupId: g } = ctrl.startGroupedRecording([1, 2]);
    client.tick(101);
    client.tick(102);
    client.captureUt = 103;
    const handle = await ctrl.stopGroupedRecording(g);

    /* Every mp4 clip was cut. */
    expect(trimCalls).toHaveLength(2);
    for (const call of trimCalls) {
      expect(call.mimeType).toBe("video/mp4;codecs=avc1");
      expect(call.startMs).toBeGreaterThanOrEqual(0);
      expect(call.endMs).toBeGreaterThan(call.startMs);
    }
    /* Clips carry the remuxed (shorter) blob + the trimmed-window duration,
       and the UT metadata still rides along after the physical trim. */
    for (const rec of handle.recordings) {
      expect(rec.byteSize).toBe(16);
      expect(rec.durationMs).toBeGreaterThanOrEqual(0);
      expect(rec.utSamples.length).toBeGreaterThan(0);
      expect(rec.utStart).toBe(100);
      expect(rec.utEnd).toBe(103);
    }
    expect(handle.commonUtWindow).toEqual([100, 103]);
  });

  it("loads the trim package only for grouped recordings, not single ones", () => {
    const loader = vi.fn(() => Promise.resolve(fakeTrimmer));
    const solo = new RecordingController(client, { loadTrimmer: loader });

    const id = solo.startRecording(1);
    expect(loader).not.toHaveBeenCalled();

    solo.startGroupedRecording([2]);
    expect(loader).toHaveBeenCalledTimes(1);

    void solo.stopRecording(id);
  });

  it("degrades to metadata-only for a webm clip (no trim call)", async () => {
    StubMediaRecorder.supportedTypes = ["video/webm"];
    client.captureUt = 100;
    const { groupId: g } = ctrl.startGroupedRecording([1, 2]);
    client.captureUt = 105;
    const handle = await ctrl.stopGroupedRecording(g);

    expect(trimCalls).toHaveLength(0);
    for (const rec of handle.recordings) {
      expect(rec.mimeType).toBe("video/webm");
      /* Original (untrimmed) canned blob size from the stub. */
      expect(rec.byteSize).toBe(2048);
    }
  });

  it("never fails the group when the trimmer throws (metadata-only degrade)", async () => {
    fakeTrimmer.trim = () => Promise.reject(new Error("cannot cut"));
    client.captureUt = 100;
    const { groupId: g } = ctrl.startGroupedRecording([1, 2]);
    client.captureUt = 105;
    const handle = await ctrl.stopGroupedRecording(g);

    expect(handle.recordings).toHaveLength(2);
    for (const rec of handle.recordings) {
      expect(rec.byteSize).toBe(2048); // original, untrimmed
    }
  });

  it("degrades to metadata-only when no trimmer is available", async () => {
    const solo = new RecordingController(client, {
      loadTrimmer: () => Promise.resolve(null),
    });
    client.captureUt = 100;
    const { groupId: g } = solo.startGroupedRecording([1, 2]);
    client.captureUt = 105;
    const handle = await solo.stopGroupedRecording(g);

    expect(handle.recordings).toHaveLength(2);
    expect(handle.commonUtWindow).toEqual([100, 105]);
    for (const rec of handle.recordings) {
      expect(rec.byteSize).toBe(2048);
    }
  });

  it("discards a grouped recording and all its clips", async () => {
    client.captureUt = 100;
    const { groupId: g } = ctrl.startGroupedRecording([1, 2]);
    const handle = await ctrl.stopGroupedRecording(g);
    ctrl.discardGroupedRecording(g);
    expect(ctrl.fetchGroupedRecording(g)).toBeUndefined();
    for (const rec of handle.recordings) {
      expect(ctrl.fetchRecording(rec.recordingId)).toBeUndefined();
    }
  });
});

describe("RecordingController observable snapshot", () => {
  let client: FakeRecordingClient;
  let ctrl: RecordingController;

  beforeEach(() => {
    client = new FakeRecordingClient();
    client.setStream(1, liveStream());
    client.setStream(2, liveStream());
    ctrl = new RecordingController(client, { loadTrimmer: () => Promise.resolve(null) });
  });

  it("returns a referentially stable snapshot between mutations", () => {
    const a = ctrl.getSnapshot();
    const b = ctrl.getSnapshot();
    expect(a).toBe(b);
  });

  it("returns a new snapshot reference after each mutation, notifying subscribers", async () => {
    const listener = vi.fn();
    ctrl.subscribe(listener);

    const before = ctrl.getSnapshot();
    const id = ctrl.startRecording(1);
    expect(listener).toHaveBeenCalledTimes(1);
    const afterStart = ctrl.getSnapshot();
    expect(afterStart).not.toBe(before);
    expect(afterStart.active).toHaveLength(1);

    const handle = await ctrl.stopRecording(id);
    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(2);
    const afterStop = ctrl.getSnapshot();
    expect(afterStop).not.toBe(afterStart);
    expect(afterStop.active).toHaveLength(0);
    expect(afterStop.recordings.map((r) => r.recordingId)).toEqual([handle.recordingId]);

    ctrl.discardRecording(id);
    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(3);
    const afterDiscard = ctrl.getSnapshot();
    expect(afterDiscard).not.toBe(afterStop);
    expect(afterDiscard.recordings).toHaveLength(0);
  });

  it("stops notifying once unsubscribed", () => {
    const listener = vi.fn();
    const unsubscribe = ctrl.subscribe(listener);
    unsubscribe();
    ctrl.startRecording(1);
    expect(listener).not.toHaveBeenCalled();
  });

  it("notifies on group start/stop and keeps group members out of standalone recordings", async () => {
    const listener = vi.fn();
    ctrl.subscribe(listener);

    const { groupId, recordingIds } = ctrl.startGroupedRecording([1, 2]);
    expect(listener).toHaveBeenCalled();
    const afterStart = ctrl.getSnapshot();
    expect(afterStart.active).toHaveLength(2);
    expect(afterStart.active.every((a) => a.groupId === groupId)).toBe(true);
    expect(afterStart.recordings).toHaveLength(0);

    const callsBeforeStop = listener.mock.calls.length;
    const handle = await ctrl.stopGroupedRecording(groupId);
    expect(listener.mock.calls.length).toBeGreaterThan(callsBeforeStop);

    const afterStop = ctrl.getSnapshot();
    expect(afterStop.active).toHaveLength(0);
    /* Group members never show up in the standalone list. */
    expect(afterStop.recordings).toHaveLength(0);
    expect(afterStop.groups).toHaveLength(1);
    expect(afterStop.groups[0].groupId).toBe(handle.groupId);
    expect(afterStop.groups[0].recordings.map((r) => r.recordingId)).toEqual(recordingIds);
  });

  it("never notifies a subscriber with a group member missing its groupId", () => {
    const seen: RecordingsSnapshot[] = [];
    ctrl.subscribe(() => seen.push(ctrl.getSnapshot()));

    ctrl.startGroupedRecording([1, 2]);

    expect(seen.length).toBeGreaterThan(0);
    for (const snap of seen) {
      for (const a of snap.active) {
        if (a.flightId === 1 || a.flightId === 2) {
          expect(a.groupId).toBeDefined();
        }
      }
    }
  });

  it("carries flightId on a grouped clip's finished handle", async () => {
    const { groupId } = ctrl.startGroupedRecording([1, 2]);
    const handle = await ctrl.stopGroupedRecording(groupId);
    expect(handle.recordings.map((r) => r.flightId).sort()).toEqual([1, 2]);
  });

  it("notifies on discardGroupedRecording", async () => {
    const { groupId } = ctrl.startGroupedRecording([1, 2]);
    await ctrl.stopGroupedRecording(groupId);
    const listener = vi.fn();
    ctrl.subscribe(listener);

    ctrl.discardGroupedRecording(groupId);
    expect(listener).toHaveBeenCalled();
    expect(ctrl.getSnapshot().groups).toHaveLength(0);
  });

  it("keeps a standalone (non-grouped) finished recording in the recordings list", async () => {
    const id = ctrl.startRecording(1);
    await ctrl.stopRecording(id);
    expect(ctrl.getSnapshot().recordings.map((r) => r.recordingId)).toEqual([id]);
  });
});

describe("utToRecordingTimeMs", () => {
  /* A clip that started 2 UT-seconds before the window and samples ~1Hz. */
  const samples = [
    { t: 0, ut: 100 },
    { t: 1000, ut: 101 },
    { t: 2000, ut: 102 },
    { t: 3000, ut: 103 },
  ];

  it("interpolates a UT that falls between two samples", () => {
    /* UT 101.5 is halfway between the t=1000 and t=2000 samples. */
    expect(utToRecordingTimeMs(samples, 101.5)).toBe(1500);
  });

  it("maps a window start after the clip start to a nonzero offset", () => {
    expect(utToRecordingTimeMs(samples, 102)).toBe(2000);
  });

  it("clamps below the first and above the last sample", () => {
    expect(utToRecordingTimeMs(samples, 90)).toBe(0);
    expect(utToRecordingTimeMs(samples, 200)).toBe(3000);
  });

  it("is null when the clip has no UT samples", () => {
    expect(utToRecordingTimeMs([{ t: 0 }, { t: 1000 }], 100)).toBeNull();
  });
});

/** Linear interpolation of recording-time (ms) for a UT, off a utSamples series. */
function interpolateT(
  samples: { t: number; ut?: number }[],
  ut: number,
): number | null {
  const pts = samples.filter((s): s is { t: number; ut: number } => s.ut != null);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (ut >= a.ut && ut <= b.ut && b.ut !== a.ut) {
      const frac = (ut - a.ut) / (b.ut - a.ut);
      return a.t + frac * (b.t - a.t);
    }
  }
  if (pts.length > 0 && ut === pts[0].ut) return pts[0].t;
  return null;
}

describe("createMediabunnyTrimmerLoader", () => {
  /** A fake Mediabunny module namespace, shaped like the real package's
      exports, that records what it was asked to do and returns a fixed
      output buffer. */
  function fakeMediabunnyModule(outputBytes: Uint8Array) {
    const calls: { start: number; end: number }[] = [];
    const mb = {
      Input: class {
        constructor(public opts: unknown) {}
      },
      BlobSource: class {
        constructor(public blob: Blob) {}
      },
      ALL_FORMATS: Symbol("ALL_FORMATS"),
      BufferTarget: class {
        buffer: ArrayBuffer | null = outputBytes.buffer as ArrayBuffer;
      },
      Output: class {
        constructor(public opts: unknown) {}
      },
      Mp4OutputFormat: class {},
      Conversion: {
        init: (opts: { trim: { start: number; end: number } }) => {
          calls.push(opts.trim);
          return Promise.resolve({ execute: () => Promise.resolve() });
        },
      },
    };
    return { mb, calls };
  }

  it("builds a trimmer that remuxes through the resolved module's Conversion API", async () => {
    const { mb, calls } = fakeMediabunnyModule(new Uint8Array([1, 2, 3]));
    const loader = createMediabunnyTrimmerLoader(() => Promise.resolve(mb));

    const trimmer = await loader();
    expect(trimmer).not.toBeNull();
    const blob = await trimmer!.trim(new Blob(["x"]), "video/mp4;codecs=avc1", 1000, 2000);

    expect(calls).toEqual([{ start: 1, end: 2 }]);
    expect(blob.size).toBe(3);
    expect(blob.type).toBe("video/mp4;codecs=avc1");
  });

  it("resolves null when the module import rejects", async () => {
    const loader = createMediabunnyTrimmerLoader(() => Promise.reject(new Error("network down")));
    await expect(loader()).resolves.toBeNull();
  });

  it("propagates a trim() failure to the caller (no swallow inside the built trimmer)", async () => {
    const { mb } = fakeMediabunnyModule(new Uint8Array([1]));
    mb.Conversion.init = () => Promise.reject(new Error("cannot cut"));
    const loader = createMediabunnyTrimmerLoader(() => Promise.resolve(mb));

    const trimmer = await loader();
    await expect(trimmer!.trim(new Blob(["x"]), "video/mp4", 0, 1000)).rejects.toThrow(
      "cannot cut",
    );
  });
});
