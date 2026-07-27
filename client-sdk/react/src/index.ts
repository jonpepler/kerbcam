/**
 * @ksp-gonogo/kerbcast-react
 *
 * React components and hooks for kerbcast camera feeds. This package
 * is a peer to @ksp-gonogo/kerbcast (the core SDK) and requires React 18+
 * and styled-components 6+ as peer dependencies.
 */

// Context and provider
export {
  KerbcastProvider,
  createClientSubscriptions,
  createClientDisplaySizes,
  useKerbcastClient,
  useKerbcastSubscriptions,
  useKerbcastDisplaySizes,
} from "./context";
export type {
  KerbcastProviderProps,
  KerbcastSubscriptions,
  KerbcastDisplaySizes,
} from "./context";

// Hooks
export { useKerbcastCameras } from "./hooks/useKerbcastCameras";
export { useKerbcastStream } from "./hooks/useKerbcastStream";
export { useKerbcastClock } from "./hooks/useKerbcastClock";
export { useKerbcastInFlight } from "./hooks/useKerbcastInFlight";
export { useReportDisplaySize } from "./hooks/useReportDisplaySize";
export { useRecordings } from "./hooks/useRecordings";
export type { RecordingsStore, ActiveRecordingInfo } from "./hooks/useRecordings";

// Shared elapsed-timer helpers (REC badges, RecGroupBar's toolbar)
export { nowMs, formatElapsed } from "./timing";

// Shared standby glyph (used by CameraFeed + downstream dashboards)
export { StandbyIcon } from "./StandbyIcon";

// Camera label utilities
export { buildCameraLabeler } from "./cameraLabels";
export type { LabelableCamera } from "./cameraLabels";

// Lifecycle utilities
export { getCameraLifecycle, isCameraDestroyed } from "./lifecycle";
export type { CameraLifecycle } from "./lifecycle";

// CameraFeed component
export { CameraFeed } from "./CameraFeed";
export type {
  CameraFeedHandle,
  CameraFeedProps,
  CameraStreamHook,
  FeedAction,
} from "./CameraFeed";

// FeedActionBar: the shared action row (tracking, fullscreen, PiP, quality,
// close, REC) both CameraFeed and KerbalFaceFeed render, with the issue-#6
// overflow (⋮) engine.
export { FeedActionBar } from "./FeedActionBar";
export type { FeedActionBarEntry } from "./FeedActionBar";

// KerbalFaceFeed — shared single-kerbal-face primitive
export { KerbalFaceFeed } from "./KerbalFaceFeed";
export type { KerbalFaceFeedProps, KerbalFeedState } from "./KerbalFaceFeed";

// RecordingsTray: a presentational drawer over the recordings store
export { RecordingsTray } from "./RecordingsTray";
export type { RecordingsTrayProps } from "./RecordingsTray";
