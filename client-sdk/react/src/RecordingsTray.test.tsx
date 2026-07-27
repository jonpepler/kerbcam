/*
 * RecordingsTray.
 *
 * `useRecordings()` is mocked with a store that mirrors the real hook's shape
 * (its own per-mount useState, so `discard`/`discardGroup` naturally re-render
 * the tray exactly like the real hook does) seeded per test via
 * `fakeStoreSeed` (shared with the mock factory through `vi.hoisted`, the
 * documented way to reach into a hoisted `vi.mock`). This keeps the tray's
 * rendering/formatting/object-URL logic under test without a real
 * MediaRecorder track (jsdom's noise-pipeline stub has none -- see the same
 * note in CameraFeed.test.tsx).
 *
 * jsdom has no working `URL.createObjectURL`/`revokeObjectURL`, so both are
 * stubbed per test (same pattern as web/src/mock/driver.test.ts).
 */

import type { GroupedRecordingHandle, RecordingHandle } from "@ksp-gonogo/kerbcast";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveRecordingInfo } from "./hooks/useRecordings";
import { RecordingsTray } from "./RecordingsTray";

const fakeStoreSeed = vi.hoisted(() => ({
  recordings: [] as unknown[],
  groups: [] as unknown[],
  active: [] as unknown[],
}));

const storeSpies = vi.hoisted(() => ({
  discard: vi.fn(),
  discardGroup: vi.fn(),
}));

