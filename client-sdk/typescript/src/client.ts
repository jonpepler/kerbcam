import type {
  AdaptiveShedPayload,
  CameraState,
  ClientMessage,
  ErrorPayload,
  Layer,
  QualityPreset,
  ServerMessage,
  SettingsStatePayload,
  TrackMode,
} from "./__generated__/types";
import { CameraLifecycle, ErrorSource } from "./__generated__/types";
import { type NoisePipeline, tryCreateNoisePipeline } from "./noise";
import { RecordingController, type RecordingControllerOptions } from "./recording";

/** Intensity the static runs at when a camera has no live source (signal lost). */
const SOURCELESS_INTENSITY = 1.0;
/** Floor applied to the degrade-driven intensity of a live feed. */
const LIVE_INTENSITY_FLOOR = 0.05;
/**
 * While a feed is stalled, how often to re-request a keyframe. A stall is
 * usually a wedged decoder that only a fresh IDR clears; the first request or
 * its keyframe can be lost during the same outage, so we keep asking until
 * frames resume.
 */
const STALL_KEYFRAME_RETRY_MS = 2000;

/** Controls the digital-static noise overlay baked into `cam.mediaStream`. */
export interface NoiseConfig {
  /** When false, the pipeline is bypassed and `mediaStream` is the raw WebRTC track. */
  enabled: boolean;
}

/**
 * Per-camera handle returned from {@link KerbcastClient.camera}.
 * Stable identity per flight ID for the lifetime of the client.
 */
export interface KerbcastCameraHandle {
  readonly flightId: number;
  readonly state: CameraState | null;
  readonly mediaStream: MediaStream | null;
  /**
   * True while the camera has a live source whose frames have stopped
   * arriving (the noise pipeline's stall detector). Always false when the
   * noise pipeline is unavailable (no `captureStream`) or bypassed.
   * Transitions are emitted as `stall` events.
   */
  readonly stalled: boolean;
  /** Current {@link setShowStatic} setting. */
  readonly showStatic: boolean;

  setLayers(layers: Layer[]): Promise<void>;
  setRenderSize(width: number, height: number): Promise<void>;
  setFov(fov: number): Promise<void>;
  setPan(yaw: number, pitch: number): Promise<void>;
  /**
   * Set a persistent pan/tilt velocity (normalised, -1..1 per axis;
   * +yaw = right, +pitch = up). Holds until superseded — send
   * `setPanRate(0, 0)` to stop. Smoothing happens in the plugin's frame
   * loop, so call this only when the input changes (e.g. arrow down /
   * release), not on a timer.
   */
  setPanRate(yawRate: number, pitchRate: number): Promise<void>;
  /**
   * Set a persistent zoom velocity (normalised, -1..1; +1 = zoom in,
   * FoV decreasing). Holds until superseded — send `setZoomRate(0)` to
   * stop. Like {@link setPanRate}, call on input change (press-and-hold),
   * not on a timer.
   */
  setZoomRate(rate: number): Promise<void>;
  setDegrade(level: number): Promise<void>;
  /**
   * Request a resolution preset for this camera, or `null` for auto
   * (clear the viewer clamp). Server-wide and last-write-wins across
   * peers; the authoritative result arrives as a `change` event
   * (`state.viewerQuality` + `state.qualityLimitedBy`). The effective
   * resolution is min(operator ceiling, adaptive level, preset): a
   * preset can only lower quality, and the sidecar's adaptive perf
   * machinery keeps overriding it downward while throttled.
   */
  setQuality(preset: QualityPreset | null): Promise<void>;
  requestKeyframe(): Promise<void>;

  /**
   * Override noise settings for this camera only. Takes precedence over the
   * client-level default in {@link KerbcastClientConfig.noise}.
   */
  configure(options: { noise?: Partial<NoiseConfig> }): void;

  /**
   * Choose whether animated static is drawn (default true). When false:
   * a stalled source holds its last decoded frame with no noise (the
   * consumer's chrome carries the staleness indicator via the `stall`
   * event / {@link stalled}), and a sourceless path clears to black
   * without noise so only the text overlay renders.
   */
  setShowStatic(enabled: boolean): void;

  on<K extends keyof KerbcastCameraEvents>(
    event: K,
    handler: (data: KerbcastCameraEvents[K]) => void,
  ): () => void;
}

/** Event payloads emitted by a {@link KerbcastCameraHandle}. */
export interface KerbcastCameraEvents {
  /** Latest `CameraState` from the sidecar's `camera-state-changed`. */
  change: CameraState;
  /** Track arrival or teardown for this camera. `null` on disconnect. */
  stream: MediaStream | null;
  /** Frames stopped arriving on a live source (`true`) / resumed (`false`). */
  stall: boolean;
}

/** Configuration for {@link KerbcastClient} construction. */
export interface KerbcastClientConfig {
  /** Sidecar host (matches the sidecar's `--http-bind`). */
  host: string;
  /** Sidecar port. */
  port: number;
  /**
   * ICE servers to use. Defaults to Google's public STUN server,
   * which is enough for LAN streaming.
   */
  iceServers?: RTCIceServer[];
  /**
   * Default noise settings for all cameras. Individual cameras can override
   * this via `cam.configure({ noise: ... })`. Noise is enabled by default.
   */
  noise?: Partial<NoiseConfig>;
  /**
   * ICE gathering timeout in milliseconds. Passed to the default
   * {@link BrowserKerbcastTransport}; ignored when a custom transport is
   * provided (the transport owns gathering). Defaults to 2000 ms.
   *
   * On LAN topologies where the STUN server is unreachable (e.g. Steam Deck
   * IPv6 LAN with no internet path), gathering can stall for the full STUN
   * timeout. Host candidates alone are sufficient for LAN streaming, so this
   * timeout lets the connect flow proceed once host candidates are gathered.
   */
  iceGatheringTimeoutMs?: number;
  /**
   * Override how the SDP offer/answer is exchanged. Defaults to a POST to the
   * sidecar's HTTP `/offer`. A station screen injects a version that relays
   * the offer through the main screen (which can reach the sidecar), so the
   * station needs no direct sidecar address. The media itself still flows
   * peer-to-sidecar (direct or via TURN) -- only the handshake is brokered.
   */
  negotiate?: (offer: {
    sdp: string;
    cameras: number[];
    slots?: number;
  }) => Promise<{ sdp: string; cameras: number[] }>;
  /**
   * Options for the lazily-built {@link RecordingController} (`client.recording`).
   * The load-bearing use is `loadTrimmer`: a consumer that can't rely on the
   * default bare `import("mediabunny")` resolving (the sidecar's embedded web
   * page serves its own copy of the package locally, offline/LAN, no CDN)
   * supplies its own loader here. Bundler consumers (e.g. gonogo) can omit
   * this and get the default.
   */
  recording?: RecordingControllerOptions;
}

