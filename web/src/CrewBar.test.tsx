/**
 * Tests for the CrewBar (merge OFF) and the merge-ON grid path.
 *
 * CrewBar: renders the OPEN kerbal face cams (not part cams), with IVA/EVA
 * badges + SIGNAL LOST, reflows across placement modes, and drives the
 * open/close model (close a face -> onClose; the Add crew menu lists closed
 * kerbals -> onOpen). Merge ON: a kerbal cam flows through the regular Grid
 * tile path (CameraFeed hosts it), so it's not filtered out.
 *
 * Fixture mirrors Tile.test.tsx: a real KerbcastClient + MockSidecar through
 * KerbcastProvider so useKerbcastCameras() returns the live list.
 */

import { CameraKind, CrewLocation, KerbcastClient } from "@ksp-gonogo/kerbcast";
import type { CameraLifecycle } from "@ksp-gonogo/kerbcast";
import type { MockCameraInit } from "@ksp-gonogo/kerbcast/testing";
import { MockSidecar } from "@ksp-gonogo/kerbcast/testing";
import { KerbcastProvider } from "@ksp-gonogo/kerbcast-react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CrewBar } from "./CrewBar";
import { Grid } from "./Grid";
import type { CrewBarPlacement } from "./settings";

const createdClients: KerbcastClient[] = [];

