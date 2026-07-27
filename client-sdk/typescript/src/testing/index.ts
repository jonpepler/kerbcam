import type { AdaptiveShedPayload, CameraState, ClientMessage, ErrorPayload, ServerMessage, SettingsStatePayload } from "../__generated__/types";
import { CameraKind, CameraLifecycle, CrewLocation, ErrorSource, Layer, QualityPreset, TrackMode } from "../__generated__/types";
import type {
  DiscoveredCamera,
  InboundVideoStats,
  KerbcastConnectionState,
  KerbcastDataChannel,
  KerbcastPeer,
  KerbcastTransport,
} from "../client";

export interface MockCameraInit {
  flightId: number;
  lifecycle?: CameraLifecycle;
  /** Part vs kerbal face camera. Defaults to `part` when omitted, so existing
   *  part-cam callers are unchanged. */
  kind?: CameraKind;
  /** Only meaningful for `kind: Kerbal`: seated IVA portrait vs EVA view. */
  crewLocation?: CrewLocation;
  /** Only meaningful for `kind: Kerbal`: informational raw persistentID. */
  kerbalPersistentId?: number;
  partName?: string;
  partTitle?: string;
  cameraName?: string;
  vesselName?: string;
  layers?: Layer[];
  operatorLayers?: Layer[];
  renderWidth?: number;
  renderHeight?: number;
  operatorWidth?: number;
  operatorHeight?: number;
  supportsZoom?: boolean;
  fov?: number;
  fovMin?: number;
  fovMax?: number;
  supportsPan?: boolean;
  panYaw?: number;
  panPitch?: number;
  panYawMin?: number;
  panYawMax?: number;
  panPitchMin?: number;
  panPitchMax?: number;
  encoderBitrateBps?: number;
  targetBitrateBps?: number;
  degradeLevel?: number;
  viewerQuality?: QualityPreset;
  qualityLimitedBy?: string;
  /** Server-authoritative auto-track mode. Defaults to `None` (untracked). */
  trackMode?: TrackMode;
  /**
   * Physical/ceiling render size, served by the mock's `/cameras` discovery
   * intercept (`DiscoveredCamera.maxWidth`/`maxHeight`). Defaults to
   * `operatorWidth`/`operatorHeight` (i.e. already at ceiling) so a camera
   * that never sets these behaves as it always has. Give a camera a ceiling
   * above its initial `operatorWidth`/`operatorHeight` to demonstrate a
   * visible bump when `set-force-full-resolution` lands.
   */
  maxWidth?: number;
  maxHeight?: number;
}

function buildCamera(init: MockCameraInit): CameraState {
  return {
    flightId: init.flightId,
    lifecycle: init.lifecycle ?? CameraLifecycle.Active,
    kind: init.kind ?? CameraKind.Part,
    crewLocation: init.crewLocation,
    kerbalPersistentId: init.kerbalPersistentId,
    partName: init.partName ?? `part-${init.flightId}`,
    partTitle: init.partTitle ?? `Part ${init.flightId}`,
    cameraName: init.cameraName ?? `camera-${init.flightId}`,
    vesselName: init.vesselName ?? "Test Vessel",
    layers: init.layers ?? [Layer.Near],
    operatorLayers: init.operatorLayers ?? [Layer.Near],
    renderWidth: init.renderWidth ?? 1280,
    renderHeight: init.renderHeight ?? 720,
    operatorWidth: init.operatorWidth ?? 1280,
    operatorHeight: init.operatorHeight ?? 720,
    supportsZoom: init.supportsZoom ?? true,
    fov: init.fov ?? 60,
    fovMin: init.fovMin ?? 10,
    fovMax: init.fovMax ?? 120,
    supportsPan: init.supportsPan ?? false,
    panYaw: init.panYaw ?? 0,
    panPitch: init.panPitch ?? 0,
    panYawMin: init.panYawMin ?? -90,
    panYawMax: init.panYawMax ?? 90,
    panPitchMin: init.panPitchMin ?? -90,
    panPitchMax: init.panPitchMax ?? 90,
    encoderBitrateBps: init.encoderBitrateBps ?? 0,
    targetBitrateBps: init.targetBitrateBps ?? 0,
    degradeLevel: init.degradeLevel ?? 0,
    viewerQuality: init.viewerQuality,
    qualityLimitedBy: init.qualityLimitedBy,
    trackMode: init.trackMode ?? TrackMode.None,
  };
}

/** Fraction of the operator render size each preset targets (mirrors the
 *  sidecar's `QualityPreset::scale`). */