/** WebRTC connection state surface. */
export type KerbcastConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "failed";

/**
 * Inbound RTP video statistics for one camera track, derived from the
 * WebRTC stats report. Fields are `undefined` when the browser has not yet
 * emitted that stat (e.g. `framesPerSecond` before the first full second).
 * `packetsReceived` and `bytesReceived` default to 0 in the same case.
 *
 * Retrieve per-camera stats via {@link KerbcastClient.inboundVideoStats}.
 */
export interface InboundVideoStats {
  packetsReceived: number;
  bytesReceived: number;
  framesReceived: number | undefined;
  framesDecoded: number | undefined;
  jitter: number | undefined;
  framesPerSecond: number | undefined;
}

/**
 * Camera summary returned by {@link KerbcastClient.discover} (`GET /cameras`).
 *
 * This is the shape the sidecar serialises from its internal `CameraInfo`
 * struct. It is a discovery snapshot, not a live operating state: it carries
 * capability and identity fields but not per-connection operator state
 * (`layers`, `renderWidth`, `panYaw`, etc.) -- those arrive over the data
 * channel after `connect()`.
 *
 * Deliberately separate from `CameraState` even though the two share several
 * field names, because the shapes differ: `DiscoveredCamera` has `maxWidth`
 * / `maxHeight` (physical sensor limits) which `CameraState` omits, while
 * `CameraState` adds runtime fields (`layers`, `renderWidth`, `panYaw`, ...).
 */
export interface DiscoveredCamera {
  flightId: number;
  /** Part-destruction lifecycle. `"active"` for live cameras. */
  lifecycle?: CameraLifecycle;
  partName: string;
  partTitle: string;
  cameraName: string;
  vesselName: string;
  /** Physical sensor width ceiling (pixels). Distinct from `renderWidth` on
   *  `CameraState`, which is the currently-negotiated resolution. */
  maxWidth: number;
  /** Physical sensor height ceiling (pixels). */
  maxHeight: number;
  supportsZoom: boolean;
  fov: number;
  fovMin: number;
  fovMax: number;
  supportsPan: boolean;
  panYawMin: number;
  panYawMax: number;
  panPitchMin: number;
  panPitchMax: number;
  /** Current encoder bitrate in bits per second. 0 when no encoder is running. */
  encoderBitrateBps: number;
  /** REMB-derived bandwidth target. 0 until the first feedback arrives. */
  targetBitrateBps: number;
  /** Effective degrade level (max across active subscribers). 0.0 to 1.0. */
  degradeLevel: number;
}

/** Event payloads emitted by a {@link KerbcastClient}. */
export interface KerbcastClientEvents {
  "state-change": KerbcastConnectionState;
  "cameras-change": CameraState[];
  "adaptive-shed": AdaptiveShedPayload;
  error: ErrorPayload;
  /**
   * Fired whenever a `ping` keepalive arrives from the sidecar.
   * Consumers can use this to reset their own staleness watchdogs
   * without intercepting at the transport layer.
   */
  ping: undefined;
  /**
   * Fired when a `settings-state` message arrives (after `Hello` and
   * whenever the plugin-reported throttle state changes). Payload
   * reflects what the plugin has applied, not just what was requested.
   */
  "settings-change": SettingsStatePayload;
  /**
   * Fired when a `scene-state-changed` message arrives. `true` in a
   * flight scene, `false` otherwise, `undefined` before the first
   * signal. Consumers use this to show a calm out-of-flight standby
   * instead of per-camera SIGNAL LOST.
   */
  "scene-change": boolean | undefined;
}

// ---------------------------------------------------------------------------
// Transport abstraction for tests
// ---------------------------------------------------------------------------

/**
 * Pluggable WebRTC transport. Production code uses the default
 * (browser `RTCPeerConnection`). Tests substitute an in-memory
 * implementation to exercise the state machine without a real peer.
 */
export interface KerbcastTransport {
  createPeer(iceServers: RTCIceServer[]): KerbcastPeer;
}

export interface KerbcastPeer {
  addRecvOnlyTransceiver(): void;
  createDataChannel(label: string): KerbcastDataChannel;
  onTrack(
    handler: (track: MediaStreamTrack, idx: number, mid: string) => void,
  ): void;
  onStateChange(handler: (state: KerbcastConnectionState) => void): void;
  createOffer(): Promise<string>;
  setLocalDescription(sdp: string): Promise<void>;
  setRemoteAnswer(sdp: string): Promise<void>;
  waitForIceComplete(): Promise<void>;
  localSdp(): string;
  close(): void;
  /**
   * Retrieve the raw WebRTC stats report. Optional so existing third-party
   * transports and mocks that predate this method keep compiling without
   * changes. Equivalent to `RTCPeerConnection.getStats(null)`.
   */
  getStats?(): Promise<RTCStatsReport>;
}

export interface KerbcastDataChannel {
  send(payload: string): void;
  onOpen(handler: () => void): void;
  onMessage(handler: (raw: string) => void): void;
  onClose(handler: () => void): void;
}

