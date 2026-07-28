/*
 * Integration test: the mock's simulated force-full-resolution + resolution
 * bump (MockSidecar), driving the REAL RecordingController, not a
 * hand-rolled fake, through a REAL KerbcastClient + MockSidecar pair: the
 * same stack the app's `?mock=1` harness runs (see mock/driver.ts). Proves
 * the mock's `set-force-full-resolution` handling actually satisfies the
 * SDK's arm-and-wait / grouped-trim logic end to end: a forced single feed
 * really arms then records (not stuck arming forever) and a forced group
 * really trims its lead-in to the resolution-ready point.
 *
 * Client-level, not App/component-level: `client.recording` is driven
 * directly. The web app's own option-wiring (Settings toggle governs the
 * single-feed REC button, the REC+ banner checkbox governs the group) is
 * covered separately in recordingFlow.test.tsx, which fakes the recordings
 * store to sidestep jsdom's MediaRecorder/track limitations; this file
 * instead proves the real controller and real mock cooperate correctly.
 */

import { ARM_TIMEOUT_MS, KerbcastClient, utToRecordingTimeMs } from "@ksp-gonogo/kerbcast";
import type { GroupTrimmer } from "@ksp-gonogo/kerbcast";
import { MockSidecar } from "@ksp-gonogo/kerbcast/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionManager } from "./connectionManager";

function fakeVideoTrack(): MediaStreamTrack {
  return { kind: "video" } as MediaStreamTrack;
}

/**
 * Wires a KerbcastClient to `sidecar` the way mock/driver.ts does: dynamic
 * slots, a track delivered on every subscribe, `/cameras` intercepted so
 * `discover()` populates `maxRenderSize`, then connects, opens, and
 * subscribes each of `flightIds`.
 */