const QUALITY_PRESET_SCALE: Record<QualityPreset, number> = {
  [QualityPreset.Full]: 1.0,
  [QualityPreset.ThreeQuarter]: 0.75,
  [QualityPreset.Half]: 0.5,
  [QualityPreset.Quarter]: 0.25,
};

/** Scale + floor-to-even like the plugin's QualityClamp.ScaleDimension. */
function scaleDim(operatorDim: number, scale: number): number {
  const v = Math.trunc(operatorDim * scale) & ~1;
  return v < 2 ? 2 : v;
}

/** Options for {@link MockSidecar}'s constructor. */
export interface MockSidecarOptions {
  /**
   * Delay (ms) before a forced camera's simulated resolution bump lands,
   * once `set-force-full-resolution` (`force: true`) is received, and
   * before the render size reverts on `force: false`. Long enough that a
   * screenshot can catch the resulting "ARMING" state; short enough that
   * automated tests/waits don't feel slow. Defaults to 600ms.
   */
  forceBumpDelayMs?: number;
}

/**
 * In-process protocol-level fake for the kerbcast sidecar.
 *
 * Owns a camera registry and speaks the full kerbcast wire protocol.
 * Use it in tests to exercise `KerbcastClient` behaviour without a real
 * sidecar or WebRTC stack.
 *
 * ```ts
 * const sidecar = new MockSidecar();
 * sidecar.addCamera({ flightId: 42 });
 *
 * vi.spyOn(globalThis, "fetch").mockImplementation(() =>
 *   Promise.resolve(MockSidecar.makeOfferResponse([42]))
 * );
 *
 * const client = new KerbcastClient({ host: "localhost", port: 8088 }, sidecar.createTransport());
 * await client.connect([42]);
 * sidecar.open();   // fires hello + camera-snapshot
 *
 * expect(client.cameras[0].flightId).toBe(42);
 * ```
 */
export class MockSidecar {
  private readonly _cameras = new Map<number, CameraState>();
  private readonly _commands: ClientMessage[] = [];
  private _throttleMainScreen = false;
  private readonly _forceBumpDelayMs: number;
  /** Per-flight ceiling (ceiling render size), served by `discoveredCameras()`. */
  private readonly _maxRenderSizes = new Map<number, { maxWidth: number; maxHeight: number }>();
  /** Per-flight render size captured just before a force bump, restored on release. */
  private readonly _preForceSize = new Map<number, { width: number; height: number }>();
  /** Per-flight pending bump/revert timer, so a rapid force/unforce toggle cancels the stale one. */
  private readonly _forceTimers = new Map<number, ReturnType<typeof setTimeout>>();

  constructor(opts: MockSidecarOptions = {}) {
    this._forceBumpDelayMs = opts.forceBumpDelayMs ?? 600;
  }

  private _openHandler: (() => void) | undefined;
  private _clientMsgHandler: ((raw: string) => void) | undefined;
  private _stateHandler: ((s: KerbcastConnectionState) => void) | undefined;
  private _onTrackHandler:
    | ((track: MediaStreamTrack, idx: number, mid: string) => void)
    | undefined;
  private _subscribeHandler:
    | ((flightId: number, mid: string) => void)
    | undefined;
  private _trackIdx = 0;
  /** Slot mids available for the dynamic-subscription model. Override with
   *  {@link withSlots} before connecting if a test needs a specific pool. */
  private _slotMids: string[] = ["0", "1", "2", "3"];
  /** mid -> camera currently bound to that slot. */
  private readonly _slotBindings = new Map<string, number>();
  /**
   * Per-flight inbound stats to return from the fake getStats. Set via
   * {@link setInboundStats}. Keyed by flightId.
   */
  private readonly _inboundStats = new Map<number, Partial<InboundVideoStats>>();
  /**
   * Tracks delivered by {@link deliverTrack}, keyed by mid/idx string so
   * getStats can synthesize a trackIdentifier matching what the client saw.
   */
  private readonly _deliveredTracks = new Map<string, MediaStreamTrack>();

  /** Register a camera that will appear in the `camera-snapshot` sent on `open()`. */
  addCamera(init: MockCameraInit): void {
    const cam = buildCamera(init);
    this._cameras.set(init.flightId, cam);
    this._maxRenderSizes.set(init.flightId, {
      maxWidth: init.maxWidth ?? cam.operatorWidth,
      maxHeight: init.maxHeight ?? cam.operatorHeight,
    });
  }