// ---------------------------------------------------------------------------
// Default transport: browser RTCPeerConnection
// ---------------------------------------------------------------------------

/** Options for {@link BrowserKerbcastTransport}. */
export interface BrowserKerbcastTransportOptions {
  /**
   * Maximum time (ms) to wait for ICE gathering to complete before proceeding
   * with whatever candidates have been gathered. Defaults to 2000 ms.
   *
   * On LAN paths where the STUN server is unreachable, gathering blocks until
   * the STUN timeout elapses. Host candidates are all a local LAN stream
   * needs, so this timeout lets connect proceed without waiting for STUN.
   */
  iceGatheringTimeoutMs?: number;
}

export class BrowserKerbcastTransport implements KerbcastTransport {
  private readonly opts: Required<BrowserKerbcastTransportOptions>;

  constructor(opts: BrowserKerbcastTransportOptions = {}) {
    this.opts = { iceGatheringTimeoutMs: opts.iceGatheringTimeoutMs ?? 2000 };
  }

  createPeer(iceServers: RTCIceServer[]): KerbcastPeer {
    const pc = new RTCPeerConnection({ iceServers });
    const { iceGatheringTimeoutMs } = this.opts;
    let trackIdx = 0;
    let onTrack:
      | ((t: MediaStreamTrack, idx: number, mid: string) => void)
      | null = null;
    let onStateChange: ((s: KerbcastConnectionState) => void) | null = null;

    pc.ontrack = (ev) => {
      // ev.transceiver.mid is the stable m-line id the sidecar keys its
      // SlotMap on; it's set by the time ontrack fires (post-answer).
      onTrack?.(ev.track, trackIdx++, ev.transceiver.mid ?? "");
    };
    pc.onconnectionstatechange = () => {
      onStateChange?.(mapPeerState(pc.connectionState));
    };

    return {
      addRecvOnlyTransceiver: () => {
        pc.addTransceiver("video", { direction: "recvonly" });
      },
      createDataChannel: (label) =>
        wrapBrowserDataChannel(pc.createDataChannel(label)),
      onTrack: (h) => {
        onTrack = h;
      },
      onStateChange: (h) => {
        onStateChange = h;
      },
      createOffer: async () => {
        const offer = await pc.createOffer();
        return offer.sdp ?? "";
      },
      setLocalDescription: async (sdp) => {
        await pc.setLocalDescription({ type: "offer", sdp });
      },
      setRemoteAnswer: async (sdp) => {
        await pc.setRemoteDescription({ type: "answer", sdp });
      },
      waitForIceComplete: () =>
        new Promise<void>((resolve) => {
          if (pc.iceGatheringState === "complete") {
            resolve();
            return;
          }
          let timer: ReturnType<typeof setTimeout> | null = null;
          const cleanup = () => {
            pc.removeEventListener("icegatheringstatechange", check);
            if (timer !== null) {
              clearTimeout(timer);
              timer = null;
            }
          };
          const check = () => {
            if (pc.iceGatheringState === "complete") {
              cleanup();
              resolve();
            }
          };
          timer = setTimeout(() => {
            timer = null;
            cleanup();
            resolve();
          }, iceGatheringTimeoutMs);
          pc.addEventListener("icegatheringstatechange", check);
        }),
      localSdp: () => pc.localDescription?.sdp ?? "",
      getStats: () => pc.getStats(null),
      close: () => {
        pc.close();
      },
    };
  }
}

function wrapBrowserDataChannel(dc: RTCDataChannel): KerbcastDataChannel {
  let onOpen: (() => void) | null = null;
  let onMessage: ((raw: string) => void) | null = null;
  let onClose: (() => void) | null = null;
  dc.onopen = () => onOpen?.();
  dc.onclose = () => onClose?.();
  dc.onmessage = (ev) => {
    if (typeof ev.data === "string") onMessage?.(ev.data);
  };
  return {
    send: (s) => {
      dc.send(s);
    },
    onOpen: (h) => {
      onOpen = h;
    },
    onMessage: (h) => {
      onMessage = h;
    },
    onClose: (h) => {
      onClose = h;
    },
  };
}

function mapPeerState(state: RTCPeerConnectionState): KerbcastConnectionState {
  switch (state) {
    case "new":
    case "connecting":
      return "connecting";
    case "connected":
      return "connected";
    case "failed":
      return "failed";
    case "disconnected":
    case "closed":
      return "disconnected";
  }
}

// ---------------------------------------------------------------------------
// Tiny typed event emitter
// ---------------------------------------------------------------------------

type Listener<T> = (data: T) => void;

// No bound on E so consumers can use `interface` declarations
// (interfaces don't carry an implicit string index signature, so
// `extends Record<string, unknown>` would reject them).
class TypedEmitter<E> {
  private readonly listeners = new Map<keyof E, Set<Listener<unknown>>>();

  on<K extends keyof E>(event: K, handler: (data: E[K]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler as Listener<unknown>);
    return () => {
      set?.delete(handler as Listener<unknown>);
    };
  }

  protected emit<K extends keyof E>(event: K, data: E[K]): void {
    const set = this.listeners.get(event);
    set?.forEach((h) => (h as Listener<E[K]>)(data));
  }
}

// ---------------------------------------------------------------------------
// Camera handle implementation
// ---------------------------------------------------------------------------

