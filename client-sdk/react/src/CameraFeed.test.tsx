/**
 * Tests for the `CameraFeed` component.
 *
 * Two halves:
 *  - the "SIGNAL LOST" overlay + zoom / pan / resize feedback controls;
 *  - the camera-selection layer (picker, Next/Previous buttons, handle API,
 *    status indicator and empty state).
 *
 * Everything drives the real `KerbcastClient` + real hooks through the SDK's
 * canonical `MockSidecar`. The only thing faked is the WebRTC transport,
 * because jsdom can't produce a real `MediaStream`. Multi-camera scenarios
 * are expressed by populating the sidecar's registry (`addCamera` /
 * `setCameras`); state changes go through `updateCamera` / `destroyCamera`;
 * client commands are inspected via the parsed `commands` array.
 *
 * Tests intentionally left behind from gonogo:
 *  - serial-input action tests (nextCamera/prevCamera/zoomIn/zoomOut/panYaw/
 *    panPitch via dispatchAction) -- the public surface is now the
 *    CameraFeedHandle ref; handle-based equivalents cover the same paths.
 *  - CameraFeedConfigPanel -- not part of this package.
 *  - CommNet degrade -- gonogo-only data source integration.
 *  - Station (brokered) mode -- gonogo-only KerbcastDataSource.attachBroker.
 */

import { KerbcastClient, QualityPreset, TrackMode } from "@ksp-gonogo/kerbcast";
import type { CameraLifecycle, ClientMessage } from "@ksp-gonogo/kerbcast";
import { type MockCameraInit, MockSidecar } from "@ksp-gonogo/kerbcast/testing";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createRef } from "react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CameraFeed,
  type CameraFeedHandle,
  type CameraStreamHook,
  type FeedAction,
} from "./CameraFeed";
import { KerbcastProvider } from "./context";

/*
 * The REC control reads/drives `useRecordings()` (see CameraFeed - REC below).
 * The real hook sits on top of a real `RecordingController`, which under
 * jsdom needs a track-bearing MediaStream the noise-pipeline stub doesn't
 * produce (`canvas.captureStream()` is stubbed empty). Stand in a fake store
 * that mirrors the real hook's shape (its own per-component useState, so
 * start/stop naturally re-render the owning CameraFeed exactly like the real
 * hook does) so the REC tests exercise CameraFeed's wiring to the store's
 * contract without depending on a real MediaRecorder track.
 */
const recordingsStoreSpies = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  /** When true, the fake store's stop() rejects instead of resolving -- lets
   *  a test drive CameraFeed's stop-failure path (see "CameraFeed - REC"). */
  stopRejects: false,
  /** Flips a still-arming fake recording out of arming, simulating the real
   *  controller's arm-and-wait resolving once the feed reaches full
   *  resolution. Given its real implementation by the mock factory below
   *  (it needs the factory's own closured resolver map, unavailable at
   *  hoist time). */
  resolveArming: (_recordingId: string) => {},
}));

vi.mock("./hooks/useRecordings", async () => {
  const { useCallback, useState: useReactState } = await import("react");

  interface FakeActive {
    recordingId: string;
    flightId: number;
    startedAt: number;
    arming: boolean;
  }

  /* recordingId -> the setState callback that flips that entry's arming off,
     invoked by test code via recordingsStoreSpies.resolveArming. */
  const armingResolvers = new Map<string, () => void>();
  recordingsStoreSpies.resolveArming = (recordingId: string) => {
    armingResolvers.get(recordingId)?.();
    armingResolvers.delete(recordingId);
  };

  function useRecordings() {
    const [state, setState] = useReactState<{
      active: FakeActive[];
      recordings: unknown[];
    }>({ active: [], recordings: [] });

    const start = useCallback(
      (flightId: number, opts?: { forceFullResolution?: boolean }): string => {
        recordingsStoreSpies.start(flightId, opts);
        const recordingId = `rec-${flightId}`;
        const forced = opts?.forceFullResolution === true;
        setState((s) => ({
          ...s,
          active: [
            ...s.active,
            { recordingId, flightId, startedAt: performance.now(), arming: forced },
          ],
        }));
        if (forced) {
          armingResolvers.set(recordingId, () => {
            setState((s) => ({
              ...s,
              active: s.active.map((a) =>
                a.recordingId === recordingId
                  ? { ...a, arming: false, startedAt: performance.now() }
                  : a,
              ),
            }));
          });
        }
        return recordingId;
      },
      [],
    );

    const stop = useCallback(async (recordingId: string) => {
      recordingsStoreSpies.stop(recordingId);
      armingResolvers.delete(recordingId);
      if (recordingsStoreSpies.stopRejects) {
        throw new Error("stop failed");
      }
      const handle = {
        recordingId,
        blob: new Blob(),
        mimeType: "video/webm",
        utSamples: [],
        byteSize: 0,
        durationMs: 0,
      };
      setState((s) => ({
        active: s.active.filter((a) => a.recordingId !== recordingId),
        recordings: [...s.recordings, handle],
      }));
      return handle;
    }, []);

    return {
      recordings: state.recordings,
      groups: [],
      active: state.active,
      isRecording: (flightId: number) => state.active.some((a) => a.flightId === flightId),
      start,
      stop,
      startGroup: vi.fn(),
      stopGroup: vi.fn(),
      discard: vi.fn(),
      discardGroup: vi.fn(),
    };
  }

  return { useRecordings };
});

// ---------------------------------------------------------------------------
// Camera-state fixture factory
// ---------------------------------------------------------------------------

type CameraStateLike = Record<string, unknown> & { flightId: number };

function makeCamera(overrides: CameraStateLike): CameraStateLike {
  return {
    lifecycle: "active",
    partName: "mumech.MuMechModuleHullCamera",
    partTitle: "Hullcam Mk1",
    cameraName: "Camera",
    vesselName: "Kerbal X",
    layers: ["NEAR", "SCALED"],
    operatorLayers: ["NEAR", "SCALED"],
    renderWidth: 384,
    renderHeight: 384,
    operatorWidth: 384,
    operatorHeight: 384,
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
    encoderBitrateBps: 1_500_000,
    targetBitrateBps: 0,
    degradeLevel: 0,
    ...overrides,
  };
}

function toInit(c: CameraStateLike): MockCameraInit {
  return {
    flightId: c.flightId,
    lifecycle: c.lifecycle as CameraLifecycle | undefined,
    partName: c.partName as string | undefined,
    partTitle: c.partTitle as string | undefined,
    cameraName: c.cameraName as string | undefined,
    vesselName: c.vesselName as string | undefined,
    renderWidth: c.renderWidth as number | undefined,
    renderHeight: c.renderHeight as number | undefined,
    operatorWidth: c.operatorWidth as number | undefined,
    operatorHeight: c.operatorHeight as number | undefined,
    supportsZoom: c.supportsZoom as boolean | undefined,
    fov: c.fov as number | undefined,
    fovMin: c.fovMin as number | undefined,
    fovMax: c.fovMax as number | undefined,
    supportsPan: c.supportsPan as boolean | undefined,
    panYaw: c.panYaw as number | undefined,
    panPitch: c.panPitch as number | undefined,
    panYawMin: c.panYawMin as number | undefined,
    panYawMax: c.panYawMax as number | undefined,
    panPitchMin: c.panPitchMin as number | undefined,
    panPitchMax: c.panPitchMax as number | undefined,
    encoderBitrateBps: c.encoderBitrateBps as number | undefined,
    targetBitrateBps: c.targetBitrateBps as number | undefined,
    degradeLevel: c.degradeLevel as number | undefined,
    viewerQuality: c.viewerQuality as QualityPreset | undefined,
    qualityLimitedBy: c.qualityLimitedBy as string | undefined,
    trackMode: c.trackMode as TrackMode | undefined,
  };
}

// ---------------------------------------------------------------------------
// Fixture: connected KerbcastClient + MockSidecar
// ---------------------------------------------------------------------------

const createdClients: KerbcastClient[] = [];

