# Changelog

## 1.8.0 - 2026-07-28

Client-side camera recording. The capture itself is pure SDK: the recorder taps
a track the browser has already received, and the sidecar never learns a
recording happened. Full-resolution recording is the exception, and it does
reach the wire: it added the `SetForceFullResolution` control message to the
protocol, plus the matching force-pin handling in the sidecar's camera
registry.

### Added

- `KerbcastClient.recording`: a `RecordingController` that records a camera's
  already-received WebRTC track with the browser's `MediaRecorder`, entirely
  client-local (the sidecar never learns a recording happened)
- Per-feed API: `startRecording(flightId, opts?)` returns a client-minted
  `recordingId`; `stopRecording(recordingId)` resolves a `RecordingHandle`;
  `fetchRecording` / `discardRecording` / `isRecording`
- `RecordingHandle = { recordingId, blob, mimeType, utStart?, utEnd?,
  utSamples, byteSize, durationMs }`, where `utSamples` is a ~1Hz
  (recording-time, UT) series so a consumer can interpolate any frame's
  mission-time near-frame-tight; out of flight it falls back to wall-clock
  timing (`ut` absent) and upgrades automatically once UT appears
- Mime negotiation prefers `video/mp4;codecs=avc1` where
  `MediaRecorder.isTypeSupported`, else `video/webm;codecs=vp9`, else
  `video/webm`; the chosen type is on the handle. `opts.maxDurationMs` auto-stops
- Grouped API: `startGroupedRecording(flightIds, opts?)` (all recorders open in
  one tick) and `stopGroupedRecording(groupId, { targetUt? })`. `targetUt`
  enforces a coverage guarantee: finalization waits until every feed's latest
  UT sample passes it, so no feed falls short of the common window
- `GroupedRecordingHandle = { groupId, recordings, commonUtWindow? }`, where
  `commonUtWindow` is the intersection of the feeds' `[utStart, utEnd]`
- Grouped clips are physically remux-trimmed to `commonUtWindow` by default
  (keyframe-boundary cut, no re-encode) via a lazily `import()`-ed Mediabunny,
  loaded only on grouped-record start (single recordings stay dependency-free);
  a clip that can't be cut cleanly (webm, or a remux error) degrades to
  metadata-only and never fails the recording. `utSamples` + `commonUtWindow`
  still ride along after trimming so a consumer can align to telemetry
- Helpers `negotiateMimeType`, `commonUtWindow`, `utToRecordingTimeMs`
- `StubMediaRecorder`: a jsdom `MediaRecorder` shim installed by
  `installDomStubs`, so the full record -> UT-sample -> stop -> handle path is
  headless-testable (its `isTypeSupported` is controllable for mime tests)
- `mediabunny` as a dependency, dynamically imported for grouped-clip trimming
  only (never pulled by single recordings or non-recording consumers)

## 1.7.0 - 2026-07-24

Crew face cameras, auto-resolution, and camera targeting.

### Added

- `KerbcastClient.reportDisplaySize(flightId, width, height)`: report a
  consumer's own displayed pixel size for a camera. The sidecar aggregates it
  MAX-across-consumers to drive auto-resolution (distinct from `setRenderSize`,
  which is the shared operator cap).
- `KerbcastClient.setTrackTarget(flightId, mode)`: ask a pan+zoom camera to
  auto-track a moving vessel, or stop.
- `TrackMode` type (`"none" | "activeVessel" | "target"`).
- `trackMode?: TrackMode` on `CameraState` (WS push) and `CameraInfo`
  (`GET /cameras`), server-authoritative so every consumer reflects the same
  tracking state.
- `MockSidecar` accepts the new `report-display-size` and `set-track-target`
  client messages (records them; `report-display-size` is advisory and does not
  mutate render dims).
- `MockCameraInit` gains `kind`, `crewLocation`, `kerbalPersistentId`, and
  `trackMode` for building crew and tracking fixtures.

## 0.12.0 - 2026-06-07

### Added