class CameraHandle
  extends TypedEmitter<KerbcastCameraEvents>
  implements KerbcastCameraHandle
{
  readonly flightId: number;
  private _state: CameraState | null = null;
  private _mediaStream: MediaStream | null = null;
  private _rawStream: MediaStream | null = null;
  private _noisePipeline: NoisePipeline | null = null;
  private _noiseOverride: Partial<NoiseConfig> | null = null;
  /**
   * True while the handle has no live source but is still showing static
   * (signal-loss / camera-switch gap). Distinct from a true teardown, where
   * the pipeline is destroyed and `_mediaStream` goes null. While sourceless,
   * intensity is pinned at full and degrade updates must not lower it.
   */
  private _sourceless = false;
  /** Stall state mirrored from the pipeline's onStallChange callback. */
  private _stalled = false;
  /** Interval that re-requests keyframes while stalled; null when not stalled. */
  private _keyframeRetry: ReturnType<typeof setInterval> | null = null;
  /** Whether animated static is drawn; survives pipeline rebuilds. */
  private _showStatic = true;
  private readonly client: KerbcastClient;

  constructor(flightId: number, client: KerbcastClient) {
    super();
    this.flightId = flightId;
    this.client = client;
  }

  get state(): CameraState | null {
    return this._state;
  }

  get mediaStream(): MediaStream | null {
    return this._mediaStream;
  }

  get stalled(): boolean {
    return this._stalled;
  }

  get showStatic(): boolean {
    return this._showStatic;
  }

  configure(options: { noise?: Partial<NoiseConfig> }): void {
    this._noiseOverride = options.noise ?? null;
    // Re-evaluate with the new noise setting: rebuild from whatever source
    // state we're currently in (live, sourceless, or torn down).
    this._applySource(this._rawStream);
  }

  setShowStatic(enabled: boolean): void {
    this._showStatic = enabled;
    this._noisePipeline?.setShowStatic(enabled);
  }

  /**
   * Internal — called by the client when CameraState pushes arrive. Returns
   * `true` when this update resurrected the camera (Destroyed -> Active), so
   * the client can re-source the handle from its retained track.
   */
  _setState(state: CameraState): boolean {
    const prevDestroyed = this._state?.lifecycle === CameraLifecycle.Destroyed;
    this._state = state;
    this.emit("change", state);

    // A destroyed camera stops forwarding frames but its track never ends, so
    // nothing else drives the handle into the sourceless state — do it here.
    if (state.lifecycle === CameraLifecycle.Destroyed) {
      if (!this._sourceless || !prevDestroyed) this._applySource(null);
      return false;
    }

    // Live feed: degrade drives intensity. Don't touch a sourceless pipeline,
    // which is pinned at full static.
    if (!this._sourceless) {
      this._noisePipeline?.setIntensity(this._liveIntensity());
    }

    // Resurrection: KSP reused this part.flightID after a revert, so the
    // sidecar tombstoned then re-attached the SAME camera and rebound the SAME
    // track with no new slot-map. The handle went sourceless on destroy and
    // only re-sources on a slot-map, so signal the client to re-source it from
    // the track it still holds.
    return prevDestroyed;
  }

  /**
   * Internal — called by the client when a track arrives or drops.
   * A null stream does NOT tear down: if a pipeline can run, the handle keeps
   * emitting live full-intensity static (signal-loss / camera-switch gap).
   * Use {@link _teardown} for genuine teardown (disconnect / peer failure).
   */
  _setMediaStream(stream: MediaStream | null): void {
    this._applySource(stream);
  }

  /**
   * Drive the persistent pipeline to a given source (or sourceless static when
   * `raw` is null). Creates the pipeline lazily on first need and reuses it
   * thereafter so the output stream stays stable across source swaps.
   */
  private _applySource(raw: MediaStream | null): void {
    this._rawStream = raw;
    this._sourceless = raw === null;

    const noiseEnabled = this.client._resolveNoise(this._noiseOverride);

    if (noiseEnabled) {
      // Sourceless feeds show static in flight, but go blank (black, no
      // noise) out of flight so a whole-scene unload is calm.
      const showStatic = raw ? this._showStatic : this._sourcelessShowStatic();
      // Reuse an existing pipeline; otherwise try to create one.
      if (!this._noisePipeline) {
        const initial = raw ? this._liveIntensity() : SOURCELESS_INTENSITY;
        this._noisePipeline = tryCreateNoisePipeline(raw, initial, {
          showStatic,
          onStallChange: (stalled) => this._setStalled(stalled),
        });
      } else {
        this._noisePipeline.setSource(raw);
        this._noisePipeline.setShowStatic(showStatic);
      }

      const pipeline = this._noisePipeline;
      if (pipeline) {
        pipeline.setIntensity(raw ? this._liveIntensity() : SOURCELESS_INTENSITY);
        this._setOutput(pipeline.processedStream);
        return;
      }
    } else if (this._noisePipeline) {
      // Noise just got disabled — drop the pipeline and fall through to raw.
      this._noisePipeline.destroy();
      this._noisePipeline = null;
      this._setStalled(false);
    }

    // Noise disabled, or captureStream unavailable (no pipeline creatable):
    // expose the raw stream directly, or null when there's no source.
    this._setOutput(raw);
  }

  /**
   * Whether a sourceless (destroyed/absent) feed should render static. True
   * in flight (or before the scene signal), false out of flight so the feed
   * goes blank rather than a wall of red static when the whole scene unloads.
   */
  private _sourcelessShowStatic(): boolean {
    return this._showStatic && this.client.inFlight !== false;
  }

  /**
   * Internal — called by the client when the scene flag flips. Re-drives an
   * existing sourceless pipeline so it switches between static and blank.
   */
  _refreshSceneState(): void {
    if (this._sourceless) {
      this._noisePipeline?.setShowStatic(this._sourcelessShowStatic());
    }
  }

  private _setOutput(stream: MediaStream | null): void {
    this._mediaStream = stream;
    this.emit("stream", stream);
  }

  private _setStalled(stalled: boolean): void {
    if (this._stalled === stalled) return;
    this._stalled = stalled;
    this.emit("stall", stalled);
    if (stalled) {
      // A stall usually means the browser decoder is wedged (broken H.264
      // reference chain after packet loss or heavy degrade), which only a
      // fresh keyframe clears. Force one now and keep asking while stalled,
      // rather than waiting on the browser's rate-limited PLI.
      this._requestKeyframeForRecovery();
      if (this._keyframeRetry === null) {
        this._keyframeRetry = setInterval(
          () => this._requestKeyframeForRecovery(),
          STALL_KEYFRAME_RETRY_MS,
        );
      }
    } else if (this._keyframeRetry !== null) {
      clearInterval(this._keyframeRetry);
      this._keyframeRetry = null;
    }
  }

  private _requestKeyframeForRecovery(): void {
    this.requestKeyframe().catch(() => {
      // Best effort; a failed send (disconnected) is retried on the next tick,
      // or cleared when the stall ends.
    });
  }

  private _liveIntensity(): number {
    return Math.max(LIVE_INTENSITY_FLOOR, this._state?.degradeLevel ?? 0);
  }

  /**
   * Internal — genuine teardown (client disconnect / peer failure). Destroys
   * the persistent pipeline, stops its rAF loop, and nulls the stream.
   */
  _teardown(): void {
    if (this._keyframeRetry !== null) {
      clearInterval(this._keyframeRetry);
      this._keyframeRetry = null;
    }
    this._noisePipeline?.destroy();
    this._noisePipeline = null;
    this._rawStream = null;
    this._sourceless = false;
    this._setStalled(false);
    this._setOutput(null);
  }

  async setLayers(layers: Layer[]): Promise<void> {
    await this.client._send({
      type: "set-layers",
      content: { flightId: this.flightId, layers },
    });
  }

  async setRenderSize(width: number, height: number): Promise<void> {
    await this.client._send({
      type: "set-render-size",
      content: { flightId: this.flightId, width, height },
    });
  }

  async setFov(fov: number): Promise<void> {
    await this.client._send({
      type: "set-fov",
      content: { flightId: this.flightId, fov },
    });
  }

  async setPan(yaw: number, pitch: number): Promise<void> {
    await this.client._send({
      type: "set-pan",
      content: { flightId: this.flightId, yaw, pitch },
    });
  }

  async setPanRate(yawRate: number, pitchRate: number): Promise<void> {
    await this.client._send({
      type: "set-pan-rate",
      content: { flightId: this.flightId, yawRate, pitchRate },
    });
  }

  async setZoomRate(rate: number): Promise<void> {
    await this.client._send({
      type: "set-zoom-rate",
      content: { flightId: this.flightId, rate },
    });
  }

  async setDegrade(level: number): Promise<void> {
    await this.client._send({
      type: "set-degrade",
      content: { flightId: this.flightId, level },
    });
  }

  async setQuality(preset: QualityPreset | null): Promise<void> {
    await this.client._send({
      type: "set-quality",
      // null (auto) deserializes to None on the sidecar; the generated
      // payload type marks the field optional, so widen for the wire.
      content: { flightId: this.flightId, preset: preset ?? undefined },
    });
  }

  async requestKeyframe(): Promise<void> {
    await this.client._send({
      type: "request-keyframe",
      content: { flightId: this.flightId },
    });
  }
}

