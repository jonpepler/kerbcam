import type { CameraState, KerbcastClient } from "@ksp-gonogo/kerbcast";
import { PanZoomController, QualityPreset, TrackMode } from "@ksp-gonogo/kerbcast";
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import styled, { css } from "styled-components";
import { buildCameraLabeler } from "./cameraLabels";
import { KerbcastProvider, useKerbcastClient } from "./context";
import {
  ActionBarRow,
  FeedActionBar,
  OverlayIconButton,
  feedActionToEntry,
  type FeedAction,
  type FeedActionBarEntry,
} from "./FeedActionBar";
import { useKerbcastCameras } from "./hooks/useKerbcastCameras";
import { useKerbcastInFlight } from "./hooks/useKerbcastInFlight";
import { useKerbcastStream } from "./hooks/useKerbcastStream";
import { useRecordings } from "./hooks/useRecordings";
import { useReportDisplaySize } from "./hooks/useReportDisplaySize";
import { StandbyIcon } from "./StandbyIcon";
import { isCameraDestroyed } from "./lifecycle";
import { usePortalMenu } from "./menuPositioning";
import { formatElapsed, nowMs } from "./timing";

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------
const PAN_BALL_RADIUS = 15; // pixel deflection bound (full = rate 1)
const MENU_MAX_WIDTH = 260; // matches CameraMenu's CSS cap
const MENU_MAX_HEIGHT = 300; // matches CameraMenu's min(40vh, 300px) cap
const QUALITY_MENU_MAX_WIDTH = 220; // matches QualityMenu's CSS cap
const QUALITY_MENU_MAX_HEIGHT = 220; // matches QualityMenu's min(40vh, 220px) cap

/*
 * Viewer quality presets, in menu order. Scales mirror the sidecar's
 * QualityPreset mapping (fractions of the camera's operator render size);
 * the target-dims hint floors to even exactly like the plugin does.
 */
const QUALITY_PRESETS: ReadonlyArray<{
  preset: QualityPreset;
  label: string;
  scale: number;
}> = [
  { preset: QualityPreset.Full, label: "Full", scale: 1.0 },
  { preset: QualityPreset.ThreeQuarter, label: "3/4", scale: 0.75 },
  { preset: QualityPreset.Half, label: "1/2", scale: 0.5 },
  { preset: QualityPreset.Quarter, label: "1/4", scale: 0.25 },
];

function presetDim(operatorDim: number, scale: number): number {
  const v = Math.trunc(operatorDim * scale) & ~1;
  return v < 2 ? 2 : v;
}

/*
 * Fullscreen helpers. Safari (incl. iPadOS) only exposes the webkit-prefixed
 * API; iOS iPhone has no element fullscreen at all, which `isFullscreenSupported`
 * reports as unsupported so the button hides.
 */
type FsDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitFullscreenEnabled?: boolean;
  webkitExitFullscreen?: () => Promise<void> | void;
};
type FsElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

function isFullscreenSupported(): boolean {
  if (typeof document === "undefined") return false;
  const d = document as FsDocument;
  return Boolean(d.fullscreenEnabled || d.webkitFullscreenEnabled);
}

function currentFullscreenElement(): Element | null {
  const d = document as FsDocument;
  return d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
}

function requestFullscreen(el: HTMLElement): void {
  const e = el as FsElement;
  void (e.requestFullscreen?.() ?? e.webkitRequestFullscreen?.());
}

