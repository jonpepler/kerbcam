/**
 * Tests for the beforeunload guard.
 *
 * Recording is client-side and in-memory only (see the recording UX design
 * doc): a reload or tab close silently drops every unsaved clip. This guard
 * is the one protection against that. Drives a real RecordingController
 * through the same FakeRecordingClient fixture as
 * client-sdk/react/src/hooks/useRecordings.test.tsx (a live-track stand-in,
 * since jsdom's captureStream stub never produces one), so start/stop/discard
 * flow through the real store the hook reads.
 */

import type { KerbcastClient } from "@ksp-gonogo/kerbcast";
import { RecordingController, type RecordingClient } from "@ksp-gonogo/kerbcast";
import { installDomStubs } from "@ksp-gonogo/kerbcast/testing";
import { KerbcastProvider } from "@ksp-gonogo/kerbcast-react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRecordingsUnloadGuard } from "./useRecordingsUnloadGuard";

installDomStubs();

function liveStream(): MediaStream {
  const track = { kind: "video" } as MediaStreamTrack;
  return {
    getVideoTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
}

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

function Probe(): null {
  useRecordingsUnloadGuard();
  return null;
}

function mount(client: KerbcastClient): void {
  render(
    <KerbcastProvider client={client}>
      <Probe />
    </KerbcastProvider>,
  );
}

let addSpy: ReturnType<typeof vi.spyOn>;
let removeSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  addSpy = vi.spyOn(window, "addEventListener");
  removeSpy = vi.spyOn(window, "removeEventListener");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useRecordingsUnloadGuard", () => {
  it("does not register a handler while the store is empty", () => {
    mount(fakeClient());
    expect(addSpy).not.toHaveBeenCalledWith("beforeunload", expect.any(Function));
  });

  it("registers a beforeunload handler once a recording is active", () => {
    const client = fakeClient();
    mount(client);

    act(() => {
      client.recording.startRecording(1);
    });

    expect(addSpy).toHaveBeenCalledWith("beforeunload", expect.any(Function));
  });

  it("registers a handler once a clip finishes and stays registered (a download doesn't discard it)", async () => {
    const client = fakeClient();
    mount(client);

    let id = "";
    act(() => {
      id = client.recording.startRecording(1);
    });
    await act(async () => {
      await client.recording.stopRecording(id);
    });

    expect(addSpy).toHaveBeenCalledWith("beforeunload", expect.any(Function));
    expect(removeSpy).not.toHaveBeenCalledWith("beforeunload", expect.any(Function));
  });

  it("removes the handler once the store empties again (discard)", async () => {
    const client = fakeClient();
    mount(client);

    let id = "";
    act(() => {
      id = client.recording.startRecording(1);
    });
    await act(async () => {
      await client.recording.stopRecording(id);
    });

    act(() => {
      client.recording.discardRecording(id);
    });

    expect(removeSpy).toHaveBeenCalledWith("beforeunload", expect.any(Function));
  });

  it("the registered handler calls preventDefault and sets returnValue", () => {
    const client = fakeClient();
    mount(client);

    act(() => {
      client.recording.startRecording(1);
    });

    const call = addSpy.mock.calls.find(([type]) => type === "beforeunload");
    expect(call).toBeTruthy();
    const handler = call![1] as (e: Event) => void;

    const event = new Event("beforeunload", { cancelable: true });
    Object.defineProperty(event, "returnValue", { value: "", writable: true });
    const preventDefaultSpy = vi.spyOn(event, "preventDefault");

    handler(event);

    expect(preventDefaultSpy).toHaveBeenCalled();
    expect((event as unknown as { returnValue: string }).returnValue).toBe("");
  });
});