// ---------------------------------------------------------------------------
// KerbcastClient
// ---------------------------------------------------------------------------

/**
 * High-level kerbcast sidecar client. Owns the WebRTC peer + the
 * `kerbcast-control` data channel + the per-camera registry + the
 * `MediaStream`s for each subscribed camera.
 *
 * Usage:
 *
 * ```ts
 * const client = new KerbcastClient({ host: "192.168.1.74", port: 8088 });
 * await client.connect();
 *
 * const cam = client.camera(2592004302);
 * await cam.setFov(35);
 * videoEl.srcObject = cam.mediaStream;
 *
 * cam.on("change", (state) => { ... });
 * client.on("adaptive-shed", (event) => { ... });
 * ```
 *
 * Disconnect with {@link disconnect}. The handles returned by
 * `camera()` remain valid across reconnects; their `mediaStream`
 * goes null on disconnect and is replaced when the next connect's
 * tracks arrive.
 */
export class KerbcastClient extends TypedEmitter<KerbcastClientEvents> {
  private readonly cfg: KerbcastClientConfig;
  private readonly transport: KerbcastTransport;
  private peer: KerbcastPeer | null = null;
  private control: KerbcastDataChannel | null = null;
  private _state: KerbcastConnectionState = "disconnected";
  private _cameras: CameraState[] = [];
  private readonly handles = new Map<number, CameraHandle>();
  private requestedOrder: number[] = [];
  /** Set when `connect` is given an explicit slot pool. Switches track
   *  routing from legacy index order to mid-keyed dynamic slots. */
  private dynamicMode = false;
  /** Dynamic mode: transceiver mid -> the live track on that slot. */
  private readonly trackByMid = new Map<string, MediaStreamTrack>();
  /** Dynamic mode: transceiver mid -> the camera bound to that slot
   *  (populated by SlotMap -- initial bindings announced on Hello). */
  private readonly flightByMid = new Map<string, number>();
  /**
   * Legacy mode: raw incoming track id -> flightId. Populated in handleTrack
   * so inboundVideoStats() can match inbound-rtp report entries by
   * trackIdentifier. Cleared on disconnect. Not used in dynamic mode (which
   * matches by mid instead).
   */
  private readonly flightByTrackId = new Map<string, number>();
  /** Sidecar version reported on `Hello`; null before handshake. */
  private _sidecarVersion: string | null = null;
  private _encoderBackend: string | null = null;
  /** Last-received throttle state from `settings-state`. False until the first push. */
  private _throttleMainScreen = false;
  /**
   * Mission-time capture clock from `settings-state`. `_captureUt` is null
   * until the first clock arrives (and against an old sidecar that never
   * sends one), so consumers treat it as "no clock". `_captureEpoch` bumps
   * on discontinuities (revert / quickload / scene reload); only the change
   * is meaningful. `_warpRate` defaults to 1 when the field is absent.
   */
  private _captureUt: number | null = null;
  private _captureEpoch = 0;
  private _warpRate = 1;
  /** Whether KSP is in a flight scene. `undefined` until the first signal. */
  private _inFlight: boolean | undefined = undefined;
  /** Client-side recording controller, lazily built on first `recording` access. */
  private _recording: RecordingController | null = null;