  /**
   * The `DiscoveredCamera[]` the mock's `GET /cameras` intercept serves,
   * mirroring the real sidecar's discovery endpoint. `maxWidth`/`maxHeight`
   * come from each camera's `maxWidth`/`maxHeight` init (or its initial
   * `operatorWidth`/`operatorHeight` when omitted). Used by
   * `client.discover()` to populate `KerbcastCameraHandle.maxRenderSize`.
   */
  discoveredCameras(): DiscoveredCamera[] {
    return Array.from(this._cameras.values()).map((cam) => {
      const max = this._maxRenderSizes.get(cam.flightId);
      return {
        flightId: cam.flightId,
        lifecycle: cam.lifecycle,
        partName: cam.partName,
        partTitle: cam.partTitle,
        cameraName: cam.cameraName,
        vesselName: cam.vesselName,
        maxWidth: max?.maxWidth ?? cam.operatorWidth,
        maxHeight: max?.maxHeight ?? cam.operatorHeight,
        supportsZoom: cam.supportsZoom,
        fov: cam.fov,
        fovMin: cam.fovMin,
        fovMax: cam.fovMax,
        supportsPan: cam.supportsPan,
        panYawMin: cam.panYawMin,
        panYawMax: cam.panYawMax,
        panPitchMin: cam.panPitchMin,
        panPitchMax: cam.panPitchMax,
        encoderBitrateBps: cam.encoderBitrateBps,
        targetBitrateBps: cam.targetBitrateBps,
        degradeLevel: cam.degradeLevel,
      };
    });
  }

  /**
   * Returns a `KerbcastTransport` backed by this mock. Pass it as the
   * second argument to `KerbcastClient`.
   */
  createTransport(): KerbcastTransport {
    const self = this;
    return {
      createPeer(): KerbcastPeer {
        const channel: KerbcastDataChannel = {
          send(payload) {
            const msg = JSON.parse(payload) as ClientMessage;
            self._commands.push(msg);
            self._handleClientMessage(msg);
          },
          onOpen(h) {
            self._openHandler = h;
          },
          onMessage(h) {
            self._clientMsgHandler = h;
          },
          onClose() {},
        };
        return {
          addRecvOnlyTransceiver() {},
          createDataChannel: () => channel,
          onTrack(h) {
            self._onTrackHandler = h;
          },
          onStateChange(h) {
            self._stateHandler = h;
          },
          createOffer: async () => "v=0\r\n",
          setLocalDescription: async () => {},
          setRemoteAnswer: async () => {},
          waitForIceComplete: async () => {},
          localSdp: () => "v=0\r\n",
          close() {},
          getStats: async () => self._buildStatsReport(),
        };
      },
    };
  }

  /**
   * Simulate the sidecar completing the WebRTC handshake. Fires the
   * channel `onOpen` handler (which triggers the client's `hello`), then
   * responds with `hello` + `camera-snapshot`.
   */
  open(): void {
    this._openHandler?.();
    this._sendToClient({ type: "hello", content: { sidecarVersion: "0.0.1-mock", encoderBackend: "mock" } });
    this._sendToClient({ type: "camera-snapshot", content: { cameras: Array.from(this._cameras.values()) } });
    this._sendToClient({ type: "settings-state", content: { throttleMainScreen: this._throttleMainScreen } });
  }

  /** Drive the underlying peer's connection-state handler. */
  setConnectionState(state: KerbcastConnectionState): void {
    this._stateHandler?.(state);
  }

  /**
   * Mark a camera as destroyed and push a `camera-state-changed` message
   * to the client. The camera stays in the internal registry with
   * `lifecycle: Destroyed`.
   */
  destroyCamera(flightId: number): void {
    const cam = this._cameras.get(flightId);
    if (!cam) return;
    const destroyed: CameraState = { ...cam, lifecycle: CameraLifecycle.Destroyed };
    this._cameras.set(flightId, destroyed);
    this._sendToClient({ type: "camera-state-changed", content: { state: destroyed } });
  }

  /**
   * Apply a partial update to an existing camera and push a
   * `camera-state-changed` message to the client.
   */
  updateCamera(flightId: number, partial: Partial<CameraState>): void {
    const cam = this._cameras.get(flightId);
    if (!cam) return;
    const updated: CameraState = { ...cam, ...partial };
    this._cameras.set(flightId, updated);
    this._sendToClient({ type: "camera-state-changed", content: { state: updated } });
  }

  /**
   * Replace the entire camera registry and push a fresh `camera-snapshot` to
   * the client. Models a vessel change / scene switch where the set of
   * available cameras changes (cameras appear or disappear) — distinct from
   * {@link destroyCamera}, which keeps the camera present but `Destroyed`.
   */
  setCameras(inits: MockCameraInit[]): void {
    for (const timer of this._forceTimers.values()) clearTimeout(timer);
    this._forceTimers.clear();
    this._preForceSize.clear();
    this._cameras.clear();
    this._maxRenderSizes.clear();
    for (const init of inits) {
      this._cameras.set(init.flightId, buildCamera(init));
      this._maxRenderSizes.set(init.flightId, {
        maxWidth: init.maxWidth ?? init.operatorWidth ?? 1280,
        maxHeight: init.maxHeight ?? init.operatorHeight ?? 720,
      });
    }
    this._sendToClient({
      type: "camera-snapshot",
      content: { cameras: Array.from(this._cameras.values()) },
    });
  }