async function connectedClientWithTracks(
  sidecar: MockSidecar,
  flightIds: number[],
  loadTrimmer: () => Promise<GroupTrimmer | null>,
): Promise<KerbcastClient> {
  sidecar.withSlots(["0", "1", "2", "3"]);
  sidecar.onSubscribe((_flightId, mid) => sidecar.deliverTrack(mid, fakeVideoTrack()));

  vi.spyOn(globalThis, "fetch").mockImplementation((input: RequestInfo | URL) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    if (url.endsWith("/cameras")) {
      return Promise.resolve(
        new Response(JSON.stringify({ cameras: sidecar.discoveredCameras() }), { status: 200 }),
      );
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });

  const client = new KerbcastClient(
    { host: "h", port: 1, negotiate: (o) => sidecar.negotiate(o), recording: { loadTrimmer } },
    sidecar.createTransport(),
  );
  await client.discover();
  await client.connect([], { slots: 4 });
  sidecar.open();
  sidecar.setConnectionState("connected");
  for (const flightId of flightIds) {
    await client.subscribe(flightId);
  }
  return client;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("force-full-resolution through the mock: single feed", () => {
  it("arms, sends force, then records once the mock bumps resolution, and clears force on stop", async () => {
    vi.useFakeTimers();
    const sidecar = new MockSidecar({ forceBumpDelayMs: 200 });
    sidecar.addCamera({
      flightId: 42,
      renderWidth: 640,
      renderHeight: 360,
      operatorWidth: 640,
      operatorHeight: 360,
      maxWidth: 1920,
      maxHeight: 1080,
    });
    const client = await connectedClientWithTracks(sidecar, [42], () => Promise.resolve(null));

    // maxRenderSize came from discover(): the "known ceiling" ready check,
    // not the weaker "operator size increased" fallback.
    expect(client.camera(42).maxRenderSize).toEqual({ width: 1920, height: 1080 });

    const id = client.recording.startRecording(42, { forceFullResolution: true });

    expect(sidecar.lastCommand("set-force-full-resolution", 42)?.content.force).toBe(true);
    expect(client.recording.getSnapshot().active.find((a) => a.recordingId === id)?.arming).toBe(
      true,
    );

    // Not yet: the mock hasn't landed the bump.
    await vi.advanceTimersByTimeAsync(50);
    expect(client.recording.getSnapshot().active.find((a) => a.recordingId === id)?.arming).toBe(
      true,
    );

    await vi.advanceTimersByTimeAsync(150);
    expect(client.recording.getSnapshot().active.find((a) => a.recordingId === id)?.arming).toBe(
      false,
    );

    await client.recording.stopRecording(id);
    expect(sidecar.lastCommand("set-force-full-resolution", 42)?.content.force).toBe(false);
  });

  it("never arms and sends no force message when forceFullResolution is not set", async () => {
    const sidecar = new MockSidecar();
    sidecar.addCamera({ flightId: 42 });
    const client = await connectedClientWithTracks(sidecar, [42], () => Promise.resolve(null));

    const id = client.recording.startRecording(42);

    expect(sidecar.lastCommand("set-force-full-resolution", 42)).toBeUndefined();
    expect(client.recording.getSnapshot().active.find((a) => a.recordingId === id)?.arming).toBe(
      false,
    );
  });
});

describe("force-full-resolution through the mock: grouped", () => {
  it("records every member immediately (no arming) and trims the lead-in to the resolution-ready point", async () => {
    vi.useFakeTimers();
    const sidecar = new MockSidecar({ forceBumpDelayMs: 200 });
    for (const flightId of [1, 2]) {
      sidecar.addCamera({
        flightId,
        renderWidth: 640,
        renderHeight: 360,
        operatorWidth: 640,
        operatorHeight: 360,
        maxWidth: 1920,
        maxHeight: 1080,
      });
    }

    const trimCalls: { startMs: number; endMs: number }[] = [];
    const fakeTrimmer: GroupTrimmer = {
      trim: async (blob, _mimeType, startMs, endMs) => {
        trimCalls.push({ startMs, endMs });
        return blob;
      },
    };
    const client = await connectedClientWithTracks(sidecar, [1, 2], () =>
      Promise.resolve(fakeTrimmer),
    );

    sidecar.fireSettingsState({ throttleMainScreen: false, captureUt: 500 });

    const { groupId, recordingIds } = client.recording.startGroupedRecording([1, 2], {
      forceFullResolution: true,
    });

    // Grouped members record immediately: no arming, ever.
    const active = client.recording.getSnapshot().active;
    expect(active.every((a) => a.arming === false)).toBe(true);
    expect(sidecar.lastCommand("set-force-full-resolution", 1)?.content.force).toBe(true);
    expect(sidecar.lastCommand("set-force-full-resolution", 2)?.content.force).toBe(true);

    // Some recording-time passes (a distinct utSamples point), then UT
    // advances while the feeds are still catching up to full resolution.
    await vi.advanceTimersByTimeAsync(100);
    sidecar.fireSettingsState({ throttleMainScreen: false, captureUt: 506 });

    // The remaining half of the bump delay elapses: both cameras' bumps land,
    // each firing camera-state-changed, which resolves each member's
    // resolution-ready wait at the CURRENT captureUt (still 506).
    await vi.advanceTimersByTimeAsync(100);

    sidecar.fireSettingsState({ throttleMainScreen: false, captureUt: 510 });
    const handle = await client.recording.stopGroupedRecording(groupId);

    expect(handle.commonUtWindow).toEqual([500, 510]);
    expect(trimCalls).toHaveLength(2);

    const rec1 = handle.recordings.find((r) => r.recordingId === recordingIds[0])!;
    const expectedStartMs = utToRecordingTimeMs(rec1.utSamples, 506);
    expect(trimCalls[0].startMs).toBe(expectedStartMs);
    // Confirms the fold actually moved the start later than the raw common
    // window (500) would have, i.e. the low-res lead-in is really cut.
    expect(trimCalls[0].startMs).toBeGreaterThan(utToRecordingTimeMs(rec1.utSamples, 500)!);
  });

  it("leaves the lead-in untrimmed when no member ever reaches full resolution", async () => {
    // Real timers: a gap exists (the mock *could* bump these), but the test
    // never waits out the delay, modelling a feed that's out of flight or
    // wedged and never actually lands the bump (the design's documented
    // "never reaches full" edge case, bounded rather than hanging forever).
    const sidecar = new MockSidecar({ forceBumpDelayMs: 200 });
    sidecar.addCamera({
      flightId: 1,
      operatorWidth: 640,
      operatorHeight: 360,
      maxWidth: 1920,
      maxHeight: 1080,
    });
    sidecar.addCamera({
      flightId: 2,
      operatorWidth: 640,
      operatorHeight: 360,
      maxWidth: 1920,
      maxHeight: 1080,
    });

    const trimCalls: { startMs: number; endMs: number }[] = [];
    const fakeTrimmer: GroupTrimmer = {
      trim: async (blob, _mimeType, startMs, endMs) => {
        trimCalls.push({ startMs, endMs });
        return blob;
      },
    };
    const client = await connectedClientWithTracks(sidecar, [1, 2], () =>
      Promise.resolve(fakeTrimmer),
    );

    sidecar.fireSettingsState({ throttleMainScreen: false, captureUt: 100 });
    const { groupId } = client.recording.startGroupedRecording([1, 2], {
      forceFullResolution: true,
    });
    sidecar.fireSettingsState({ throttleMainScreen: false, captureUt: 105 });
    const handle = await client.recording.stopGroupedRecording(groupId);

    expect(handle.commonUtWindow).toEqual([100, 105]);
    expect(trimCalls).toHaveLength(2);
    for (const call of trimCalls) {
      expect(call.startMs).toBe(utToRecordingTimeMs(handle.recordings[0].utSamples, 100));
    }
  });
});

/*
 * Regression coverage for the production connect path: connectedClientWithTracks
 * above calls discover() manually (a test-only convenience), but the real web
 * page's ConnectionManager is what actually drives connect() in the browser.
 * Before this fix, ConnectionManager never called discover(), so
 * maxRenderSize stayed null for every feed and a force-full-resolution arm on
 * a feed already at its render ceiling had no known target to check against;
 * it fell back to the weaker "operator size increased" heuristic, which can
 * never fire for a feed that never changes, so the single-recording
 * arm-and-wait ran out the full ARM_TIMEOUT_MS before recording started,
 * losing the first ~3s of the clip.
 */
describe("force-full-resolution through the real production connect flow (ConnectionManager)", () => {
  it("arms promptly for a feed already at its render ceiling, because ConnectionManager wires discover() into connect()", async () => {
    const sidecar = new MockSidecar();
    sidecar.withSlots(["0", "1", "2", "3", "4", "5", "6", "7"]);
    sidecar.onSubscribe((_flightId, mid) => sidecar.deliverTrack(mid, fakeVideoTrack()));
    sidecar.addCamera({
      flightId: 7,
      renderWidth: 1280,
      renderHeight: 720,
      operatorWidth: 1280,
      operatorHeight: 720,
    });

    vi.spyOn(globalThis, "fetch").mockImplementation((input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      if (url.endsWith("/cameras")) {
        return Promise.resolve(
          new Response(JSON.stringify({ cameras: sidecar.discoveredCameras() }), { status: 200 }),
        );
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    const client = new KerbcastClient(
      { host: "h", port: 1, negotiate: (o) => sidecar.negotiate(o) },
      sidecar.createTransport(),
    );

    const manager = new ConnectionManager(client);
    manager.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    sidecar.open();
    sidecar.setConnectionState("connected");
    await new Promise((resolve) => setTimeout(resolve, 0));

    await client.subscribe(7);

    expect(client.camera(7).maxRenderSize).toEqual({ width: 1280, height: 720 });

    const id = client.recording.startRecording(7, { forceFullResolution: true });
    expect(
      client.recording.getSnapshot().active.find((a) => a.recordingId === id)?.arming,
    ).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      client.recording.getSnapshot().active.find((a) => a.recordingId === id)?.arming,
    ).toBe(false);

    await client.recording.stopRecording(id);
    manager.stop();
  });

  it("regression guard: with maxRenderSize unknown (no discover()), the same already-at-ceiling feed stalls for the full ARM_TIMEOUT_MS", async () => {
    vi.useFakeTimers();
    try {
      const sidecar = new MockSidecar();
      sidecar.withSlots(["0", "1", "2", "3"]);
      sidecar.onSubscribe((_flightId, mid) => sidecar.deliverTrack(mid, fakeVideoTrack()));
      sidecar.addCamera({
        flightId: 7,
        renderWidth: 1280,
        renderHeight: 720,
        operatorWidth: 1280,
        operatorHeight: 720,
      });

      const client = new KerbcastClient(
        { host: "h", port: 1, negotiate: (o) => sidecar.negotiate(o) },
        sidecar.createTransport(),
      );
      await client.connect([], { slots: 4 });
      sidecar.open();
      sidecar.setConnectionState("connected");
      await client.subscribe(7);

      expect(client.camera(7).maxRenderSize).toBeNull();

      const id = client.recording.startRecording(7, { forceFullResolution: true });
      expect(
        client.recording.getSnapshot().active.find((a) => a.recordingId === id)?.arming,
      ).toBe(true);

      await vi.advanceTimersByTimeAsync(ARM_TIMEOUT_MS - 100);
      expect(
        client.recording.getSnapshot().active.find((a) => a.recordingId === id)?.arming,
      ).toBe(true);

      await vi.advanceTimersByTimeAsync(200);
      expect(
        client.recording.getSnapshot().active.find((a) => a.recordingId === id)?.arming,
      ).toBe(false);

      await client.recording.stopRecording(id);
    } finally {
      vi.useRealTimers();
    }
  });
});