- `BrowserKerbcastTransport` accepts an options object with `iceGatheringTimeoutMs`
  (default 2000 ms). `waitForIceComplete` now resolves at the earlier of gathering
  completing or the timeout, so connect does not stall the full STUN timeout on
  LAN topologies where the STUN server is unreachable.
- `KerbcastClientConfig.iceGatheringTimeoutMs` threads the timeout into the default
  transport when no custom transport is provided.
- `BrowserKerbcastTransportOptions` exported from the package root.
- `KerbcastPeer.getStats?()` optional method; `BrowserKerbcastTransport` implements
  it via `RTCPeerConnection.getStats(null)`. Third-party transports and existing
  mocks keep compiling without changes.
- `KerbcastClient.inboundVideoStats()` returns a `Map<number, InboundVideoStats>`
  keyed by flightId. Resolves to an empty map when not connected or when the
  transport does not implement `getStats`.
- `InboundVideoStats` type exported from the package root.
- `MockSidecar.setInboundStats(flightId, partialStats)` configures the stats the
  fake `getStats()` returns, keyed by track id (legacy mode) or mid (dynamic mode).
- `DiscoveredCamera` widened to match the full `GET /cameras` payload: added
  `lifecycle`, `panYawMin`, `panYawMax`, `panPitchMin`, `panPitchMax`,
  `encoderBitrateBps`, `targetBitrateBps`, `degradeLevel`. `maxWidth`/`maxHeight`
  were already present. Additive -- existing consumers that destructure only
  the previous fields continue working unchanged.
- `PanZoomController` headless state machine for pan/zoom camera control.
  Manages rate deduplication, analog deadzone, optimistic nudge accumulators,
  FoV slider debounce, and echo-sync idle rules. `KerbcastCameraHandle`
  satisfies `PanZoomCommandSink` structurally. Exported from the package root
  along with `PanZoomCommandSink`, `PanZoomBounds`, and `PanZoomControllerOptions`.

## 0.3.1 — 2026-05-21

Export `KerbcastTransport`, `KerbcastPeer`, `KerbcastDataChannel` from
the package root. 0.3.0 introduced these as a public extension
point for tests and non-browser consumers but didn't re-export
them, so the only way to reference the types was a deep import
into `dist/client.d.ts`. Strictly additive — no behaviour change.


## 0.3.0 — 2026-05-21

High-level `KerbcastClient` class wraps the WebRTC peer, the
`kerbcast-control` data channel, per-camera state cache, and
per-track `MediaStream`s. Consumers no longer hand-roll
`RTCPeerConnection`, build JSON wire messages, or thread SDP offers
through `fetch`.

```ts
import { KerbcastClient, Layer } from "@jonpepler/kerbcast";

const client = new KerbcastClient({ host: "192.168.1.74", port: 8088 });
await client.connect();

const cam = client.camera(2592004302);
await cam.setLayers([Layer.Near, Layer.Scaled]);
await cam.setFov(35);
await cam.setDegrade(0.5);

document.querySelector("video")!.srcObject = cam.mediaStream;

cam.on("change", (state) => { /* per-camera state delta */ });
client.on("adaptive-shed", (e) => { /* shed level + reason */ });
```

### Added

- `KerbcastClient` owns the peer, control channel, and registry of
  cameras. `connect(flightIds?)`, `disconnect()`, `camera(flightId)`,
  `discover()`.
- `KerbcastCameraHandle` exposes `setLayers`, `setRenderSize`,
  `setFov`, `setPan`, `setDegrade`, `requestKeyframe`, plus a
  `mediaStream` getter that yields the per-camera `MediaStream`
  once the track arrives.
- Typed event API on both `KerbcastClient`
  (`state-change` / `cameras-change` / `adaptive-shed` / `error`)
  and `KerbcastCameraHandle` (`change` / `stream`). Subscribing
  returns an unsubscribe function.
- `KerbcastTransport` interface — swappable transport for tests and
  non-browser consumers. Default `BrowserKerbcastTransport` uses
  `RTCPeerConnection`.
- `client.discover()` fetches the sidecar's `/cameras` listing
  without opening a peer connection, for picking a subset to
  `connect()` with.

### Restructured