function exitFullscreen(): void {
  const d = document as FsDocument;
  void (d.exitFullscreen?.() ?? d.webkitExitFullscreen?.());
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * The consumer-supplied action shape, and the shared top-right action bar
 * both `CameraFeed` and `KerbalFaceFeed` render, live in `FeedActionBar`.
 * Re-exported here since existing imports reference `./CameraFeed`.
 */
export type { FeedAction } from "./FeedActionBar";

/**
 * A hook that yields the live `MediaStream` for a resolved flightId. Must be
 * a stable reference (the same function identity every render) and called
 * unconditionally, per the rules of hooks. Default: the built-in
 * `useKerbcastStream`. Consumers wrap this to inject delayed playout,
 * alternate transports, etc.; the feed stays unaware of what the wrapper
 * does, and keeps binding whatever stream comes back to its `<video>`.
 *
 * A replacement takes over the camera subscription slot: the built-in
 * `useKerbcastStream` (which acquires/releases the slot) does not run when
 * this is supplied, so a replacement must either compose `useKerbcastStream`
 * or acquire the slot itself, or the sidecar is never subscribed and the
 * feed stays black.
 */
export type CameraStreamHook = (flightId: number | null) => MediaStream | null;

export interface CameraFeedProps {
  /** Override the context client for this feed only. */
  client?: KerbcastClient;
  /**
   * KSP `Part.flightID` of the camera to display. `null` triggers
   * auto-selection: the first live camera in the registry is latched.
   */
  flightId: number | null;
  /**
   * Called when the user explicitly picks a camera (picker, Next/Prev
   * buttons). Never called on auto-latch.
   */
  onSelectCamera?: (flightId: number) => void;
  /**
   * Restrict the cameras this feed can select / step through / auto-latch onto
   * (the picker menu + stepper + fallback). Omit to consider every camera (the
   * default). A host uses it to scope the selectable set — e.g. a part-grid tile
   * offering only part cameras so crew cams stay in the crew bar.
   */
  cameraFilter?: (camera: CameraState) => boolean;
  /**
   * Called whenever the camera this feed actually displays changes — including
   * auto-latch and fallback picks, not just explicit selection. The argument
   * is the resolved flightId (null when nothing is shown). Use it to label or
   * annotate the feed by what it is really showing rather than what was
   * requested; the two differ whenever auto-selection kicks in.
   */
  onDisplayedCameraChange?: (flightId: number | null) => void;
  /** Show resolution + encoder readout. Default false. */
  showDebugInfo?: boolean;
  /**
   * Whether to show animated static. `true`: stall ramps noise in over the
   * held last frame; sourceless path shows live noise. `false`: stall freezes
   * the last frame with a dim scrim and stale badge; sourceless path shows a
   * plain black background. `undefined` (default): auto mode, reads
   * `prefers-reduced-motion: reduce` at mount and follows changes at runtime
   * (reduced motion defaults to off, normal motion defaults to on).
   */
  showStatic?: boolean;
  /**
   * Override the client's in-flight signal for this feed only. When known
   * false, the feed shows the dimmed standby icon instead of SIGNAL LOST.
   * Defaults to the client's `useKerbcastInFlight()` value.
   */
  inFlight?: boolean;
  /**
   * Show the per-feed standby icon when out of flight. Default true. Set
   * false when a container renders its own single out-of-flight overlay
   * (e.g. the kerbcast web dashboard) so the icon isn't drawn twice; the
   * feed then just goes dark.
   */
  showStandbyIcon?: boolean;
  /**
   * "auto" (default): the feed self-measures its rendered pixel box and reports
   * it to the sidecar via the per-consumer `reportDisplaySize` (auto-resolution;
   * the sidecar maxes across consumers). "none": no reporting, for a
   * fixed-resolution feed. This drives the AUTO signal, not the operator
   * `setRenderSize` (which, with the quality presets, is the manual cap:
   * effective = min(auto, cap)).
   */
  renderSize?: "auto" | "none";
  /** Message shown when no cameras are available. */
  emptyMessage?: string;
  /**
   * Show a built-in fullscreen toggle that fullscreens this feed's frame.
   * Auto-hidden where the Fullscreen API is unavailable (e.g. iOS Safari,
   * which only fullscreens the bare <video>). Default false.
   */
  enableFullscreen?: boolean;
  /**
   * Show a built-in Picture-in-Picture toggle for this feed's video.
   * Auto-hidden where `document.pictureInPictureEnabled` is false. Default
   * false.
   */
  enablePictureInPicture?: boolean;
  /**
   * Show a built-in per-camera quality control in the action bar: Auto plus
   * the resolution presets (full / 3-4 / 1-2 / 1-4 of the operator-configured
   * size), with the camera's effective resolution and a marker when the
   * sidecar's adaptive machinery is throttling below the request. Requests
   * can only lower quality; the resolution change arrives in-band over the
   * existing WebRTC track (the video element is never remounted). Default
   * false.
   */
  enableQualityControl?: boolean;
  /**
   * Show a built-in auto-track (crosshair) control, only on pan+zoom cameras.
   * A tri-state toggle group (off / track active vessel / track target): the
   * camera aims itself at the chosen moving vessel (and auto-zooms) with no kOS.
   * State is SERVER-authoritative: the highlight reflects `CameraState.trackMode`
   * published by the sidecar, never the local click, so two browsers agree.
   * While tracking, the manual pan/zoom controls are disabled (the aim loop owns
   * the gimbal + FoV). Default false.
   */
  enableTracking?: boolean;
  /**
   * Stand down the built-in MANUAL camera controls: the pan ball and the
   * zoom/FoV controls disappear, their in-flight rates are zeroed, and the
   * imperative handle's pan/zoom methods become no-ops (so a physical
   * controller wired to the handle can't reach the camera either).
   *
   * "Manual" in the sense this file already uses it - a human directly driving
   * the gimbal and optics - and named for that intent rather than for today's
   * specific surfaces, so anything added later that hand-flies the camera
   * stands down under this flag too. Auto-track is NOT manual and stays live:
   * the aim loop runs game-side, so it keeps working when a host takes the
   * hand-flown path away. Feed affordances are untouched as well - action bar,
   * recording, fullscreen, PiP, quality.
   *
   * For a host that owns manual control itself, e.g. a signal-delay setpoint
   * surface where live pan/zoom would be steering at where the craft is now
   * while watching where it was a light-time ago. Default false.
   */
  disableManualControls?: boolean;
  /**
   * Show a built-in REC control in the action bar: a STATEFUL toggle (never
   * overflow-eligible, per the #6 spec) that starts/stops a client-side
   * recording of this feed via `useRecordings()`. Idle -> click starts
   * (`start(flightId)`); active shows a red dot + a live elapsed timer on the
   * tile -> click stops (`stop(recordingId)`) and the clip lands in the
   * recordings store. Recording is purely client-local (this browser's own
   * MediaRecorder, nothing server-authoritative) and read from the store
   * (`isRecording(flightId)`), so it stays correct if toggled elsewhere (e.g.
   * a REC+ grouped recording). Default false.
   */
  enableRecording?: boolean;
  /**
   * Record this feed at the operator's full render size for the duration of
   * the built-in REC control's recording (overrides only the display-size
   * demand; still yields to the adaptive framerate shed). Off by default.
   * Threaded straight into `start(flightId, { forceFullResolution })`; has
   * no effect unless `enableRecording` is also set. While the feed is armed
   * (force sent, waiting for the resolution bump) the tile shows an
   * "ARMING" pill under the title in place of the REC badge, then switches
   * to the normal REC badge + elapsed timer once recording actually starts.
   */
  recordFullResolution?: boolean;
  /**
   * Consumer-injected action buttons, rendered left of the built-in
   * fullscreen/PiP controls in the top-right action bar.
   */
  actions?: FeedAction[];
  /**
   * Consumer-injected action buttons rendered at the far end of the action
   * bar: the natural home for a close/remove button. Always pinned trailing
   * (never overflow-eligible, never counted toward the overflow threshold),
   * so it sits in the corner as a persistent, single-click control, right of
   * the ⋮ overflow trigger when one is present.
   */
  trailingActions?: FeedAction[];
  /**
   * Render the feed's action UI (the top-right action bar: camera stepper,
   * custom actions, quality / fullscreen / PiP). Default true. Set false to
   * suppress the whole bar (e.g. a small tile where hover controls add
   * nothing). Does not affect display-size reporting.
   */
  showActions?: boolean;
  /**
   * Override how the displayed video stream is sourced for the resolved
   * flightId. Omit (the default) to use the built-in `useKerbcastStream` —
   * unchanged behaviour. When supplied it must be a stable reference passed
   * consistently across renders (it is called as a hook); see
   * {@link CameraStreamHook}.
   */
  useStream?: CameraStreamHook;
}

export interface CameraFeedHandle {
  stepCamera(delta: number): void;
  setZoomRate(rate: number): void;
  setPanAxis(axis: "yaw" | "pitch", value: number): void;
  nudgeZoom(deltaSign: number): void;
  nudgePan(yawSign: number, pitchSign: number): void;
}

// ---------------------------------------------------------------------------
// Inner component (reads from context)
// ---------------------------------------------------------------------------

const CameraFeedInner = forwardRef<CameraFeedHandle, CameraFeedProps>(
  function CameraFeedInner(
    {
      flightId: requestedFlightId,
      onSelectCamera,
      cameraFilter,
      onDisplayedCameraChange,
      showDebugInfo = false,
      showStatic,
      inFlight: inFlightProp,
      showStandbyIcon = true,
      renderSize = "auto",
      emptyMessage = "No camera feeds - start a vessel with Hullcam parts installed",
      enableFullscreen = false,
      enablePictureInPicture = false,
      enableQualityControl = false,
      enableTracking = false,
      disableManualControls = false,
      enableRecording = false,
      recordFullResolution = false,
      actions,
      trailingActions,
      showActions = true,
      useStream,
    },
    ref,
  ) {
    const client = useKerbcastClient();
    // Always called (rules of hooks); `enableRecording` only gates whether the
    // REC entry/badge render, not whether the store is subscribed.
    const recordings = useRecordings();
    // The selectable set: every live camera, optionally narrowed by the host's
    // cameraFilter (e.g. a part-grid tile offering only part cams). Drives the
    // picker menu, the stepper, and the auto-latch fallback so none can land on
    // a filtered-out camera.
    const allCameras = useKerbcastCameras();
    const cameras = useMemo(
      () => (cameraFilter ? allCameras.filter(cameraFilter) : allCameras),
      [allCameras, cameraFilter],
    );
    const inFlightFromClient = useKerbcastInFlight();
    const inFlight = inFlightProp ?? inFlightFromClient;
    const outOfFlight = inFlight === false;

    /*
     * Reduced-motion auto mode: when `showStatic` prop is undefined, read and
     * track `prefers-reduced-motion: reduce`. Reduced motion defaults to off
     * (no animated noise); normal motion defaults to on.
     */
    const [reducedMotion, setReducedMotion] = useState(() => {
      if (typeof window === "undefined") return false;
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    });
    useEffect(() => {
      if (showStatic !== undefined) return;
      const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
      const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    }, [showStatic]);
    const effectiveShowStatic = showStatic === undefined ? !reducedMotion : showStatic;

    // -------------------------------------------------------------------------
    // Selection model (mirrors gonogo's CameraFeed)
    //
    // Resolution order:
    //   1. Explicit pick, if still present in the list (destroyed or not).
    //   2. Auto: latch the currently-displayed camera. Keep showing it even if
    //      destroyed, but only while no other live camera exists (destroyed
    //      tombstones never leave the list on their own, so a destroyed latch
    //      would otherwise never release). Once a live camera is available,
    //      release the latch and auto-pick it.
    //   3. Fresh auto-pick: prefer the first live camera; fall back to first
    //      overall only when every camera is destroyed.
    // -------------------------------------------------------------------------
    const displayedRef = useRef<number | null>(null);
    const requestedStillPresent =
      requestedFlightId !== null &&
      cameras.some((c) => c.flightId === requestedFlightId);

    let flightId: number | null;
    if (requestedStillPresent) {
      flightId = requestedFlightId;
    } else {
      const latched = displayedRef.current;
      const latchedCamera =
        latched !== null ? cameras.find((c) => c.flightId === latched) : undefined;
      const anyLive = cameras.some((c) => !isCameraDestroyed(c));
      const latchedPresent =
        latchedCamera !== undefined &&
        (!isCameraDestroyed(latchedCamera) || !anyLive);
      flightId = latchedPresent
        ? latched
        : (cameras.find((c) => !isCameraDestroyed(c))?.flightId ??
          cameras[0]?.flightId ??
          null);
    }

    const camera =
      flightId !== null
        ? (cameras.find((c) => c.flightId === flightId) ?? null)
        : null;

    // Latest onDisplayedCameraChange, held in a ref so the commit effect below
    // fires only on a resolved-flightId change, not on every render when the
    // consumer passes an inline callback.
    const onDisplayedRef = useRef(onDisplayedCameraChange);
    useEffect(() => {
      onDisplayedRef.current = onDisplayedCameraChange;
    });

    // Commit on-screen camera for the auto-mode latch, and report which camera
    // is actually displayed so consumers can label by it (auto-picks included).
    useEffect(() => {
      displayedRef.current = flightId;
      onDisplayedRef.current?.(flightId);
    }, [flightId]);

    // `flightId` here is the RESOLVED id (auto-latch / fallback applied), so a
    // consumer-injected hook never has to duplicate that resolution. The
    // built-in hook is the default. See CameraStreamHook's rules-of-hooks note.
    const resolveStream = useStream ?? useKerbcastStream;
    const stream = resolveStream(flightId);
    const videoRef = useRef<HTMLVideoElement>(null);
    // The feed frame; fullscreen targets this and ResizeObserver measures it.
    const wrapRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
      if (videoRef.current && stream) {
        videoRef.current.srcObject = stream;
      }
    }, [stream]);

    // -------------------------------------------------------------------------
    // Stall presentation. The static is composited in-stream by the SDK's
    // noise pipeline; this forwards the resolved setting to the camera handle
    // and mirrors the handle's stall state for the no-static badge.
    // -------------------------------------------------------------------------
    useEffect(() => {
      if (flightId === null) return;
      client.camera(flightId).setShowStatic(effectiveShowStatic);
    }, [client, flightId, effectiveShowStatic]);

    const [isStale, setIsStale] = useState(false);
    useEffect(() => {
      if (flightId === null) {
        setIsStale(false);
        return;
      }
      const cam = client.camera(flightId);
      setIsStale(cam.stalled);
      return cam.on("stall", setIsStale);
    }, [client, flightId]);

    // -------------------------------------------------------------------------
    // Fullscreen + Picture-in-Picture (opt-in, feature-detected)
    // -------------------------------------------------------------------------
    const fullscreenAvailable = enableFullscreen && isFullscreenSupported();
    const pipAvailable =
      enablePictureInPicture &&
      typeof document !== "undefined" &&
      document.pictureInPictureEnabled === true;

    const [isFullscreen, setIsFullscreen] = useState(false);
    const [isPip, setIsPip] = useState(false);

    // Keep the fullscreen icon in sync however the user enters/exits (Esc, etc).
    useEffect(() => {
      if (!fullscreenAvailable) return;
      const sync = () =>
        setIsFullscreen(currentFullscreenElement() === wrapRef.current);
      document.addEventListener("fullscreenchange", sync);
      document.addEventListener("webkitfullscreenchange", sync);
      sync();
      return () => {
        document.removeEventListener("fullscreenchange", sync);
        document.removeEventListener("webkitfullscreenchange", sync);
      };
    }, [fullscreenAvailable]);

    // PiP listeners re-attach when the <video> mounts/remounts (flightId change).
    useEffect(() => {
      if (!pipAvailable) return;
      const v = videoRef.current;
      if (!v) return;
      const onEnter = () => setIsPip(true);
      const onLeave = () => setIsPip(false);
      v.addEventListener("enterpictureinpicture", onEnter);
      v.addEventListener("leavepictureinpicture", onLeave);
      return () => {
        v.removeEventListener("enterpictureinpicture", onEnter);
        v.removeEventListener("leavepictureinpicture", onLeave);
      };
    }, [pipAvailable, flightId]);

    const toggleFullscreen = useCallback(() => {
      const el = wrapRef.current;
      if (!el) return;
      if (currentFullscreenElement()) exitFullscreen();
      else requestFullscreen(el);
    }, []);

    const togglePip = useCallback(() => {
      const v = videoRef.current;
      if (!v) return;
      if (document.pictureInPictureElement) {
        void document.exitPictureInPicture().catch(() => {});
      } else {
        void v.requestPictureInPicture().catch(() => {});
      }
    }, []);

    const isDestroyed = camera ? isCameraDestroyed(camera) : false;
    /* Gating here rather than at the render sites covers the whole manual
       path at once: the controls unmount, the effects below zero any in-flight
       rate, and the imperative handle's pan/zoom methods no-op. */
    const showPan = camera?.supportsPan && !isDestroyed && !disableManualControls;
    const showZoom =
      camera?.supportsZoom && !isDestroyed && !disableManualControls;

    // Auto-track state is server-authoritative: driven purely by the published
    // trackMode (absent -> none), never local click. While tracking, the aim
    // loop owns the gimbal + FoV, so the manual pan/zoom controls are disabled
    // (they jitter against the track and are no-ops in practice).
    const trackMode = camera?.trackMode ?? TrackMode.None;
    const tracking = trackMode !== TrackMode.None;
    const manualDisabled = tracking;
    const supportsPitch =
      !!camera && camera.panPitchMax - camera.panPitchMin > 0;

    // -------------------------------------------------------------------------
    // Camera selection callbacks (Next/Prev, picker)
    // onSelectCamera is ONLY called on explicit user picks, never on auto-latch.
    // -------------------------------------------------------------------------
    const currentIndex = useMemo(
      () =>
        flightId !== null
          ? cameras.findIndex((c) => c.flightId === flightId)
          : -1,
      [cameras, flightId],
    );

    const stepCamera = useCallback(
      (delta: number) => {
        if (cameras.length === 0) return;
        const base = currentIndex >= 0 ? currentIndex : 0;
        const next = (base + delta + cameras.length) % cameras.length;
        const nextId = cameras[next]?.flightId;
        if (nextId !== undefined) onSelectCamera?.(nextId);
      },
      [cameras, currentIndex, onSelectCamera],
    );

    // -------------------------------------------------------------------------
    // PanZoomController: one per displayed camera
    // -------------------------------------------------------------------------
    const controllerRef = useRef<PanZoomController | null>(null);
    const [sliderFov, setSliderFov] = useState(60);

    useEffect(() => {
      if (flightId === null) {
        controllerRef.current?.dispose();
        controllerRef.current = null;
        return;
      }
      const cam = client.camera(flightId);
      const ctrl = new PanZoomController(cam);
      controllerRef.current?.dispose();
      controllerRef.current = ctrl;

      const unsubSlider = ctrl.onSliderFov(setSliderFov);
      // Seed the slider from the controller's initial (0). It will be
      // overwritten immediately by syncFromState in the camera-state effect below.
      setSliderFov(ctrl.sliderFov);

      return () => {
        unsubSlider();
        ctrl.stop();
        ctrl.dispose();
        controllerRef.current = null;
      };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [client, flightId]);

    // Sync controller from camera state on every state update.
    useEffect(() => {
      if (!camera || !controllerRef.current) return;
      controllerRef.current.syncFromState(camera);
    }, [camera]);

    // Stop pan/zoom when the control hides (signal lost / support dropped).
    useEffect(() => {
      if (!showPan) {
        controllerRef.current?.setPanRate(0, 0);
        setBallPos({ x: 0, y: 0 });
        setBallActive(false);
      }
    }, [showPan]);
    useEffect(() => {
      if (!showZoom) controllerRef.current?.setZoomRate(0);
    }, [showZoom]);

    // -------------------------------------------------------------------------
    // Ball drag state (pixel math lives here)
    // -------------------------------------------------------------------------
    const ballStartRef = useRef({ x: 0, y: 0 });
    const [ballPos, setBallPos] = useState({ x: 0, y: 0 });
    const [ballActive, setBallActive] = useState(false);

    const handleBallDown = useCallback(
      (e: React.PointerEvent<HTMLDivElement>) => {
        if (flightId === null) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        ballStartRef.current = { x: e.clientX, y: e.clientY };
        setBallActive(true);
        controllerRef.current?.setBallDragging(true);
      },
      [flightId],
    );

    const handleBallMove = useCallback(
      (e: React.PointerEvent<HTMLDivElement>) => {
        if (!ballActive) return;
        let dx = e.clientX - ballStartRef.current.x;
        let dy = supportsPitch ? e.clientY - ballStartRef.current.y : 0;
        const mag = Math.hypot(dx, dy);
        if (mag > PAN_BALL_RADIUS) {
          const k = PAN_BALL_RADIUS / mag;
          dx *= k;
          dy *= k;
        }
        setBallPos({ x: dx, y: dy });
        controllerRef.current?.setPanRate(dx / PAN_BALL_RADIUS, -dy / PAN_BALL_RADIUS);
      },
      [ballActive, supportsPitch],
    );

    const handleBallUp = useCallback(() => {
      setBallActive(false);
      setBallPos({ x: 0, y: 0 });
      controllerRef.current?.setBallDragging(false);
      controllerRef.current?.setPanRate(0, 0);
    }, []);

    // -------------------------------------------------------------------------
    // Handle API (forwardRef)
    // -------------------------------------------------------------------------
    useImperativeHandle(
      ref,
      () => ({
        stepCamera,
        setZoomRate(rate: number) {
          if (!showZoom) return;
          controllerRef.current?.setZoomRate(rate);
        },
        setPanAxis(axis: "yaw" | "pitch", value: number) {
          if (!showPan) return;
          if (axis === "pitch" && !supportsPitch) return;
          controllerRef.current?.setPanAxis(axis, value);
        },
        nudgeZoom(deltaSign: number) {
          if (!showZoom) return;
          controllerRef.current?.nudgeZoom(deltaSign);
        },
        nudgePan(yawSign: number, pitchSign: number) {
          if (!showPan) return;
          controllerRef.current?.nudgePan(yawSign, pitchSign);
        },
      }),
      [stepCamera, showZoom, showPan, supportsPitch],
    );

    // -------------------------------------------------------------------------
    // Display-size reporting (auto-resolution). The feed self-measures its
    // rendered box and reports it per-consumer; the sidecar maxes across
    // consumers. Reports the real w x h (part cams are not square). Disabled by
    // `renderSize="none"`. See useReportDisplaySize for debounce / bucketing.
    // -------------------------------------------------------------------------
    useReportDisplaySize(flightId, wrapRef, { enabled: renderSize === "auto" });

    // -------------------------------------------------------------------------
    // UI state
    // -------------------------------------------------------------------------
    const bitrateLabel =
      camera && camera.encoderBitrateBps > 0
        ? ` · ${Math.round(camera.encoderBitrateBps / 1000)}kbps`
        : "";
    const adaptiveLabel =
      camera && camera.renderWidth < camera.operatorWidth ? " · adaptive" : "";

    const hasCameras = cameras.length > 0;
    const canStep = cameras.length > 1;
    const menuId = useId();
    const [chromePinned, setChromePinned] = useState(false);
    const cameraMenu = usePortalMenu({
      maxWidth: MENU_MAX_WIDTH,
      maxHeight: MENU_MAX_HEIGHT,
      align: "start",
    });

    const cameraLabel = useMemo(() => buildCameraLabeler(cameras), [cameras]);
    const title = camera ? cameraLabel(camera) : "Camera Feed";

    // -------------------------------------------------------------------------
    // Viewer quality control (opt-in). A built-in action button + menu: Auto
    // plus the resolution presets. Requested state = camera.viewerQuality
    // (authoritative, broadcast by the sidecar so every UI agrees); effective
    // state = renderWidth/Height; qualityLimitedBy marks adaptive throttling.
    // -------------------------------------------------------------------------
    const qualityAvailable =
      enableQualityControl && flightId !== null && camera !== null;
    const qualityThrottled = Boolean(camera?.qualityLimitedBy);
    const qualityMenuId = useId();
    // Same portal/anchor/dismissal machinery as the camera menu, hung from
    // the right edge of its action-bar trigger.
    const qualityMenu = usePortalMenu({
      maxWidth: QUALITY_MENU_MAX_WIDTH,
      maxHeight: QUALITY_MENU_MAX_HEIGHT,
      align: "end",
    });
    const closeQualityMenu = qualityMenu.close;

    const selectQuality = useCallback(
      (preset: QualityPreset | null) => {
        if (flightId === null) return;
        void client.camera(flightId).setQuality(preset);
        closeQualityMenu();
      },
      [client, flightId, closeQualityMenu],
    );

    // -------------------------------------------------------------------------
    // Auto-track control (opt-in, pan+zoom cameras only). A crosshair button +
    // menu with the two modes. Sends the intent; the highlight follows the
    // server-published trackMode (above), so two browsers agree.
    // -------------------------------------------------------------------------
    const trackingAvailable =
      enableTracking &&
      flightId !== null &&
      camera !== null &&
      camera.supportsPan === true &&
      camera.supportsZoom === true &&
      !isDestroyed;
    const trackingMenuId = useId();
    const trackingMenu = usePortalMenu({
      maxWidth: QUALITY_MENU_MAX_WIDTH,
      maxHeight: QUALITY_MENU_MAX_HEIGHT,
      align: "end",
    });
    const closeTrackingMenu = trackingMenu.close;

    const selectTrack = useCallback(
      (mode: TrackMode) => {
        if (flightId === null) return;
        // Tri-state: clicking the already-active mode hands aiming back (none).
        // Decision reads the server-confirmed trackMode, not a local toggle.
        const next = trackMode === mode ? TrackMode.None : mode;
        void client.setTrackTarget(flightId, next);
        closeTrackingMenu();
      },
      [client, flightId, trackMode, closeTrackingMenu],
    );

    // -------------------------------------------------------------------------
    // REC control (opt-in). A stateful toggle that starts/stops a client-side
    // recording of this feed via the recordings store; state is read from the
    // store (isRecording), never held locally, so it stays correct if the
    // recording was started elsewhere (e.g. a REC+ grouped recording).
    // -------------------------------------------------------------------------
    const recordingActive =
      enableRecording && flightId !== null && recordings.isRecording(flightId);
    const activeRecording = recordingActive
      ? recordings.active.find((a) => a.flightId === flightId)
      : undefined;
    /* True while a single forced recording is armed (force sent, waiting for
       the feed to reach full resolution) but the recorder has not started
       yet (see ActiveRecordingInfo.arming). Drives the ARMING pill below in
       place of the REC badge. */
    const armingActive = activeRecording?.arming === true;

    // Ticks once a second while recording so the elapsed timer stays live;
    // the timer itself is derived from activeRecording.startedAt each render.
    const [, tickRecordingTimer] = useReducer((c: number) => c + 1, 0);
    useEffect(() => {
      if (!recordingActive) return;
      const interval = setInterval(tickRecordingTimer, 1000);
      return () => clearInterval(interval);
    }, [recordingActive]);

    const recordingElapsedMs = activeRecording ? nowMs() - activeRecording.startedAt : 0;

    const toggleRecording = useCallback(() => {
      if (flightId === null) return;
      if (recordingActive) {
        const active = recordings.active.find((a) => a.flightId === flightId);
        if (active) {
          void recordings.stop(active.recordingId).catch(() => {
            /* A rejected stop shouldn't leave the REC toggle wedged; the
               store's own state (active/recordings) is the source of truth
               for whether it's still "recording", not this call's outcome. */
          });
        }
        return;
      }
      try {
        recordings.start(flightId, { forceFullResolution: recordFullResolution });
      } catch {
        /* no live track yet, or a race with a recording already in progress
           elsewhere on this feed; the operator can retry once live. */
      }
    }, [flightId, recordingActive, recordings, recordFullResolution]);

    const topOverlay = (
      <TopOverlay>
        <TitleRow>
          <TopTitle>
            {hasCameras ? (
              <TitleButton
                ref={cameraMenu.triggerRef}
                type="button"
                aria-haspopup="menu"
                aria-expanded={cameraMenu.open}
                aria-controls={menuId}
                disabled={recordingActive}
                title={recordingActive ? "Stop recording to change camera" : undefined}
                onClick={recordingActive ? undefined : cameraMenu.toggle}
              >
                <TitleButton__Text>{title}</TitleButton__Text>
                <ChevronDownIcon aria-hidden="true" />
              </TitleButton>
            ) : (
              title
            )}
          </TopTitle>
        </TitleRow>

        {cameraMenu.open &&
          hasCameras &&
          cameraMenu.position &&
          createPortal(
            <CameraMenu
              ref={cameraMenu.menuRef}
              id={menuId}
              role="menu"
              aria-label="Camera"
              style={cameraMenu.position}
            >
              {cameras.map((c) => (
                <CameraMenuItem
                  key={c.flightId}
                  type="button"
                  role="menuitemradio"
                  aria-checked={c.flightId === flightId}
                  $selected={c.flightId === flightId}
                  onClick={() => {
                    onSelectCamera?.(c.flightId);
                    cameraMenu.close();
                  }}
                >
                  {cameraLabel(c)} ({c.vesselName})
                  {isCameraDestroyed(c) ? " - signal lost" : ""}
                </CameraMenuItem>
              ))}
            </CameraMenu>,
            document.body,
          )}

        {showDebugInfo &&
          (camera ? (
            <TopMeta>
              {camera.vesselName} · {camera.renderWidth}×{camera.renderHeight}
              {bitrateLabel}
              {adaptiveLabel}
            </TopMeta>
          ) : (
            <TopMeta>no cameras on this vessel</TopMeta>
          ))}
      </TopOverlay>
    );

    /*
     * Built-in action-bar entries, in the bar's natural (fallback) order:
     * consumer actions, quality, tracking, PiP, fullscreen, trailing actions.
     * FeedActionBar partitions these into primary/overflow (see its own
     * doc-comment); tracking is the only built-in marked `stateful` today,
     * per #6's "stateful toggles stay primary" rule (REC joins it the same
     * way).
     */
    const trackingLabel = tracking
      ? trackMode === TrackMode.Target
        ? "Auto-tracking target"
        : "Auto-tracking active vessel"
      : "Auto-track a vessel";
    const pipLabel = isPip ? "Exit picture in picture" : "Picture in picture";
    const fullscreenLabel = isFullscreen ? "Exit fullscreen" : "Enter fullscreen";
    const recordingLabel = recordingActive ? "Stop recording" : "Start recording";

    const entries: FeedActionBarEntry[] = [
      ...(actions?.map(feedActionToEntry) ?? []),
      ...(qualityAvailable
        ? [
            {
              id: "quality",
              label: "Quality",
              stateful: false,
              render: () => (
                <OverlayIconButton
                  ref={qualityMenu.triggerRef}
                  type="button"
                  aria-label="Quality"
                  aria-haspopup="menu"
                  aria-expanded={qualityMenu.open}
                  aria-controls={qualityMenuId}
                  title={
                    qualityThrottled
                      ? "Quality (throttled by adaptive performance)"
                      : "Quality"
                  }
                  $active={qualityMenu.open}
                  onClick={qualityMenu.toggle}
                >
                  <QualityIcon />
                  {qualityThrottled && <ThrottledDot aria-hidden="true" />}
                </OverlayIconButton>
              ),
            } satisfies FeedActionBarEntry,
          ]
        : []),
      ...(enableRecording && flightId !== null
        ? [
            {
              id: "record",
              label: recordingLabel,
              stateful: true,
              render: () => (
                <RecordActionButton
                  type="button"
                  aria-label={recordingLabel}
                  aria-pressed={recordingActive}
                  title={recordingLabel}
                  $active={recordingActive}
                  onClick={toggleRecording}
                >
                  <RecordIcon />
                </RecordActionButton>
              ),
            } satisfies FeedActionBarEntry,
          ]
        : []),
      ...(trackingAvailable
        ? [
            {
              id: "tracking",
              label: trackingLabel,
              stateful: true,
              render: () => (
                <OverlayIconButton
                  ref={trackingMenu.triggerRef}
                  type="button"
                  aria-label="Auto-track"
                  aria-haspopup="menu"
                  aria-expanded={trackingMenu.open}
                  aria-controls={trackingMenuId}
                  aria-pressed={tracking}
                  title={trackingLabel}
                  $active={tracking || trackingMenu.open}
                  onClick={trackingMenu.toggle}
                >
                  <CrosshairIcon />
                </OverlayIconButton>
              ),
            } satisfies FeedActionBarEntry,
          ]
        : []),
      ...(flightId !== null && pipAvailable
        ? [
            {
              id: "pip",
              label: pipLabel,
              stateful: false,
              render: () => (
                <OverlayIconButton
                  type="button"
                  aria-label={pipLabel}
                  aria-pressed={isPip}
                  title={pipLabel}
                  $active={isPip}
                  onClick={togglePip}
                >
                  <PictureInPictureIcon />
                </OverlayIconButton>
              ),
            } satisfies FeedActionBarEntry,
          ]
        : []),
      ...(flightId !== null && fullscreenAvailable
        ? [
            {
              id: "fullscreen",
              label: fullscreenLabel,
              stateful: false,
              render: () => (
                <OverlayIconButton
                  type="button"
                  aria-label={fullscreenLabel}
                  aria-pressed={isFullscreen}
                  title={fullscreenLabel}
                  $active={isFullscreen}
                  onClick={toggleFullscreen}
                >
                  {isFullscreen ? <FullscreenExitIcon /> : <FullscreenEnterIcon />}
                </OverlayIconButton>
              ),
            } satisfies FeedActionBarEntry,
          ]
        : []),
      /* trailingActions is always the pinned-trailing (close/remove) slot,
         regardless of what the consumer's FeedAction sets. See its own
         doc-comment on CameraFeedProps. While a recording is active, closing
         the feed would lose it, so the control stays visible but disabled
         and inert rather than disappearing. */
      ...(trailingActions?.map((a) => {
        const entry = feedActionToEntry(a);
        if (!recordingActive) return { ...entry, pinnedTrailing: true };
        return {
          ...entry,
          pinnedTrailing: true,
          render: () => (
            <OverlayIconButton
              key={a.id}
              type="button"
              aria-label={a.label}
              title="Stop recording to close this feed"
              disabled
              $active={a.active ?? false}
            >
              {a.icon}
            </OverlayIconButton>
          ),
        };
      }) ?? []),
    ];

    const builtInActions =
      flightId !== null &&
      (pipAvailable ||
        fullscreenAvailable ||
        qualityAvailable ||
        trackingAvailable ||
        enableRecording);
    const hasActionBar =
      showActions &&
      (hasCameras ||
        (actions && actions.length > 0) ||
        (trailingActions && trailingActions.length > 0) ||
        builtInActions);
    const stepButtons = hasCameras ? (
      <StepButtons>
        <OverlayIconButton
          type="button"
          aria-label="Previous camera"
          disabled={!canStep}
          onClick={() => stepCamera(-1)}
        >
          &#8249;
        </OverlayIconButton>
        <OverlayIconButton
          type="button"
          aria-label="Next camera"
          disabled={!canStep}
          onClick={() => stepCamera(1)}
        >
          &#8250;
        </OverlayIconButton>
      </StepButtons>
    ) : null;
    const actionBar = hasActionBar ? (
      <FeedActionBar leading={stepButtons} entries={entries} />
    ) : null;

    return (
      <Stage ref={wrapRef} $pinned={chromePinned}>
        {flightId === null ? (
          <>
            <Empty>{emptyMessage}</Empty>
            {topOverlay}
            {actionBar}
          </>
        ) : (
          <>
            <StyledVideo
              ref={videoRef}
              autoPlay
              playsInline
              muted
              controls={false}
              onClick={() => setChromePinned((v) => !v)}
            />
            {topOverlay}
            {actionBar}
            {qualityAvailable &&
              qualityMenu.open &&
              qualityMenu.position &&
              camera &&
              createPortal(
                <QualityMenu
                  ref={qualityMenu.menuRef}
                  id={qualityMenuId}
                  role="menu"
                  aria-label="Quality"
                  style={qualityMenu.position}
                >
                  <CameraMenuItem
                    type="button"
                    role="menuitemradio"
                    aria-checked={camera.viewerQuality == null}
                    $selected={camera.viewerQuality == null}
                    onClick={() => selectQuality(null)}
                  >
                    Auto
                  </CameraMenuItem>
                  {QUALITY_PRESETS.map(({ preset, label, scale }) => (
                    <CameraMenuItem
                      key={preset}
                      type="button"
                      role="menuitemradio"
                      aria-checked={camera.viewerQuality === preset}
                      $selected={camera.viewerQuality === preset}
                      onClick={() => selectQuality(preset)}
                    >
                      {label} ({presetDim(camera.operatorWidth, scale)}×
                      {presetDim(camera.operatorHeight, scale)})
                    </CameraMenuItem>
                  ))}
                  <QualityMeta role="status">
                    now {camera.renderWidth}×{camera.renderHeight}
                    {qualityThrottled ? " · throttled" : ""}
                  </QualityMeta>
                </QualityMenu>,
                document.body,
              )}
            {trackingAvailable &&
              trackingMenu.open &&
              trackingMenu.position &&
              camera &&
              createPortal(
                <QualityMenu
                  ref={trackingMenu.menuRef}
                  id={trackingMenuId}
                  role="menu"
                  aria-label="Auto-track"
                  style={trackingMenu.position}
                >
                  <CameraMenuItem
                    type="button"
                    role="menuitemradio"
                    aria-checked={trackMode === TrackMode.ActiveVessel}
                    $selected={trackMode === TrackMode.ActiveVessel}
                    onClick={() => selectTrack(TrackMode.ActiveVessel)}
                  >
                    Track active vessel
                  </CameraMenuItem>
                  <CameraMenuItem
                    type="button"
                    role="menuitemradio"
                    aria-checked={trackMode === TrackMode.Target}
                    $selected={trackMode === TrackMode.Target}
                    onClick={() => selectTrack(TrackMode.Target)}
                  >
                    Track target
                  </CameraMenuItem>
                </QualityMenu>,
                document.body,
              )}
            {outOfFlight ? (
              showStandbyIcon && (
                <StandbyOverlay role="status" aria-label="Standby, no active flight">
                  <StandbyIconWrap>
                    <StandbyIcon size={40} />
                  </StandbyIconWrap>
                </StandbyOverlay>
              )
            ) : (
              isDestroyed && (
                <SignalLostOverlay role="status" aria-label="Signal lost">
                  <SignalLostText $animated={effectiveShowStatic}>
                    SIGNAL LOST
                  </SignalLostText>
                </SignalLostOverlay>
              )
            )}
            {!outOfFlight && !effectiveShowStatic && isStale && !isDestroyed && (
              <>
                <StaleScrim aria-hidden="true" />
                <StaleBadge role="status" aria-label="Feed stale">
                  <StaleIcon />
                  Stale
                </StaleBadge>
              </>
            )}
            {recordingActive && armingActive && (
              <ArmingBadge role="status" aria-label="Arming">
                <ArmingDot aria-hidden="true" />
                ARMING
              </ArmingBadge>
            )}
            {recordingActive && !armingActive && (
              <RecBadge role="status" aria-label="Recording">
                <RecDot aria-hidden="true" />
                REC {formatElapsed(recordingElapsedMs)}
              </RecBadge>
            )}
            {showZoom && (
              <ZoomControlsWrap $disabled={manualDisabled} aria-hidden={manualDisabled}>
                <ZoomButton
                  type="button"
                  aria-label="Zoom in"
                  $pos="top"
                  disabled={manualDisabled}
                  onPointerDown={() =>
                    controllerRef.current?.setZoomRate(1)
                  }
                  onPointerUp={() => controllerRef.current?.setZoomRate(0)}
                  onPointerLeave={() => controllerRef.current?.setZoomRate(0)}
                  onPointerCancel={() => controllerRef.current?.setZoomRate(0)}
                  onClick={(e) => {
                    if (e.detail === 0) controllerRef.current?.nudgeZoom(-1);
                  }}
                >
                  +
                </ZoomButton>
                <FovSlider
                  type="range"
                  aria-label="Zoom"
                  min={camera.fovMin}
                  max={camera.fovMax}
                  step={0.5}
                  value={sliderFov}
                  disabled={manualDisabled}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    controllerRef.current?.fovSliderInput(v);
                  }}
                  onPointerDown={() => {
                    controllerRef.current?.setFovSliderDragging(true);
                  }}
                  onPointerUp={() => {
                    controllerRef.current?.setFovSliderDragging(false);
                  }}
                  onPointerCancel={() => {
                    controllerRef.current?.setFovSliderDragging(false);
                  }}
                />
                <ZoomButton
                  type="button"
                  aria-label="Zoom out"
                  $pos="bottom"
                  disabled={manualDisabled}
                  onPointerDown={() => controllerRef.current?.setZoomRate(-1)}
                  onPointerUp={() => controllerRef.current?.setZoomRate(0)}
                  onPointerLeave={() => controllerRef.current?.setZoomRate(0)}
                  onPointerCancel={() => controllerRef.current?.setZoomRate(0)}
                  onClick={(e) => {
                    if (e.detail === 0) controllerRef.current?.nudgeZoom(1);
                  }}
                >
                  &#8722;
                </ZoomButton>
              </ZoomControlsWrap>
            )}
            {showPan && (
              <PanControl
                role="group"
                aria-label="Pan camera"
                $disabled={manualDisabled}
                aria-hidden={manualDisabled}
              >
                <PanArrow
                  type="button"
                  $dir="up"
                  aria-label="Pan up"
                  disabled={manualDisabled || !supportsPitch}
                  onClick={() => controllerRef.current?.nudgePan(0, 1)}
                >
                  &#9650;
                </PanArrow>
                <PanArrow
                  type="button"
                  $dir="down"
                  aria-label="Pan down"
                  disabled={manualDisabled || !supportsPitch}
                  onClick={() => controllerRef.current?.nudgePan(0, -1)}
                >
                  &#9660;
                </PanArrow>
                <PanArrow
                  type="button"
                  $dir="left"
                  aria-label="Pan left"
                  disabled={manualDisabled}
                  onClick={() => controllerRef.current?.nudgePan(-1, 0)}
                >
                  &#9664;
                </PanArrow>
                <PanArrow
                  type="button"
                  $dir="right"
                  aria-label="Pan right"
                  disabled={manualDisabled}
                  onClick={() => controllerRef.current?.nudgePan(1, 0)}
                >
                  &#9654;
                </PanArrow>
                <PanBall
                  aria-hidden="true"
                  title="Drag to pan"
                  onPointerDown={manualDisabled ? undefined : handleBallDown}
                  onPointerMove={manualDisabled ? undefined : handleBallMove}
                  onPointerUp={manualDisabled ? undefined : handleBallUp}
                  onPointerCancel={manualDisabled ? undefined : handleBallUp}
                  style={{
                    transform: `translate(${ballPos.x}px, ${ballPos.y}px)`,
                  }}
                />
              </PanControl>
            )}
          </>
        )}
      </Stage>
    );
  },
);

