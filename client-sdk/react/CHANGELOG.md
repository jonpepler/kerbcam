# Changelog

## 1.8.0 - 2026-07-28

### Added

- `useRecordings`: a reactive recordings store over the SDK's
  `client.recording` controller. Exposes finished standalone clips
  (`recordings`), synchronised sets (`groups`), and in-progress recordings
  (`active`, for a REC dot + elapsed timer), plus `start` / `stop` /
  `startGroup` / `stopGroup` / `discard` / `discardGroup` / `isRecording`. This
  is the headless data layer the recordings tray + REC controls sit on; it owns
  no chrome and keeps grouped clips out of the singles list
- `RecordingsStore` and `ActiveRecordingInfo` types

## 1.7.0 - 2026-07-24

Crew face cameras, auto-resolution, and camera targeting.

### Added

- `KerbalFaceFeed`: a single-kerbal face-camera primitive. Renders one crew
  face in a square frame, keyed by `flightId`, and never remounts its `<video>`
  on re-layout. Composable via `children` (name label, badge, custom overlays)
  and an `actions` bar.
- Low-level auto-resolution primitives, for CUSTOM feed surfaces only (not
  needed for normal use, since the feed components self-measure):
  `useReportDisplaySize`, `createClientDisplaySizes`, `useKerbcastDisplaySizes`,
  the `KerbcastDisplaySizes` type, and a `displaySizes` override on
  `KerbcastProvider`.
- `showActions?: boolean` (default true) on `CameraFeed` and `KerbalFaceFeed` to
  suppress the hover action bar without affecting resolution reporting.
- `reportSize?: boolean` (default true) on `KerbalFaceFeed` to opt a
  fixed-resolution face out of auto-resolution.
- `enableTracking?: boolean` (default false) on `CameraFeed`: a tri-state
  auto-track control (off / active-vessel / target) on pan+zoom cameras,
  highlighted from the server-published `CameraState.trackMode`.
- `cameraFilter?: (camera) => boolean` on `CameraFeed` to narrow the selectable
  set (picker menu, stepper, auto-latch). Omit to consider every camera.
- `--kerbcast-action-active` theme token: the fill for every active action-row
  toggle (tracking, quality, PiP, fullscreen, custom). Defaults to
  `var(--kerbcast-accent, #00ff88)`, so one knob recolours them all.

### Changed

- `KerbalFaceFeed` `size` is now LAYOUT-ONLY. It sets the element's size but no
  longer requests a stream resolution: the primitive always self-measures its
  rendered box and reports that (auto-resolution), so resolution follows how
  large the feed is actually shown.
- `CameraFeed` with `renderSize="auto"` (the default) now reports its measured
  display size for auto-resolution instead of writing a 16:9 operator render
  size. `renderSize="none"` opts out.
- `CameraFeed` auto-disables its manual pan/zoom controls while the camera's
  published `trackMode` is not `none` (they no-op against a live track and the
  rate/drag path otherwise jitters).

## 0.12.0 - 2026-06-07

Initial release. Versioned in lockstep with `@jonpepler/kerbcast` and the
sidecar binary.

### Added

- `CameraFeed`: the full-bleed camera feed component extracted from gonogo's
  dashboard widget. Hover/tap-revealed chrome, camera picker menu, Next/Prev
  step buttons, map-style zoom rod (hold-to-zoom buttons + debounced absolute
  FoV slider), pan pad with discrete arrows and an analog drag ball, SIGNAL
  LOST overlay, optional debug readout, automatic 16:9 render sizing via
  ResizeObserver.
- `CameraFeedHandle` imperative ref (`stepCamera`, `setZoomRate`,
  `setPanAxis`, `nudgeZoom`, `nudgePan`) for host platforms that drive the
  feed from their own input systems.
- `KerbcastProvider` / `useKerbcastClient` context carrying the
  `KerbcastClient`, plus a pluggable `KerbcastSubscriptions` seam with a
  refcounting default (`createClientSubscriptions`).
- `useKerbcastCameras` and `useKerbcastStream` hooks.
- `buildCameraLabeler` and `isCameraDestroyed` utilities.
- Theming hooks: accent colors read `--kerbcast-accent` /
  `--kerbcast-accent-wash` CSS custom properties with the original values as
  fallbacks.