  /** Send a `ping` from the sidecar; the client should respond with `pong`. */
  firePing(): void {
    this._sendToClient({ type: "ping" });
  }

  /** Push an `adaptive-shed` event to the client. */
  fireAdaptiveShed(payload: AdaptiveShedPayload): void {
    this._sendToClient({ type: "adaptive-shed", content: payload });
  }

  /** Push an `error` event to the client (simulates a sidecar error reply). */
  fireError(payload: ErrorPayload): void {
    this._sendToClient({ type: "error", content: payload });
  }

  /** Current mock-sidecar throttle state (reflects `set-throttle-main-screen` commands). */
  get throttleMainScreen(): boolean {
    return this._throttleMainScreen;
  }

  /** Push a `settings-state` event to the client (simulates a plugin-status-change broadcast). */
  fireSettingsState(payload: SettingsStatePayload): void {
    this._throttleMainScreen = payload.throttleMainScreen;
    this._sendToClient({ type: "settings-state", content: payload });
  }

  /** Push a `scene-state-changed` event to the client (flight scene or not). */
  fireSceneState(inFlight: boolean): void {
    this._sendToClient({ type: "scene-state-changed", content: { inFlight } });
  }

  /** Configure the slot-pool mids before connecting (dynamic mode). */
  withSlots(mids: string[]): this {
    this._slotMids = [...mids];
    return this;
  }

  /**
   * Deliver a track onto a slot (by mid), simulating the slot's media
   * arriving over WebRTC. The client routes it to whichever camera is bound
   * to that mid. (jsdom can't make real tracks; pass a stub in unit tests or
   * a `canvas.captureStream()` track in a real-browser harness.)
   *
   * The track is remembered so the fake `getStats()` can synthesize a
   * `trackIdentifier` matching what the client received.
   */
  deliverTrack(mid: string, track: MediaStreamTrack): void {
    this._deliveredTracks.set(mid, track);
    this._onTrackHandler?.(track, this._trackIdx++, mid);
  }

  /**
   * Register a handler fired each time a `subscribe` binds a camera to a slot,
   * with `(flightId, mid)`. A browser harness uses it to deliver that camera's
   * track to the mid it was actually bound to — so tracks follow the real
   * subscription order, not the registration/array order. Set before connecting.
   */
  onSubscribe(handler: (flightId: number, mid: string) => void): void {
    this._subscribeHandler = handler;
  }

  /** The slot mid currently carrying `flightId`, or undefined. */
  slotMidFor(flightId: number): string | undefined {
    for (const [mid, fid] of this._slotBindings) {
      if (fid === flightId) return mid;
    }
    return undefined;
  }

  /** Every `ClientMessage` received from the client, in order. */
  get commands(): ReadonlyArray<ClientMessage> {
    return this._commands;
  }

  /**
   * Find the most recent client command of the given type. Pass `flightId`
   * to further filter by camera (ignored for message types without a
   * `content.flightId` field).
   */
  lastCommand<T extends ClientMessage["type"]>(
    type: T,
    flightId?: number,
  ): Extract<ClientMessage, { type: T }> | undefined {
    for (let i = this._commands.length - 1; i >= 0; i--) {
      const cmd = this._commands[i];
      if (cmd.type !== type) continue;
      if (flightId !== undefined) {
        const c = cmd as { content?: { flightId?: number } };
        if (c.content?.flightId !== flightId) continue;
      }
      return cmd as Extract<ClientMessage, { type: T }>;
    }
    return undefined;
  }