// ---------------------------------------------------------------------------
// Public CameraFeed - wraps inner in a nested provider when client prop given
// ---------------------------------------------------------------------------

/**
 * Display a live kerbcast camera feed with pan/zoom controls and camera picker.
 * Must be rendered inside a `KerbcastProvider` unless the `client` prop is
 * provided (which creates an implicit inner provider for this feed only).
 */
export const CameraFeed = forwardRef<CameraFeedHandle, CameraFeedProps>(
  function CameraFeed({ client, ...rest }, ref) {
    if (client) {
      return (
        <KerbcastProvider client={client}>
          <CameraFeedInner ref={ref} {...rest} />
        </KerbcastProvider>
      );
    }
    return <CameraFeedInner ref={ref} {...rest} />;
  },
);

// ---------------------------------------------------------------------------
// Inline UI primitives (replacing @gonogo/ui dependencies)
// ---------------------------------------------------------------------------

function ChevronDownIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth={1.5} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const iconProps = {
  viewBox: "0 0 16 16",
  width: 14,
  height: 14,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true as const,
};

function FullscreenEnterIcon() {
  return (
    <svg {...iconProps}>
      <path d="M2 6V2.5h3.5M14 6V2.5h-3.5M2 10v3.5h3.5M14 10v3.5h-3.5" />
    </svg>
  );
}

