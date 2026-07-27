/**
 * Tests for the Tile's missing-camera ("reconnecting / gone") state.
 *
 * A tile keyed to a flightId that is no longer present in the live cameras
 * list (a fresh launch, a different craft, a destroyed vessel) must not mount a
 * dead CameraFeed. Instead it shows a reconnecting affordance with a way to
 * repoint or remove the tile.
 *
 * The fixture mirrors App.test.tsx: a real KerbcastClient + MockSidecar wired
 * through KerbcastProvider so useKerbcastCameras() returns the live list.
 */

import { KerbcastClient } from "@ksp-gonogo/kerbcast";
import type { CameraLifecycle } from "@ksp-gonogo/kerbcast";
import { CameraKind, CrewLocation, Layer } from "@ksp-gonogo/kerbcast";
import type { MockCameraInit } from "@ksp-gonogo/kerbcast/testing";
import { MockSidecar } from "@ksp-gonogo/kerbcast/testing";
import { KerbcastProvider } from "@ksp-gonogo/kerbcast-react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Tile } from "./Tile";

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

async function buildConnectedFixture(cameras: MockCameraInit[] = []) {
  const sidecar = new MockSidecar();
  sidecar.withSlots(["0", "1", "2", "3", "4", "5", "6", "7"]);
  for (const cam of cameras) sidecar.addCamera(cam);

  const client = new KerbcastClient(
    { host: "h", port: 1, negotiate: (o) => sidecar.negotiate(o) },
    sidecar.createTransport(),
  );
  createdClients.push(client);

  await act(async () => {
    await client.connect([], { slots: 8 });
  });
  await act(async () => {
    sidecar.open();
    sidecar.setConnectionState("connected");
  });

  return { client, sidecar };
}

function renderTile(
  client: KerbcastClient,
  flightId: number | null,
  opts: {
    mergeCrew?: boolean;
    onSelectCamera?: (id: number) => void;
    selectionMode?: boolean;
    selected?: boolean;
    onToggleSelect?: () => void;
  } = {},
) {
  return render(
    <KerbcastProvider client={client}>
      <Tile
        flightId={flightId}
        index={0}
        showDebugInfo={false}
        showStatic={false}
        spotlit={false}
        // Default true (no filter) so existing part-cam tests are unchanged.
        mergeCrew={opts.mergeCrew ?? true}
        onSelectCamera={opts.onSelectCamera ?? (() => {})}
        onRemove={() => {}}
        onToggleSpotlight={() => {}}
        selectionMode={opts.selectionMode ?? false}
        selected={opts.selected ?? false}
        onToggleSelect={opts.onToggleSelect ?? (() => {})}
      />
    </KerbcastProvider>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
  for (const c of createdClients) {
    try { c.disconnect(); } catch { /* ignore */ }
  }
  createdClients.length = 0;
  vi.restoreAllMocks();
});

describe("Tile - missing camera state", () => {
  it("shows a reconnecting affordance and no live feed when the camera is gone", async () => {
    // Live list has flightId 1; the tile is keyed to 2 (gone).
    const { client } = await buildConnectedFixture([
      makeCamera({ flightId: 1, cameraName: "Alpha" }),
    ]);

    let container: HTMLElement;
    await act(async () => {
      ({ container } = renderTile(client, 2));
    });

    // Reconnecting / gone affordance is shown.
    expect(screen.getByText(/camera reconnecting/i)).toBeTruthy();
    // A way to repoint/remove the tile is present.
    expect(screen.getByRole("button", { name: /remove tile/i })).toBeTruthy();
    // No live CameraFeed video element mounted.
    expect(container!.querySelector("video")).toBeNull();
  });

  it("renders the live feed when the camera is present", async () => {
    const { client } = await buildConnectedFixture([
      makeCamera({ flightId: 1, cameraName: "Alpha" }),
    ]);

    let container: HTMLElement;
    await act(async () => {
      ({ container } = renderTile(client, 1));
    });

    // The feed mounts (its video element is present); no reconnecting text.
    expect(container!.querySelector("video")).not.toBeNull();
    expect(screen.queryByText(/reconnecting|camera gone/i)).toBeNull();
  });
});

