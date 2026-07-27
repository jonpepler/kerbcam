import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CameraLifecycle, Layer, TrackMode } from "./__generated__/types";
import { KerbcastClient } from "./index";
import { MockSidecar } from "./testing/index";

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    Promise.resolve(MockSidecar.makeOfferResponse([42])),
  );
});

describe("MockSidecar", () => {
  it("cameras populate on open()", async () => {
    const sidecar = new MockSidecar();
    sidecar.addCamera({ flightId: 42 });

    const client = new KerbcastClient(
      { host: "localhost", port: 8088 },
      sidecar.createTransport(),
    );

    const cameraEvents: unknown[] = [];
    client.on("cameras-change", (cams) => cameraEvents.push(cams));

    await client.connect([42]);
    sidecar.open();

    expect(client.cameras).toHaveLength(1);
    expect(client.cameras[0].flightId).toBe(42);
    expect(cameraEvents).toHaveLength(1);
  });

  it("client sends hello on open()", async () => {
    const sidecar = new MockSidecar();
    sidecar.addCamera({ flightId: 42 });

    const client = new KerbcastClient(
      { host: "localhost", port: 8088 },
      sidecar.createTransport(),
    );
    await client.connect([42]);
    sidecar.open();

    expect(sidecar.lastCommand("hello")).toBeDefined();
  });

  it("destroyCamera sends Destroyed lifecycle to client", async () => {
    const sidecar = new MockSidecar();
    sidecar.addCamera({ flightId: 42 });

    const client = new KerbcastClient(
      { host: "localhost", port: 8088 },
      sidecar.createTransport(),
    );
    await client.connect([42]);
    sidecar.open();

    const cam = client.camera(42);
    const changes: unknown[] = [];
    cam.on("change", (s) => changes.push(s));

    sidecar.destroyCamera(42);

    expect(cam.state?.lifecycle).toBe(CameraLifecycle.Destroyed);
    expect(changes).toHaveLength(1);
  });

  it("firePing causes client to respond with pong", async () => {
    const sidecar = new MockSidecar();
    sidecar.addCamera({ flightId: 42 });

    const client = new KerbcastClient(
      { host: "localhost", port: 8088 },
      sidecar.createTransport(),
    );
    await client.connect([42]);
    sidecar.open();

    const cmdsBefore = sidecar.commands.length;
    sidecar.firePing();

    expect(sidecar.commands.length).toBe(cmdsBefore + 1);
    expect(sidecar.lastCommand("pong")).toBeDefined();
  });

  it("ping event fires on the client when sidecar sends ping", async () => {
    const sidecar = new MockSidecar();
    sidecar.addCamera({ flightId: 42 });

    const client = new KerbcastClient(
      { host: "localhost", port: 8088 },
      sidecar.createTransport(),
    );
    await client.connect([42]);
    sidecar.open();

    let pingFired = false;
    client.on("ping", () => { pingFired = true; });

    sidecar.firePing();

    expect(pingFired).toBe(true);
  });

  it("lastCommand filters by flightId", async () => {
    const sidecar = new MockSidecar();
    sidecar.addCamera({ flightId: 42 });

    const client = new KerbcastClient(
      { host: "localhost", port: 8088 },
      sidecar.createTransport(),
    );
    await client.connect([42]);
    sidecar.open();

    const cam = client.camera(42);
    await cam.setFov(35);
    await cam.setFov(60);

    const last = sidecar.lastCommand("set-fov", 42);
    expect(last?.content.fov).toBe(60);
  });

  it("accepts and records report-display-size as an advisory command", async () => {
    const sidecar = new MockSidecar();
    sidecar.addCamera({ flightId: 42 });

    const client = new KerbcastClient(
      { host: "localhost", port: 8088 },
      sidecar.createTransport(),
    );
    await client.connect([42]);
    sidecar.open();

    // Must not throw on the new message type, and must be retrievable.
    await client.reportDisplaySize(42, 40, 40);

    const cmd = sidecar.lastCommand("report-display-size", 42);
    expect(cmd?.content).toEqual({ flightId: 42, width: 40, height: 40 });
    // Advisory: reporting a display size must NOT be translated into an
    // operator set-render-size command (that path is the manual cap only).
    expect(sidecar.commands.some((c) => c.type === "set-render-size")).toBe(false);
  });

  it("set-track-target updates trackMode and echoes it to the client (server-authoritative)", async () => {
    const sidecar = new MockSidecar();
    sidecar.addCamera({ flightId: 7, supportsPan: true, supportsZoom: true });

    const client = new KerbcastClient(
      { host: "localhost", port: 8088 },
      sidecar.createTransport(),
    );
    await client.connect([7]);
    sidecar.open();

    await client.setTrackTarget(7, TrackMode.Target);
    expect(sidecar.lastCommand("set-track-target", 7)?.content.mode).toBe(TrackMode.Target);
    // The mock echoes camera-state-changed so every client reflects the same
    // server-held mode (never optimistic-local).
    expect(client.cameras.find((c) => c.flightId === 7)?.trackMode).toBe(TrackMode.Target);

    await client.setTrackTarget(7, TrackMode.None);
    expect(client.cameras.find((c) => c.flightId === 7)?.trackMode).toBe(TrackMode.None);
  });

  it("updateCamera pushes state-change to the client", async () => {
    const sidecar = new MockSidecar();
    sidecar.addCamera({ flightId: 42, layers: [Layer.Near] });

    const client = new KerbcastClient(
      { host: "localhost", port: 8088 },
      sidecar.createTransport(),
    );
    await client.connect([42]);
    sidecar.open();

    sidecar.updateCamera(42, { layers: [Layer.Near, Layer.Scaled] });

    expect(client.cameras[0].layers).toEqual([Layer.Near, Layer.Scaled]);
  });

  it("setConnectionState drives client state-change events", async () => {
    const sidecar = new MockSidecar();
    const client = new KerbcastClient(
      { host: "localhost", port: 8088 },
      sidecar.createTransport(),
    );
    await client.connect();

    const states: string[] = [];
    client.on("state-change", (s) => states.push(s));

    sidecar.setConnectionState("connected");
    sidecar.setConnectionState("failed");

    expect(states).toEqual(["connected", "failed"]);
  });
});