vi.mock("./hooks/useRecordings", async () => {
  const { useState } = await import("react");

  function useRecordings() {
    const [state, setState] = useState(() => ({
      recordings: fakeStoreSeed.recordings,
      groups: fakeStoreSeed.groups,
      active: fakeStoreSeed.active,
    }));

    return {
      recordings: state.recordings,
      groups: state.groups,
      active: state.active,
      isRecording: () => false,
      start: vi.fn(),
      stop: vi.fn(),
      startGroup: vi.fn(),
      stopGroup: vi.fn(),
      discard: (recordingId: string) => {
        storeSpies.discard(recordingId);
        setState((s) => ({
          ...s,
          recordings: (s.recordings as { recordingId: string }[]).filter(
            (r) => r.recordingId !== recordingId,
          ),
        }));
      },
      discardGroup: (groupId: string) => {
        storeSpies.discardGroup(groupId);
        setState((s) => ({
          ...s,
          groups: (s.groups as { groupId: string }[]).filter((g) => g.groupId !== groupId),
        }));
      },
    };
  }

  return { useRecordings };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRecording(overrides: Partial<RecordingHandle> = {}): RecordingHandle {
  return {
    recordingId: "rec-1",
    flightId: 42,
    blob: new Blob(["clip"], { type: "video/webm" }),
    mimeType: "video/webm",
    utStart: 100,
    utEnd: 160,
    utSamples: [],
    byteSize: 2048,
    durationMs: 65_000,
    ...overrides,
  };
}

function makeGroup(overrides: Partial<GroupedRecordingHandle> = {}): GroupedRecordingHandle {
  return {
    groupId: "grp-1",
    recordings: [
      makeRecording({ recordingId: "rec-a" }),
      makeRecording({ recordingId: "rec-b" }),
    ],
    commonUtWindow: [100, 150],
    ...overrides,
  };
}

function activeInfo(overrides: Partial<ActiveRecordingInfo> = {}): ActiveRecordingInfo {
  return { recordingId: "rec-1", flightId: 42, startedAt: 0, ...overrides };
}

let urlCounter = 0;

beforeEach(() => {
  urlCounter = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:mock-${urlCounter++}`);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  storeSpies.discard.mockClear();
  storeSpies.discardGroup.mockClear();
  fakeStoreSeed.recordings = [];
  fakeStoreSeed.groups = [];
  fakeStoreSeed.active = [];
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RecordingsTray - empty state", () => {
  it("shows a placeholder when there are no clips", () => {
    render(<RecordingsTray />);
    expect(screen.getByText(/no recordings yet/i)).toBeTruthy();
    expect(screen.queryByText(/unsaved clips/i)).toBeNull();
  });
});

describe("RecordingsTray - single clips", () => {
  it("renders a clip's camera name, UT range, duration, and size", () => {
    fakeStoreSeed.active = [activeInfo({ recordingId: "rec-1", flightId: 42 })];
    fakeStoreSeed.recordings = [
      makeRecording({ recordingId: "rec-1", utStart: 100, utEnd: 160, durationMs: 65_000, byteSize: 2048 }),
    ];

    render(<RecordingsTray cameraLabel={(flightId) => `Cam ${flightId}`} />);

    expect(screen.getByText("Cam 42")).toBeTruthy();
    expect(screen.getByText(/T\+100s.*T\+160s/)).toBeTruthy();
    expect(screen.getByText(/1:05/)).toBeTruthy(); // 65s
    expect(screen.getByText(/2\.0 KB/)).toBeTruthy();
    expect(screen.getByText(/unsaved clips/i)).toBeTruthy();
  });

  it("falls back to 'Camera <flightId>' when no cameraLabel prop is given", () => {
    fakeStoreSeed.recordings = [makeRecording({ recordingId: "rec-1", flightId: 7 })];
    render(<RecordingsTray />);
    expect(screen.getByText("Camera 7")).toBeTruthy();
  });

  it("labels a finished clip from its own flightId, even when the tray mounts after the recording finished (never in `active`)", () => {
    fakeStoreSeed.active = []; // the tray mounted after the clip finished
    fakeStoreSeed.recordings = [makeRecording({ recordingId: "rec-1", flightId: 99 })];
    render(<RecordingsTray cameraLabel={(flightId) => `Cam ${flightId}`} />);
    expect(screen.getByText("Cam 99")).toBeTruthy();
  });

  it("shows 'no UT' when the clip has no UT range", () => {
    fakeStoreSeed.recordings = [
      makeRecording({ recordingId: "rec-1", utStart: undefined, utEnd: undefined }),
    ];
    render(<RecordingsTray />);
    expect(screen.getByText(/no ut \(out of flight\)/i)).toBeTruthy();
  });

  it("download uses an object URL created from the clip's blob", () => {
    const blob = new Blob(["specific"], { type: "video/webm" });
    fakeStoreSeed.recordings = [makeRecording({ recordingId: "rec-1", blob })];
    render(<RecordingsTray />);

    expect(URL.createObjectURL).toHaveBeenCalledWith(blob);
    const link = screen.getByText("Download").closest("a");
    expect(link?.getAttribute("href")).toBe("blob:mock-0");
    expect(link?.hasAttribute("download")).toBe(true);
  });

  it("mounts a <video> preview sourced from the clip's object URL", () => {
    fakeStoreSeed.recordings = [makeRecording({ recordingId: "rec-1" })];
    const { container } = render(<RecordingsTray />);
    const video = container.querySelector("video");
    expect(video).toBeTruthy();
    expect(video?.getAttribute("src")).toBe("blob:mock-0");
  });

  it("discard calls the store and revokes the clip's object URL", () => {
    fakeStoreSeed.recordings = [makeRecording({ recordingId: "rec-1" })];
    render(<RecordingsTray />);

    fireEvent.click(screen.getByText("Discard"));

    expect(storeSpies.discard).toHaveBeenCalledWith("rec-1");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-0");
    expect(screen.queryByText("Discard")).toBeNull();
  });
});

describe("RecordingsTray - grouped sets", () => {
  it("renders a group's clips together with a download-all", () => {
    fakeStoreSeed.groups = [
      makeGroup({
        groupId: "grp-1",
        recordings: [
          makeRecording({ recordingId: "rec-a" }),
          makeRecording({ recordingId: "rec-b" }),
        ],
      }),
    ];
    render(<RecordingsTray />);

    expect(screen.getByText(/grouped recording/i)).toBeTruthy();
    expect(screen.getByText(/2 feeds/i)).toBeTruthy();
    expect(screen.getAllByText("Download")).toHaveLength(2);
    expect(screen.getByText("Download all")).toBeTruthy();
  });

  it("download-all clicks one <a> per member", () => {
    fakeStoreSeed.groups = [
      makeGroup({
        groupId: "grp-1",
        recordings: [
          makeRecording({ recordingId: "rec-a" }),
          makeRecording({ recordingId: "rec-b" }),
        ],
      }),
    ];
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<RecordingsTray />);

    fireEvent.click(screen.getByText("Download all"));

    expect(clickSpy).toHaveBeenCalledTimes(2);
  });

  it("labels grouped clips from their own flightId, with no active info needed", () => {
    fakeStoreSeed.active = [];
    fakeStoreSeed.groups = [
      makeGroup({
        groupId: "grp-1",
        recordings: [
          makeRecording({ recordingId: "rec-a", flightId: 10 }),
          makeRecording({ recordingId: "rec-b", flightId: 11 }),
        ],
      }),
    ];
    render(<RecordingsTray cameraLabel={(flightId) => `Cam ${flightId}`} />);

    expect(screen.getByText("Cam 10")).toBeTruthy();
    expect(screen.getByText("Cam 11")).toBeTruthy();
  });

  it("discard set calls the store's discardGroup, not a per-clip discard", () => {
    fakeStoreSeed.groups = [makeGroup({ groupId: "grp-1" })];
    render(<RecordingsTray />);

    fireEvent.click(screen.getByText("Discard set"));

    expect(storeSpies.discardGroup).toHaveBeenCalledWith("grp-1");
    expect(storeSpies.discard).not.toHaveBeenCalled();
    expect(screen.queryByText(/grouped recording/i)).toBeNull();
  });
});

describe("RecordingsTray - object URL lifecycle", () => {
  it("revokes every outstanding object URL on unmount", () => {
    fakeStoreSeed.recordings = [
      makeRecording({ recordingId: "rec-1" }),
      makeRecording({ recordingId: "rec-2" }),
    ];
    const { unmount } = render(<RecordingsTray />);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);

    unmount();

    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-0");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-1");
  });
});