describe("Tile - camera picker excludes crew when merge is OFF", () => {
  const PART = () => makeCamera({ flightId: 1, cameraName: "NavCam", vesselName: "Kerbal X" });
  const KERBAL = () => makeCamera({
    flightId: 900,
    kind: CameraKind.Kerbal,
    crewLocation: CrewLocation.Seat,
    cameraName: "Jebediah Kerman",
    vesselName: "Kerbal X",
    partName: "",
    partTitle: "",
  });

  async function openMenu() {
    // The picker trigger is the button labelled with the currently-shown camera.
    const trigger = await screen.findByRole("button", { name: /navcam/i });
    await act(async () => { fireEvent.click(trigger); });
    return screen.getAllByRole("menuitemradio").map((i) => i.textContent ?? "");
  }

  it("merge OFF: the picker lists ONLY part cams, never crew", async () => {
    const { client } = await buildConnectedFixture([PART(), KERBAL()]);
    await act(async () => { renderTile(client, 1, { mergeCrew: false }); });

    const labels = await openMenu();
    expect(labels.some((l) => /navcam/i.test(l))).toBe(true);        // part offered
    expect(labels.some((l) => /jebediah/i.test(l))).toBe(false);     // crew NOT offered
  });

  it("merge ON: crew cams ARE offered (they're grid cams then)", async () => {
    const { client } = await buildConnectedFixture([PART(), KERBAL()]);
    await act(async () => { renderTile(client, 1, { mergeCrew: true }); });

    const labels = await openMenu();
    expect(labels.some((l) => /jebediah/i.test(l))).toBe(true);
  });

  it("merge OFF: picking a part option selects it (and doesn't drop an unrelated tile)", async () => {
    const onSelectCamera = vi.fn();
    // Two part cams so there's a second option to pick.
    const { client } = await buildConnectedFixture([
      PART(),
      makeCamera({ flightId: 2, cameraName: "BoosterCam", vesselName: "Kerbal X" }),
      KERBAL(),
    ]);
    await act(async () => { renderTile(client, 1, { mergeCrew: false, onSelectCamera }); });

    const trigger = await screen.findByRole("button", { name: /navcam/i });
    await act(async () => { fireEvent.click(trigger); });
    const booster = screen.getByRole("menuitemradio", { name: /boostercam/i });
    await act(async () => { fireEvent.click(booster); });
    expect(onSelectCamera).toHaveBeenCalledWith(2);
    // No crew option was ever selectable, so the "picking crew drops a tile"
    // side effect cannot occur.
    expect(screen.queryByRole("menuitemradio", { name: /jebediah/i })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// REC+ selection mode: checkbox overlay, additive only (never remounts the feed)
// ---------------------------------------------------------------------------

describe("Tile - REC+ selection mode", () => {
  it("shows no selection checkbox when selectionMode is off", async () => {
    const { client } = await buildConnectedFixture([
      makeCamera({ flightId: 1, cameraName: "Alpha" }),
    ]);
    await act(async () => { renderTile(client, 1); });

    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("shows an unchecked selection checkbox when selectionMode is on", async () => {
    const { client } = await buildConnectedFixture([
      makeCamera({ flightId: 1, cameraName: "Alpha" }),
    ]);
    await act(async () => { renderTile(client, 1, { selectionMode: true, selected: false }); });

    const cb = screen.getByRole("checkbox") as HTMLInputElement;
    expect(cb).toBeTruthy();
    expect(cb.getAttribute("aria-checked")).toBe("false");
  });

  it("reflects selected=true as aria-checked", async () => {
    const { client } = await buildConnectedFixture([
      makeCamera({ flightId: 1, cameraName: "Alpha" }),
    ]);
    await act(async () => { renderTile(client, 1, { selectionMode: true, selected: true }); });

    const cb = screen.getByRole("checkbox");
    expect(cb.getAttribute("aria-checked")).toBe("true");
  });

  it("clicking the checkbox calls onToggleSelect", async () => {
    const onToggleSelect = vi.fn();
    const { client } = await buildConnectedFixture([
      makeCamera({ flightId: 1, cameraName: "Alpha" }),
    ]);
    await act(async () => {
      renderTile(client, 1, { selectionMode: true, onToggleSelect });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("checkbox"));
    });
    expect(onToggleSelect).toHaveBeenCalledTimes(1);
  });

  it("offers no checkbox for an empty (flightId null) slot", async () => {
    const { client } = await buildConnectedFixture([]);
    await act(async () => { renderTile(client, null, { selectionMode: true }); });

    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("never remounts the live feed's video element when selection mode toggles", async () => {
    const { client } = await buildConnectedFixture([
      makeCamera({ flightId: 1, cameraName: "Alpha" }),
    ]);

    function Wrapped({ selectionMode }: { selectionMode: boolean }) {
      return (
        <KerbcastProvider client={client}>
          <Tile
            flightId={1}
            index={0}
            showDebugInfo={false}
            showStatic={false}
            spotlit={false}
            mergeCrew={true}
            onSelectCamera={() => {}}
            onRemove={() => {}}
            onToggleSpotlight={() => {}}
            selectionMode={selectionMode}
            selected={false}
            onToggleSelect={() => {}}
          />
        </KerbcastProvider>
      );
    }

    let r: ReturnType<typeof render>;
    await act(async () => { r = render(<Wrapped selectionMode={false} />); });
    const before = r!.container.querySelector("video");
    expect(before).not.toBeNull();

    await act(async () => { r!.rerender(<Wrapped selectionMode={true} />); });
    const after = r!.container.querySelector("video");

    expect(after).not.toBeNull();
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Per-feed REC control is always enabled on this page
// ---------------------------------------------------------------------------

describe("Tile - per-feed recording", () => {
  it("shows a REC control in the feed's action bar", async () => {
    const { client } = await buildConnectedFixture([
      makeCamera({ flightId: 1, cameraName: "Alpha" }),
    ]);
    await act(async () => { renderTile(client, 1); });

    expect(screen.getByRole("button", { name: /start recording/i })).toBeTruthy();
  });
});