describe("MockSidecar force-full-resolution", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("bumps render/operator size to the ceiling after a delay, then reverts on release", async () => {
    vi.useFakeTimers();
    const sidecar = new MockSidecar({ forceBumpDelayMs: 100 });
    sidecar.addCamera({
      flightId: 42,
      renderWidth: 640,
      renderHeight: 360,
      operatorWidth: 640,
      operatorHeight: 360,
      maxWidth: 1920,
      maxHeight: 1080,
    });

    const client = new KerbcastClient(
      { host: "localhost", port: 8088 },
      sidecar.createTransport(),
    );
    await client.connect([42]);
    sidecar.open();

    await client.camera(42).setForceFullResolution(true);
    // Not yet bumped: the delay hasn't elapsed.
    expect(client.camera(42).state?.operatorWidth).toBe(640);

    await vi.advanceTimersByTimeAsync(100);
    expect(client.camera(42).state).toMatchObject({
      renderWidth: 1920,
      renderHeight: 1080,
      operatorWidth: 1920,
      operatorHeight: 1080,
    });

    await client.camera(42).setForceFullResolution(false);
    expect(client.camera(42).state?.operatorWidth).toBe(1920); // not yet reverted

    await vi.advanceTimersByTimeAsync(100);
    expect(client.camera(42).state).toMatchObject({
      renderWidth: 640,
      renderHeight: 360,
      operatorWidth: 640,
      operatorHeight: 360,
    });
  });

  it("defaults the ceiling to the camera's initial operator size when maxWidth/maxHeight are omitted", async () => {
    vi.useFakeTimers();
    const sidecar = new MockSidecar({ forceBumpDelayMs: 10 });
    sidecar.addCamera({ flightId: 7, operatorWidth: 1280, operatorHeight: 720 });

    const client = new KerbcastClient(
      { host: "localhost", port: 8088 },
      sidecar.createTransport(),
    );
    await client.connect([7]);
    sidecar.open();

    await client.camera(7).setForceFullResolution(true);
    await vi.advanceTimersByTimeAsync(10);

    expect(client.camera(7).state).toMatchObject({
      renderWidth: 1280,
      renderHeight: 720,
      operatorWidth: 1280,
      operatorHeight: 720,
    });
  });

  it("cancels a pending bump when force is released before the delay elapses", async () => {
    vi.useFakeTimers();
    const sidecar = new MockSidecar({ forceBumpDelayMs: 100 });
    sidecar.addCamera({
      flightId: 42,
      operatorWidth: 640,
      operatorHeight: 360,
      maxWidth: 1920,
      maxHeight: 1080,
    });

    const client = new KerbcastClient(
      { host: "localhost", port: 8088 },
      sidecar.createTransport(),
    );
    await client.connect([42]);
    sidecar.open();

    await client.camera(42).setForceFullResolution(true);
    await vi.advanceTimersByTimeAsync(50);
    await client.camera(42).setForceFullResolution(false);
    await vi.advanceTimersByTimeAsync(200);

    // Never bumped, so nothing to revert: still the original size.
    expect(client.camera(42).state).toMatchObject({
      operatorWidth: 640,
      operatorHeight: 360,
    });
  });
});

describe("MockSidecar.discoveredCameras / client.discover()", () => {
  it("reports maxWidth/maxHeight from each camera's init", () => {
    const sidecar = new MockSidecar();
    sidecar.addCamera({
      flightId: 1,
      cameraName: "NavCam",
      operatorWidth: 1280,
      operatorHeight: 720,
      maxWidth: 1920,
      maxHeight: 1080,
    });
    sidecar.addCamera({ flightId: 2, operatorWidth: 640, operatorHeight: 360 });

    const discovered = sidecar.discoveredCameras();
    expect(discovered.find((c) => c.flightId === 1)).toMatchObject({
      maxWidth: 1920,
      maxHeight: 1080,
    });
    // No explicit ceiling: falls back to the camera's initial operator size.
    expect(discovered.find((c) => c.flightId === 2)).toMatchObject({
      maxWidth: 640,
      maxHeight: 360,
    });
  });

  it("populates client.camera(id).maxRenderSize via client.discover()", async () => {
    const sidecar = new MockSidecar();
    sidecar.addCamera({ flightId: 42, maxWidth: 1920, maxHeight: 1080 });

    const client = new KerbcastClient(
      { host: "localhost", port: 8088 },
      sidecar.createTransport(),
    );

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ cameras: sidecar.discoveredCameras() }), { status: 200 }),
    );

    await client.discover();
    expect(client.camera(42).maxRenderSize).toEqual({ width: 1920, height: 1080 });
  });
});