async function buildConnectedFixture(cameras: MockCameraInit[]) {
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

interface CrewProps {
  placement?: CrewBarPlacement;
  minimised?: boolean;
  closed?: ReadonlySet<number>;
  onClose?: (id: number) => void;
  onOpen?: (id: number) => void;
  spotlight?: number | null;
  onToggleSpotlight?: (id: number) => void;
}

function renderCrewBar(client: KerbcastClient, props: CrewProps = {}) {
  return render(
    <KerbcastProvider client={client}>
      <CrewBar
        placement={props.placement ?? "row"}
        minimised={props.minimised ?? false}
        onToggleMinimise={() => {}}
        closed={props.closed ?? new Set()}
        onClose={props.onClose ?? (() => {})}
        onOpen={props.onOpen ?? (() => {})}
        spotlight={props.spotlight ?? null}
        onToggleSpotlight={props.onToggleSpotlight ?? (() => {})}
      />
    </KerbcastProvider>,
  );
}

const ROSTER: MockCameraInit[] = [
  { flightId: 101, cameraName: "NavCam", partName: "mumech.MuMechModuleHullCamera" },
  { flightId: 201, kind: CameraKind.Kerbal, crewLocation: CrewLocation.Seat, cameraName: "Jebediah Kerman" },
  { flightId: 202, kind: CameraKind.Kerbal, crewLocation: CrewLocation.Eva, cameraName: "Valentina Kerman" },
  {
    flightId: 203,
    kind: CameraKind.Kerbal,
    crewLocation: CrewLocation.Seat,
    cameraName: "Kirrim Kerman",
    lifecycle: "destroyed" as CameraLifecycle,
  },
];

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

describe("CrewBar", () => {
  it("renders open kerbal faces (not part cams), with IVA/EVA badges and SIGNAL LOST", async () => {
    const { client } = await buildConnectedFixture(ROSTER);

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = renderCrewBar(client));
    });

    expect(screen.getByText("Jebediah Kerman")).toBeTruthy();
    expect(screen.getByText("Valentina Kerman")).toBeTruthy();
    expect(screen.getByText("Kirrim Kerman")).toBeTruthy();
    expect(screen.queryByText("NavCam")).toBeNull();

    expect(container.querySelectorAll('[data-testid="crew-face"]').length).toBe(3);
    expect(screen.getAllByText("IVA").length).toBe(2);
    expect(screen.getAllByText("EVA").length).toBe(1);
    expect(screen.getByText(/signal lost/i)).toBeTruthy();
    expect(container.querySelector('[data-flight-id="203"]')?.getAttribute("data-destroyed")).toBe("true");
  });

  it("reflows across placement modes without changing the roster", async () => {
    const { client } = await buildConnectedFixture(ROSTER);
    for (const placement of ["row", "column"] as CrewBarPlacement[]) {
      let container!: HTMLElement;
      await act(async () => {
        ({ container } = renderCrewBar(client, { placement }));
      });
      expect(container.querySelector('[data-testid="crew-bar"]')?.getAttribute("data-placement")).toBe(placement);
      expect(container.querySelectorAll('[data-testid="crew-face"]').length).toBe(3);
      cleanup();
    }
  });

  it("closing a face calls onClose; a closed face is hidden and offered in Add crew", async () => {
    const { client } = await buildConnectedFixture(ROSTER);
    const onOpen = vi.fn();

    // Jeb (201) is closed: hidden from the faces, present in the Add crew menu.
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = renderCrewBar(client, { closed: new Set([201]), onOpen }));
    });

    // Only Val + Kirrim shown as faces; Jeb hidden.
    expect(container.querySelectorAll('[data-testid="crew-face"]').length).toBe(2);
    expect(container.querySelector('[data-flight-id="201"]')).toBeNull();

    // Add crew menu lists the closed Jeb; picking it re-opens (onOpen(201)).
    // The menu is a native <details>; open it directly (jsdom doesn't toggle on
    // a summary click reliably) then pick the item.
    expect(screen.getByText(/add crew/i)).toBeTruthy();
    await act(async () => { container.querySelector("details")?.setAttribute("open", ""); });
    const jebItem = screen.getByRole("button", { name: "Jebediah Kerman" });
    await act(async () => { fireEvent.click(jebItem); });
    expect(onOpen).toHaveBeenCalledWith(201);
  });

  it("close (x) on a face calls onClose with its flightId", async () => {
    const { client } = await buildConnectedFixture(ROSTER);
    const onClose = vi.fn();

    await act(async () => { renderCrewBar(client, { onClose }); });

    // Close is the shared FeedActionBar's pinned-trailing slot: always
    // visible, never swept behind the ⋮ overflow, so it's reachable directly.
    const closeButtons = screen.getAllByRole("button", { name: /^close$/i });
    await act(async () => { fireEvent.click(closeButtons[0]); });
    expect(onClose).toHaveBeenCalled();
  });

  it("renders the header (Add crew) when all crew are closed", async () => {
    const { client } = await buildConnectedFixture(ROSTER);
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = renderCrewBar(client, { closed: new Set([201, 202, 203]) }));
    });
    // Bar still present (so Add crew is reachable), but no faces.
    expect(container.querySelector('[data-testid="crew-bar"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-testid="crew-face"]').length).toBe(0);
    expect(screen.getByText(/add crew/i)).toBeTruthy();
  });

  it("offers visible spotlight / fullscreen / PiP / close controls per face, with no ⋮ overflow", async () => {
    const { client } = await buildConnectedFixture([
      { flightId: 201, kind: CameraKind.Kerbal, crewLocation: CrewLocation.Seat, cameraName: "Jebediah Kerman" },
    ]);
    await act(async () => { renderCrewBar(client); });

    // Spotlight is a stateful toggle (active !== undefined): primary/inline.
    // Close is the shared FeedActionBar's pinned-trailing slot: excluded from
    // the overflow-threshold count entirely, so it's directly visible too.
    // That leaves fullscreen/PiP (2 non-stateful, non-pinned) as the only
    // overflow-eligible set -- below the >=4-total threshold on their own --
    // so the row never crosses it and there is no ⋮ trigger at all.
    expect(screen.getByRole("button", { name: /spotlight this feed/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^fullscreen$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /picture in picture/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^close$/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^more actions$/i })).toBeNull();
  });

  it("clicking spotlight requests the toggle for that face's flightId", async () => {
    const { client } = await buildConnectedFixture([
      { flightId: 201, kind: CameraKind.Kerbal, crewLocation: CrewLocation.Seat, cameraName: "Jebediah Kerman" },
    ]);
    const onToggleSpotlight = vi.fn();
    await act(async () => { renderCrewBar(client, { onToggleSpotlight }); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /spotlight this feed/i })); });
    expect(onToggleSpotlight).toHaveBeenCalledWith(201);
  });

  it("spotlighting floats the face to FIRST and flips it in place (same node, no remount)", async () => {
    const { client } = await buildConnectedFixture([
      { flightId: 201, kind: CameraKind.Kerbal, crewLocation: CrewLocation.Seat, cameraName: "Jebediah Kerman" },
      { flightId: 202, kind: CameraKind.Kerbal, crewLocation: CrewLocation.Eva, cameraName: "Valentina Kerman" },
    ]);

    // Controlled: the App owns the spotlit id; drive it via the prop (rerender).
    const props = (spotlight: number | null) => (
      <KerbcastProvider client={client}>
        <CrewBar placement="column" minimised={false} onToggleMinimise={() => {}}
          closed={new Set()} onClose={() => {}} onOpen={() => {}}
          spotlight={spotlight} onToggleSpotlight={() => {}} />
      </KerbcastProvider>
    );

    let container!: HTMLElement;
    let rerender!: (ui: React.ReactElement) => void;
    await act(async () => { ({ container, rerender } = render(props(null))); });

    const val0 = container.querySelector('[data-flight-id="202"]');
    expect(val0?.getAttribute("data-spotlit")).toBe("false");
    // Natural order: Jeb (201) first, Val (202) second.
    let faces = [...container.querySelectorAll('[data-testid="crew-face"]')];
    expect(faces[0].getAttribute("data-flight-id")).toBe("201");

    // Spotlight Val: floats to FIRST, data-spotlit true, IDENTICAL DOM node.
    await act(async () => { rerender(props(202)); });
    const val1 = container.querySelector('[data-flight-id="202"]');
    expect(val1).toBe(val0); // moved by keyed reconciliation, not remounted
    expect(val1?.getAttribute("data-spotlit")).toBe("true");
    faces = [...container.querySelectorAll('[data-testid="crew-face"]')];
    expect(faces[0].getAttribute("data-flight-id")).toBe("202"); // floated first
  });

  it("never remounts a face across placement + minimise changes (same instance)", async () => {
    const { client } = await buildConnectedFixture([
      { flightId: 201, kind: CameraKind.Kerbal, crewLocation: CrewLocation.Seat, cameraName: "Jebediah Kerman" },
    ]);

    // ONE mounted CrewBar; rerender (not remount) with new props each step.
    const props = (placement: CrewBarPlacement, minimised: boolean) => (
      <KerbcastProvider client={client}>
        <CrewBar
          placement={placement}
          minimised={minimised}
          onToggleMinimise={() => {}}
          closed={new Set()}
          onClose={() => {}}
          onOpen={() => {}}
          spotlight={null}
          onToggleSpotlight={() => {}}
        />
      </KerbcastProvider>
    );

    let container!: HTMLElement;
    let rerender!: (ui: React.ReactElement) => void;
    await act(async () => { ({ container, rerender } = render(props("row", false))); });

    const face0 = container.querySelector('[data-flight-id="201"]');
    const video0 = container.querySelector("video");
    expect(face0).not.toBeNull();
    expect(video0).not.toBeNull();

    for (const [placement, minimised] of [["column", false], ["row", true], ["column", true], ["row", false]] as [CrewBarPlacement, boolean][]) {
      await act(async () => { rerender(props(placement, minimised)); });
      // The face + its <video> are the IDENTICAL DOM nodes — a CSS reflow, never
      // a remount. (The merge toggle IS an expected remount, tracked separately.)
      expect(container.querySelector('[data-flight-id="201"]')).toBe(face0);
      expect(container.querySelector("video")).toBe(video0);
    }
  });

  it("renders nothing when there are no kerbal cams", async () => {
    const { client } = await buildConnectedFixture([
      { flightId: 101, cameraName: "NavCam", partName: "mumech.MuMechModuleHullCamera" },
    ]);
    let container!: HTMLElement;
    await act(async () => { ({ container } = renderCrewBar(client)); });
    expect(container.querySelector('[data-testid="crew-bar"]')).toBeNull();
  });
});