  constructor(cfg: KerbcastClientConfig, transport?: KerbcastTransport) {
    super();
    this.cfg = cfg;
    this.transport =
      transport ??
      new BrowserKerbcastTransport({
        iceGatheringTimeoutMs: cfg.iceGatheringTimeoutMs,
      });
  }

  get state(): KerbcastConnectionState {
    return this._state;
  }

  get cameras(): ReadonlyArray<CameraState> {
    return this._cameras;
  }

  get sidecarVersion(): string | null {
    return this._sidecarVersion;
  }

  get encoderBackend(): string | null {
    return this._encoderBackend;
  }

  /**
   * Current effective state of the "Throttle KSP main render" setting.
   * Reflects what the plugin has applied (from `settings-state` messages),
   * not just what was last requested. False until the first push arrives.
   */
  get throttleMainScreen(): boolean {
    return this._throttleMainScreen;
  }

  /**
   * Mission-time capture clock, from the sidecar's ~1Hz `settings-state`.
   * `captureUt` is the KSP universal time (seconds) the current video was
   * captured at, or null when no clock is known (old plugin/sidecar, or
   * before the first push). `epoch` bumps on a UT discontinuity so a
   * consumer can flush and resync. `warpRate` lets a consumer interpolate
   * `captureUt` between samples; defaults to 1.
   */
  get clock(): { captureUt: number | null; epoch: number; warpRate: number } {
    return {
      captureUt: this._captureUt,
      epoch: this._captureEpoch,
      warpRate: this._warpRate,
    };
  }

  /**
   * Client-side recording controller. Records a camera's already-received
   * track with the browser's `MediaRecorder`, annotated with the mission-time
   * (UT) clock; purely local, no sidecar involvement. Lazily created on first
   * access and stable thereafter. See {@link RecordingController}.
   */
  get recording(): RecordingController {
    if (!this._recording) this._recording = new RecordingController(this, this.cfg.recording);
    return this._recording;
  }

  /**
   * Whether KSP is currently in a flight scene, from the sidecar's
   * `scene-state-changed`. `undefined` until the first signal (so a
   * consumer never flashes the out-of-flight standby on connect).
   */
  get inFlight(): boolean | undefined {
    return this._inFlight;
  }

  /**
   * Send a `set-throttle-main-screen` command to the sidecar, which writes
   * `global.control.json` for the plugin to apply. The plugin persists the
   * change in the per-save difficulty parameter. The resulting
   * `settings-state` broadcast reflects the applied value.
   */
  async setThrottleMainScreen(enabled: boolean): Promise<void> {
    await this._send({
      type: "set-throttle-main-screen",
      content: { enabled },
    });
  }

  /**
   * Pre-handshake camera discovery via the sidecar's HTTP `/cameras`
   * endpoint. Useful when the consumer wants to pick which cameras
   * to subscribe to before opening a peer connection.
   */
  async discover(): Promise<DiscoveredCamera[]> {
    const res = await fetch(`http://${this.cfg.host}:${this.cfg.port}/cameras`);
    if (!res.ok) throw new Error(`/cameras returned ${res.status}`);
    const body = (await res.json()) as { cameras: DiscoveredCamera[] };
    return body.cameras;
  }

  /**
   * Open the WebRTC peer and subscribe to cameras. Idempotent: calling
   * `connect` while already connected disconnects first.
   *
   * Two modes:
   * - **Legacy** (no `opts.slots`): one transceiver per requested camera;
   *   an empty array subscribes to every currently-known camera. Tracks
   *   route by m-line index. Unchanged behaviour.
   * - **Dynamic** (`opts.slots` set): negotiates a pool of `opts.slots`
   *   recv-only video slots. `requestedCameras` are the *initial*
   *   subscription bound to the first slots; spare slots are filled at
   *   runtime via {@link subscribe}. Tracks route by transceiver mid
   *   (the sidecar announces bindings via SlotMap), so switching a slot's
   *   camera needs no renegotiation.
   */
  async connect(
    requestedCameras: number[] = [],
    opts: { slots?: number } = {},
  ): Promise<void> {
    this.disconnect();
    this.setState("connecting");
    this.requestedOrder = [...requestedCameras];
    this.dynamicMode = opts.slots !== undefined;
    this.trackByMid.clear();
    this.flightByMid.clear();
    this.flightByTrackId.clear();

    const peer = this.transport.createPeer(
      this.cfg.iceServers ?? [{ urls: "stun:stun.l.google.com:19302" }],
    );
    this.peer = peer;

    // Slot-pool size = the recv-only transceivers we offer. Dynamic mode
    // uses the explicit pool size (spares subscribable at runtime); legacy
    // uses one per requested camera (>=1).
    const slotCount = this.dynamicMode
      ? Math.max(opts.slots ?? 0, 1)
      : Math.max(this.requestedOrder.length, 1);
    for (let i = 0; i < slotCount; i++) {
      peer.addRecvOnlyTransceiver();
    }

    peer.onTrack((track, idx, mid) => this.handleTrack(track, idx, mid));

    peer.onStateChange((s) => {
      this.setState(s);
      if (s === "disconnected" || s === "failed") {
        this.tearDownStreams();
      }
    });

    this.control = peer.createDataChannel("kerbcast-control");
    this.control.onOpen(() => {
      void this._send({ type: "hello" });
    });
    this.control.onMessage((raw) => {
      this.handleServerMessage(raw);
    });
    this.control.onClose(() => {
      // Channel closure usually follows peer disconnect; the peer
      // state-change handler covers the tear-down. Nothing to do here.
    });

    await peer.createOffer().then((sdp) => peer.setLocalDescription(sdp));
    await peer.waitForIceComplete();

    const body: { sdp: string; cameras: number[]; slots?: number } = {
      sdp: peer.localSdp(),
      cameras: this.requestedOrder,
    };
    if (this.dynamicMode) body.slots = slotCount;

    let answer: { sdp: string; cameras: number[] };
    try {
      answer = await (this.cfg.negotiate
        ? this.cfg.negotiate(body)
        : this.httpNegotiate(body));
    } catch (err) {
      this.setState("failed");
      throw err;
    }
    await peer.setRemoteAnswer(answer.sdp);
    // Legacy mode routes by index → requestedOrder, so realign to what the
    // sidecar actually wired. Dynamic mode routes by mid via SlotMap (initial
    // bindings arrive on Hello), so the answer's camera list isn't used.
    if (!this.dynamicMode) {
      this.requestedOrder = answer.cameras;
    }
  }