function FullscreenExitIcon() {
  return (
    <svg {...iconProps}>
      <path d="M5.5 2v3.5H2M10.5 2v3.5H14M5.5 14v-3.5H2M10.5 14v-3.5H14" />
    </svg>
  );
}

/* Quality control: three horizontal slider rails with offset knobs. */
function QualityIcon() {
  return (
    <svg {...iconProps}>
      <path d="M2 4.5h12M2 8h12M2 11.5h12" />
      <circle cx="10.5" cy="4.5" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="5.5" cy="8" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="8.5" cy="11.5" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

/* Auto-track: a crosshair / reticle. */
function CrosshairIcon() {
  return (
    <svg {...iconProps}>
      <circle cx="8" cy="8" r="4.5" />
      <path d="M8 1v2.5M8 12.5V15M1 8h2.5M12.5 8H15" />
    </svg>
  );
}

/* Stale badge: fading signal bars (tallest dimmed). */
function StaleIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={10}
      height={10}
      fill="currentColor"
      stroke="none"
      aria-hidden="true"
    >
      <rect x="2" y="9" width="2.5" height="5" />
      <rect x="6.5" y="6" width="2.5" height="8" />
      <rect x="11" y="3" width="2.5" height="11" opacity="0.35" />
    </svg>
  );
}