async function buildConnectedSource(
  cameras: CameraStateLike[] = [
    makeCamera({ flightId: 42, cameraName: "Starboard Cam" }),
  ],
): Promise<{ client: KerbcastClient; sidecar: MockSidecar }> {
  const sidecar = new MockSidecar();
  for (const c of cameras) {
    sidecar.addCamera(toInit(c));
  }
  const client = new KerbcastClient(
    { host: "h", port: 1, negotiate: (o) => sidecar.negotiate(o) },
    sidecar.createTransport(),
  );
  createdClients.push(client);

  await act(async () => {
    await client.connect([], { slots: 4 });
  });
  await act(async () => {
    sidecar.open();
    sidecar.setConnectionState("connected");
  });
  return { client, sidecar };
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

function renderFeed(
  client: KerbcastClient,
  props: {
    flightId: number | null;
    onSelectCamera?: (id: number) => void;
    showDebugInfo?: boolean;
    renderSize?: "auto" | "none";
    enableQualityControl?: boolean;
    enableTracking?: boolean;
    enableRecording?: boolean;
    recordFullResolution?: boolean;
    enableFullscreen?: boolean;
    enablePictureInPicture?: boolean;
    actions?: FeedAction[];
    trailingActions?: FeedAction[];
    showStatic?: boolean;
    showStandbyIcon?: boolean;
    showActions?: boolean;
    ref?: React.Ref<CameraFeedHandle>;
  },
) {
  const { ref, ...rest } = props;
  return render(
    <KerbcastProvider client={client}>
      <CameraFeed ref={ref ?? null} {...rest} />
    </KerbcastProvider>,
  );
}

// A stateful wrapper: holds `flightId` in state, feeds its own setter as
// `onSelectCamera`. Lets selection tests exercise the real round-trip.
function renderStatefulFeed(
  client: KerbcastClient,
  initial: number | null,
  ref?: React.Ref<CameraFeedHandle>,
) {
  function Harness() {
    const [flightId, setFlightId] = useState<number | null>(initial);
    return (
      <KerbcastProvider client={client}>
        <CameraFeed
          ref={ref ?? null}
          flightId={flightId}
          onSelectCamera={setFlightId}
        />
      </KerbcastProvider>
    );
  }
  return render(<Harness />);
}

// ---------------------------------------------------------------------------
// Global ResizeObserver stub for tests that don't need the controllable one.
// ---------------------------------------------------------------------------

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

afterEach(() => {
  cleanup();
  // Disconnect tracked clients AFTER cleanup so the widget is unmounted first.
  for (const c of createdClients) {
    try { c.disconnect(); } catch { /* ignore */ }
  }
  createdClients.length = 0;
  vi.restoreAllMocks();
  recordingsStoreSpies.start.mockClear();
  recordingsStoreSpies.stop.mockClear();
  recordingsStoreSpies.stopRejects = false;
});

// ---------------------------------------------------------------------------
// Camera selection
// ---------------------------------------------------------------------------

describe("CameraFeed - camera selection", () => {
  const THREE_CAMERAS = [
    makeCamera({ flightId: 42, cameraName: "Starboard Cam", vesselName: "Kerbal X" }),
    makeCamera({ flightId: 43, cameraName: "Nose Cam", vesselName: "Kerbal X" }),
    makeCamera({ flightId: 44, cameraName: "Tail Cam", vesselName: "Kerbal X" }),
  ];

  it("lists every available camera in the menu", async () => {
    const { client } = await buildConnectedSource(THREE_CAMERAS);

    renderFeed(client, { flightId: null });

    fireEvent.click(screen.getByRole("button", { name: /starboard cam/i }));

    const labels = screen
      .getAllByRole("menuitemradio")
      .map((item) => item.textContent);
    expect(labels).toEqual([
      "Starboard Cam (Kerbal X)",
      "Nose Cam (Kerbal X)",
      "Tail Cam (Kerbal X)",
    ]);
  });

  it("caps the menu height and scrolls instead of overflowing", async () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      makeCamera({ flightId: 100 + i, cameraName: `Cam ${String(i + 1).padStart(2, "0")}` }),
    );
    const { client } = await buildConnectedSource(many);

    renderFeed(client, { flightId: null });

    fireEvent.click(screen.getByRole("button", { name: /cam 01/i }));

    const style = getComputedStyle(screen.getByRole("menu"));
    expect(style.overflowY).toBe("auto");
    expect(style.maxHeight).toBe("min(40vh, 300px)");
  });

  it("portals the open menu to document.body so tile clipping cannot cut it off", async () => {
    const { client } = await buildConnectedSource(THREE_CAMERAS);

    const { container } = renderFeed(client, { flightId: null });

    fireEvent.click(screen.getByRole("button", { name: /starboard cam/i }));

    const menu = screen.getByRole("menu");
    // The menu lives on document.body, outside the tile's DOM subtree...
    expect(menu.parentElement).toBe(document.body);
    expect(container.contains(menu)).toBe(false);
    // ...with fixed positioning so no ancestor overflow can clip it.
    expect(getComputedStyle(menu).position).toBe("fixed");
  });

  it("pointer-down inside the portaled menu keeps it open; outside dismisses it", async () => {
    const { client } = await buildConnectedSource(THREE_CAMERAS);

    renderFeed(client, { flightId: null });

    fireEvent.click(screen.getByRole("button", { name: /starboard cam/i }));
    expect(screen.getByRole("menu")).toBeTruthy();

    // A press inside the portaled menu is not "outside" even though it is
    // outside the tile's subtree.
    fireEvent.pointerDown(
      screen.getByRole("menuitemradio", { name: /nose cam/i }),
    );
    expect(screen.getByRole("menu")).toBeTruthy();

    // A press anywhere else dismisses.
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("disambiguates same-named cameras by part title", async () => {
    const { client } = await buildConnectedSource([
      makeCamera({ flightId: 42, cameraName: "NavCam", vesselName: "Kerbal X", partTitle: "NavCam" }),
      makeCamera({ flightId: 43, cameraName: "NavCam", vesselName: "Kerbal X", partTitle: "Clamp-O-Tron Docking Port Jr." }),
      makeCamera({ flightId: 44, cameraName: "Tail Cam", vesselName: "Kerbal X", partTitle: "Some Other Part" }),
    ]);

    renderFeed(client, { flightId: null });

    fireEvent.click(screen.getByRole("button", { name: /navcam/i }));
    const labels = screen
      .getAllByRole("menuitemradio")
      .map((item) => item.textContent);
    expect(labels).toEqual([
      "NavCam (Kerbal X)",
      "NavCam - Clamp-O-Tron Docking Port Jr. (Kerbal X)",
      "Tail Cam (Kerbal X)",
    ]);
  });

  it("auto-selects the first available camera when flightId is null", async () => {
    const { client } = await buildConnectedSource(THREE_CAMERAS);

    renderFeed(client, { flightId: null });

    expect(screen.getByRole("heading", { name: "Starboard Cam" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /starboard cam/i }));
    const checked = screen.getByRole("menuitemradio", { checked: true });
    expect(checked.textContent).toBe("Starboard Cam (Kerbal X)");
  });

  it("auto-latch does NOT fire onSelectCamera", async () => {
    const { client } = await buildConnectedSource(THREE_CAMERAS);

    const onSelect = vi.fn();
    renderFeed(client, { flightId: null, onSelectCamera: onSelect });

    // Auto-latch picks Starboard Cam but must never call onSelectCamera.
    expect(screen.getByRole("heading", { name: "Starboard Cam" })).toBeTruthy();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("honours an explicitly-configured non-top camera", async () => {
    const { client } = await buildConnectedSource(THREE_CAMERAS);

    renderFeed(client, { flightId: 44 });

    expect(screen.getByRole("heading", { name: "Tail Cam" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /tail cam/i }));
    const checked = screen.getByRole("menuitemradio", { checked: true });
    expect(checked.textContent).toBe("Tail Cam (Kerbal X)");
  });

  it("selecting a different camera in the menu persists the choice and switches", async () => {
    const { client } = await buildConnectedSource(THREE_CAMERAS);

    renderStatefulFeed(client, 42);

    expect(screen.getByRole("heading", { name: "Starboard Cam" })).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /starboard cam/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitemradio", { name: /nose cam/i }));
    });

    expect(screen.getByRole("heading", { name: "Nose Cam" })).toBeTruthy();
    expect(screen.queryByRole("menu")).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /nose cam/i }));
    });
    expect(
      screen.getByRole("menuitemradio", { checked: true }).textContent,
    ).toBe("Nose Cam (Kerbal X)");
  });

  it("Next button advances to the next camera and wraps round", async () => {
    const { client } = await buildConnectedSource(THREE_CAMERAS);

    renderStatefulFeed(client, 42);

    const next = screen.getByRole("button", { name: /next camera/i });

    await act(async () => { fireEvent.click(next); });
    expect(screen.getByRole("heading", { name: "Nose Cam" })).toBeTruthy();

    await act(async () => { fireEvent.click(next); });
    expect(screen.getByRole("heading", { name: "Tail Cam" })).toBeTruthy();

    // Wrap: third -> first.
    await act(async () => { fireEvent.click(next); });
    expect(screen.getByRole("heading", { name: "Starboard Cam" })).toBeTruthy();
  });

  it("Previous button steps backward and wraps round", async () => {
    const { client } = await buildConnectedSource(THREE_CAMERAS);

    renderStatefulFeed(client, 42);

    const prev = screen.getByRole("button", { name: /previous camera/i });

    await act(async () => { fireEvent.click(prev); });
    expect(screen.getByRole("heading", { name: "Tail Cam" })).toBeTruthy();
  });

  it("handle.stepCamera(1) advances camera", async () => {
    const { client } = await buildConnectedSource(THREE_CAMERAS);

    const handleRef = createRef<CameraFeedHandle>();
    renderStatefulFeed(client, 42, handleRef);

    await act(async () => {
      handleRef.current?.stepCamera(1);
    });
    expect(screen.getByRole("heading", { name: "Nose Cam" })).toBeTruthy();

    await act(async () => {
      handleRef.current?.stepCamera(-1);
    });
    expect(screen.getByRole("heading", { name: "Starboard Cam" })).toBeTruthy();
  });

  it("falls back to the first camera when the configured one disappears", async () => {
    const { client, sidecar } = await buildConnectedSource(THREE_CAMERAS);

    renderFeed(client, { flightId: 44 });
    expect(screen.getByRole("heading", { name: "Tail Cam" })).toBeTruthy();

    await act(async () => {
      sidecar.setCameras([
        toInit(makeCamera({ flightId: 42, cameraName: "Starboard Cam" })),
      ]);
    });

    expect(screen.getByRole("heading", { name: "Starboard Cam" })).toBeTruthy();
  });

  it("step buttons are disabled when only one camera is available", async () => {
    const { client } = await buildConnectedSource();

    renderFeed(client, { flightId: 42 });

    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: /next camera/i }).disabled,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: /previous camera/i }).disabled,
    ).toBe(true);
  });

  it("renders step buttons inside the action bar alongside injected actions", async () => {
    // Regression: the step buttons used to sit in the title row and were
    // covered by the separately-positioned action bar (and any consumer
    // action buttons) in the top-right corner. They now share the action
    // bar so the two lay out in one flex row instead of overlapping.
    const { client } = await buildConnectedSource(THREE_CAMERAS);

    render(
      <KerbcastProvider client={client}>
        <CameraFeed
          flightId={42}
          actions={[
            {
              id: "custom",
              label: "Custom action",
              icon: <span>x</span>,
              onClick: () => {},
            },
          ]}
        />
      </KerbcastProvider>,
    );

    const next = screen.getByRole("button", { name: /next camera/i });
    const custom = screen.getByRole("button", { name: /custom action/i });

    // The injected action's parent is the action bar; the step buttons live
    // in a wrapper within that same action bar, so it contains both.
    const actionBar = custom.parentElement;
    expect(actionBar).not.toBeNull();
    expect(actionBar?.contains(next)).toBe(true);
  });

  it("Escape closes the open camera menu", async () => {
    const { client } = await buildConnectedSource(THREE_CAMERAS);

    renderFeed(client, { flightId: 42 });

    fireEvent.click(screen.getByRole("button", { name: /starboard cam/i }));
    expect(screen.getByRole("menu")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Debug-info toggle
// ---------------------------------------------------------------------------

describe("CameraFeed - debug info toggle", () => {
  it("hides the resolution/bitrate readout by default", async () => {
    const { client } = await buildConnectedSource([
      makeCamera({ flightId: 42, cameraName: "Starboard Cam", vesselName: "Kerbal X", renderWidth: 640, renderHeight: 360 }),
    ]);

    renderFeed(client, { flightId: 42 });

    expect(screen.queryByText(/640×360/)).toBeNull();
  });

  it("shows the resolution/bitrate readout when showDebugInfo is true", async () => {
    const { client } = await buildConnectedSource([
      makeCamera({ flightId: 42, cameraName: "Starboard Cam", vesselName: "Kerbal X", renderWidth: 640, renderHeight: 360 }),
    ]);

    renderFeed(client, { flightId: 42, showDebugInfo: true });

    expect(screen.getByText(/640×360/)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Empty state and status
// ---------------------------------------------------------------------------

describe("CameraFeed - empty state and status", () => {
  it("shows the no-cameras empty state and hides the menu trigger when connected with no cameras", async () => {
    const { client } = await buildConnectedSource([]);

    renderFeed(client, { flightId: null });

    expect(screen.queryByRole("button", { name: /camera feed/i })).toBeNull();
    expect(document.querySelector("video")).toBeNull();
    expect(screen.getByText(/start a vessel with hullcam parts/i)).toBeTruthy();
  });

  it("renders the empty state gracefully when the source is disconnected", async () => {
    const sidecar = new MockSidecar();
    const client = new KerbcastClient(
      { host: "h", port: 1, negotiate: (o) => sidecar.negotiate(o) },
      sidecar.createTransport(),
    );
    createdClients.push(client);

    render(
      <KerbcastProvider client={client}>
        <CameraFeed flightId={null} />
      </KerbcastProvider>,
    );

    expect(screen.getByText(/start a vessel with hullcam parts/i)).toBeTruthy();
    expect(
      screen.queryByRole("status", { name: /connected|disconnected/i }),
    ).toBeNull();
  });

  it("shows a custom emptyMessage when provided", async () => {
    const { client } = await buildConnectedSource([]);

    renderFeed(client, { flightId: null, emptyMessage: "Custom empty message" });

    expect(screen.getByText("Custom empty message")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// SIGNAL LOST overlay
// ---------------------------------------------------------------------------

describe("CameraFeed - SIGNAL LOST overlay", () => {
  it("does not render SIGNAL LOST overlay when camera is active", async () => {
    const { client } = await buildConnectedSource();

    renderFeed(client, { flightId: 42 });

    expect(screen.queryByRole("status", { name: /signal lost/i })).toBeNull();
  });

  it("renders SIGNAL LOST overlay when camera lifecycle transitions to destroyed", async () => {
    const { client, sidecar } = await buildConnectedSource();

    renderFeed(client, { flightId: 42 });

    expect(screen.queryByRole("status", { name: /signal lost/i })).toBeNull();

    await act(async () => {
      sidecar.destroyCamera(42);
    });

    const overlay = screen.getByRole("status", { name: /signal lost/i });
    expect(overlay).toBeTruthy();
    expect(overlay.textContent).toMatch(/SIGNAL LOST/i);
  });

  it("shows the standby icon (not SIGNAL LOST) when out of flight", async () => {
    const { client, sidecar } = await buildConnectedSource();

    renderFeed(client, { flightId: 42 });

    await act(async () => {
      sidecar.fireSceneState(false);
      sidecar.destroyCamera(42);
    });

    expect(screen.queryByRole("status", { name: /signal lost/i })).toBeNull();
    expect(screen.getByRole("status", { name: /standby/i })).toBeTruthy();
  });

  it("hides the per-feed standby icon when showStandbyIcon is false", async () => {
    const { client, sidecar } = await buildConnectedSource();

    renderFeed(client, { flightId: 42, showStandbyIcon: false });

    await act(async () => {
      sidecar.fireSceneState(false);
      sidecar.destroyCamera(42);
    });

    expect(screen.queryByRole("status", { name: /standby/i })).toBeNull();
    expect(screen.queryByRole("status", { name: /signal lost/i })).toBeNull();
  });

  it("keeps SIGNAL LOST for a single destroyed camera while in flight", async () => {
    const { client, sidecar } = await buildConnectedSource();

    renderFeed(client, { flightId: 42 });

    await act(async () => {
      sidecar.fireSceneState(true);
      sidecar.destroyCamera(42);
    });

    expect(screen.getByRole("status", { name: /signal lost/i })).toBeTruthy();
    expect(screen.queryByRole("status", { name: /standby/i })).toBeNull();
  });

  it("auto-latch releases a destroyed camera once a live camera exists (vessel switch)", async () => {
    const { client, sidecar } = await buildConnectedSource([
      makeCamera({ flightId: 42, cameraName: "Old Vessel Cam" }),
    ]);

    renderFeed(client, { flightId: null });

    expect(screen.getByRole("heading", { name: "Old Vessel Cam" })).toBeTruthy();

    await act(async () => {
      sidecar.destroyCamera(42);
    });

    expect(screen.getByRole("status", { name: /signal lost/i })).toBeTruthy();

    await act(async () => {
      sidecar.setCameras([
        toInit(makeCamera({ flightId: 42, cameraName: "Old Vessel Cam", lifecycle: "destroyed" })),
        toInit(makeCamera({ flightId: 43, cameraName: "New Vessel Cam" })),
      ]);
    });

    expect(screen.getByRole("heading", { name: "New Vessel Cam" })).toBeTruthy();
    expect(screen.queryByRole("status", { name: /signal lost/i })).toBeNull();
  });

  it("renders SIGNAL LOST overlay from initial snapshot when camera starts destroyed", async () => {
    const { client } = await buildConnectedSource([
      makeCamera({
        flightId: 99,
        lifecycle: "destroyed",
        partTitle: "Hullcam Mk2",
        cameraName: "Nose Cam",
        vesselName: "Debris Field",
        layers: [],
        operatorLayers: [],
        renderWidth: 0,
        renderHeight: 0,
        operatorWidth: 0,
        operatorHeight: 0,
        fov: 0,
        encoderBitrateBps: 0,
      }),
    ]);

    renderFeed(client, { flightId: 99 });

    const overlay = await screen.findByRole("status", { name: /signal lost/i });
    expect(overlay).toBeTruthy();
    expect(overlay.textContent).toMatch(/SIGNAL LOST/i);
  });
});

// ---------------------------------------------------------------------------
// Stall presentation (showStatic prop)
// ---------------------------------------------------------------------------

/*
 * The stall detector lives in the SDK's noise pipeline, which needs a canvas
 * 2d context, captureStream, and requestVideoFrameCallback. The shared setup
 * stubs captureStream; this adds the rest, captures the pipeline's rAF draw
 * loop and rVFC frame callback, and mocks performance.now so tests can step
 * a real feed into (and out of) a stall through the public client surface.
 */
function installStallEnv() {
  let now = 0;
  const fakeCtx = {
    globalAlpha: 1,
    fillStyle: "",
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    createImageData: vi.fn((w: number, h: number) => ({
      data: new Uint8ClampedArray(w * h * 4),
    })),
    putImageData: vi.fn(),
  };
  const origGetContext = HTMLCanvasElement.prototype.getContext;
  // @ts-expect-error -- jsdom augmentation
  HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(fakeCtx);

  let rafCb: FrameRequestCallback | null = null;
  const rafSpy = vi
    .spyOn(globalThis, "requestAnimationFrame")
    .mockImplementation((cb) => {
      rafCb = cb;
      return 1;
    });
  const cancelSpy = vi
    .spyOn(globalThis, "cancelAnimationFrame")
    .mockImplementation(() => {});

  let vfcCb: (() => void) | null = null;
  const proto = HTMLVideoElement.prototype as HTMLVideoElement & {
    requestVideoFrameCallback?: (cb: () => void) => number;
    cancelVideoFrameCallback?: (id: number) => void;
  };
  proto.requestVideoFrameCallback = (cb: () => void) => {
    vfcCb = cb;
    return 1;
  };
  proto.cancelVideoFrameCallback = () => {};

  const origPause = HTMLMediaElement.prototype.pause;
  HTMLMediaElement.prototype.pause = () => {};

  const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => now);

  return {
    setNow(t: number) {
      now = t;
    },
    /** Deliver one decoded frame (fires the captured rVFC callback). */
    fireFrame() {
      vfcCb?.();
    },
    /** Run one pipeline draw-loop iteration. */
    drawOnce() {
      rafCb?.(now);
    },
    restore() {
      HTMLCanvasElement.prototype.getContext = origGetContext;
      delete proto.requestVideoFrameCallback;
      delete proto.cancelVideoFrameCallback;
      HTMLMediaElement.prototype.pause = origPause;
      rafSpy.mockRestore();
      cancelSpy.mockRestore();
      nowSpy.mockRestore();
    },
  };
}

describe("CameraFeed - stall presentation (showStatic)", () => {
  it("forwards showStatic to the displayed camera's handle", async () => {
    const { client } = await buildConnectedSource();

    const { unmount } = renderFeed(client, { flightId: 42 });
    // Default on (no reduced-motion in jsdom).
    expect(client.camera(42).showStatic).toBe(true);
    unmount();

    renderFeed(client, { flightId: 42, showStatic: false });
    expect(client.camera(42).showStatic).toBe(false);
  });

  it("showStatic=false shows the stale badge on stall and clears it when frames resume", async () => {
    const env = installStallEnv();
    try {
      const { client, sidecar } = await buildConnectedSource();
      renderFeed(client, { flightId: 42, showStatic: false });

      // Slot bound by the feed's subscription; deliver the media so the
      // noise pipeline (and its stall detector) attaches to a live source.
      const mid = sidecar.slotMidFor(42);
      expect(mid).toBeDefined();
      await act(async () => {
        sidecar.deliverTrack(mid as string, {} as MediaStreamTrack);
      });
      expect(screen.queryByRole("status", { name: /feed stale/i })).toBeNull();

      // A frame lands, then nothing for >500 ms: the stall detector trips
      // and the badge appears over the frozen frame.
      env.setNow(1000);
      await act(async () => {
        env.fireFrame();
      });
      env.setNow(1601);
      await act(async () => {
        env.drawOnce();
      });
      const badge = screen.getByRole("status", { name: /feed stale/i });
      expect(badge.textContent).toMatch(/stale/i);

      // Recovery is instant: the first decoded frame clears the badge on the
      // very next draw.
      await act(async () => {
        env.fireFrame();
        env.drawOnce();
      });
      expect(screen.queryByRole("status", { name: /feed stale/i })).toBeNull();
    } finally {
      env.restore();
    }
  });

  it("default mode shows no badge on stall (the in-stream static carries it)", async () => {
    const env = installStallEnv();
    try {
      const { client, sidecar } = await buildConnectedSource();
      renderFeed(client, { flightId: 42 });

      const mid = sidecar.slotMidFor(42);
      await act(async () => {
        sidecar.deliverTrack(mid as string, {} as MediaStreamTrack);
      });

      env.setNow(1000);
      await act(async () => {
        env.fireFrame();
      });
      env.setNow(1601);
      await act(async () => {
        env.drawOnce();
      });

      // The stall IS detected (the SDK composites ramping static in-stream),
      // but the chrome stays clean.
      expect(client.camera(42).stalled).toBe(true);
      expect(screen.queryByRole("status", { name: /feed stale/i })).toBeNull();
    } finally {
      env.restore();
    }
  });

  it("SIGNAL LOST supersedes the stale badge when the camera is destroyed", async () => {
    const env = installStallEnv();
    try {
      const { client, sidecar } = await buildConnectedSource();
      renderFeed(client, { flightId: 42, showStatic: false });

      const mid = sidecar.slotMidFor(42);
      await act(async () => {
        sidecar.deliverTrack(mid as string, {} as MediaStreamTrack);
      });
      env.setNow(1000);
      await act(async () => {
        env.fireFrame();
      });
      env.setNow(1601);
      await act(async () => {
        env.drawOnce();
      });
      expect(screen.getByRole("status", { name: /feed stale/i })).toBeTruthy();

      await act(async () => {
        sidecar.destroyCamera(42);
      });
      expect(screen.getByRole("status", { name: /signal lost/i })).toBeTruthy();
      expect(screen.queryByRole("status", { name: /feed stale/i })).toBeNull();
    } finally {
      env.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Zoom controls
// ---------------------------------------------------------------------------

describe("CameraFeed - quality control", () => {
  it("hidden unless enableQualityControl is set", async () => {
    const { client } = await buildConnectedSource();
    renderFeed(client, { flightId: 42 });
    expect(screen.queryByRole("button", { name: /quality/i })).toBeNull();
  });

  it("menu lists Auto plus the presets with target dims from the operator size", async () => {
    const { client } = await buildConnectedSource([
      makeCamera({
        flightId: 42,
        operatorWidth: 1024,
        operatorHeight: 576,
        renderWidth: 1024,
        renderHeight: 576,
      }),
    ]);
    renderFeed(client, { flightId: 42, enableQualityControl: true });

    fireEvent.click(screen.getByRole("button", { name: /quality/i }));

    const items = screen
      .getAllByRole("menuitemradio")
      .map((el) => el.textContent);
    expect(items).toEqual([
      "Auto",
      "Full (1024×576)",
      "3/4 (768×432)",
      "1/2 (512×288)",
      "1/4 (256×144)",
    ]);
    // No request yet: Auto is the checked entry.
    expect(
      screen
        .getByRole("menuitemradio", { name: "Auto" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    // Footer shows the effective state.
    expect(screen.getByRole("status").textContent).toBe("now 1024×576");
  });

  it("picking a preset sends set-quality and the echoed state checks it", async () => {
    const { client, sidecar } = await buildConnectedSource([
      makeCamera({
        flightId: 42,
        operatorWidth: 1024,
        operatorHeight: 576,
        renderWidth: 1024,
        renderHeight: 576,
      }),
    ]);
    renderFeed(client, { flightId: 42, enableQualityControl: true });

    fireEvent.click(screen.getByRole("button", { name: /quality/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitemradio", { name: /^1\/2/ }));
    });

    expect(sidecar.lastCommand("set-quality", 42)?.content.preset).toBe(
      QualityPreset.Half,
    );

    // Authoritative state came back: re-opened menu reflects it.
    fireEvent.click(screen.getByRole("button", { name: /quality/i }));
    expect(
      screen
        .getByRole("menuitemradio", { name: /^1\/2/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.getByRole("status").textContent).toBe("now 512×288");

    // Auto clears the request (preset omitted on the wire).
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitemradio", { name: "Auto" }));
    });
    const last = sidecar.lastCommand("set-quality", 42);
    expect(last && "preset" in last.content && last.content.preset).toBeFalsy();
  });

  it("marks the feed when the sidecar reports throttling below the request", async () => {
    const { client, sidecar } = await buildConnectedSource([
      makeCamera({
        flightId: 42,
        operatorWidth: 1024,
        operatorHeight: 576,
        renderWidth: 512,
        renderHeight: 288,
        viewerQuality: QualityPreset.Half,
      }),
    ]);
    renderFeed(client, { flightId: 42, enableQualityControl: true });

    // Honored request: no throttled marker.
    let button = screen.getByRole("button", { name: /quality/i });
    expect(button.title).toBe("Quality");

    // Adaptive demote pushes below the viewer target; sidecar broadcasts it.
    await act(async () => {
      sidecar.updateCamera(42, {
        renderWidth: 256,
        renderHeight: 144,
        qualityLimitedBy: "throttled",
      });
    });

    button = screen.getByRole("button", { name: /quality/i });
    expect(button.title).toMatch(/throttled/i);
    fireEvent.click(button);
    expect(screen.getByRole("status").textContent).toBe(
      "now 256×144 · throttled",
    );
    // The request itself is still shown as 1/2; it gets honored again
    // when the controller recovers.
    expect(
      screen
        .getByRole("menuitemradio", { name: /^1\/2/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("portals the open quality menu to document.body so tile clipping cannot cut it off", async () => {
    const { client } = await buildConnectedSource();
    const { container } = renderFeed(client, {
      flightId: 42,
      enableQualityControl: true,
    });

    fireEvent.click(screen.getByRole("button", { name: /quality/i }));

    const menu = screen.getByRole("menu", { name: "Quality" });
    // Same portal contract as the camera menu: on document.body, outside
    // the tile's DOM subtree, fixed so no ancestor overflow can clip it.
    expect(menu.parentElement).toBe(document.body);
    expect(container.contains(menu)).toBe(false);
    expect(getComputedStyle(menu).position).toBe("fixed");
  });

  it("pointer-down inside the portaled quality menu keeps it open; outside dismisses it", async () => {
    const { client } = await buildConnectedSource();
    renderFeed(client, { flightId: 42, enableQualityControl: true });

    fireEvent.click(screen.getByRole("button", { name: /quality/i }));
    expect(screen.getByRole("menu", { name: "Quality" })).toBeTruthy();

    // A press inside the portaled menu is not "outside" even though it is
    // outside the tile's subtree.
    fireEvent.pointerDown(screen.getByRole("menuitemradio", { name: "Auto" }));
    expect(screen.getByRole("menu", { name: "Quality" })).toBeTruthy();

    // A press anywhere else dismisses.
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu", { name: "Quality" })).toBeNull();
  });

  it("Escape closes the quality menu", async () => {
    const { client } = await buildConnectedSource();
    renderFeed(client, { flightId: 42, enableQualityControl: true });

    fireEvent.click(screen.getByRole("button", { name: /quality/i }));
    expect(screen.getByRole("menu", { name: "Quality" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("menu", { name: "Quality" })).toBeNull(),
    );
  });
});

describe("CameraFeed - zoom controls", () => {
  it("zoom controls appear when camera supportsZoom", async () => {
    const { client, sidecar } = await buildConnectedSource();

    renderFeed(client, { flightId: 42 });

    await act(async () => {
      sidecar.updateCamera(42, { supportsZoom: true });
    });

    expect(screen.getByRole("button", { name: /zoom in/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /zoom out/i })).toBeTruthy();
  });

  it("zoom controls absent when camera does not support zoom", async () => {
    const { client } = await buildConnectedSource();

    renderFeed(client, { flightId: 42 });

    expect(screen.queryByRole("button", { name: /zoom in/i })).toBeNull();
  });

  it("clicking the on-screen + button fires a discrete set-fov step", async () => {
    const { client, sidecar } = await buildConnectedSource();

    await act(async () => {
      sidecar.updateCamera(42, { supportsZoom: true, fov: 60 });
    });

    renderFeed(client, { flightId: 42 });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /zoom in/i }));
    });
    expect(sidecar.lastCommand("set-fov")?.content).toMatchObject({
      flightId: 42,
      fov: 55, // 60 - 5 (zoom in, FoV decreases)
    });
    expect(sidecar.lastCommand("set-zoom-rate")).toBeUndefined();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /zoom out/i }));
    });
    // Accumulates against the optimistic FoV (55 -> 60).
    expect(sidecar.lastCommand("set-fov")?.content.fov).toBe(60);
  });

  it("keyboard-activating a zoom button (no pointer events) fires a discrete nudge", async () => {
    const { client, sidecar } = await buildConnectedSource();

    await act(async () => {
      sidecar.updateCamera(42, { supportsZoom: true, fov: 60 });
    });

    renderFeed(client, { flightId: 42 });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /zoom in/i }), { detail: 0 });
    });
    expect(sidecar.lastCommand("set-fov")?.content).toMatchObject({
      flightId: 42,
      fov: 55,
    });
    expect(sidecar.lastCommand("set-zoom-rate")).toBeUndefined();
  });

  it("handle.setZoomRate(1) holds a zoom-in rate; setZoomRate(0) stops it", async () => {
    const { client, sidecar } = await buildConnectedSource();

    await act(async () => {
      sidecar.updateCamera(42, { supportsZoom: true, fov: 60 });
    });

    const handleRef = createRef<CameraFeedHandle>();
    renderFeed(client, { flightId: 42, ref: handleRef });

    await act(async () => {
      handleRef.current?.setZoomRate(1);
    });
    expect(sidecar.lastCommand("set-zoom-rate")?.content).toMatchObject({
      flightId: 42,
      rate: 1,
    });

    await act(async () => {
      handleRef.current?.setZoomRate(0);
    });
    expect(sidecar.lastCommand("set-zoom-rate")?.content.rate).toBe(0);
  });

  it("handle.setZoomRate is a no-op when camera does not support zoom", async () => {
    const { client, sidecar } = await buildConnectedSource();

    const handleRef = createRef<CameraFeedHandle>();
    renderFeed(client, { flightId: 42, ref: handleRef });

    await act(async () => {
      handleRef.current?.setZoomRate(1);
    });

    expect(sidecar.lastCommand("set-zoom-rate")).toBeUndefined();
  });

  it("a release with no prior press emits no command (rate already 0)", async () => {
    const { client, sidecar } = await buildConnectedSource();

    await act(async () => {
      sidecar.updateCamera(42, { supportsZoom: true, fov: 60 });
    });

    const handleRef = createRef<CameraFeedHandle>();
    renderFeed(client, { flightId: 42, ref: handleRef });

    await act(async () => {
      handleRef.current?.setZoomRate(0);
    });

    // sendZoomRate dedupes against the last-sent rate (0).
    expect(sidecar.lastCommand("set-zoom-rate")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Vertical FoV (zoom) slider
// ---------------------------------------------------------------------------

describe("CameraFeed - vertical FoV (zoom) slider", () => {
  const PAN_ZOOM_CAMERA = {
    flightId: 42,
    cameraName: "Gimbal Cam",
    supportsPan: true,
    panYaw: 0,
    panPitch: 0,
    panYawMin: -45,
    panYawMax: 45,
    panPitchMin: -30,
    panPitchMax: 30,
    supportsZoom: true,
    fov: 60,
    fovMin: 10,
    fovMax: 90,
  };

  it("shows a single zoom slider (no yaw/pitch sliders) when zoom is supported", async () => {
    const { client, sidecar } = await buildConnectedSource();

    await act(async () => {
      sidecar.updateCamera(42, PAN_ZOOM_CAMERA);
    });

    renderFeed(client, { flightId: 42 });

    expect(screen.getByRole("slider", { name: /zoom/i })).toBeTruthy();
    expect(screen.queryByRole("slider", { name: /pan/i })).toBeNull();
  });

  it("does not show the zoom slider when the camera has no zoom", async () => {
    const { client } = await buildConnectedSource();

    renderFeed(client, { flightId: 42 });

    expect(screen.queryByRole("slider", { name: /zoom/i })).toBeNull();
  });

  it("zoom slider min/max reflect the camera FoV range and initial value", async () => {
    const { client, sidecar } = await buildConnectedSource();

    await act(async () => {
      sidecar.updateCamera(42, PAN_ZOOM_CAMERA);
    });

    renderFeed(client, { flightId: 42 });

    const fovSlider = screen.getByRole<HTMLInputElement>("slider", { name: /zoom/i });
    expect(Number(fovSlider.min)).toBe(10);
    expect(Number(fovSlider.max)).toBe(90);
    expect(Number(fovSlider.value)).toBe(60);
  });

  it("zoom slider commits the settled absolute set-fov on release (debounced)", async () => {
    const { client, sidecar } = await buildConnectedSource();

    await act(async () => {
      sidecar.updateCamera(42, PAN_ZOOM_CAMERA);
    });

    renderFeed(client, { flightId: 42 });

    const fovSlider = screen.getByRole("slider", { name: /zoom/i });

    await act(async () => {
      fireEvent.pointerDown(fovSlider);
      fireEvent.change(fovSlider, { target: { value: "50" } });
      fireEvent.change(fovSlider, { target: { value: "30" } });
    });
    expect(sidecar.lastCommand("set-fov")).toBeUndefined();

    await act(async () => {
      fireEvent.pointerUp(fovSlider);
    });
    expect(sidecar.lastCommand("set-fov")?.content).toMatchObject({
      flightId: 42,
      fov: 30,
    });
  });

  it("zoom slider commits the settled value after a pause (no pointer release)", async () => {
    vi.useFakeTimers();
    const { client, sidecar } = await buildConnectedSource();

    await act(async () => {
      sidecar.updateCamera(42, PAN_ZOOM_CAMERA);
    });

    renderFeed(client, { flightId: 42 });

    const fovSlider = screen.getByRole("slider", { name: /zoom/i });

    await act(async () => {
      fireEvent.change(fovSlider, { target: { value: "42" } });
    });
    expect(sidecar.lastCommand("set-fov")).toBeUndefined();

    await act(async () => {
      vi.advanceTimersByTime(150); // past FOV_SLIDER_DEBOUNCE_MS (120)
    });
    expect(sidecar.lastCommand("set-fov")?.content.fov).toBe(42);

    vi.useRealTimers();
  });

  it("holding a zoom button sends a constant rate; releasing stops it", async () => {
    const { client, sidecar } = await buildConnectedSource();

    await act(async () => {
      sidecar.updateCamera(42, { supportsZoom: true, fov: 60 });
    });

    renderFeed(client, { flightId: 42 });

    const zoomInBtn = screen.getByRole("button", { name: /zoom in/i });

    await act(async () => {
      fireEvent.pointerDown(zoomInBtn);
    });
    expect(sidecar.lastCommand("set-zoom-rate")?.content).toMatchObject({
      flightId: 42,
      rate: 1,
    });

    await act(async () => {
      fireEvent.pointerUp(zoomInBtn);
    });
    expect(sidecar.lastCommand("set-zoom-rate")?.content.rate).toBe(0);
  });

  it("zoom slider thumb tracks the camera echo when not dragging", async () => {
    const { client, sidecar } = await buildConnectedSource();

    await act(async () => {
      sidecar.updateCamera(42, PAN_ZOOM_CAMERA);
    });

    renderFeed(client, { flightId: 42 });

    await act(async () => {
      sidecar.updateCamera(42, { fov: 45 });
    });

    const fovSlider = screen.getByRole<HTMLInputElement>("slider", { name: /zoom/i });
    expect(Number(fovSlider.value)).toBe(45);
  });
});

// ---------------------------------------------------------------------------
// ResizeObserver render-size feedback
// ---------------------------------------------------------------------------

describe("CameraFeed - ResizeObserver render-size feedback", () => {
  let resizeCallback:
    | ((entries: ResizeObserverEntry[], observer: ResizeObserver) => void)
    | undefined;
  const originalResizeObserver = globalThis.ResizeObserver;

  beforeEach(() => {
    vi.useFakeTimers();
    globalThis.ResizeObserver = class {
      constructor(
        cb: (entries: ResizeObserverEntry[], observer: ResizeObserver) => void,
      ) {
        resizeCallback = cb;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.ResizeObserver = originalResizeObserver;
    resizeCallback = undefined;
  });

  it("reports the measured display size (report-display-size, real w x h)", async () => {
    const { client, sidecar } = await buildConnectedSource();

    renderFeed(client, { flightId: 42 });

    // First measurement reports promptly (no debounce wait).
    await act(async () => {
      resizeCallback?.(
        [{ contentRect: { width: 400, height: 224 } }] as ResizeObserverEntry[],
        {} as ResizeObserver,
      );
    });

    const msg = sidecar.lastCommand("report-display-size");
    expect(msg).toBeTruthy();
    // Measured w x h (no synthetic 16:9 crop), bucketed to a 16-multiple:
    // 400 -> 400, 224 -> 224.
    expect(msg?.content.width).toBe(400);
    expect(msg?.content.height).toBe(224);
    // Measurement no longer drives the operator set-render-size (that path is
    // the manual quality cap only).
    expect(sidecar.commands.some((c) => c.type === "set-render-size")).toBe(false);
  });

  it("does not report when renderSize is none", async () => {
    const { client, sidecar } = await buildConnectedSource();

    renderFeed(client, { flightId: 42, renderSize: "none" });

    // The observer is never armed when reporting is disabled.
    expect(resizeCallback).toBeUndefined();
    expect(sidecar.commands.some((c) => c.type === "report-display-size")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// showActions
// ---------------------------------------------------------------------------

describe("CameraFeed - showActions", () => {
  it("renders the action bar by default", async () => {
    const { client } = await buildConnectedSource();
    const { queryByLabelText } = renderFeed(client, { flightId: 42 });
    // The camera step buttons live in the action bar.
    expect(queryByLabelText("Next camera")).toBeTruthy();
  });

  it("hides the action bar when showActions is false", async () => {
    const { client } = await buildConnectedSource();
    const { queryByLabelText } = renderFeed(client, {
      flightId: 42,
      showActions: false,
    });
    expect(queryByLabelText("Next camera")).toBeNull();
    expect(queryByLabelText("Previous camera")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Action-bar overflow threshold crossing -- never-remount regression
// ---------------------------------------------------------------------------

describe("CameraFeed - action bar overflow threshold crossing", () => {
  it("never remounts the <video> element when the actions count crosses the overflow threshold", async () => {
    const { client } = await buildConnectedSource();

    function Harness() {
      const [count, setCount] = useState(3);
      const actions = Array.from({ length: count }, (_, i) => ({
        id: `extra-${i}`,
        label: `Extra ${i}`,
        icon: <span>{i}</span>,
        onClick: () => {},
      }));
      return (
        <KerbcastProvider client={client}>
          <CameraFeed flightId={42} actions={actions} />
          <button type="button" onClick={() => setCount(4)}>
            grow
          </button>
        </KerbcastProvider>
      );
    }

    const { container } = render(<Harness />);
    const before = container.querySelector("video");
    expect(before).toBeTruthy();
    // Below the threshold (3 total): every action is inline, no ⋮ trigger.
    expect(screen.queryByRole("button", { name: /more actions/i })).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^grow$/i }));
    });

    // Crossed the threshold (4 total, all non-stateful >= 2): the ⋮ trigger
    // now appears -- but the SAME <video> node is still there, never remounted.
    expect(screen.getByRole("button", { name: /more actions/i })).toBeTruthy();
    const after = container.querySelector("video");
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Pan reticle
// ---------------------------------------------------------------------------

describe("CameraFeed - pan reticle", () => {
  const PAN_FLIP = {
    supportsPan: true,
    panYawMin: -45,
    panYawMax: 45,
    panPitchMin: -30,
    panPitchMax: 30,
  };

  it("pan controls appear when camera supportsPan", async () => {
    const { client, sidecar } = await buildConnectedSource();

    renderFeed(client, { flightId: 42 });

    await act(async () => {
      sidecar.updateCamera(42, PAN_FLIP);
    });

    expect(screen.getByRole("button", { name: /pan left/i })).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /pan up/i }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("pan controls absent when camera does not support pan", async () => {
    const { client } = await buildConnectedSource();

    renderFeed(client, { flightId: 42 });

    expect(screen.queryByRole("button", { name: /pan left/i })).toBeNull();
  });

  const panRateMsgs = (sidecar: MockSidecar) =>
    sidecar.commands.filter(
      (c): c is Extract<ClientMessage, { type: "set-pan-rate" }> =>
        c.type === "set-pan-rate",
    );

  it("clicking a pan arrow moves one discrete step (absolute set-pan, no rate)", async () => {
    const { client, sidecar } = await buildConnectedSource();

    await act(async () => {
      sidecar.updateCamera(42, PAN_FLIP);
    });

    renderFeed(client, { flightId: 42 });

    const leftArrow = screen.getByRole("button", { name: /pan left/i });

    await act(async () => {
      fireEvent.click(leftArrow);
    });
    expect(panRateMsgs(sidecar)).toHaveLength(0);
    expect(sidecar.lastCommand("set-pan")?.content).toMatchObject({
      flightId: 42,
      yaw: -5, // left = negative yaw
      pitch: 0,
    });

    await act(async () => {
      fireEvent.click(leftArrow);
    });
    expect(sidecar.lastCommand("set-pan")?.content.yaw).toBe(-10);
  });

  it("dragging the pan ball sends a proportional set-pan-rate; release sends 0", async () => {
    const origCapture = HTMLElement.prototype.setPointerCapture;
    HTMLElement.prototype.setPointerCapture = vi.fn();

    const { client, sidecar } = await buildConnectedSource();

    await act(async () => {
      sidecar.updateCamera(42, PAN_FLIP);
    });

    renderFeed(client, { flightId: 42 });

    const ball = screen.getByTitle("Drag to pan");

    await act(async () => {
      fireEvent.pointerDown(ball, { clientX: 100, clientY: 100 });
    });
    expect(panRateMsgs(sidecar)).toHaveLength(0);

    // Deflect fully right (40px >= PAN_BALL_RADIUS => rate clamps to +1).
    await act(async () => {
      fireEvent.pointerMove(ball, { clientX: 140, clientY: 100 });
    });
    const moved = panRateMsgs(sidecar);
    expect(moved.length).toBeGreaterThan(0);
    expect(moved.at(-1)?.content).toMatchObject({ flightId: 42, yawRate: 1 });
    expect(moved.at(-1)?.content.pitchRate).toBe(0);

    await act(async () => {
      fireEvent.pointerUp(ball);
    });
    expect(panRateMsgs(sidecar).at(-1)?.content).toMatchObject({
      yawRate: 0,
      pitchRate: 0,
    });

    HTMLElement.prototype.setPointerCapture = origCapture;
  });

  it("handle.setPanAxis('yaw', 0.5) sends set-pan-rate on the yaw axis", async () => {
    const { client, sidecar } = await buildConnectedSource();

    await act(async () => {
      sidecar.updateCamera(42, PAN_FLIP);
    });

    const handleRef = createRef<CameraFeedHandle>();
    renderFeed(client, { flightId: 42, ref: handleRef });

    await act(async () => {
      handleRef.current?.setPanAxis("yaw", 0.5);
    });

    expect(sidecar.lastCommand("set-pan-rate")?.content).toMatchObject({
      flightId: 42,
      yawRate: 0.5,
      pitchRate: 0,
    });
  });

  it("handle.setPanAxis('pitch', 0.5) sends set-pan-rate on the pitch axis", async () => {
    const { client, sidecar } = await buildConnectedSource();

    await act(async () => {
      sidecar.updateCamera(42, PAN_FLIP);
    });

    const handleRef = createRef<CameraFeedHandle>();
    renderFeed(client, { flightId: 42, ref: handleRef });

    await act(async () => {
      handleRef.current?.setPanAxis("pitch", 0.5);
    });

    expect(sidecar.lastCommand("set-pan-rate")?.content).toMatchObject({
      flightId: 42,
      yawRate: 0,
      pitchRate: 0.5,
    });
  });

  it("yaw and pitch axes compose -- setting one preserves the other", async () => {
    const { client, sidecar } = await buildConnectedSource();

    await act(async () => {
      sidecar.updateCamera(42, PAN_FLIP);
    });

    const handleRef = createRef<CameraFeedHandle>();
    renderFeed(client, { flightId: 42, ref: handleRef });

    await act(async () => {
      handleRef.current?.setPanAxis("yaw", 1);
    });
    await act(async () => {
      handleRef.current?.setPanAxis("pitch", 0.5);
    });

    expect(sidecar.lastCommand("set-pan-rate")?.content).toMatchObject({
      yawRate: 1,
      pitchRate: 0.5,
    });
  });

  it("a tiny analog deflection inside the deadzone sends no command", async () => {
    const { client, sidecar } = await buildConnectedSource();

    await act(async () => {
      sidecar.updateCamera(42, PAN_FLIP);
    });

    const handleRef = createRef<CameraFeedHandle>();
    renderFeed(client, { flightId: 42, ref: handleRef });

    // 0.02 < ANALOG_DEADZONE (0.05) -> snapped to 0 -> deduped against 0 -> no traffic.
    await act(async () => {
      handleRef.current?.setPanAxis("yaw", 0.02);
    });

    expect(panRateMsgs(sidecar)).toHaveLength(0);
  });

  it("handle.setPanAxis is a no-op when camera does not support pan", async () => {
    // Default camera has supportsPan: false.
    const { client, sidecar } = await buildConnectedSource();

    const handleRef = createRef<CameraFeedHandle>();
    renderFeed(client, { flightId: 42, ref: handleRef });

    await act(async () => {
      handleRef.current?.setPanAxis("yaw", 1);
    });

    expect(panRateMsgs(sidecar)).toHaveLength(0);
  });

  it("unmounting mid-pan stops the rate so the plugin doesn't run away", async () => {
    const { client, sidecar } = await buildConnectedSource();

    await act(async () => {
      sidecar.updateCamera(42, PAN_FLIP);
    });

    const handleRef = createRef<CameraFeedHandle>();
    const { unmount } = renderFeed(client, { flightId: 42, ref: handleRef });

    await act(async () => {
      handleRef.current?.setPanAxis("yaw", 1);
    });
    expect(panRateMsgs(sidecar).at(-1)?.content.yawRate).toBe(1);

    await act(async () => {
      unmount();
    });
    expect(panRateMsgs(sidecar).at(-1)?.content).toMatchObject({
      flightId: 42,
      yawRate: 0,
      pitchRate: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// client prop override
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// useStream injection seam
// ---------------------------------------------------------------------------

describe("CameraFeed - useStream injection seam", () => {
  const THREE_CAMERAS = [
    makeCamera({ flightId: 42, cameraName: "Starboard Cam", vesselName: "Kerbal X" }),
    makeCamera({ flightId: 43, cameraName: "Nose Cam", vesselName: "Kerbal X" }),
    makeCamera({ flightId: 44, cameraName: "Tail Cam", vesselName: "Kerbal X" }),
  ];

  it("without useStream, the built-in stream binds to the video (regression)", async () => {
    const { client, sidecar } = await buildConnectedSource();

    renderFeed(client, { flightId: 42 });

    // Deliver a track so the built-in useKerbcastStream yields a MediaStream.
    const mid = sidecar.slotMidFor(42);
    expect(mid).toBeDefined();
    await act(async () => {
      sidecar.deliverTrack(mid as string, {} as MediaStreamTrack);
    });

    const video = document.querySelector("video");
    expect(video?.srcObject).toBe(client.camera(42).mediaStream);
  });

  it("routes the video through a custom useStream, called with the RESOLVED flightId", async () => {
    const { client } = await buildConnectedSource(THREE_CAMERAS);

    const sentinel = {} as MediaStream;
    const seen: (number | null)[] = [];
    // Stable identity (declared once per test render tree), so React treats it
    // as the same hook every render — the rules-of-hooks contract the prop docs.
    const useCustom: CameraStreamHook = (flightId) => {
      seen.push(flightId);
      return flightId === 42 ? sentinel : null;
    };

    render(
      <KerbcastProvider client={client}>
        {/* flightId=null: auto-latch must resolve to the first live camera (42)
            before the hook is called, proving it sees the resolved id. */}
        <CameraFeed flightId={null} useStream={useCustom} />
      </KerbcastProvider>,
    );

    expect(screen.getByRole("heading", { name: "Starboard Cam" })).toBeTruthy();
    // Called with the resolved 42, never the requested null.
    expect(seen).toContain(42);
    expect(seen).not.toContain(null);
    // The stream the custom hook returned is what got bound.
    const video = document.querySelector("video");
    expect(video?.srcObject).toBe(sentinel);
  });
});

describe("CameraFeed - client prop override", () => {
  it("accepts a client prop instead of a provider", async () => {
    const { client } = await buildConnectedSource([
      makeCamera({ flightId: 42, cameraName: "Override Cam", vesselName: "Test" }),
    ]);

    // Render without a KerbcastProvider -- client prop provides it implicitly.
    render(<CameraFeed client={client} flightId={42} />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Override Cam" })).toBeTruthy();
    });
  });
});

// ---------------------------------------------------------------------------
// Tracking (crosshair) — auto-track a moving vessel, server-authoritative
// ---------------------------------------------------------------------------

describe("CameraFeed - tracking (crosshair)", () => {
  function panZoomCam(overrides: Record<string, unknown> = {}) {
    return makeCamera({
      flightId: 42,
      cameraName: "Launchpad Cam",
      supportsPan: true,
      supportsZoom: true,
      panPitchMin: -90,
      panPitchMax: 90,
      ...overrides,
    });
  }

  it("shows the crosshair on a pan+zoom camera when enableTracking", async () => {
    const { client } = await buildConnectedSource([panZoomCam()]);
    const { queryByLabelText } = renderFeed(client, {
      flightId: 42,
      enableTracking: true,
    });
    expect(queryByLabelText("Auto-track")).toBeTruthy();
  });

  it("hides the crosshair without enableTracking", async () => {
    const { client } = await buildConnectedSource([panZoomCam()]);
    const { queryByLabelText } = renderFeed(client, { flightId: 42 });
    expect(queryByLabelText("Auto-track")).toBeNull();
  });

  it("hides the crosshair when the camera lacks pan or zoom", async () => {
    const { client } = await buildConnectedSource([
      makeCamera({ flightId: 42, supportsPan: true, supportsZoom: false }),
    ]);
    const { queryByLabelText } = renderFeed(client, {
      flightId: 42,
      enableTracking: true,
    });
    expect(queryByLabelText("Auto-track")).toBeNull();
  });

  it("clicking a mode sends set-track-target with that mode", async () => {
    const { client, sidecar } = await buildConnectedSource([panZoomCam()]);
    const { getByLabelText } = renderFeed(client, {
      flightId: 42,
      enableTracking: true,
    });
    fireEvent.click(getByLabelText("Auto-track"));
    fireEvent.click(
      await screen.findByRole("menuitemradio", { name: "Track active vessel" }),
    );
    expect(sidecar.lastCommand("set-track-target", 42)?.content.mode).toBe(
      TrackMode.ActiveVessel,
    );
  });

  it("highlight reflects the SERVER trackMode, never the click (not optimistic)", async () => {
    const { client, sidecar } = await buildConnectedSource([panZoomCam()]);
    // Suppress the echo so a click alone cannot flip the highlight; only a
    // real server state change may.
    const spy = vi.spyOn(client, "setTrackTarget").mockResolvedValue();
    const { getByLabelText } = renderFeed(client, {
      flightId: 42,
      enableTracking: true,
    });
    expect(getByLabelText("Auto-track").getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(getByLabelText("Auto-track"));
    fireEvent.click(
      await screen.findByRole("menuitemradio", { name: "Track target" }),
    );
    expect(spy).toHaveBeenCalledWith(42, TrackMode.Target);
    // No echo yet -> highlight must stay off.
    expect(getByLabelText("Auto-track").getAttribute("aria-pressed")).toBe("false");

    // Server confirms -> highlight turns on.
    await act(async () => {
      sidecar.updateCamera(42, { trackMode: TrackMode.Target });
    });
    expect(getByLabelText("Auto-track").getAttribute("aria-pressed")).toBe("true");
  });

  it("clicking the active mode deselects to none", async () => {
    const { client, sidecar } = await buildConnectedSource([
      panZoomCam({ trackMode: TrackMode.ActiveVessel }),
    ]);
    const { getByLabelText } = renderFeed(client, {
      flightId: 42,
      enableTracking: true,
    });
    fireEvent.click(getByLabelText("Auto-track"));
    fireEvent.click(
      await screen.findByRole("menuitemradio", { name: "Track active vessel" }),
    );
    expect(sidecar.lastCommand("set-track-target", 42)?.content.mode).toBe(
      TrackMode.None,
    );
  });

  it("disables the manual pan + zoom controls while tracking", async () => {
    const { client } = await buildConnectedSource([
      panZoomCam({ trackMode: TrackMode.Target }),
    ]);
    const { getByLabelText } = renderFeed(client, {
      flightId: 42,
      enableTracking: true,
    });
    expect((getByLabelText("Zoom in") as HTMLButtonElement).disabled).toBe(true);
    expect((getByLabelText("Zoom out") as HTMLButtonElement).disabled).toBe(true);
    expect((getByLabelText("Pan left") as HTMLButtonElement).disabled).toBe(true);
    expect((getByLabelText("Pan right") as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps manual pan + zoom enabled when not tracking", async () => {
    const { client } = await buildConnectedSource([
      panZoomCam({ trackMode: TrackMode.None }),
    ]);
    const { getByLabelText } = renderFeed(client, {
      flightId: 42,
      enableTracking: true,
    });
    expect((getByLabelText("Zoom in") as HTMLButtonElement).disabled).toBe(false);
    expect((getByLabelText("Pan left") as HTMLButtonElement).disabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// REC (per-feed recording)
// ---------------------------------------------------------------------------

describe("CameraFeed - REC", () => {
  it("does not render REC without enableRecording", async () => {
    const { client } = await buildConnectedSource();
    const { queryByLabelText } = renderFeed(client, { flightId: 42 });
    expect(queryByLabelText("Start recording")).toBeNull();
  });

  it("renders an idle REC toggle when enableRecording", async () => {
    const { client } = await buildConnectedSource();
    const { getByLabelText, queryByLabelText } = renderFeed(client, {
      flightId: 42,
      enableRecording: true,
    });
    const rec = getByLabelText("Start recording");
    expect(rec.getAttribute("aria-pressed")).toBe("false");
    // No red-dot/timer badge while idle.
    expect(queryByLabelText("Recording")).toBeNull();
  });

  it("clicking idle REC starts a recording via the store", async () => {
    const { client } = await buildConnectedSource();
    const { getByLabelText } = renderFeed(client, {
      flightId: 42,
      enableRecording: true,
    });

    fireEvent.click(getByLabelText("Start recording"));

    expect(recordingsStoreSpies.start).toHaveBeenCalledWith(42, { forceFullResolution: false });
    const rec = getByLabelText("Stop recording");
    expect(rec.getAttribute("aria-pressed")).toBe("true");
    expect(getByLabelText("Recording")).toBeTruthy();
  });

  it("clicking active REC stops the recording via the store", async () => {
    const { client } = await buildConnectedSource();
    const { getByLabelText, queryByLabelText } = renderFeed(client, {
      flightId: 42,
      enableRecording: true,
    });

    fireEvent.click(getByLabelText("Start recording"));
    await act(async () => {
      fireEvent.click(getByLabelText("Stop recording"));
    });

    expect(recordingsStoreSpies.stop).toHaveBeenCalledWith("rec-42");
    expect(getByLabelText("Start recording").getAttribute("aria-pressed")).toBe("false");
    expect(queryByLabelText("Recording")).toBeNull();
  });

  it("does not leave an unhandled rejection when the store's stop() fails", async () => {
    recordingsStoreSpies.stopRejects = true;
    const { client } = await buildConnectedSource();
    const { getByLabelText } = renderFeed(client, {
      flightId: 42,
      enableRecording: true,
    });

    fireEvent.click(getByLabelText("Start recording"));
    await act(async () => {
      fireEvent.click(getByLabelText("Stop recording"));
      await Promise.resolve();
      await Promise.resolve();
    });

    /* Reaching here without vitest reporting an unhandled rejection is the
       assertion: toggleRecording's void recordings.stop(...) must catch. */
    expect(recordingsStoreSpies.stop).toHaveBeenCalledWith("rec-42");
  });

  it("reads recording state from the store, not local state", async () => {
    // Two feeds on independent flightIds: starting one's recording must not
    // flip the other's REC control -- isRecording(flightId) is per-feed.
    const { client } = await buildConnectedSource([
      makeCamera({ flightId: 42, cameraName: "Cam A" }),
      makeCamera({ flightId: 43, cameraName: "Cam B" }),
    ]);
    renderFeed(client, { flightId: 42, enableRecording: true });
    renderFeed(client, { flightId: 43, enableRecording: true });

    fireEvent.click(screen.getAllByLabelText("Start recording")[0]);

    const stopButtons = screen.queryAllByLabelText("Stop recording");
    const idleButtons = screen.queryAllByLabelText("Start recording");
    expect(stopButtons).toHaveLength(1);
    expect(idleButtons).toHaveLength(1);
  });

  it("shows a live elapsed timer while recording", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"],
    });
    try {
      const { client } = await buildConnectedSource();
      const { getByLabelText } = renderFeed(client, {
        flightId: 42,
        enableRecording: true,
      });

      act(() => {
        fireEvent.click(getByLabelText("Start recording"));
      });
      expect(getByLabelText("Recording").textContent).toBe("REC 0:00");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(getByLabelText("Recording").textContent).toBe("REC 0:03");
    } finally {
      vi.useRealTimers();
    }
  });

  it("REC is a stateful primary that never enters the ⋮ overflow", async () => {
    const { client } = await buildConnectedSource();
    const extraActions: FeedAction[] = Array.from({ length: 3 }, (_, i) => ({
      id: `extra-${i}`,
      label: `Extra ${i}`,
      icon: <span>{i}</span>,
      onClick: () => {},
    }));
    const { getByLabelText, getByRole } = renderFeed(client, {
      flightId: 42,
      enableRecording: true,
      actions: extraActions,
    });

    // Crowded (>= 4 total, >= 2 non-stateful): the overflow trigger exists...
    expect(getByRole("button", { name: /more actions/i })).toBeTruthy();
    // ...but REC is directly queryable without opening it -- it never
    // collapsed into the menu.
    expect(getByLabelText("Start recording")).toBeTruthy();
  });

  it("never remounts the <video> element across a start/stop cycle", async () => {
    const { client } = await buildConnectedSource();
    const { container, getByLabelText } = renderFeed(client, {
      flightId: 42,
      enableRecording: true,
    });
    const before = container.querySelector("video");
    expect(before).toBeTruthy();

    fireEvent.click(getByLabelText("Start recording"));
    await act(async () => {
      fireEvent.click(getByLabelText("Stop recording"));
    });

    const after = container.querySelector("video");
    expect(after).toBe(before);
  });
});

describe("CameraFeed - recordFullResolution", () => {
  it("threads recordFullResolution: true into the store's start call", async () => {
    const { client } = await buildConnectedSource();
    const { getByLabelText } = renderFeed(client, {
      flightId: 42,
      enableRecording: true,
      recordFullResolution: true,
    });

    fireEvent.click(getByLabelText("Start recording"));

    expect(recordingsStoreSpies.start).toHaveBeenCalledWith(42, {
      forceFullResolution: true,
    });
  });

  it("sends forceFullResolution: false when the prop is absent (default)", async () => {
    const { client } = await buildConnectedSource();
    const { getByLabelText } = renderFeed(client, {
      flightId: 42,
      enableRecording: true,
    });

    fireEvent.click(getByLabelText("Start recording"));

    expect(recordingsStoreSpies.start).toHaveBeenCalledWith(42, {
      forceFullResolution: false,
    });
  });

  it("shows the ARMING pill instead of the REC badge while arming, then swaps to the REC badge", async () => {
    const { client } = await buildConnectedSource();
    const { getByLabelText, queryByLabelText } = renderFeed(client, {
      flightId: 42,
      enableRecording: true,
      recordFullResolution: true,
    });

    fireEvent.click(getByLabelText("Start recording"));

    expect(getByLabelText("Arming").textContent).toBe("ARMING");
    expect(queryByLabelText("Recording")).toBeNull();

    await act(async () => {
      recordingsStoreSpies.resolveArming("rec-42");
    });

    expect(queryByLabelText("Arming")).toBeNull();
    expect(getByLabelText("Recording").textContent).toMatch(/^REC /);
  });

  it("never remounts the <video> element across the arming -> recording transition", async () => {
    const { client } = await buildConnectedSource();
    const { container, getByLabelText } = renderFeed(client, {
      flightId: 42,
      enableRecording: true,
      recordFullResolution: true,
    });
    const before = container.querySelector("video");
    expect(before).toBeTruthy();

    fireEvent.click(getByLabelText("Start recording"));
    expect(getByLabelText("Arming")).toBeTruthy();

    await act(async () => {
      recordingsStoreSpies.resolveArming("rec-42");
    });
    expect(getByLabelText("Recording")).toBeTruthy();

    const after = container.querySelector("video");
    expect(after).toBe(before);
  });

  it("does not show the ARMING pill when recordFullResolution is false (default)", async () => {
    const { client } = await buildConnectedSource();
    const { getByLabelText, queryByLabelText } = renderFeed(client, {
      flightId: 42,
      enableRecording: true,
    });

    fireEvent.click(getByLabelText("Start recording"));

    expect(queryByLabelText("Arming")).toBeNull();
    expect(getByLabelText("Recording")).toBeTruthy();
  });
});

describe("CameraFeed - recording locks source and close", () => {
  it("disables the camera source dropdown while recording, with a hint, and re-enables on stop", async () => {
    const { client } = await buildConnectedSource();
    const { getByLabelText, getByRole } = renderFeed(client, {
      flightId: 42,
      enableRecording: true,
    });

    const source = getByRole<HTMLButtonElement>("button", { name: /starboard cam/i });
    expect(source.disabled).toBe(false);

    fireEvent.click(getByLabelText("Start recording"));

    expect(source.disabled).toBe(true);
    expect(source.title).toBe("Stop recording to change camera");

    await act(async () => {
      fireEvent.click(getByLabelText("Stop recording"));
    });

    expect(source.disabled).toBe(false);
  });

  it("does not open the camera menu when the source dropdown is clicked while recording", async () => {
    const { client } = await buildConnectedSource([
      makeCamera({ flightId: 42, cameraName: "Starboard Cam" }),
      makeCamera({ flightId: 43, cameraName: "Nose Cam" }),
    ]);
    const { getByLabelText, getByRole, queryAllByRole } = renderFeed(client, {
      flightId: 42,
      enableRecording: true,
    });

    fireEvent.click(getByLabelText("Start recording"));
    fireEvent.click(getByRole("button", { name: /starboard cam/i }));

    expect(queryAllByRole("menuitemradio")).toHaveLength(0);
  });

  it("disables the pinned trailing close control while recording and re-enables on stop", async () => {
    const onClose = vi.fn();
    const { client } = await buildConnectedSource();
    const { getByLabelText } = renderFeed(client, {
      flightId: 42,
      enableRecording: true,
      trailingActions: [
        { id: "close", label: "Close", icon: <span>x</span>, onClick: onClose },
      ],
    });

    const close = getByLabelText("Close") as HTMLButtonElement;
    expect(close.disabled).toBe(false);

    fireEvent.click(getByLabelText("Start recording"));

    expect(close.disabled).toBe(true);
    expect(close.title).toBe("Stop recording to close this feed");
    fireEvent.click(close);
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(getByLabelText("Stop recording"));
    });

    expect(close.disabled).toBe(false);
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps tracking, PiP, fullscreen, and the REC(stop) button enabled while recording", async () => {
    const fsDoc = document as Document & { fullscreenEnabled?: boolean };
    const pipDoc = document as Document & { pictureInPictureEnabled?: boolean };
    Object.defineProperty(fsDoc, "fullscreenEnabled", { value: true, configurable: true });
    Object.defineProperty(pipDoc, "pictureInPictureEnabled", { value: true, configurable: true });

    try {
      const { client } = await buildConnectedSource([
        makeCamera({
          flightId: 42,
          cameraName: "Launchpad Cam",
          supportsPan: true,
          supportsZoom: true,
          panPitchMin: -90,
          panPitchMax: 90,
        }),
      ]);
      const { getByLabelText, queryByLabelText } = renderFeed(client, {
        flightId: 42,
        enableRecording: true,
        enableTracking: true,
        enableFullscreen: true,
        enablePictureInPicture: true,
      });

      fireEvent.click(getByLabelText("Start recording"));

      // Tracking + REC are stateful primaries, always inline; PiP + fullscreen
      // (non-stateful) collapse into the ⋮ overflow once the row is crowded
      // (REC + tracking + PiP + fullscreen == 4), so open it to reach them.
      const overflowTrigger = queryByLabelText("More actions");
      if (overflowTrigger) fireEvent.click(overflowTrigger);

      expect((getByLabelText("Auto-track") as HTMLButtonElement).disabled).toBe(false);
      expect((getByLabelText("Picture in picture") as HTMLButtonElement).disabled).toBe(false);
      expect((getByLabelText("Enter fullscreen") as HTMLButtonElement).disabled).toBe(false);
      expect((getByLabelText("Stop recording") as HTMLButtonElement).disabled).toBe(false);
    } finally {
      delete (fsDoc as { fullscreenEnabled?: boolean }).fullscreenEnabled;
      delete (pipDoc as { pictureInPictureEnabled?: boolean }).pictureInPictureEnabled;
    }
  });

  it("leaves the source dropdown and close control enabled when not recording", async () => {
    const onClose = vi.fn();
    const { client } = await buildConnectedSource();
    const { getByLabelText, getByRole } = renderFeed(client, {
      flightId: 42,
      enableRecording: true,
      trailingActions: [
        { id: "close", label: "Close", icon: <span>x</span>, onClick: onClose },
      ],
    });

    expect(getByRole<HTMLButtonElement>("button", { name: /starboard cam/i }).disabled).toBe(
      false,
    );
    fireEvent.click(getByLabelText("Close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