- Generated wire-format types moved from `src/index.ts` to
  `src/__generated__/types.ts`. `src/index.ts` is now hand-written
  and re-exports both the generated types and the new client.
- Consumers that imported types from the package root keep working
  (`import { ClientMessage } from "@jonpepler/kerbcast"` still
  resolves to the same wire-format types).

Version line is shared with the Rust sidecar (`sidecar/Cargo.toml`).
CI verifies the two agree before any publish.

## 0.2.0 — 2026-05-21

New `set-degrade` client message and matching `degradeLevel` field
on `CameraState`. Lets consumers request artificial signal
degradation per camera (e.g. when in-game CommNet signal weakens);
sidecar applies `max` across active subscribers and squeezes the
encoder bitrate + skips a fraction of frames to produce the
macroblocking + stuttering aesthetic of real signal loss. Also a
real CPU optimisation: if every consumer wants degraded video, the
encoder runs lighter.

```ts
const msg: ClientMessage = {
  type: "set-degrade",
  content: { flightId: 2592004302, level: 0.7 },
};
dc.send(JSON.stringify(msg));
```

### Wire-format additions

- `ClientMessage::SetDegrade { flightId, level }` — level clamps to
  `[0.0, 1.0]`; out-of-range values are clamped by the sidecar.
- `CameraState.degradeLevel` — sidecar-pushed effective degrade
  (max across subscribers).

Additive: existing 0.1.0 consumers keep working — they just don't
see the new field unless they read it.

## 0.1.0 — 2026-05-21

Initial release as `@jonpepler/kerbcast` on GitHub Packages.
TypeScript bindings for the kerbcast sidecar's WebRTC data-channel
protocol, generated from Rust types via
[typeshare](https://github.com/1Password/typeshare).

### Client → server messages

- `hello` — handshake; server replies with `Hello` + `CameraSnapshot`.
- `set-layers` — operator layer mask per camera (`NEAR` / `SCALED` /
  `GALAXY`).
- `set-render-size` — operator capture dimensions per camera (even
  pixels, capped at the ring's allocated max).
- `set-fov` — operator FoV in degrees (silently rejected for fixed-FoV
  parts; clients should clamp to `fovMin`/`fovMax` from the camera's
  `CameraState`).
- `set-pan` — reserved for the future Hullcam VDS pan/tilt extension.
  Rejected today on every shipping part (`supportsPan == false`).
- `request-keyframe` — recover the H.264 stream after packet loss.

### Server → client messages

- `hello` — reply to client `hello` with sidecar version + encoder
  backend name.
- `camera-snapshot` — full state of every currently-attached camera.
  Sent on handshake and after structural changes (vessel switch, ring
  added / removed).
- `camera-state-changed` — single-camera delta on operator request or
  adaptive event.
- `adaptive-shed` — KSP-FPS adaptive shedding level changed; carries a
  human-readable `reason` so client UIs can show *why* quality
  changed rather than just *that* it did.
- `error` — malformed / invalid client message.

### Per-camera capabilities

`CameraState` exposes feature flags so clients can render controls
only for what each part advertises:

- `supportsZoom`, `fov`, `fovMin`, `fovMax` — true for parts whose
  Hullcam module is `MuMechModuleHullCameraZoom` (19 of 21 stock
  Hullcam VDS parts).
- `supportsPan`, `panYawMin`/`Max`, `panPitchMin`/`Max`, `panYaw`,
  `panPitch` — reserved; always false on shipping parts.
- `encoderBitrateBps`, `targetBitrateBps` — current encoder bitrate
  and REMB-driven target. Diverge briefly when receivers' bandwidth
  estimates move; converge after the consume loop's next bitrate
  threshold check.

### Wire format

JSON-per-message over an `RTCDataChannel` labelled `kerbcast-control`,
opened by the browser after SDP exchange completes. Messages use
adjacent tagging — `{ "type": "set-layers", "content": { ... } }` —
because that's the discriminator shape typeshare can faithfully model
across TypeScript / Kotlin / Swift / Scala / Go. Unit variants
(`hello`) carry no `content`.
