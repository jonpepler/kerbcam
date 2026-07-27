/**
 * Integration test for the recording UI slice: per-feed REC -> tray ->
 * discard, and REC+ grouped selection -> start -> stop -> a grouped set in
 * the tray. Exercises the real App/Header/Grid/Tile/CameraFeed/RecGroupBar/
 * RecordingsPanel wiring end to end.
 *
 * `useRecordings` is faked (partial mock of @ksp-gonogo/kerbcast-react, same
 * technique as CameraFeed.test.tsx's own REC tests) with a SHARED external
 * store, because a real recording needs a track-bearing MediaStream jsdom
 * cannot produce -- see the useRecordings.test.tsx / CameraFeed.test.tsx doc
 * comments for the underlying reason. Sharing one store across every call
 * site (CameraFeed's own REC button, Header's badge, RecGroupBar, the
 * RecordingsTray) is what makes this an actual integration test rather than
 * N isolated component tests: a clip started on one tile is visible
 * everywhere else the same way the real RecordingController would make it.
 */

import { KerbcastClient } from "@ksp-gonogo/kerbcast";
import type { CameraLifecycle } from "@ksp-gonogo/kerbcast";
import { Layer } from "@ksp-gonogo/kerbcast";
import type { MockCameraInit } from "@ksp-gonogo/kerbcast/testing";
import { MockSidecar } from "@ksp-gonogo/kerbcast/testing";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

// ---------------------------------------------------------------------------
// Shared fake recordings store (vi.hoisted: referenced inside vi.mock's
// factory, which Vitest hoists above this file's own imports/consts).
// ---------------------------------------------------------------------------

interface FakeActive {
  recordingId: string;
  flightId: number;
  startedAt: number;
  groupId?: string;
}
interface FakeHandle {
  recordingId: string;
  blob: Blob;
  mimeType: string;
  utStart: number;
  utEnd: number;
  utSamples: unknown[];
  byteSize: number;
  durationMs: number;
}
interface FakeGroupHandle {
  groupId: string;
  recordings: FakeHandle[];
  commonUtWindow: [number, number];
}

const fakeStore = vi.hoisted(() => {
  function nowMs(): number {
    return typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
  }

  class FakeRecordingsStore {
    private state: { recordings: FakeHandle[]; groups: FakeGroupHandle[]; active: FakeActive[] } = {
      recordings: [],
      groups: [],
      active: [],
    };
    private listeners = new Set<() => void>();
    private counter = 0;

    subscribe = (fn: () => void): (() => void) => {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    };
    getSnapshot = (): typeof this.state => this.state;

    private set(next: typeof this.state): void {
      this.state = next;
      for (const l of this.listeners) l();
    }

    private makeHandle(recordingId: string): FakeHandle {
      return {
        recordingId,
        blob: new Blob(["clip-data"], { type: "video/mp4" }),
        mimeType: "video/mp4",
        utStart: 100,
        utEnd: 110,
        utSamples: [],
        byteSize: 9,
        durationMs: 10_000,
      };
    }

    isRecording(flightId: number): boolean {
      return this.state.active.some((a) => a.flightId === flightId);
    }

    start(flightId: number): string {
      const id = `rec-${++this.counter}`;
      this.set({
        ...this.state,
        active: [...this.state.active, { recordingId: id, flightId, startedAt: nowMs() }],
      });
      return id;
    }

    async stop(recordingId: string): Promise<FakeHandle> {
      const handle = this.makeHandle(recordingId);
      this.set({
        active: this.state.active.filter((a) => a.recordingId !== recordingId),
        recordings: [...this.state.recordings, handle],
        groups: this.state.groups,
      });
      return handle;
    }

    startGroup(flightIds: number[]): string {
      const groupId = `grp-${++this.counter}`;
      const active = flightIds.map((flightId) => ({
        recordingId: `rec-${++this.counter}`,
        flightId,
        startedAt: nowMs(),
        groupId,
      }));
      this.set({ ...this.state, active: [...this.state.active, ...active] });
      return groupId;
    }

    async stopGroup(groupId: string): Promise<FakeGroupHandle> {
      const members = this.state.active.filter((a) => a.groupId === groupId);
      const recordings = members.map((m) => this.makeHandle(m.recordingId));
      const handle: FakeGroupHandle = { groupId, recordings, commonUtWindow: [100, 110] };
      this.set({
        active: this.state.active.filter((a) => a.groupId !== groupId),
        recordings: this.state.recordings,
        groups: [...this.state.groups, handle],
      });
      return handle;
    }

    discard(recordingId: string): void {
      this.set({ ...this.state, recordings: this.state.recordings.filter((r) => r.recordingId !== recordingId) });
    }

    discardGroup(groupId: string): void {
      this.set({ ...this.state, groups: this.state.groups.filter((g) => g.groupId !== groupId) });
    }

    reset(): void {
      this.state = { recordings: [], groups: [], active: [] };
      this.listeners.clear();
      this.counter = 0;
    }
  }

  return new FakeRecordingsStore();
});

/*
 * Mock the ONE underlying hook module by its resolved file path, not the
 * "@ksp-gonogo/kerbcast-react" package barrel. CameraFeed and RecordingsTray
 * (both inside kerbcast-react) import `useRecordings` via their own relative
 * "./hooks/useRecordings" path, which a package-specifier mock never reaches
 * -- ES module resolution keys mocks off the resolved module, and a barrel
 * re-export only forwards whatever this module actually exports. Mocking
 * here means the barrel (consumed by Header/RecGroupBar/RecordingsPanel/App
 * via the package specifier) re-exports the SAME fake automatically, so
 * every consumer -- inside kerbcast-react or in this app -- shares one store.
 */
