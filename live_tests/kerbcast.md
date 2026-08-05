# Live-testing kerbcast

Script-testable reference for verifying a running kerbcast sidecar — written so
a Claude session (or a human with curl) can check a live instance without
re-deriving the protocol from source. The canonical definitions live in
`sidecar/src/protocol/mod.rs` and `sidecar/src/signalling.rs`; if this file
and the source disagree, the source wins — and this file should be fixed.

## Spinning up a sidecar without KSP

```sh
cd sidecar
cargo run --example fake_camera -- /tmp/kerbcast-test-rings 101 "NavCam" &
cargo run --bin kerbcast-sidecar -- --shm-dir /tmp/kerbcast-test-rings --encoder software
```

`fake_camera` writes `<flight_id>.info.json` + `<flight_id>.ring` and keeps
producing an animated test pattern, exactly like the plugin's writer side.
Run several with distinct flight IDs for multi-camera tests. Ring geometry
must match the sidecar defaults (4 slots, 1024×576 max).

Against a real KSP install, the sidecar runs once per KSP session: the first
flight scene spawns it and it stays up across scene changes, reverts, and
trips through the KSC until KSP exits (KerbcastSidecarHost owns the process;
the per-flight KerbcastCore only registers/unregisters cameras). The default
endpoint is `127.0.0.1:8088` (settings.cfg `BindAddress` / `Port`).

### Session lifecycle / orphan protection

- A scene change shows up in the sidecar log as `camera ring removed (normal
  teardown)` for every camera, then `camera ring attached` when the next
  flight loads. Peers are NOT torn down; each gets a fresh `camera-snapshot`
  push on any ring churn, and slots still bound to a re-attached flight id
  log `re-attached camera rebound to surviving peer subscriptions` and
  resume streaming without a browser-side re-subscribe.
- The plugin touches `<shm-dir>/global.heartbeat` ~1Hz for the whole
  session. Once that file has been seen, a stale mtime beyond
  `--heartbeat-timeout-secs` (default 90; 0 disables) on two consecutive
  checks makes the sidecar log `plugin heartbeat stale` and exit: that is
  the KSP-crashed-without-killing-us path. The no-KSP harness above never
  writes the file, so the watch never arms there.
- A sidecar crash mid-session is relaunched by the plugin with growing
  backoff (5s, 10s, ...; 5 attempts, budget refunded after 60s of healthy
  uptime); entering a flight scene relaunches immediately.

## HTTP endpoints

All on `--http-bind` (default `127.0.0.1:8088`). CORS is wide open.

| Route | Method | Purpose |
|---|---|---|
| `/` | GET | bundled web UI (embedded `web/dist/index.html`) |
| `/health` | GET | liveness + version — first thing to check |
| `/cameras` | GET | `{ "cameras": [CameraInfo, …] }` for every attached ring |
| `/offer` | POST | WebRTC signalling (see below) |
| `/dumpLogs` | GET | `{ "entries": [StatusLogEntry, …] }` — capped ring of every distinct plugin status snapshot since last reset |
| `/dumpLogs/reset` | POST | clear that ring (perf harnesses call this at run start) |
| `/profile` | GET | profiling state |
| `/profile/render` | POST | force every camera subscribed so the plugin renders without a peer (measures plugin cost only; nothing encodes) |

Quick health pass:

```sh
curl -s http://127.0.0.1:8088/health
curl -s http://127.0.0.1:8088/cameras | python3 -m json.tool
```

Expect `/cameras` to list one entry per camera part on the active vessel
(or per fake_camera), each carrying `flightId`, `partTitle`, `vesselName`,
`supportsZoom`/`fovMin`/`fovMax`, `supportsPan` + ranges, render/operator
dims, and lifecycle.

## WebRTC signalling

`POST /offer` body:

```json
{ "sdp": "<browser offer SDP>", "cameras": [101], "slots": 4 }
```

- `cameras` — initial flight-ID subscriptions. With no `slots`: empty means
  "every known camera" (dev convenience).
- `slots` — number of recv-only video transceivers in the offer. Spare slots
  idle until a runtime `subscribe`. Omitted = legacy one-track-per-camera.

Response: `{ "sdp": "<answer>", "cameras": [101] }` (echo after dropping
unknown IDs). A full WebRTC handshake needs a browser or webrtc library —
from plain curl you can still assert the route exists: a garbage SDP returns
an error status, not a hang.

For a real end-to-end check with a browser available, load `GET /` with
`?mock=0` (the bundled page auto-connects) and confirm a moving test pattern.

## Control data channel (`kerbcast-control`)

JSON messages, envelope `{ "type": "<kebab-case>", "content": { … } }`
(serde `tag = "type", content = "content"`). TypeScript bindings are
generated into `client-sdk/typescript/src/__generated__/types.ts` — that file
is the wire-accurate reference for every payload.

Client → sidecar (`ClientMessage`):

