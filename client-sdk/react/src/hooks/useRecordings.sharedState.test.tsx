/*
 * Regression test for the shared-state bug: two independent useRecordings()
 * call sites over the same client must see the same controller state. Before
 * the observable-store fix, each call site held its own useState mirror, so
 * a clip started/stopped through one component's hook was invisible to
 * another -- the exact scenario where a tile's own REC button starts a clip
 * a RecordingsTray elsewhere can never reach (data loss).
 *
 * Must fail on the old per-instance-useState hook and pass once
 * useRecordings consumes RecordingController via useSyncExternalStore.
 */

import type { KerbcastClient } from "@ksp-gonogo/kerbcast";
import { RecordingController, type RecordingClient } from "@ksp-gonogo/kerbcast";
import { installDomStubs, StubMediaRecorder } from "@ksp-gonogo/kerbcast/testing";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { KerbcastProvider } from "../context";
import { useRecordings, type RecordingsStore } from "./useRecordings";

installDomStubs();

function liveStream(): MediaStream {
  const track = { kind: "video" } as MediaStreamTrack;
  return {
    getVideoTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
}

/** Fake RecordingClient with a settable clock; enough for the controller. */
class FakeRecordingClient implements RecordingClient {
  captureUt: number | null = 100;
  camera(_flightId: number): { readonly mediaStream: MediaStream | null } {
    return { mediaStream: liveStream() };
  }
  get clock(): { readonly captureUt: number | null } {
    return { captureUt: this.captureUt };
  }
  on(_event: "settings-change", _handler: (data: unknown) => void): () => void {
    return () => {};
  }
}

function fakeClient(): KerbcastClient {
  const controller = new RecordingController(new FakeRecordingClient(), {
    loadTrimmer: () => Promise.resolve(null),
  });
  return { recording: controller } as unknown as KerbcastClient;
}

let storeA: RecordingsStore | undefined;
let storeB: RecordingsStore | undefined;

/* Two components mounted side by side, each calling useRecordings() on its
   own, standing in for a CameraFeed's own REC control and a separately
   mounted RecordingsTray. */
function ProbeA(): null {
  storeA = useRecordings();
  return null;
}
function ProbeB(): null {
  storeB = useRecordings();
  return null;
}

function mount(client: KerbcastClient): void {
  render(
    <KerbcastProvider client={client}>
      <ProbeA />
      <ProbeB />
    </KerbcastProvider>,
  );
}

afterEach(() => {
  cleanup();
  storeA = undefined;
  storeB = undefined;
  StubMediaRecorder.supportedTypes = null;
});

describe("useRecordings shared store", () => {
  it("makes an in-progress recording started via one call site visible to another", () => {
    mount(fakeClient());

    let id = "";
    act(() => {
      id = storeA!.start(42);
    });

    expect(storeB?.active).toHaveLength(1);
    expect(storeB?.active[0]).toMatchObject({ flightId: 42, recordingId: id });
  });

  it("makes a clip finished via one call site's stop visible in another's recordings", async () => {
    mount(fakeClient());

    let id = "";
    act(() => {
      id = storeA!.start(42);
    });

    await act(async () => {
      await storeA!.stop(id);
    });

    expect(storeA?.active).toHaveLength(0);
    expect(storeA?.recordings).toHaveLength(1);

    /* storeB never called start/stop itself: without the fix, this clip is
       unreachable through it, which is exactly the data-loss bug. */
    expect(storeB?.active).toHaveLength(0);
    expect(storeB?.recordings).toHaveLength(1);
    expect(storeB?.recordings[0].recordingId).toBe(id);
  });
});