  /**
   * Build a `Response` that looks like the sidecar's `POST /offer` reply.
   * Pass to `vi.spyOn(globalThis, "fetch").mockImplementation(...)` so the
   * client's handshake can complete without a real HTTP server.
   *
   * ```ts
   * vi.spyOn(globalThis, "fetch").mockImplementation(() =>
   *   Promise.resolve(MockSidecar.makeOfferResponse([42]))
   * );
   * ```
   */
  static makeOfferResponse(cameras: number[]): Response {
    return new Response(
      JSON.stringify({ sdp: "v=0\r\n", cameras }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  /**
   * Signaling-seam analogue of {@link makeOfferResponse}: resolve an offer's
   * answer without HTTP. Pass as the client's `negotiate` config to exercise
   * the brokered-signaling path a station uses.
   */
  negotiate(offer: {
    sdp: string;
    cameras: number[];
    slots?: number;
  }): Promise<{ sdp: string; cameras: number[] }> {
    return Promise.resolve({ sdp: "v=0\r\n", cameras: offer.cameras });
  }

  /**
   * Configure the inbound video stats the fake `getStats()` will return for
   * a given camera. Call before `client.inboundVideoStats()` in tests.
   *
   * The mock synthesizes a minimal `RTCStatsReport`-shaped object: one entry
   * per flight that has stats set, with `type: "inbound-rtp"`, `kind: "video"`,
   * and either a `trackIdentifier` matching the track delivered for that camera
   * (legacy path) or a `mid` matching the slot binding (dynamic path), plus
   * the stat fields from `partialStats`.
   *
   * ```ts
   * sidecar.setInboundStats(42, { packetsReceived: 1000, framesDecoded: 300 });
   * const stats = await client.inboundVideoStats();
   * expect(stats.get(42)?.packetsReceived).toBe(1000);
   * ```
   */
  setInboundStats(flightId: number, partialStats: Partial<InboundVideoStats>): void {
    this._inboundStats.set(flightId, partialStats);
  }

  /** Build a minimal RTCStatsReport-compatible object for the current state. */
  private _buildStatsReport(): RTCStatsReport {
    const entries: [string, RTCStats][] = [];

    for (const [flightId, stats] of this._inboundStats) {
      const id = `inbound-rtp-${flightId}`;

      // Resolve the identifier: prefer trackIdentifier from the delivered track
      // (legacy path); fall back to mid from the slot binding (dynamic path).
      let trackIdentifier: string | undefined;
      let mid: string | undefined;

      // Check slot bindings (dynamic mode).
      for (const [slotMid, fid] of this._slotBindings) {
        if (fid === flightId) {
          mid = slotMid;
          const track = this._deliveredTracks.get(slotMid);
          if (track?.id) trackIdentifier = track.id;
          break;
        }
      }

      // Legacy mode: look for a delivered track whose mid matches the index
      // position (mids in legacy mode are the slot index strings "0", "1", ...).
      if (!trackIdentifier && !mid) {
        for (const [deliveredMid, track] of this._deliveredTracks) {
          if (track.id) {
            trackIdentifier = track.id;
            mid = deliveredMid;
            break;
          }
        }
      }

      const entry = {
        id,
        type: "inbound-rtp" as const,
        timestamp: Date.now(),
        kind: "video",
        trackIdentifier,
        mid,
        packetsReceived: stats.packetsReceived ?? 0,
        bytesReceived: stats.bytesReceived ?? 0,
        framesReceived: stats.framesReceived,
        framesDecoded: stats.framesDecoded,
        jitter: stats.jitter,
        framesPerSecond: stats.framesPerSecond,
      };
      entries.push([id, entry as unknown as RTCStats]);
    }

    // Build a Map that satisfies the RTCStatsReport interface (iterable + forEach).
    const map = new Map<string, RTCStats>(entries);
    return map as unknown as RTCStatsReport;
  }

  private _sendToClient(msg: ServerMessage): void {
    this._clientMsgHandler?.(JSON.stringify(msg));
  }

  private _handleClientMessage(msg: ClientMessage): void {
    switch (msg.type) {
      case "set-fov": {
        const cam = this._cameras.get(msg.content.flightId);
        if (cam) this._cameras.set(msg.content.flightId, { ...cam, fov: msg.content.fov });
        break;
      }
      case "set-layers": {
        const cam = this._cameras.get(msg.content.flightId);
        if (cam) {
          this._cameras.set(msg.content.flightId, {
            ...cam,
            layers: msg.content.layers,
            operatorLayers: msg.content.layers,
          });
        }
        break;
      }
      case "set-render-size": {
        const cam = this._cameras.get(msg.content.flightId);
        if (cam) {
          this._cameras.set(msg.content.flightId, {
            ...cam,
            renderWidth: msg.content.width,
            renderHeight: msg.content.height,
            operatorWidth: msg.content.width,
            operatorHeight: msg.content.height,
          });
        }
        break;
      }
      case "set-pan": {
        const cam = this._cameras.get(msg.content.flightId);
        if (cam) {
          this._cameras.set(msg.content.flightId, {
            ...cam,
            panYaw: msg.content.yaw,
            panPitch: msg.content.pitch,
          });
        }
        break;
      }
      case "set-degrade": {
        const cam = this._cameras.get(msg.content.flightId);
        if (cam) {
          this._cameras.set(msg.content.flightId, { ...cam, degradeLevel: msg.content.level });
        }
        break;
      }
      case "set-quality": {
        // Models the request being honored (no adaptive throttle in the
        // mock): effective dims become the preset's fraction of the
        // operator ceiling, and the authoritative state is echoed back as
        // camera-state-changed, the same broadcast the sidecar fans out
        // to every peer. Use `updateCamera` to simulate the throttled case
        // (renderWidth below the target + qualityLimitedBy: "throttled").
        const cam = this._cameras.get(msg.content.flightId);
        if (!cam) {
          this._sendToClient({
            type: "error",
            content: {
              message: `no camera with flight_id=${msg.content.flightId}`,
              source: ErrorSource.Sidecar,
            },
          });
          break;
        }
        const preset = msg.content.preset ?? undefined;
        const scale = preset ? QUALITY_PRESET_SCALE[preset] : 1.0;
        const updated: CameraState = {
          ...cam,
          viewerQuality: preset,
          qualityLimitedBy: undefined,
          renderWidth: scaleDim(cam.operatorWidth, scale),
          renderHeight: scaleDim(cam.operatorHeight, scale),
        };
        this._cameras.set(msg.content.flightId, updated);
        this._sendToClient({ type: "camera-state-changed", content: { state: updated } });
        break;
      }
      case "set-track-target": {
        // Server-authoritative: hold the chosen mode and broadcast it back as
        // camera-state-changed, mirroring the sidecar so every browser reflects
        // the same trackMode (never optimistic-local).
        const cam = this._cameras.get(msg.content.flightId);
        if (cam) {
          const updated: CameraState = { ...cam, trackMode: msg.content.mode };
          this._cameras.set(msg.content.flightId, updated);
          this._sendToClient({ type: "camera-state-changed", content: { state: updated } });
        }
        break;
      }
      case "subscribe": {
        const flightId = msg.content.flightId;
        const freeMid = this._slotMids.find((m) => !this._slotBindings.has(m));
        if (freeMid === undefined) {
          this._sendToClient({
            type: "error",
            content: { message: "no free slot", source: ErrorSource.Sidecar },
          });
        } else {
          this._slotBindings.set(freeMid, flightId);
          this._sendToClient({
            type: "slot-map",
            content: { mid: freeMid, flightId },
          });
          // Let a harness deliver this camera's track to the slot it was just
          // bound to (so tracks follow the actual subscription, not array order).
          this._subscribeHandler?.(flightId, freeMid);
        }
        break;
      }
      case "unsubscribe": {
        const flightId = msg.content.flightId;
        let bound: string | undefined;
        for (const [mid, fid] of this._slotBindings) {
          if (fid === flightId) {
            bound = mid;
            break;
          }
        }
        if (bound !== undefined) {
          this._slotBindings.delete(bound);
          this._sendToClient({
            type: "slot-map",
            content: { mid: bound, flightId: undefined },
          });
        }
        break;
      }
      // Persistent velocities are integrated frame-by-frame by the plugin;
      // the mock has no frame clock, so it doesn't model their *effect* on
      // panYaw/fov. They're still recorded in `_commands`, so consumer tests
      // can assert the command was sent via `lastCommand("set-pan-rate")`.
      // Advisory per-consumer display-size input. The real sidecar aggregates
      // it MAX-across-consumers to drive auto-resolution; the mock has no
      // aggregator, so it just records the command (via `_commands`) and does
      // NOT mutate camera render dims (unlike the operator `set-render-size`).
      case "report-display-size":
      case "set-pan-rate":
      case "set-zoom-rate":
      case "hello":
      case "pong":
      case "request-keyframe":
        break;
      case "set-throttle-main-screen": {
        /* Flip state and echo SettingsState back, mirroring the sidecar's broadcast. */
        this._throttleMainScreen = msg.content.enabled;
        this._sendToClient({
          type: "settings-state",
          content: { throttleMainScreen: this._throttleMainScreen },
        });
        break;
      }
      case "set-force-full-resolution": {
        this._setForced(msg.content.flightId, msg.content.force);
        break;
      }
      case "disconnect":
        break;
    }
  }

  /**
   * Simulate the sidecar's `effective_render_size` force branch: after
   * {@link _forceBumpDelayMs}, bump the camera's render/operator size to its
   * ceiling (`force: true`) or restore whatever it was before the force
   * (`force: false`), pushing a `camera-state-changed` either way. The delay
   * models the real round trip (control-file write, plugin capture pickup,
   * WebRTC renegotiation) and gives a UI something to show an "ARMING" state
   * for. A rapid re-toggle cancels the previous pending bump/revert.
   */
  private _setForced(flightId: number, force: boolean): void {
    const pending = this._forceTimers.get(flightId);
    if (pending !== undefined) {
      clearTimeout(pending);
      this._forceTimers.delete(flightId);
    }

    const cam = this._cameras.get(flightId);
    if (!cam) return;

    if (force) {
      if (!this._preForceSize.has(flightId)) {
        this._preForceSize.set(flightId, { width: cam.operatorWidth, height: cam.operatorHeight });
      }
      const max = this._maxRenderSizes.get(flightId);
      const timer = setTimeout(() => {
        this._forceTimers.delete(flightId);
        this._applyRenderSize(flightId, max?.maxWidth, max?.maxHeight);
      }, this._forceBumpDelayMs);
      this._forceTimers.set(flightId, timer);
    } else {
      const prior = this._preForceSize.get(flightId);
      this._preForceSize.delete(flightId);
      if (!prior) return;
      const timer = setTimeout(() => {
        this._forceTimers.delete(flightId);
        this._applyRenderSize(flightId, prior.width, prior.height);
      }, this._forceBumpDelayMs);
      this._forceTimers.set(flightId, timer);
    }
  }

  /** Push a render/operator size onto a camera (both fields alike, i.e. no adaptive shed in effect) and broadcast it. */
  private _applyRenderSize(flightId: number, width: number | undefined, height: number | undefined): void {
    const cam = this._cameras.get(flightId);
    if (!cam || width === undefined || height === undefined) return;
    const updated: CameraState = {
      ...cam,
      renderWidth: width,
      renderHeight: height,
      operatorWidth: width,
      operatorHeight: height,
    };
    this._cameras.set(flightId, updated);
    this._sendToClient({ type: "camera-state-changed", content: { state: updated } });
  }
}

/**
 * Install jsdom shims needed by kerbcast component tests.
 *
 * jsdom omits several browser APIs that the SDK and React components call at
 * construction or mount time. Stubbing here keeps individual tests clean.
 * Each shim is idempotent so setup files can call `installDomStubs()`
 * unconditionally.
 *
 * Stubs installed:
 *   ResizeObserver   - jsdom does not implement it; CameraFeed uses it to
 *                      drive auto render-size updates.
 *   captureStream    - jsdom's HTMLCanvasElement lacks captureStream; the
 *                      noise pipeline calls it to get its output MediaStream.
 *                      Returns a stub MediaStream so callers receive a valid
 *                      object rather than throwing.
 *   MediaStream      - jsdom's MediaStream constructor is incomplete; tests
 *                      need to construct instances for track delivery and
 *                      stream assertions.
 *   play             - jsdom prints "Not implemented" for HTMLMediaElement.play;
 *                      the noise pipeline awaits it on the internal video element.
 *   matchMedia       - jsdom does not implement window.matchMedia; theme
 *                      detection reads prefers-color-scheme through it.
 */
export function installDomStubs(): void {
  // ResizeObserver: jsdom omits entirely; CameraFeed's auto-size hook needs it.
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }

  // captureStream: jsdom's HTMLCanvasElement does not have it; the noise
  // pipeline's tryCreateNoisePipeline checks for it and returns null when
  // absent (safe degrade), but component tests that exercise the stream
  // path directly need a stub that returns a constructible MediaStream.
  if (
    typeof HTMLCanvasElement !== "undefined" &&
    typeof (HTMLCanvasElement.prototype as { captureStream?: unknown }).captureStream !== "function"
  ) {
    (HTMLCanvasElement.prototype as { captureStream: (fps?: number) => MediaStream }).captureStream =
      (_fps?: number): MediaStream => new StubMediaStream() as unknown as MediaStream;
  }

  // MediaStream: jsdom's implementation is minimal and not always constructible
  // with tracks. Provide a stub that satisfies the basic interface used by
  // tests (getTracks, addTrack, id).
  installStubMediaStream();

  // MediaRecorder: jsdom ships none, so the recording controller can't be
  // exercised headlessly without it. The stub emits one canned Blob on stop,
  // closing the start -> stop -> Blob path. Its isTypeSupported is controllable
  // (StubMediaRecorder.supportedTypes) so tests can drive mime negotiation and
  // its fallback.
  if (typeof (globalThis as { MediaRecorder?: unknown }).MediaRecorder === "undefined") {
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = StubMediaRecorder;
  }

  // play: jsdom's HTMLMediaElement.play is not implemented and prints a warning.
  // The noise pipeline awaits video.play() on its internal video element.
  if (typeof HTMLMediaElement !== "undefined") {
    HTMLMediaElement.prototype.play = (): Promise<void> => Promise.resolve();
  }

  // matchMedia: jsdom does not implement window.matchMedia; theme detection
  // queries prefers-color-scheme through it. Stub returns a non-matching
  // MediaQueryList so tests default to the light theme unless overridden.
  if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
    window.matchMedia = (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => false,
    } as MediaQueryList);
  }
}

