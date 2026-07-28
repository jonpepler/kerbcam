// Re-export every type the typeshare codegen emits from the Rust
// protocol module. New code should prefer the higher-level
// `KerbcastClient` re-exported below, but the underlying wire types
// stay available for consumers that want to roll their own transport.
export * from "./__generated__/types";

export {
  KerbcastClient,
  BrowserKerbcastTransport,
  type BrowserKerbcastTransportOptions,
  type InboundVideoStats,
  type KerbcastCameraHandle,
  type KerbcastClientConfig,
  type KerbcastConnectionState,
  type KerbcastClientEvents,
  type KerbcastCameraEvents,
  type KerbcastTransport,
  type KerbcastPeer,
  type KerbcastDataChannel,
  type DiscoveredCamera,
  type NoiseConfig,
} from "./client";

export {
  PanZoomController,
  type PanZoomCommandSink,
  type PanZoomBounds,
  type PanZoomControllerOptions,
} from "./panZoom";

export {
  RecordingController,
  createMediabunnyTrimmerLoader,
  negotiateMimeType,
  commonUtWindow,
  utToRecordingTimeMs,
  DEFAULT_COVERAGE_TIMEOUT_MS,
  ARM_TIMEOUT_MS,
  type ActiveRecordingInfo,
  type RecordingClient,
  type RecordingControllerOptions,
  type RecordingHandle,
  type RecordingsSnapshot,
  type GroupedRecordingHandle,
  type GroupedRecordingStart,
  type GroupTrimmer,
  type TrimmerLoader,
  type UtSample,
  type StartRecordingOptions,
  type StopGroupedRecordingOptions,
} from "./recording";
