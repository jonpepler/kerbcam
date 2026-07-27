/**
 * KerbalFaceFeed — the shared single-kerbal-face primitive.
 *
 * Renders ONE kerbal's face-camera stream in a fixed SQUARE frame. It is the
 * reusable building block a crew bar (kerbcast web) or a mission-control
 * surface (gonogo) composes: identity-keyed by `flightId`, it binds the live
 * `MediaStream` to a persistent `<video>` and NEVER remounts that element on
 * re-layout (the "never remount a live feed" rule — the same srcObject-via-ref
 * technique `CameraFeed` uses).
 *
 * Deliberately minimal chrome: just the square live face plus a standby glyph
 * when there is no live signal. Everything else — name label, IVA/EVA badge,
 * click behaviour, a "SIGNAL LOST" treatment — is layered OVER it by the
 * wrapper via `children`, driven by the `onFeedStateChange` signal. A thin
 * `actions` bar (the shared `FeedAction` shape) is rendered top-right when a
 * wrapper supplies one, so declarative controls compose the same way they do
 * on `CameraFeed`.
 */

import { useEffect, useRef, useState } from "react";
import styled from "styled-components";

import { CameraStreamHook, FeedAction } from "./CameraFeed";
import { FeedActionBar, feedActionToEntry } from "./FeedActionBar";
import { useKerbcastStream } from "./hooks/useKerbcastStream";
import { useKerbcastCameras } from "./hooks/useKerbcastCameras";
import { useReportDisplaySize } from "./hooks/useReportDisplaySize";
import { isCameraDestroyed } from "./lifecycle";
import { StandbyIcon } from "./StandbyIcon";

/**
 * Coarse presentation state a wrapper reacts to for its own fallback/badge:
 * - `live`: a stream is bound and playing.
 * - `no-signal`: no stream yet (connecting, out of flight, or not visible).
 * - `destroyed`: the camera's part/kerbal is gone (the wrapper renders SIGNAL
 *   LOST; the last frame stays on-screen because the `<video>` is not cleared).
 */
export type KerbalFeedState = "live" | "no-signal" | "destroyed";

export interface KerbalFaceFeedProps {
  /** Wire-id (`CameraState.flightId`) of the kerbal face camera to display. */
  flightId: number;
  /**
   * Explicit square side in px, for LAYOUT only. When omitted the feed fills
   * its parent's width at a 1:1 aspect ratio. This does NOT drive resolution:
   * the primitive always self-measures its rendered box and reports that to the
   * sidecar (auto-resolution). Pass it to fix the element's size, not to
   * request a stream resolution.
   */
  size?: number;
  /**
   * Report the self-measured display size to the sidecar to drive
   * auto-resolution. Default true. Set false for a fixed-resolution feed that
   * should not participate in auto-res. Independent of {@link showActions}
   * (a resolution concern, not a UI one).
   */
  reportSize?: boolean;
  /**
   * Consumer action buttons, rendered as a minimal top-right bar (the shared
   * {@link FeedAction} shape). Omit for no bar — the common case, since a crew
   * bar usually composes its controls in `children` instead.
   */
  actions?: FeedAction[];
  /**
   * Render the feed's action UI (the top-right action bar). Default true. Set
   * false to suppress the bar entirely (e.g. a tiny avatar where hover controls
   * add nothing). Does not affect display-size reporting.
   */
  showActions?: boolean;
  /**
   * Overlay content layered OVER the square face: name label, IVA/EVA badge,
   * click target, a custom destroyed treatment. Absolutely positioned to fill
   * the frame; the primitive keeps its own chrome out of the way.
   */
  children?: React.ReactNode;
  /**
   * Fired whenever the derived feed state changes, so the wrapper can swap its
   * fallback/badge without polling. Fires once on mount with the initial state.
   */
  onFeedStateChange?: (state: KerbalFeedState) => void;
  /**
   * Draw the built-in standby glyph while not `live`. Default true. Set false
   * when the wrapper renders its own out-of-signal overlay (so it isn't drawn
   * twice); the frame then just stays dark / holds the last frame.
   */
  showStandby?: boolean;
  /**
   * Override how the stream is sourced (delayed playout, alternate transport).
   * Must be a stable reference passed consistently across renders — it is
   * called as a hook. Omit to use the built-in {@link useKerbcastStream}.
   */
  useStream?: CameraStreamHook;
}