/** Minimal MediaStream stand-in for jsdom environments. */
class StubMediaStream {
  readonly id: string = Math.random().toString(36).slice(2);
  private readonly _tracks: MediaStreamTrack[] = [];

  /**
   * Mirrors the real `MediaStream(tracks?)` constructor: the real SDK builds
   * its per-camera stream as `new MediaStream([track])` on track arrival, so
   * without this the tracks array is silently dropped and the stream always
   * reports zero video tracks: the client and anything downstream (e.g. a
   * real `RecordingController.startRecording`, which requires at least one
   * live video track) would never see the delivered track.
   */
  constructor(tracks: MediaStreamTrack[] = []) {
    this._tracks.push(...tracks);
  }

  getTracks(): MediaStreamTrack[] {
    return [...this._tracks];
  }
  getVideoTracks(): MediaStreamTrack[] {
    return this._tracks.filter((t) => t.kind === "video");
  }
  getAudioTracks(): MediaStreamTrack[] {
    return this._tracks.filter((t) => t.kind === "audio");
  }
  addTrack(track: MediaStreamTrack): void {
    this._tracks.push(track);
  }
  removeTrack(track: MediaStreamTrack): void {
    const i = this._tracks.indexOf(track);
    if (i !== -1) this._tracks.splice(i, 1);
  }
  clone(): StubMediaStream {
    return new StubMediaStream();
  }
}