describe("merge (crew in the regular grid)", () => {
  it("a kerbal cam renders as a grid tile via CameraFeed when merged", async () => {
    const { client } = await buildConnectedFixture([
      { flightId: 201, kind: CameraKind.Kerbal, crewLocation: CrewLocation.Seat, cameraName: "Jebediah Kerman" },
    ]);

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(
        <KerbcastProvider client={client}>
          <Grid
            mergeCrew={true}
            tiles={[{ flightId: 201, spotlit: false, key: null }]}
            onTilesChange={() => {}}
            showDebugInfo={false}
            showStatic={false}
            selectionMode={false}
            selectedFlightIds={new Set()}
            onToggleSelect={() => {}}
          />
        </KerbcastProvider>,
      ));
    });

    // CameraFeed hosts the kerbal cam (a <video> is mounted, not the
    // reconnecting placeholder) — it flows through the same tile path as parts.
    expect(container.querySelector("video")).not.toBeNull();
    expect(screen.queryByText(/camera reconnecting/i)).toBeNull();
  });

  it("a merged kerbal tile is spotlightable via the part-grid path", async () => {
    const { client } = await buildConnectedFixture([
      { flightId: 201, kind: CameraKind.Kerbal, crewLocation: CrewLocation.Seat, cameraName: "Jebediah Kerman" },
    ]);
    await act(async () => {
      render(
        <KerbcastProvider client={client}>
          <Grid
            mergeCrew={true}
            tiles={[{ flightId: 201, spotlit: false, key: null }]}
            onTilesChange={() => {}}
            showDebugInfo={false}
            showStatic={false}
            selectionMode={false}
            selectedFlightIds={new Set()}
            onToggleSelect={() => {}}
          />
        </KerbcastProvider>,
      );
    });
    // A merged kerbal is an ordinary tile, so it exposes the part-grid spotlight
    // control (2x2 span handled by the existing Grid mechanism, no crew path).
    expect(screen.getByRole("button", { name: /spotlight this feed/i })).toBeTruthy();
  });
});
