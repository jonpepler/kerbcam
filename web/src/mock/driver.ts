/**
 * Mock driver for dev/browser review.
 *
 * Loaded dynamically only when location.search contains mock=1.
 * Never imported statically from the app entry.
 *
 * Creates a KerbcastClient backed by MockSidecar. Registers 4 plausible
 * cameras and delivers animated canvas captureStream tracks to each slot.
 *
 * One camera starts destroyed to demonstrate SIGNAL LOST.
 * /profile fetch is intercepted to return plausible stagger numbers.
 */

import { CameraKind, CameraLifecycle, CrewLocation, KerbcastClient } from "@ksp-gonogo/kerbcast";
import type { MockCameraInit } from "@ksp-gonogo/kerbcast/testing";
import { MockSidecar } from "@ksp-gonogo/kerbcast/testing";
import { loadLocalMediabunnyTrimmer } from "../mediabunnyAsset";

const MOCK_CAMERAS: MockCameraInit[] = [
  {
    flightId: 101,
    cameraName: "NavCam",
    vesselName: "Kerbal X",
    partName: "mumech.MuMechModuleHullCamera",
    partTitle: "NavCam",
    lifecycle: CameraLifecycle.Active,
    supportsPan: true,
    panYawMin: -45,
    panYawMax: 45,
    panPitchMin: -30,
    panPitchMax: 30,
    supportsZoom: true,
    fov: 60,
    fovMin: 15,
    fovMax: 90,
    renderWidth: 1280,
    renderHeight: 720,
    operatorWidth: 1280,
    operatorHeight: 720,
    encoderBitrateBps: 2_000_000,
  },
  {
    flightId: 102,
    cameraName: "Booster Cam",
    vesselName: "Kerbal X",
    partName: "mumech.MuMechModuleHullCamera",
    partTitle: "Booster Cam",
    lifecycle: CameraLifecycle.Active,
    supportsZoom: false,
    supportsPan: false,
    renderWidth: 1280,
    renderHeight: 720,
    operatorWidth: 1280,
    operatorHeight: 720,
    encoderBitrateBps: 1_500_000,
  },
  {
    flightId: 103,
    cameraName: "NavCam",
    vesselName: "Kerbal X",
    partName: "mumech.MuMechModuleHullCamera",
    partTitle: "Clamp-O-Tron Docking Port Jr.",
    lifecycle: CameraLifecycle.Active,
    supportsZoom: false,
    supportsPan: false,
    renderWidth: 1280,
    renderHeight: 720,
    operatorWidth: 1280,
    operatorHeight: 720,
    encoderBitrateBps: 1_200_000,
  },
  {
    flightId: 104,
    cameraName: "Launchpad West",
    vesselName: "Ground",
    partName: "mumech.MuMechModuleHullCamera",
    partTitle: "Launchpad Camera",
    lifecycle: CameraLifecycle.Destroyed,
    supportsZoom: false,
    supportsPan: false,
    renderWidth: 0,
    renderHeight: 0,
    operatorWidth: 0,
    operatorHeight: 0,
    encoderBitrateBps: 0,
  },
  // Kerbal face cameras (square, no pan/zoom). Kerbal wire-ids are name-hashed
  // with the top bit set on the plugin side; the exact values are arbitrary in
  // the mock — the crew bar distinguishes them by `kind: "kerbal"`. Seated crew
  // report crewLocation "seat"; Val is on EVA; one kerbal is destroyed to
  // exercise SIGNAL LOST in the crew bar.
  {
    flightId: 2_147_483_701,
    kind: CameraKind.Kerbal,
    crewLocation: CrewLocation.Seat,
    kerbalPersistentId: 2854682590,
    cameraName: "Jebediah Kerman",
    vesselName: "Kerbal X",
    partName: "",
    partTitle: "",
    lifecycle: CameraLifecycle.Active,
    supportsZoom: false,
    supportsPan: false,
    renderWidth: 360,
    renderHeight: 360,
    operatorWidth: 512,
    operatorHeight: 512,
    encoderBitrateBps: 700_000,
  },
  {
    flightId: 2_147_483_702,
    kind: CameraKind.Kerbal,
    crewLocation: CrewLocation.Seat,
    kerbalPersistentId: 1904857326,
    cameraName: "Bill Kerman",
    vesselName: "Kerbal X",
    partName: "",
    partTitle: "",
    lifecycle: CameraLifecycle.Active,
    supportsZoom: false,
    supportsPan: false,
    renderWidth: 360,
    renderHeight: 360,
    operatorWidth: 512,
    operatorHeight: 512,
    encoderBitrateBps: 680_000,
  },
  {
    flightId: 2_147_483_703,
    kind: CameraKind.Kerbal,
    crewLocation: CrewLocation.Seat,
    kerbalPersistentId: 771203944,
    cameraName: "Bob Kerman",
    vesselName: "Kerbal X",
    partName: "",
    partTitle: "",
    lifecycle: CameraLifecycle.Active,
    supportsZoom: false,
    supportsPan: false,
    renderWidth: 360,
    renderHeight: 360,
    operatorWidth: 512,
    operatorHeight: 512,
    encoderBitrateBps: 690_000,
  },
  {
    flightId: 2_147_483_704,
    kind: CameraKind.Kerbal,
    crewLocation: CrewLocation.Eva,
    kerbalPersistentId: 2235898073,
    cameraName: "Valentina Kerman",
    vesselName: "Valentina Kerman (EVA)",
    partName: "",
    partTitle: "",
    lifecycle: CameraLifecycle.Active,
    supportsZoom: false,
    supportsPan: false,
    renderWidth: 360,
    renderHeight: 360,
    operatorWidth: 512,
    operatorHeight: 512,
    encoderBitrateBps: 720_000,
  },
  {
    flightId: 2_147_483_705,
    kind: CameraKind.Kerbal,
    crewLocation: CrewLocation.Seat,
    kerbalPersistentId: 448921077,
    cameraName: "Kirrim Kerman",
    vesselName: "Kerbal X",
    partName: "",
    partTitle: "",
    lifecycle: CameraLifecycle.Destroyed,
    supportsZoom: false,
    supportsPan: false,
    renderWidth: 0,
    renderHeight: 0,
    operatorWidth: 512,
    operatorHeight: 512,
    encoderBitrateBps: 0,
  },
];

