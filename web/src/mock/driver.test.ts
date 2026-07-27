/*
 * Mock driver record -> replay half.
 *
 * buildReplayTrack turns a recorded Blob back into a live track. jsdom has no
 * HTMLMediaElement.captureStream and no URL.createObjectURL, so both are
 * stubbed here (installDomStubs covers canvas.captureStream, not the video
 * element's). Asserts the Blob -> object-URL -> <video> -> captureStream chain
 * yields a video track ready for MockSidecar.deliverTrack, and that the object
 * URL is revoked on the track's own teardown rather than leaking forever
 * (video.loop means the <video> element's own "ended" event never fires).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { buildReplayTrack } from "./driver";

/** A fake MediaStreamTrack that supports addEventListener/stop, so tests can
 *  simulate the track's own teardown (distinct from the <video> "ended" event,
 *  which never fires while looping). */
function fakeTrack(): MediaStreamTrack {
  const listeners = new Map<string, Set<() => void>>();
  return {
    kind: "video",
    addEventListener(type: string, cb: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(cb);
    },
    removeEventListener(type: string, cb: () => void) {
      listeners.get(type)?.delete(cb);
    },
    stop() {
      for (const cb of listeners.get("ended") ?? []) cb();
    },
  } as unknown as MediaStreamTrack;
}

function stubVideoCaptureStream(): MediaStreamTrack {
  const track = fakeTrack();
  const stream = { getVideoTracks: () => [track] } as unknown as MediaStream;
  (
    HTMLVideoElement.prototype as { captureStream?: () => MediaStream }
  ).captureStream = () => stream;
  return track;
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (HTMLVideoElement.prototype as { captureStream?: () => MediaStream }).captureStream;
});

describe("buildReplayTrack", () => {
  it("object-URLs the blob and returns its captured video track", () => {
    const track = stubVideoCaptureStream();
    const created = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:mock-url");

    const blob = new Blob([new Uint8Array(16)], { type: "video/webm" });
    const result = buildReplayTrack(blob);

    expect(created).toHaveBeenCalledWith(blob);
    expect(result).toBe(track);
  });

  it("throws when the element yields no video track", () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock-url");
    (
      HTMLVideoElement.prototype as { captureStream?: () => MediaStream }
    ).captureStream = () =>
      ({ getVideoTracks: () => [] }) as unknown as MediaStream;

    const blob = new Blob([new Uint8Array(4)], { type: "video/webm" });
    expect(() => buildReplayTrack(blob)).toThrow(/no video tracks/);
  });

  it("revokes the object URL once the track itself is torn down", () => {
    const track = stubVideoCaptureStream();
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock-url");
    const revoked = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    buildReplayTrack(new Blob([new Uint8Array(16)], { type: "video/webm" }));
    expect(revoked).not.toHaveBeenCalled();

    /* Simulate the track being stopped (e.g. replaced by a fresh replay): the
       track's own "ended" fires, not the looping <video> element's. */
    (track as unknown as { stop(): void }).stop();
    expect(revoked).toHaveBeenCalledWith("blob:mock-url");
  });

  it("does not leak the object URL while the video loops (no 'ended' from playback)", () => {
    stubVideoCaptureStream();
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock-url");
    const revoked = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const track = buildReplayTrack(new Blob([new Uint8Array(16)], { type: "video/webm" }));
    /* Looping playback never fires the <video> element's "ended"; nothing
       should revoke from that alone. */
    expect(revoked).not.toHaveBeenCalled();
    expect(track).toBeDefined();
  });
});