function installStubMediaStream(): void {
  if (typeof globalThis === "undefined") return;
  // Only replace if the native MediaStream is not constructible (jsdom
  // registers the class but its constructor requires active getUserMedia
  // permissions that are never granted in a test environment).
  try {
    const ms = new globalThis.MediaStream();
    if (typeof ms.getTracks === "function") return; // native is adequate
  } catch {
    // Fall through to install the stub.
  }
  (globalThis as unknown as { MediaStream: unknown }).MediaStream = StubMediaStream;
}

/**
 * Minimal MediaRecorder stand-in for jsdom, installed by {@link installDomStubs}.
 *
 * jsdom implements no MediaRecorder, so the recording controller can't run
 * headlessly without this. On `stop()` it synchronously flushes one canned
 * Blob (a fixed byte pattern tagged with the negotiated mimeType) then fires
 * `stop`, closing the start -> stop -> Blob path the controller drives.
 *
 * `isTypeSupported` is controllable so tests exercise mime negotiation:
 *   - `supportedTypes = null` (default): support everything, so negotiation
 *     picks the mp4 preference.
 *   - `supportedTypes = ["video/webm"]`: force the webm fallback.
 * Reset `supportedTypes` back to null between tests that change it.
 */
export class StubMediaRecorder {
  /** Types isTypeSupported reports available; null = everything. */
  static supportedTypes: string[] | null = null;