  /** Default signaling: POST the offer to the sidecar's HTTP `/offer`. */
  private async httpNegotiate(offer: {
    sdp: string;
    cameras: number[];
    slots?: number;
  }): Promise<{ sdp: string; cameras: number[] }> {
    const res = await fetch(`http://${this.cfg.host}:${this.cfg.port}/offer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(offer),
    });
    if (!res.ok) throw new Error(`POST /offer returned ${res.status}`);
    return (await res.json()) as { sdp: string; cameras: number[] };
  }

  disconnect(): void {
    this.peer?.close();
    this.peer = null;
    this.control = null;
    this.tearDownStreams();
    this.setState("disconnected");
  }

  /**
   * Stable per-flight-id handle. Creates a new handle on first call
   * for a given ID; returns the same handle on subsequent calls.
   */
  camera(flightId: number): KerbcastCameraHandle {
    return this.getOrCreateHandle(flightId);
  }

  /**
   * Dynamic mode only: bind a camera to a free slot on the already-connected
   * peer. The camera's stream appears on its handle once the sidecar answers
   * with a SlotMap; the sidecar emits an `error` event if no slot is free. No
   * renegotiation.
   */
  async subscribe(flightId: number): Promise<void> {
    await this._send({ type: "subscribe", content: { flightId } });
  }

  /**
   * Dynamic mode only: release a camera's slot. Its handle's `mediaStream`
   * goes null once the sidecar confirms with a SlotMap.
   */
  async unsubscribe(flightId: number): Promise<void> {
    await this._send({ type: "unsubscribe", content: { flightId } });
  }

  /**
   * Report this consumer's own displayed pixel size for a camera, driving the
   * sidecar's auto-resolution. Unlike `setRenderSize` (an operator command that
   * sets the shared render size directly, last-writer-wins), this is a
   * per-consumer input the sidecar aggregates MAX-across-consumers, so a big
   * spotlight bumps the stream up while tiny avatars leave it small. The SDK's
   * feed primitives self-measure and call this; consumers do not report by hand.
   */
  async reportDisplaySize(flightId: number, width: number, height: number): Promise<void> {
    await this._send({ type: "report-display-size", content: { flightId, width, height } });
  }

  /**
   * Ask a pan+zoom camera to auto-track a moving vessel (or stop). Sends the
   * intent; the sidecar holds the chosen mode per camera and publishes it in
   * `CameraState.trackMode`, so the UI must reflect that server-confirmed value
   * rather than this call (two browsers stay in agreement). While tracking, the
   * camera also auto-zooms; `TrackMode.None` hands aiming/zoom back.
   */
  async setTrackTarget(flightId: number, mode: TrackMode): Promise<void> {
    await this._send({ type: "set-track-target", content: { flightId, mode } });
  }

  /**
   * Internal — resolves the effective noise enabled state for a camera,
   * merging the per-camera override (if any) with the client-level default.
   */
  _resolveNoise(override: Partial<NoiseConfig> | null): boolean {
    if (override?.enabled !== undefined) return override.enabled;
    return this.cfg.noise?.enabled !== false; // default: enabled
  }

  /**
   * Internal — sends a typed `ClientMessage` over the control
   * channel. Drops silently if the channel hasn't opened yet (and
   * logs to console). Public on the camera handle, but consumers
   * shouldn't need to call this directly.
   */
  async _send(msg: ClientMessage): Promise<void> {
    if (!this.control) {
      throw new Error("[kerbcast] control channel not open");
    }
    this.control.send(JSON.stringify(msg));
  }

  // -- private --

  private getOrCreateHandle(flightId: number): CameraHandle {
    let handle = this.handles.get(flightId);
    if (!handle) {
      handle = new CameraHandle(flightId, this);
      this.handles.set(flightId, handle);
    }
    return handle;
  }

  private handleTrack(
    track: MediaStreamTrack,
    idx: number,
    mid: string,
  ): void {
    if (this.dynamicMode) {
      // Store the slot's track keyed by mid; bind it to a camera if (or once)
      // a SlotMap names this mid. Track and SlotMap can arrive in either
      // order — whichever lands second triggers the binding.
      this.trackByMid.set(mid, track);
      const flightId = this.flightByMid.get(mid);
      if (flightId !== undefined) {
        this.getOrCreateHandle(flightId)._setMediaStream(
          new MediaStream([track]),
        );
      }
      return;
    }
    // Legacy: m-line index maps to the requested camera list.
    const flightId = this.requestedOrder[idx];
    if (flightId === undefined) return;
    // Record the raw track id so inboundVideoStats() can match it against
    // the report's trackIdentifier field.
    if (track.id) this.flightByTrackId.set(track.id, flightId);
    this.getOrCreateHandle(flightId)._setMediaStream(new MediaStream([track]));
  }

  private handleServerMessage(raw: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch (err) {
      this.emit("error", {
        message: err instanceof Error ? err.message : String(err),
        source: ErrorSource.Client,
      });
      return;
    }
    switch (msg.type) {
      case "hello":
        this._sidecarVersion = msg.content.sidecarVersion;
        this._encoderBackend = msg.content.encoderBackend;
        break;
      case "camera-snapshot":
        this._cameras = msg.content.cameras;
        for (const cam of this._cameras) {
          if (this.getOrCreateHandle(cam.flightId)._setState(cam)) {
            this._resourceHandle(cam.flightId);
          }
        }
        this.emit("cameras-change", this._cameras);
        break;
      case "camera-state-changed": {
        const next = this._cameras.filter(
          (c) => c.flightId !== msg.content.state.flightId,
        );
        next.push(msg.content.state);
        next.sort((a, b) => a.flightId - b.flightId);
        this._cameras = next;
        if (
          this.getOrCreateHandle(msg.content.state.flightId)._setState(
            msg.content.state,
          )
        ) {
          this._resourceHandle(msg.content.state.flightId);
        }
        this.emit("cameras-change", this._cameras);
        break;
      }
      case "slot-map": {
        const { mid, flightId } = msg.content;
        const prev = this.flightByMid.get(mid);
        if (flightId == null) {
          // Slot freed — the camera that held it loses its stream.
          if (prev !== undefined) {
            this.getOrCreateHandle(prev)._setMediaStream(null);
          }
          this.flightByMid.delete(mid);
        } else {
          // A switch (a different camera held this slot) clears the old one.
          if (prev !== undefined && prev !== flightId) {
            this.getOrCreateHandle(prev)._setMediaStream(null);
          }
          this.flightByMid.set(mid, flightId);
          const track = this.trackByMid.get(mid);
          if (track) {
            this.getOrCreateHandle(flightId)._setMediaStream(
              new MediaStream([track]),
            );
          } else {
            // Bound to a slot but the track hasn't arrived yet (the
            // camera-switch gap). Drive the incoming handle sourceless so it
            // shows static rather than going blank until the track lands.
            this.getOrCreateHandle(flightId)._setMediaStream(null);
          }
        }
        break;
      }
      case "adaptive-shed":
        this.emit("adaptive-shed", msg.content);
        break;
      case "error":
        this.emit("error", msg.content);
        break;
      case "ping":
        /*
         * A ping can race a closing channel (disconnect mid-flight); a
         * pong that can't be delivered is moot, not an error.
         */
        void this._send({ type: "pong" }).catch(() => {});
        this.emit("ping", undefined);
        break;
      case "settings-state":
        this._throttleMainScreen = msg.content.throttleMainScreen;
        /*
         * Capture clock: null captureUt means "no clock" (absent field).
         * Epoch is retained across pushes that omit it (only a present
         * value updates it); warpRate falls back to 1 when absent.
         */
        this._captureUt = msg.content.captureUt ?? null;
        if (msg.content.captureEpoch != null) {
          this._captureEpoch = msg.content.captureEpoch;
        }
        this._warpRate = msg.content.timeWarpRate ?? 1;
        this.emit("settings-change", msg.content);
        break;
      case "scene-state-changed":
        this._inFlight = msg.content.inFlight;
        /* Re-drive every handle: out of flight, sourceless feeds go blank
           instead of showing static. Scene state carries no per-camera
           state, so nudge each handle to re-evaluate its presentation. */
        for (const handle of this.handles.values()) {
          handle._refreshSceneState();
        }
        this.emit("scene-change", this._inFlight);
        break;
    }
  }

  /**
   * Re-source a resurrected camera's handle from the track the client still
   * holds for its slot. Called when {@link KerbcastCameraHandle._setState}
   * reports a Destroyed -> Active transition: the sidecar rebinds the same
   * track without a new slot-map, so nothing else drives the handle back out
   * of the sourceless (static) state it entered on destroy.
   */
  private _resourceHandle(flightId: number): void {
    for (const [mid, boundFlightId] of this.flightByMid) {
      if (boundFlightId !== flightId) continue;
      const track = this.trackByMid.get(mid);
      if (track) {
        this.getOrCreateHandle(flightId)._setMediaStream(
          new MediaStream([track]),
        );
      }
      return;
    }
  }

  private setState(state: KerbcastConnectionState): void {
    if (this._state === state) return;
    this._state = state;
    this.emit("state-change", state);
  }

  /**
   * Inbound RTP video statistics keyed by flight ID. Returns an empty map
   * when not connected or when the transport does not implement `getStats`.
   *
   * Iterates the stats report and matches `inbound-rtp` + `kind === "video"`
   * entries to cameras. Legacy mode matches by `trackIdentifier`; dynamic
   * mode falls back to the `mid` field when `trackIdentifier` is absent
   * (modern browsers include it; some implementations omit it).
   */
  async inboundVideoStats(): Promise<Map<number, InboundVideoStats>> {
    const result = new Map<number, InboundVideoStats>();
    if (!this.peer?.getStats) return result;

    let report: RTCStatsReport;
    try {
      report = await this.peer.getStats();
    } catch {
      return result;
    }

    report.forEach((raw) => {
      if (raw.type !== "inbound-rtp" || raw.kind !== "video") return;
      const entry = raw as {
        type: string;
        kind: string;
        trackIdentifier?: string;
        mid?: string;
        packetsReceived?: number;
        bytesReceived?: number;
        framesReceived?: number;
        framesDecoded?: number;
        jitter?: number;
        framesPerSecond?: number;
      };

      // Resolve the flightId: trackIdentifier wins (legacy path populated it),
      // mid fallback covers dynamic mode and browsers that omit trackIdentifier.
      let flightId: number | undefined;
      if (entry.trackIdentifier) {
        flightId = this.flightByTrackId.get(entry.trackIdentifier);
      }
      if (flightId === undefined && entry.mid) {
        flightId = this.flightByMid.get(entry.mid);
      }
      if (flightId === undefined) return;

      result.set(flightId, {
        packetsReceived: entry.packetsReceived ?? 0,
        bytesReceived: entry.bytesReceived ?? 0,
        framesReceived: entry.framesReceived,
        framesDecoded: entry.framesDecoded,
        jitter: entry.jitter,
        framesPerSecond: entry.framesPerSecond,
      });
    });

    return result;
  }

  private tearDownStreams(): void {
    this.flightByTrackId.clear();
    for (const handle of this.handles.values()) {
      handle._teardown();
    }
  }
}