vi.mock("../../client-sdk/react/src/hooks/useRecordings", async () => {
  const { useSyncExternalStore } = await import("react");

  function useRecordings() {
    const snapshot = useSyncExternalStore(fakeStore.subscribe, fakeStore.getSnapshot);
    return {
      recordings: snapshot.recordings,
      groups: snapshot.groups,
      active: snapshot.active,
      isRecording: (flightId: number) => fakeStore.isRecording(flightId),
      start: (flightId: number) => fakeStore.start(flightId),
      stop: (id: string) => fakeStore.stop(id),
      startGroup: (flightIds: number[]) => fakeStore.startGroup(flightIds),
      stopGroup: (groupId: string) => fakeStore.stopGroup(groupId),
      discard: (id: string) => fakeStore.discard(id),
      discardGroup: (id: string) => fakeStore.discardGroup(id),
    };
  }

  return { useRecordings };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCamera(overrides: MockCameraInit): MockCameraInit {
  return {
    lifecycle: "active" as CameraLifecycle,
    partName: "mumech.MuMechModuleHullCamera",
    partTitle: "Hullcam Mk1",
    cameraName: "Camera",
    vesselName: "Kerbal X",
    layers: [Layer.Near, Layer.Scaled],
    operatorLayers: [Layer.Near, Layer.Scaled],
    renderWidth: 640,
    renderHeight: 360,
    operatorWidth: 640,
    operatorHeight: 360,
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

const createdClients: KerbcastClient[] = [];

async function renderAppWithCameras(cameras: MockCameraInit[]) {
  const sidecar = new MockSidecar();
  sidecar.withSlots(["0", "1", "2", "3"]);
  for (const cam of cameras) sidecar.addCamera(cam);

  const client = new KerbcastClient(
    { host: "h", port: 1, negotiate: (o) => sidecar.negotiate(o) },
    sidecar.createTransport(),
  );
  createdClients.push(client);

  await act(async () => {
    render(<App client={client} />);
  });
  await act(async () => {
    sidecar.open();
    sidecar.setConnectionState("connected");
  });

  return { client, sidecar };
}

afterEach(() => {
  cleanup();
  fakeStore.reset();
  for (const c of createdClients) {
    try { c.disconnect(); } catch { /* ignore */ }
  }
  createdClients.length = 0;
  vi.restoreAllMocks();
  localStorage.clear();
});

// ---------------------------------------------------------------------------
// Single-feed REC -> tray -> discard
// ---------------------------------------------------------------------------

describe("recording flow - single feed", () => {
  it("start REC -> stop -> the clip lands in the tray -> discard clears it", async () => {
    await renderAppWithCameras([makeCamera({ flightId: 1, cameraName: "Alpha" })]);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /remove tile 1/i })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /stop recording/i })).toBeTruthy();
    });
    // The tile shows its own REC-active dot while recording.
    expect(screen.getByLabelText("Recording")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /stop recording/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /start recording/i })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /^recordings$/i }));
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: /recordings/i })).toBeTruthy();
    });
    expect(screen.queryByText(/no recordings yet/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^discard$/i }));
    await waitFor(() => {
      expect(screen.getByText(/no recordings yet/i)).toBeTruthy();
    });
  });
});

// ---------------------------------------------------------------------------
// REC+ grouped selection -> start -> stop -> a grouped set in the tray
// ---------------------------------------------------------------------------

describe("recording flow - REC+ grouped", () => {
  it("selects two feeds, starts a grouped recording, and lands a grouped set in the tray", async () => {
    await renderAppWithCameras([
      makeCamera({ flightId: 1, cameraName: "Alpha" }),
      makeCamera({ flightId: 2, cameraName: "Bravo" }),
    ]);

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: /remove tile/i })).toHaveLength(2);
    });

    fireEvent.click(screen.getByRole("button", { name: /rec\+/i }));

    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(2);
    fireEvent.click(checkboxes[0]);
    fireEvent.click(checkboxes[1]);

    fireEvent.click(screen.getByRole("button", { name: /start grouped recording/i }));

    await waitFor(() => {
      expect(screen.getByText(/recording 2 feeds/i)).toBeTruthy();
    });
    // Selection checkboxes are gone (the set is fixed); both tiles show the
    // shared store's REC-active dot instead.
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.getAllByLabelText("Recording")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: /stop grouped recording/i }));
    await waitFor(() => {
      expect(screen.queryByText(/recording 2 feeds/i)).toBeNull();
    });

    fireEvent.click(screen.getByRole("button", { name: /^recordings$/i }));
    await waitFor(() => {
      expect(screen.getByText(/grouped recording/i)).toBeTruthy();
    });
    expect(screen.getByText(/2 feeds/i)).toBeTruthy();
  });

  it("Cancel exits selection mode without starting any recording", async () => {
    await renderAppWithCameras([
      makeCamera({ flightId: 1, cameraName: "Alpha" }),
      makeCamera({ flightId: 2, cameraName: "Bravo" }),
    ]);
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: /remove tile/i })).toHaveLength(2);
    });

    fireEvent.click(screen.getByRole("button", { name: /rec\+/i }));
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.queryByText(/recording \d feeds/i)).toBeNull();
    expect(screen.queryAllByLabelText("Recording")).toHaveLength(0);
  });
});
