/**
 * Tests for RecGroupBar: the REC+ toolbar that drives the grouped-recording
 * selection -> start -> stop flow.
 *
 * `useRecordings` is faked (partial mock of the package, same technique as
 * client-sdk/react/src/CameraFeed.test.tsx's REC tests) because a real
 * recording needs a track-bearing MediaStream jsdom cannot produce. The fake
 * keeps its own `active` list keyed by groupId, driven entirely by the
 * `startGroup`/`stopGroup` spies below, so assertions can check both "the
 * store was called with the right ids" and "the toolbar reflects the store".
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecGroupBar } from "./RecGroupBar";

interface FakeActive {
  recordingId: string;
  flightId: number;
  startedAt: number;
  groupId?: string;
}

const startGroupSpy = vi.fn<(flightIds: number[]) => string>();
const stopGroupSpy = vi.fn<(groupId: string) => Promise<unknown>>();

/* Matches RecGroupBar's own nowMs(): performance.now() when available, same
   clock the real RecordingController stamps `startedAt` with. Date.now() (a
   different clock) would silently desync from the elapsed-timer math. */
function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

vi.mock("@ksp-gonogo/kerbcast-react", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { useState: useReactState } = await import("react");

  function useRecordings() {
    const [active, setActive] = useReactState<FakeActive[]>([]);

    return {
      recordings: [],
      groups: [],
      active,
      isRecording: () => false,
      start: vi.fn(),
      stop: vi.fn(),
      startGroup: (flightIds: number[]): string => {
        const groupId = startGroupSpy(flightIds);
        setActive(
          flightIds.map((flightId, i) => ({
            recordingId: `rec-${i}`,
            flightId,
            startedAt: nowMs(),
            groupId,
          })),
        );
        return groupId;
      },
      stopGroup: async (groupId: string): Promise<unknown> => {
        const result = await stopGroupSpy(groupId);
        setActive([]);
        return result;
      },
      discard: vi.fn(),
      discardGroup: vi.fn(),
    };
  }

  return { ...actual, useRecordings };
});

beforeEach(() => {
  startGroupSpy.mockReset();
  startGroupSpy.mockReturnValue("grp-1");
  stopGroupSpy.mockReset();
  stopGroupSpy.mockResolvedValue({ groupId: "grp-1", recordings: [] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("RecGroupBar - idle", () => {
  it("renders nothing when not selecting and no group is recording", () => {
    const { container } = render(
      <RecGroupBar
        active={false}
        selectedFlightIds={new Set()}
        groupId={null}
        onCancel={() => {}}
        onStarted={() => {}}
        onStopped={() => {}}
      />,
    );
    expect(container.textContent).toBe("");
  });
});

describe("RecGroupBar - selecting", () => {
  it("disables Start grouped recording with nothing selected", () => {
    render(
      <RecGroupBar
        active={true}
        selectedFlightIds={new Set()}
        groupId={null}
        onCancel={() => {}}
        onStarted={() => {}}
        onStopped={() => {}}
      />,
    );
    const startBtn = screen.getByRole("button", {
      name: /start grouped recording/i,
    }) as HTMLButtonElement;
    expect(startBtn.disabled).toBe(true);
  });

  it("Cancel calls onCancel and never touches the store", () => {
    const onCancel = vi.fn();
    render(
      <RecGroupBar
        active={true}
        selectedFlightIds={new Set([1, 2])}
        groupId={null}
        onCancel={onCancel}
        onStarted={() => {}}
        onStopped={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(startGroupSpy).not.toHaveBeenCalled();
  });

  it("Start grouped recording calls startGroup with the selected ids and reports the groupId", () => {
    const onStarted = vi.fn();
    render(
      <RecGroupBar
        active={true}
        selectedFlightIds={new Set([3, 5])}
        groupId={null}
        onCancel={() => {}}
        onStarted={onStarted}
        onStopped={() => {}}
      />,
    );
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /start grouped recording/i }));
    });
    expect(startGroupSpy).toHaveBeenCalledWith([3, 5]);
    expect(onStarted).toHaveBeenCalledWith("grp-1");
  });
});

describe("RecGroupBar - recording", () => {
  function startThenRecord(onStopped: () => void = () => {}) {
    let r: ReturnType<typeof render>;
    r = render(
      <RecGroupBar
        active={true}
        selectedFlightIds={new Set([1, 2])}
        groupId={null}
        onCancel={() => {}}
        onStarted={() => {}}
        onStopped={onStopped}
      />,
    );
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /start grouped recording/i }));
    });
    // Simulate the parent flipping to the recording phase (active=false,
    // groupId set) once it receives onStarted.
    r.rerender(
      <RecGroupBar
        active={false}
        selectedFlightIds={new Set()}
        groupId="grp-1"
        onCancel={() => {}}
        onStarted={() => {}}
        onStopped={onStopped}
      />,
    );
    return r;
  }

  it("shows a 'recording N feeds' indicator reflecting the store's active members", () => {
    startThenRecord();
    expect(screen.getByText(/recording 2 feeds/i)).toBeTruthy();
  });

  it("ticks an elapsed timer while recording", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"],
    });
    startThenRecord();

    expect(screen.getByText(/0:00/)).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(screen.getByText(/0:03/)).toBeTruthy();
  });

  it("Stop grouped recording calls stopGroup(groupId) and onStopped", async () => {
    const onStopped = vi.fn();
    startThenRecord(onStopped);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /stop grouped recording/i }));
      await Promise.resolve();
    });

    expect(stopGroupSpy).toHaveBeenCalledWith("grp-1");
    expect(onStopped).toHaveBeenCalledTimes(1);
  });

  it("still calls onStopped when stopGroup rejects, instead of leaving the bar stuck", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    stopGroupSpy.mockRejectedValueOnce(new Error("sidecar-less stop failure"));
    const onStopped = vi.fn();
    startThenRecord(onStopped);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /stop grouped recording/i }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(stopGroupSpy).toHaveBeenCalledWith("grp-1");
    expect(onStopped).toHaveBeenCalledTimes(1);
    consoleErrorSpy.mockRestore();
  });
});