| `type` | content | notes |
|---|---|---|
| `hello` | – | first message; sidecar replies `hello` + `camera-snapshot` + `settings-state` |
| `subscribe` / `unsubscribe` | `{ "flightId": n }` | dynamic slot binding; reply is `slot-map` |
| `set-layers` | `{ "flightId": n, "layers": ["NEAR","SCALED","GALAXY"] }` | server-wide |
| `set-render-size` | `{ "flightId": n, … }` | even pixels only; capped at ring max |
| `set-fov` | `{ "flightId": n, "fov": deg }` | ignored when `supportsZoom == false` |
| `set-pan` | `{ "flightId": n, … }` | absolute; ignored unless `supportsPan == true` (steerable mounts: `DC.TurretCam`, `hc.launchcam`) |
| `set-pan-rate` / `set-zoom-rate` | `{ "flightId": n, … }` | persistent velocity, −1..=1; zero stops; `Error` reply if unsupported |
| `set-degrade` | `{ "flightId": n, "level": 0.0–1.0 }` | max-across-subscribers wins |
| `set-quality` | `{ "flightId": n, "preset": "half" }` | viewer resolution preset (`full`/`threeQuarter`/`half`/`quarter`; omit or null = auto); last write wins; can only lower below the operator ceiling |
| `request-keyframe` | `{ "flightId": n }` | forces IDR next encode tick |
| `set-throttle-main-screen` | `{ … }` | global; persists to the KSP save |
| `pong` | – | reply to each server `ping` |
| `disconnect` | – | graceful teardown; releases all slots immediately |

Sidecar → client (`ServerMessage`): `hello` (version + encoder backend name),
`camera-snapshot` (full `CameraState` array), `camera-state-changed`,
`slot-map` (`mid` ↔ `flightId`/null), `adaptive-shed` (with human-readable
`reason`), `settings-state`, `ping` (every 5 s; client must `pong` — no ping
for 15 s means the client should tear down), `error` (echoes the offending
payload).

## What "healthy" looks like

1. `/health` answers immediately.
2. `/cameras` lists the expected cameras within ~1 s of a ring appearing
   (registry rescans every second).
3. After a peer subscribes: sidecar log shows `per-camera encoder
   initialised` with the expected backend (`libva` on the Deck, `software`
   elsewhere), then steady frame flow — no `encode failed` streaks.
4. Killing a fake_camera writer: the camera goes `destroyed` / disappears
   from `/cameras` and subscribed peers get `camera-state-changed`.
5. SIGTERM (`kill <pid>`) exits promptly — no hang until SIGKILL.
6. Adaptive behaviour: `/dumpLogs` entries carry the kspFps / shedLevel /
   per-camera render-size timeline; `adaptive-shed` messages name a reason.

## Windows Media Foundation smoke test (real hardware only)

The tier-2 `mediafoundation` backend (hardware H.264 encoder MFTs: AMD
VCN, Intel Quick Sync, NVIDIA NVENC all register one) can only be
exercised on a real Windows machine with a GPU; CI runners have no
hardware MFT and correctly fall through to software. To verify on, say,
the RX 9070 XT box:

```powershell
# terminal 1
cd sidecar
cargo run --example fake_camera -- $env:TEMP\kerbcast-test-rings 101 "NavCam"
# terminal 2
cd sidecar
cargo run --bin kerbcast-sidecar -- --shm-dir $env:TEMP\kerbcast-test-rings
```

(no `--encoder` flag: auto-select must pick Media Foundation by itself;
`--encoder mediafoundation` forces it if you need to bypass auto-select
while debugging.)

Checklist:

1. Open `http://127.0.0.1:8088/` in a browser and subscribe to the
   camera. The control channel's `hello` reply carries
   `encoderBackend: "h264 mft (media foundation)"`; with `software` there
   instead, the probe found no hardware MFT (check GPU drivers).
2. Sidecar log shows `per-camera encoder initialised` with
   `backend="h264 mft (media foundation)"`, preceded by a debug-level
   `Media Foundation encoder initialised` line naming the vendor MFT
   (e.g. `AMDh264Encoder`) when run with `RUST_LOG=debug`.
3. The test pattern animates smoothly and `request-keyframe` over the
   control channel recovers the picture (forces an IDR through
   CODECAPI_AVEncVideoForceKeyFrame).
4. No `encode failed` streaks in the log across a few minutes of
   streaming; a streak ending in `encoder dropped after N consecutive
   failures` means the MFT wedged and the session fell back to software
   on reinit, which is worth a bug report with the log attached.

## Cleanup

```sh
pkill -f fake_camera; pkill -f kerbcast-sidecar
rm -rf /tmp/kerbcast-test-rings
```

## Orientation proof (flips)

Settles "is this camera mirrored / upside down?" without eyeballing, per camera,
through the REAL shipped chain — that camera's actual filter material, the
capture blit, the readback flip, the ring write.

1. `EnableOrientationTestPattern = true` in `GameData/Kerbcast/PluginData/settings.cfg`
   (or the main `settings.cfg`), restart KSP, enter flight.
   Every feed becomes a four-quadrant marker: TOP-LEFT darkest, BOTTOM-RIGHT
   brightest. Quadrants differ in LUMINANCE so they survive the monochrome
   filters, and are judged by rank so filter gain does not matter.
2. `python3 live_tests/orientation-check.py $(pgrep -f '[k]erbcast-sidecar')`
   on the Deck. It reads each ring — the delivered output, not a re-render —
   and prints UPRIGHT / VERTICAL FLIP / HORIZONTAL MIRROR / ROTATED 180.
3. Turn the setting back off.

Two traps this design exists to avoid, both of which produced confident wrong
answers first time:

- **Read back the way production does.** The capture tail's flip exists solely
  to cancel the inversion `AsyncGPUReadback` returns on bottom-left-origin APIs.
  Measuring it with `ReadPixels` invents a vertical flip that is not in the
  delivered frame — it will fail a correct pipeline and pass a broken one.
  Reading the ring sidesteps this entirely, which is why the check works there.
- **Do not allocate per frame.** An earlier version took a full-size
  `RenderTexture.GetTemporary` per camera per frame and took KSP down. The
  marker is one cached texture and one `Graphics.Blit` into the capture RT.

Result 2026-08-05 (Deck, glcore, 5 cameras incl. 2 Hullcam-filtered): all
UPRIGHT. The capture chain does not flip.