/** HSL hue for each camera's test pattern (part cams then kerbal faces). */
const CAMERA_HUES = [210, 30, 140, 0, 265, 320, 95, 45, 175];

/**
 * Create a KerbcastClient backed by a MockSidecar.
 *
 * The app's ConnectionManager owns connect(); the mock completes its half
 * of the handshake from inside the negotiate override so it survives the
 * manager's own connect/reconnect cycles (a pre-connected client would be
 * torn down by the manager's first connect()).
 */
export async function createMockClient(): Promise<KerbcastClient> {
  const sidecar = new MockSidecar();
  sidecar.withSlots(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"]);

  for (const cam of MOCK_CAMERAS) {
    sidecar.addCamera(cam);
  }

  /*
   * Canvas tracks are built once per camera (keyed by flightId, drawing that
   * camera's own name/hue) and reused across reconnects; the canvases keep
   * animating regardless of connection state.
   *
   * Delivery follows the actual SUBSCRIPTION, not array order: the app decides
   * which cameras to subscribe (crew bar + grid, in its own order), the mock
   * binds each to a free slot, and onSubscribe fires (flightId, mid) so we
   * deliver THAT camera's track to THAT slot. Delivering by array index instead
   * crossed the feeds once the subscribed set stopped matching array order.
   */
  const tracks = new Map<number, MediaStreamTrack>();
  const trackFor = (flightId: number): MediaStreamTrack | undefined => {
    const existing = tracks.get(flightId);
    if (existing) return existing;
    const i = MOCK_CAMERAS.findIndex((c) => c.flightId === flightId);
    if (i < 0) return undefined;
    const cam = MOCK_CAMERAS[i];
    // Destroyed cams have no live track (the UI shows SIGNAL LOST).
    if ((cam.lifecycle ?? CameraLifecycle.Active) === CameraLifecycle.Destroyed) return undefined;
    // Kerbal face cams render SQUARE; part cams stay 16:9.
    const square = cam.kind === CameraKind.Kerbal;
    const track = buildCanvasTrack(cam.cameraName ?? "Camera", CAMERA_HUES[i] ?? 0, square ? 360 : 640, 360);
    tracks.set(flightId, track);
    return track;
  };

  // Registered before connect: fires for every subscribe (incl. re-subscribe
  // after a reconnect), so a camera's track always lands on its bound slot.
  sidecar.onSubscribe((flightId, mid) => {
    const track = trackFor(flightId);
    if (track) sidecar.deliverTrack(mid, track);
  });

  const mockClient = new KerbcastClient(
    {
      host: "mock",
      port: 0,
      recording: { loadTrimmer: loadLocalMediabunnyTrimmer },
      negotiate: async (offer) => {
        const answer = await sidecar.negotiate(offer);
        /*
         * Finish the sidecar's half once connect() has applied the answer:
         * open the control channel, report connected, hand over tracks.
         */
        setTimeout(() => {
          sidecar.open();
          sidecar.setConnectionState("connected");
          // Tracks are delivered per-subscription via the onSubscribe handler
          // above, so there's nothing to push eagerly here.
        }, 50);
        return answer;
      },
    },
    sidecar.createTransport(),
  );

  // Intercept /profile before the app's DevPanel starts polling
  interceptProfileFetch();

  /*
   * Record -> replay dev hook. Closes the loop the recording SDK opens: a
   * recorded Blob (client.recording.stopRecording(...).blob) is turned back
   * into a live track and delivered onto that camera's slot, so ?mock=1 can
   * exercise capture-then-play-back without a real sidecar. deliverTrack is
   * the existing replay half; buildReplayTrack is the Blob -> <video> ->
   * captureStream front half. Exposed on window for manual/dev use and the
   * (deferred) recordings-tray inline preview.
   */
  const replayTracks = new Map<number, MediaStreamTrack>();
  (globalThis as unknown as { __kerbcastMockReplay?: unknown }).__kerbcastMockReplay = (
    flightId: number,
    blob: Blob,
  ): boolean => {
    const mid = sidecar.slotMidFor(flightId);
    if (!mid) return false;
    /* Stop this slot's previous replay track (if any) before swapping in the
       new one: that fires the old track's "ended", which is what revokes its
       object URL (see buildReplayTrack). Without this, replaying a second
       clip onto the same camera would abandon the first blob URL forever. */
    replayTracks.get(flightId)?.stop();
    const track = buildReplayTrack(blob);
    replayTracks.set(flightId, track);
    sidecar.deliverTrack(mid, track);
    return true;
  };

  // Periodic state variation
  setInterval(() => {
    const variation = 0.8 + Math.random() * 0.4;
    sidecar.updateCamera(101, {
      encoderBitrateBps: Math.round(2_000_000 * variation),
    });
  }, 3000);

  // Periodic pings (keeps the watchdog alive in mock mode)
  setInterval(() => {
    sidecar.firePing();
  }, 5000);

  return mockClient;
}

// ---------------------------------------------------------------------------
// Animated canvas track
// ---------------------------------------------------------------------------

function buildCanvasTrack(label: string, hue: number, width = 640, height = 360): MediaStreamTrack {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");

  let frame = 0;
  setInterval(() => {
    if (!ctx) return;
    frame = (frame + 1) % 360;
    const t = frame / 360;

    // Background gradient sweep
    ctx.fillStyle = `hsl(${hue}, 60%, ${15 + t * 10}%)`;
    ctx.fillRect(0, 0, width, height);

    // Moving brightness bar
    const barY = Math.round(t * height);
    ctx.fillStyle = `hsl(${hue}, 80%, 70%)`;
    ctx.fillRect(0, barY, width, 8);

    // Camera label
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 24px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, width / 2, height / 2);
  }, 1000 / 24);

  // captureStream is stubbed by installDomStubs in test environments
  // and real in a browser; return the first video track.
  type HasCaptureStream = HTMLCanvasElement & { captureStream(fps?: number): MediaStream };
  const stream = (canvas as HasCaptureStream).captureStream(24);
  const track = stream.getVideoTracks()[0];
  if (!track) throw new Error("captureStream returned no video tracks");
  return track;
}