function PictureInPictureIcon() {
  return (
    <svg {...iconProps}>
      <rect x="2" y="3" width="12" height="10" rx="1" />
      <rect x="8" y="8" width="5" height="4" rx="0.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

/* REC: a plain filled dot, coloured by RecordActionButton's own $active state. */
function RecordIcon() {
  return (
    <svg viewBox="0 0 16 16" width={14} height={14} fill="currentColor" stroke="none" aria-hidden="true">
      <circle cx="8" cy="8" r="5" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Styled components
// ---------------------------------------------------------------------------

const PanControl = styled.div<{ $disabled?: boolean }>`
  position: absolute;
  bottom: 10px;
  right: 10px;
  width: 52px;
  height: 52px;
  opacity: 0;
  transition: opacity 0.15s;
  touch-action: none;

  /* Greyed + inert while auto-tracking owns the gimbal. */
  ${(p) => p.$disabled && "pointer-events: none; filter: grayscale(1) opacity(0.4);"}

  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }
`;

const PanArrow = styled.button<{ $dir: "up" | "down" | "left" | "right" }>`
  position: absolute;
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  font-size: 11px;
  line-height: 1;
  color: #fff;
  opacity: 0.5;
  background: none;
  border: none;
  cursor: pointer;
  touch-action: none;
  text-shadow:
    0 0 3px rgba(0, 0, 0, 0.9),
    0 1px 2px rgba(0, 0, 0, 0.8);

  ${(p) =>
    p.$dir === "up"
      ? "top: 0; left: 50%; transform: translateX(-50%);"
      : p.$dir === "down"
        ? "bottom: 0; left: 50%; transform: translateX(-50%);"
        : p.$dir === "left"
          ? "left: 0; top: 50%; transform: translateY(-50%);"
          : "right: 0; top: 50%; transform: translateY(-50%);"}

  @media (hover: hover) {
    &:hover:not(:disabled) {
      opacity: 1;
      color: var(--kerbcast-accent, #00ff88);
    }
  }
  &:disabled {
    opacity: 0.3;
    cursor: default;
  }
  &:focus-visible {
    outline: 2px solid var(--kerbcast-accent, #00ff88);
    outline-offset: 2px;
  }
`;

const PanBall = styled.div`
  position: absolute;
  top: 50%;
  left: 50%;
  width: 12px;
  height: 12px;
  margin: -6px 0 0 -6px;
  border-radius: 50%;
  background: radial-gradient(circle at 35% 30%, #ffffff, #d6dbe1);
  box-shadow:
    0 0 0 1px rgba(0, 0, 0, 0.5),
    0 0 4px rgba(255, 255, 255, 0.4);
  cursor: grab;
  touch-action: none;

  &:active {
    cursor: grabbing;
  }
`;

const ZoomControlsWrap = styled.div<{ $disabled?: boolean }>`
  position: absolute;
  bottom: 8px;
  left: 8px;
  width: 30px;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  background: rgba(0, 0, 0, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.5);
  opacity: 0;
  transition: opacity 0.15s;

  /* Greyed + inert while auto-tracking owns the FoV. */
  ${(p) => p.$disabled && "pointer-events: none; filter: grayscale(1) opacity(0.4);"}

  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }
`;

const ZoomButton = styled.button<{ $pos: "top" | "bottom" }>`
  width: 100%;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: 0;
  color: #fff;
  font-size: 1rem;
  cursor: pointer;
  ${(p) =>
    p.$pos === "top"
      ? "border-bottom: 1px solid rgba(255, 255, 255, 0.3);"
      : "border-top: 1px solid rgba(255, 255, 255, 0.3);"}

  @media (hover: hover) {
    &:hover {
      color: #fff;
      background: rgba(255, 255, 255, 0.15);
    }
  }

  &:focus-visible {
    outline: 2px solid #fff;
    outline-offset: -2px;
  }
`;

const TopOverlay = styled.div`
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 6px 8px 14px;
  background: linear-gradient(to bottom, rgba(0, 0, 0, 0.78), rgba(0, 0, 0, 0));
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s;

  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }
`;

const TitleRow = styled.div`
  display: flex;
  align-items: flex-start;
  gap: 8px;
  /* Reserve the top-right corner where the ActionBar overlay sits (now home
     to the camera step buttons too) so a long title ellipsizes rather than
     sliding underneath the controls. */
  padding-right: 96px;
`;

const TopTitle = styled.h3`
  margin: 0;
  min-width: 0;
  font-size: var(--font-size-xs, 11px);
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: #fff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9);
`;

const TitleButton = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  margin: 0;
  padding: 0;
  background: none;
  border: none;
  cursor: pointer;
  color: inherit;
  font: inherit;
  letter-spacing: inherit;
  text-transform: inherit;
  text-shadow: inherit;
  text-align: left;

  svg {
    width: 12px;
    height: 12px;
    flex-shrink: 0;
    transition: transform 0.15s;
  }

  &[aria-expanded="true"] svg {
    transform: rotate(180deg);
  }

  @media (prefers-reduced-motion: reduce) {
    svg {
      transition: none;
    }
  }

  &:focus-visible {
    outline: 2px solid var(--kerbcast-accent, #00ff88);
    outline-offset: 2px;
  }
`;

const TitleButton__Text = styled.span`
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const StepButtons = styled.div`
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
`;

const CameraMenu = styled.div`
  /* Portaled to document.body: fixed position (set inline from the trigger
     rect) keeps it clear of the tile's overflow clipping. */
  position: fixed;
  z-index: 1000;
  max-width: min(260px, calc(100vw - 16px));
  /* Cap the list so a long camera roster scrolls instead of spilling past
     the tile/viewport. 40vh keeps it sane on short windows; 300px on tall. */
  max-height: min(40vh, 300px);
  display: flex;
  flex-direction: column;
  background: rgba(0, 0, 0, 0.85);
  border: 1px solid rgba(255, 255, 255, 0.3);
  border-radius: 4px;
  overflow-x: hidden;
  overflow-y: auto;
`;

const CameraMenuItem = styled.button<{ $selected: boolean }>`
  display: block;
  width: 100%;
  flex-shrink: 0;
  padding: 6px 8px;
  text-align: left;
  background: ${(p) =>
    p.$selected
      ? "var(--kerbcast-accent-wash, rgba(0, 255, 136, 0.15))"
      : "transparent"};
  border: none;
  cursor: pointer;
  color: #fff;
  font-size: 11px;
  letter-spacing: 0.04em;

  @media (hover: hover) {
    &:hover {
      background: rgba(255, 255, 255, 0.15);
    }
  }

  &:focus-visible {
    outline: 2px solid var(--kerbcast-accent, #00ff88);
    outline-offset: -2px;
  }
`;

const TopMeta = styled.div`
  font-size: 11px;
  letter-spacing: 0.04em;
  color: rgba(255, 255, 255, 0.78);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9);
`;

/* The quality picker: portaled to document.body like CameraMenu, hung from
   its action-bar trigger (fixed position set inline from the trigger rect)
   so tile clipping cannot cut it off and it survives the hover-revealed
   chrome fading while the pointer is over the menu. */
const QualityMenu = styled.div`
  position: fixed;
  z-index: 1000;
  min-width: 140px;
  max-width: min(220px, calc(100vw - 16px));
  max-height: min(40vh, 220px);
  display: flex;
  flex-direction: column;
  background: rgba(0, 0, 0, 0.85);
  border: 1px solid rgba(255, 255, 255, 0.3);
  border-radius: 4px;
  overflow-x: hidden;
  overflow-y: auto;
`;

/* Effective-state footer of the quality menu: what the camera is actually
   rendering right now, with a "throttled" marker while the adaptive
   machinery holds it below the request. */
const QualityMeta = styled.div`
  padding: 5px 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.2);
  font-size: 10px;
  letter-spacing: 0.04em;
  color: rgba(255, 255, 255, 0.65);
`;

/* Throttled marker on the quality action button. */
const ThrottledDot = styled.span`
  position: absolute;
  top: -3px;
  right: -3px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #ffb347;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6);
`;

/* REC action-bar button: same shape as OverlayIconButton, its own red
   $active colour (a coming-recording toggle should never read as the
   green "on" of tracking/quality) via its own token so a consumer can
   recolour it without touching --kerbcast-action-active. */
const RecordActionButton = styled(OverlayIconButton)<{ $active?: boolean }>`
  background: ${(p) =>
    p.$active ? "var(--kerbcast-rec-active, #ff3b30)" : "rgba(0, 0, 0, 0.5)"};
  border-color: ${(p) =>
    p.$active ? "var(--kerbcast-rec-active, #ff3b30)" : "rgba(255, 255, 255, 0.3)"};
  color: #fff;

  @media (hover: hover) {
    &:hover {
      background: ${(p) =>
        p.$active ? "var(--kerbcast-rec-active, #ff3b30)" : "rgba(0, 0, 0, 0.7)"};
    }
  }
`;

/* Persistent recording badge: red dot + elapsed timer, always visible while
   recording (not hover chrome), same convention as StaleBadge. */
const RecBadge = styled.div`
  position: absolute;
  /* Sits just under the hover-gated title/source dropdown (both are top-left)
     so an active recording stays visible without displacing that control. */
  top: 28px;
  left: 8px;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 2px 6px;
  background: rgba(0, 0, 0, 0.6);
  border: 1px solid var(--kerbcast-rec-active, #ff3b30);
  border-radius: 3px;
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9);
  pointer-events: none;
`;

const RecDot = styled.span`
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--kerbcast-rec-active, #ff3b30);
  flex-shrink: 0;

  @media (prefers-reduced-motion: no-preference) {
    animation: rec-dot-pulse 1.6s ease-in-out infinite;
  }

  @keyframes rec-dot-pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.4;
    }
  }
`;

/* Arming pill: same slot as RecBadge (a single forced recording shows one or
   the other, never both), a muted amber so it never reads as the red
   "recording is live" state: the feed hasn't actually started capturing
   yet, it's waiting for the resolution bump. */
const ArmingBadge = styled.div`
  position: absolute;
  top: 28px;
  left: 8px;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 2px 6px;
  background: rgba(0, 0, 0, 0.6);
  border: 1px solid var(--kerbcast-arming-active, #d9a441);
  border-radius: 3px;
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9);
  pointer-events: none;
`;

const ArmingDot = styled.span`
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--kerbcast-arming-active, #d9a441);
  flex-shrink: 0;

  @media (prefers-reduced-motion: no-preference) {
    animation: arming-dot-pulse 0.9s ease-in-out infinite;
  }

  @keyframes arming-dot-pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.3;
    }
  }
`;

/*
 * Outer frame. Fills the host container: the video is absolutely
 * positioned, so without explicit width/height the Stage collapses
 * to zero height.
 */
const Panel = styled.div`
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  background: #111;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 4px;
  overflow: hidden;
`;

const Stage = styled(Panel)<{ $pinned: boolean }>`
  padding: 0;
  gap: 0;
  position: relative;
  background: #000;
  align-items: center;
  justify-content: center;

  &:hover ${TopOverlay},
  &:focus-within ${TopOverlay},
  &:hover ${ZoomControlsWrap},
  &:focus-within ${ZoomControlsWrap},
  &:hover ${PanControl},
  &:focus-within ${PanControl},
  &:hover ${ActionBarRow},
  &:focus-within ${ActionBarRow} {
    opacity: 1;
  }
  &:hover ${TopOverlay},
  &:focus-within ${TopOverlay},
  &:hover ${ActionBarRow},
  &:focus-within ${ActionBarRow} {
    pointer-events: auto;
  }

  ${(p) =>
    p.$pinned &&
    css`
      ${TopOverlay} {
        opacity: 1;
        pointer-events: auto;
      }
      ${ActionBarRow} {
        opacity: 1;
        pointer-events: auto;
      }
      ${ZoomControlsWrap},
      ${PanControl} {
        opacity: 1;
      }
    `}
`;

const Empty = styled.div`
  color: #888;
  font-size: 13px;
  font-style: italic;
  padding: 1rem;
  text-align: center;
`;

const StyledVideo = styled.video`
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
`;

/**
 * Shown when the sidecar reports `lifecycle: "destroyed"`. The kerbcast SDK
 * keeps the camera's noise pipeline alive on the same `mediaStream`, so the
 * video behind this overlay shows live signal-loss static.
 */
const SignalLostOverlay = styled.div`
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.25);
`;

/* Out-of-flight standby: a dark dimmed cover with the shared hard-hat icon
   only. Supersedes SIGNAL LOST for the whole-scene case; the client keeps
   the feed blank behind it so no static bleeds through. */
const StandbyOverlay = styled.div`
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
`;

const StandbyIconWrap = styled.div`
  color: rgba(255, 255, 255, 0.55);
`;

const SignalLostText = styled.span<{ $animated: boolean }>`
  color: #ff4444;
  font-size: 1.1rem;
  font-weight: 700;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  text-shadow:
    0 0 8px rgba(255, 68, 68, 0.7),
    0 1px 2px rgba(0, 0, 0, 0.9);

  ${(p) =>
    p.$animated &&
    `
    @media (prefers-reduced-motion: no-preference) {
      animation: signal-lost-pulse 2s ease-in-out infinite;
    }
  `}

  @keyframes signal-lost-pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.6;
    }
  }
`;

/*
 * No-static stall presentation (`showStatic={false}`): a subtle dim over
 * the frozen last frame plus a corner badge, so a frozen frame is never
 * mistakable for a live one. Always visible (not hover chrome).
 */
const StaleScrim = styled.div`
  position: absolute;
  inset: 0;
  z-index: 1;
  background: rgba(0, 0, 0, 0.32);
  pointer-events: none;
`;

const StaleBadge = styled.div`
  position: absolute;
  bottom: 8px;
  right: 8px;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  background: rgba(0, 0, 0, 0.6);
  border: 1px solid rgba(255, 179, 71, 0.6);
  border-radius: 3px;
  color: #ffb347;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9);
  pointer-events: none;
`;

const FovSlider = styled.input`
  writing-mode: vertical-lr;
  width: 100%;
  height: 54px;
  margin: 0;
  padding: 3px 0;
  cursor: pointer;
  accent-color: #fff;

  &:focus-visible {
    outline: 2px solid #fff;
    outline-offset: -2px;
  }
`;
