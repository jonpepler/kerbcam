/*
 * useRecordings store.
 *
 * Renders the hook through a real KerbcastProvider, backed by a fake client
 * whose `recording` is a real RecordingController over a fake clock/camera
 * surface (the SDK's own controller path is unit-tested in the typescript
 * package). Asserts the store reflects start -> stop into `recordings` /
 * `groups` / `active`, keeps grouped members out of the singles list, and
 * clears on discard.
 */

import type { KerbcastClient } from "@ksp-gonogo/kerbcast";
import {
  RecordingController,
  type RecordingClient,
} from "@ksp-gonogo/kerbcast";
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

/** A KerbcastClient stand-in exposing only what the hook reads: `.recording`.
 *  The trimmer loader is stubbed to null so grouped stops stay hermetic (the
 *  physical-trim path itself is covered in the typescript package). */
function fakeClient(): KerbcastClient {
  const controller = new RecordingController(new FakeRecordingClient(), {
    loadTrimmer: () => Promise.resolve(null),
  });
  return { recording: controller } as unknown as KerbcastClient;
}

let store: RecordingsStore | undefined;
function Probe(): null {
  store = useRecordings();
  return null;
}

function mount(client: KerbcastClient): void {
  render(
    <KerbcastProvider client={client}>
      <Probe />
    </KerbcastProvider>,
  );
}

afterEach(() => {
  cleanup();
  store = undefined;
  StubMediaRecorder.supportedTypes = null;
});

describe("useRecordings", () => {
  it("starts empty", () => {
    mount(fakeClient());
    expect(store?.recordings).toEqual([]);
    expect(store?.groups).toEqual([]);
    expect(store?.active).toEqual([]);
  });

  it("tracks an active recording, then lands the clip in recordings on stop", async () => {
    mount(fakeClient());

    let id = "";
    act(() => {
      id = store!.start(42);
    });
    expect(store?.active).toHaveLength(1);
    expect(store?.active[0]).toMatchObject({ flightId: 42, recordingId: id });

    await act(async () => {
      await store!.stop(id);
    });
    expect(store?.active).toHaveLength(0);
    expect(store?.recordings).toHaveLength(1);
    expect(store?.recordings[0].recordingId).toBe(id);
    expect(store?.recordings[0].flightId).toBe(42);
  });

  it("keeps grouped clips out of the singles list and in groups", async () => {
    mount(fakeClient());

    let groupId = "";
    act(() => {
      groupId = store!.startGroup([1, 2]);
    });
    expect(store?.active).toHaveLength(2);
    expect(store?.active.every((a) => a.groupId === groupId)).toBe(true);

    await act(async () => {
      await store!.stopGroup(groupId);
    });
    expect(store?.active).toHaveLength(0);
    expect(store?.recordings).toHaveLength(0);
    expect(store?.groups).toHaveLength(1);
    expect(store?.groups[0].recordings).toHaveLength(2);
  });

  it("gives each active group member the real controller-minted recordingId, not a fabricated one", () => {
    const client = fakeClient();
    mount(client);

    let groupId = "";
    act(() => {
      groupId = store!.startGroup([1, 2]);
    });

    for (const member of store!.active) {
      expect(member.groupId).toBe(groupId);
      /* Not the old `${groupId}:${flightId}` fabrication. */
      expect(member.recordingId).not.toBe(`${groupId}:${member.flightId}`);
      /* A real id the controller actually tracks. */
      expect(client.recording.fetchRecording(member.recordingId)).toBeUndefined();
      expect(client.recording.isRecording(member.flightId)).toBe(true);
    }
  });

  it("cancels a single active group member without disturbing the rest of the group", async () => {
    const client = fakeClient();
    mount(client);

    let groupId = "";
    act(() => {
      groupId = store!.startGroup([1, 2]);
    });
    const [first, second] = store!.active;

    await act(async () => {
      await store!.stop(first.recordingId);
    });

    /* The cancelled member's feed actually unlocks. */
    expect(client.recording.isRecording(first.flightId)).toBe(false);
    /* The other member is untouched: still active, still recording. */
    expect(client.recording.isRecording(second.flightId)).toBe(true);
    expect(store?.active).toHaveLength(1);
    expect(store?.active[0].recordingId).toBe(second.recordingId);
  });

  it("discards a single active group member without disturbing the rest of the group", () => {
    const client = fakeClient();
    mount(client);

    let groupId = "";
    act(() => {
      groupId = store!.startGroup([1, 2]);
    });
    const [first, second] = store!.active;

    act(() => {
      store!.discard(first.recordingId);
    });

    expect(client.recording.isRecording(first.flightId)).toBe(false);
    expect(client.recording.isRecording(second.flightId)).toBe(true);
    expect(store?.active).toHaveLength(1);
    expect(store?.active[0].recordingId).toBe(second.recordingId);
  });

  it("discards a finished single clip", async () => {
    mount(fakeClient());
    let id = "";
    act(() => {
      id = store!.start(7);
    });
    await act(async () => {
      await store!.stop(id);
    });
    expect(store?.recordings).toHaveLength(1);

    act(() => {
      store!.discard(id);
    });
    expect(store?.recordings).toHaveLength(0);
  });

  it("discards a finished grouped set", async () => {
    mount(fakeClient());
    let groupId = "";
    act(() => {
      groupId = store!.startGroup([1, 2]);
    });
    await act(async () => {
      await store!.stopGroup(groupId);
    });
    expect(store?.groups).toHaveLength(1);

    act(() => {
      store!.discardGroup(groupId);
    });
    expect(store?.groups).toHaveLength(0);
  });
});