  static isTypeSupported(type: string): boolean {
    return StubMediaRecorder.supportedTypes === null
      ? true
      : StubMediaRecorder.supportedTypes.includes(type);
  }

  readonly stream: MediaStream;
  readonly mimeType: string;
  state: "inactive" | "recording" | "paused" = "inactive";

  private readonly _listeners = new Map<string, Set<(e: { data?: Blob }) => void>>();

  constructor(stream: MediaStream, options?: { mimeType?: string }) {
    this.stream = stream;
    this.mimeType = options?.mimeType ?? "";
  }

  addEventListener(type: string, cb: (e: { data?: Blob }) => void): void {
    let set = this._listeners.get(type);
    if (!set) {
      set = new Set();
      this._listeners.set(type, set);
    }
    set.add(cb);
  }

  removeEventListener(type: string, cb: (e: { data?: Blob }) => void): void {
    this._listeners.get(type)?.delete(cb);
  }

  private _emit(type: string, e: { data?: Blob }): void {
    this._listeners.get(type)?.forEach((cb) => cb(e));
  }

  start(_timeslice?: number): void {
    this.state = "recording";
  }

  /** Flush a canned data chunk, then fire `stop`, mirroring the real order. */
  stop(): void {
    if (this.state === "inactive") return;
    this.state = "inactive";
    const bytes = new Uint8Array(2048);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
    const data = new Blob([bytes], { type: this.mimeType || "video/webm" });
    this._emit("dataavailable", { data });
    this._emit("stop", {});
  }

  /** Emit a partial data chunk without stopping (matches the real API). */
  requestData(): void {
    if (this.state !== "recording") return;
    const data = new Blob([new Uint8Array(512)], { type: this.mimeType || "video/webm" });
    this._emit("dataavailable", { data });
  }
}