const Frame = styled.div<{ $size?: number }>`
  position: relative;
  ${(p) => (p.$size != null ? `width: ${p.$size}px; height: ${p.$size}px;` : "width: 100%;")}
  aspect-ratio: 1 / 1;
  overflow: hidden;
  background: #000;
  border-radius: 4px;
`;

const Face = styled.video`
  width: 100%;
  height: 100%;
  /* Cover the square: the portrait fills the frame, cropping the excess,
     rather than letterboxing — a face tile reads best edge-to-edge. */
  object-fit: cover;
  display: block;
`;

const StandbyLayer = styled.div`
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgba(255, 255, 255, 0.35);
  pointer-events: none;
`;

const DestroyedScrim = styled.div`
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  pointer-events: none;
`;

const OverlayLayer = styled.div`
  position: absolute;
  inset: 0;
`;

/*
 * The shared FeedActionBar is hover-revealed by default (CameraFeed's larger
 * frame fades it in on hover/focus). A tiny face tile has no such affordance,
 * so this override keeps the original always-visible, corner-hugging look;
 * layout/button styling (flex row, gap, the shared OverlayIconButton) still
 * comes from FeedActionBar itself.
 */
const KerbalActionBarRow = styled(FeedActionBar)`
  top: 4px;
  right: 4px;
  opacity: 1;
  pointer-events: auto;
`;

export function KerbalFaceFeed({
  flightId,
  size,
  reportSize = true,
  actions,
  showActions = true,
  children,
  onFeedStateChange,
  showStandby = true,
  useStream,
}: KerbalFaceFeedProps) {
  // Match CameraFeed: the built-in hook (which acquires/releases the
  // subscription slot) runs only when no override is supplied.
  const resolveStream = useStream ?? useKerbcastStream;
  const stream = resolveStream(flightId);

  // The camera's lifecycle comes from the registry snapshot; destroyed cameras
  // linger in the list so the wrapper can show SIGNAL LOST.
  const cameras = useKerbcastCameras();
  const destroyed = cameras.some((c) => c.flightId === flightId && isCameraDestroyed(c));

  const state: KerbalFeedState = destroyed
    ? "destroyed"
    : stream
      ? "live"
      : "no-signal";

  // Self-measure the square frame and report it to the sidecar (auto-res).
  // Reporting follows the mount lifecycle; the registry collapses multiple
  // feeds of the same kerbal to one MAX report.
  const frameRef = useRef<HTMLDivElement>(null);
  useReportDisplaySize(flightId, frameRef, { square: true, enabled: reportSize });

  // Bind the stream to the persistent <video> without remounting it — the
  // element stays mounted across every re-layout / prop change, only its
  // srcObject is (re)assigned. A stall (stream -> null) leaves the last frame.
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  // Notify the wrapper on every state transition (and once on mount).
  const notify = useRef(onFeedStateChange);
  notify.current = onFeedStateChange;
  useEffect(() => {
    notify.current?.(state);
  }, [state]);

  return (
    <Frame ref={frameRef} $size={size} data-testid="kerbal-face-feed" data-feed-state={state}>
      <Face ref={videoRef} autoPlay playsInline muted controls={false} />
      {state === "destroyed" && <DestroyedScrim />}
      {showStandby && state !== "live" && (
        <StandbyLayer>
          <StandbyIcon size={Math.round((size ?? 96) * 0.32)} />
        </StandbyLayer>
      )}
      {showActions && actions && actions.length > 0 && (
        <KerbalActionBarRow entries={actions.map(feedActionToEntry)} />
      )}
      {children && <OverlayLayer>{children}</OverlayLayer>}
    </Frame>
  );
}
