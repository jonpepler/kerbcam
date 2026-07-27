/**
 * Tests for RecordingsPanel: the header-toggled drawer wrapping the shared
 * RecordingsTray with this page's camera labels.
 */

import { KerbcastClient } from "@ksp-gonogo/kerbcast";
import type { MockCameraInit } from "@ksp-gonogo/kerbcast/testing";
import { MockSidecar } from "@ksp-gonogo/kerbcast/testing";
import { KerbcastProvider } from "@ksp-gonogo/kerbcast-react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecordingsPanel } from "./RecordingsPanel";

function makeCamera(overrides: MockCameraInit): MockCameraInit {
  return {
    lifecycle: "active" as never,
    partName: "mumech.MuMechModuleHullCamera",
    partTitle: "Hullcam Mk1",
    cameraName: "Camera",
    vesselName: "Kerbal X",
    renderWidth: 640,
    renderHeight: 360,
    operatorWidth: 640,
    operatorHeight: 360,
    supportsZoom: false,
    supportsPan: false,
    encoderBitrateBps: 1_500_000,
    ...overrides,
  };
}

async function buildConnectedFixture(cameras: MockCameraInit[] = []) {
  const sidecar = new MockSidecar();
  sidecar.withSlots(["0", "1", "2", "3"]);
  for (const cam of cameras) sidecar.addCamera(cam);

  const client = new KerbcastClient(
    { host: "h", port: 1, negotiate: (o) => sidecar.negotiate(o) },
    sidecar.createTransport(),
  );

  await act(async () => {
    await client.connect([], { slots: 4 });
  });
  await act(async () => {
    sidecar.open();
    sidecar.setConnectionState("connected");
  });

  return { client, sidecar };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("RecordingsPanel", () => {
  it("is a labelled dialog with a close button", async () => {
    const { client } = await buildConnectedFixture([]);
    const onClose = vi.fn();
    render(
      <KerbcastProvider client={client}>
        <RecordingsPanel onClose={onClose} />
      </KerbcastProvider>,
    );

    expect(screen.getByRole("dialog", { name: /recordings/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows the tray's empty state with no recordings", async () => {
    const { client } = await buildConnectedFixture([]);
    render(
      <KerbcastProvider client={client}>
        <RecordingsPanel onClose={() => {}} />
      </KerbcastProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText(/no recordings yet/i)).toBeTruthy();
    });
  });
});