// ---------------------------------------------------------------------------
// Record -> replay: Blob back to a live track
// ---------------------------------------------------------------------------

/**
 * Turn a recorded Blob back into a live MediaStreamTrack: object-URL it onto a
 * looping muted <video>, then captureStream() the element. The returned track
 * is what {@link MockSidecar.deliverTrack} feeds onto a slot to replay a clip.
 * Browser-only (needs real HTMLMediaElement.captureStream).
 */
export function buildReplayTrack(blob: Blob): MediaStreamTrack {
  const url = URL.createObjectURL(blob);
  const video = document.createElement("video");
  video.src = url;
  video.loop = true;
  video.muted = true;
  video.autoplay = true;
  void video.play().catch(() => {});

  type HasCaptureStream = HTMLVideoElement & { captureStream(): MediaStream };
  const stream = (video as HasCaptureStream).captureStream();
  const track = stream.getVideoTracks()[0];
  if (!track) throw new Error("replay captureStream returned no video tracks");
  /* Free the object URL once the TRACK is torn down (its own "ended", fired by
     track.stop()), not the <video> element's "ended" -- video.loop means
     playback never reaches that event, so the URL would otherwise leak for as
     long as the tab stays open. */
  track.addEventListener("ended", () => URL.revokeObjectURL(url), { once: true });
  return track;
}

// ---------------------------------------------------------------------------
// /profile intercept (fetch wrapper for this URL only)
// ---------------------------------------------------------------------------

function interceptProfileFetch(): void {
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;

    if (url === "/profile" || url.endsWith("/profile")) {
      const data = {
        staggerBudget: 3 + Math.floor(Math.random() * 3),
        kerbcastFrameMs: 0.1 + Math.random() * 0.2,
        kspFps: 55 + Math.random() * 10,
      };
      return Promise.resolve(
        new Response(JSON.stringify(data), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return original(input, init);
  };
}
