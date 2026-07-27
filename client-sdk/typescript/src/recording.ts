/*
 * Client-side camera recording.
 *
 * Records an already-received WebRTC camera track with the browser's
 * MediaRecorder, annotating the clip with the mission-time (UT) clock so a
 * consumer can align frames to telemetry. Pure client-side: no sidecar,
 * plugin, protocol, or network involvement. The sidecar never learns a
 * recording happened.
 *
 * The value-add over a bare MediaRecorder is the UT track: `utStart` /
 * `utEnd` bracket the clip, and `utSamples` is a ~1Hz series of
 * (recording-time, UT) points sampled from the client's capture clock, so a
 * consumer can interpolate any frame's UT near-frame-tight. Out of flight the
 * clock is unknown, so samples fall back to wall-clock timing (`ut` absent)
 * and upgrade automatically once UT appears.
 */

import type { CameraState } from "./__generated__/types";

/**
 * One point on a recording's UT track. `t` is milliseconds since recording
 * start; `ut` is the KSP universal time (seconds) the capture clock reported
 * at that instant, or absent when out of flight (no clock).
 */
export interface UtSample {
  t: number;
  ut?: number;
}

/** The finished, in-memory result of a single-feed recording. */
export interface RecordingHandle {
  recordingId: string;
  /** The camera this clip was recorded from. */
  flightId: number;
  /** The recorded media, in `mimeType`. */
  blob: Blob;
  /** The negotiated container/codec (e.g. `video/mp4;codecs=avc1`). */
  mimeType: string;
  /** UT (seconds) at recording start, or absent when out of flight. */
  utStart?: number;
  /** UT (seconds) at recording stop, or absent when out of flight. */
  utEnd?: number;
  /** ~1Hz (recording-time, UT) series across the clip. Always present. */
  utSamples: UtSample[];
  /** `blob.size` in bytes. */
  byteSize: number;
  /** Wall-clock recording duration in milliseconds. */
  durationMs: number;
}

/** Options for {@link RecordingController.startRecording}. */
export interface StartRecordingOptions {
  /**
   * Preferred container/codec. Tried first; if MediaRecorder can't support
   * it, negotiation falls back (mp4 -> webm/vp9 -> webm). Omit to let
   * negotiation choose.
   */
  mimeType?: string;
  /**
   * Auto-stop after this many milliseconds. The clip finalizes on its own and
   * is retrievable via {@link RecordingController.fetchRecording}. Omit for
   * manual stop only.
   */
  maxDurationMs?: number;
  /**
   * Force this feed to the operator's full render size for the duration of
   * the recording (overrides the display-size demand only; still yields to
   * the adaptive framerate shed). Off by default. A single recording arms
   * and waits (bounded) for the bump before the clip starts, so it opens on
   * full-res frames; a grouped recording starts immediately and the lead-in
   * is cut via the existing UT-window trim instead. Released automatically
   * on stop, discard, or auto-stop.
   */
  forceFullResolution?: boolean;
}

/**
 * Bound on the single-recording arm-and-wait: how long
 * {@link RecordingController.startRecording} waits for a forced feed to
 * reach full resolution before starting the recorder anyway. Never hangs a
 * start indefinitely (feed out of flight, wedged, or the sidecar/plugin
 * round trip taking longer than expected).
 */
export const ARM_TIMEOUT_MS = 3000;

/** Options for {@link RecordingController.stopGroupedRecording}. */
export interface StopGroupedRecordingOptions {
  /**
   * Coverage guarantee: hold finalization until every feed's latest UT sample
   * has passed this UT (seconds), so no feed falls short of the common window.
   * Omit to stop all feeds at the current moment (best-effort).
   *
   * The guarantee only holds for members that are still recording when the
   * target arrives. A member started with its own `maxDurationMs` can
   * auto-stop before reaching `targetUt`; that member's `utEnd` then falls
   * short, which silently narrows (or, if the ranges no longer overlap,
   * clears) the resulting `commonUtWindow`. Pair a grouped `targetUt` with an
   * unbounded (or generously long) per-member `maxDurationMs`, or none at all.
   */
  targetUt?: number;
  /**
   * Bound on how long to wait for `targetUt` coverage before giving up and
   * finalizing with whatever each feed has captured so far. Guards against a
   * UT that never arrives (feed out of flight, sim frozen, warp reversed)
   * hanging the stop forever. Ignored when `targetUt` is omitted. Defaults to
   * {@link DEFAULT_COVERAGE_TIMEOUT_MS}.
   */
  coverageTimeoutMs?: number;
}

/** Default {@link StopGroupedRecordingOptions.coverageTimeoutMs}. */
export const DEFAULT_COVERAGE_TIMEOUT_MS = 10_000;

/** The result of {@link RecordingController.startGroupedRecording}. */
export interface GroupedRecordingStart {
  groupId: string;
  /**
   * The real per-feed recording ids the controller minted internally, in the
   * order `flightIds` was given. These are the ids that work with the
   * single-recording surface (`isRecording`, `stopRecording`,
   * `discardRecording`) for cancelling one member of the group.
   */
  recordingIds: string[];
}

/** The finished, in-memory result of a grouped (multi-feed) recording. */
export interface GroupedRecordingHandle {
  groupId: string;
  /** One handle per feed, in the order the group was started. */
  recordings: RecordingHandle[];
  /**
   * The UT span all feeds cover: [max(utStart), min(utEnd)] across the clips.
   * Absent when any clip lacks UT or the ranges don't overlap. Each clip's
   * own `utSamples` let a consumer map this window to that clip's
   * recording-time and trim/seek itself (metadata alignment; no physical cut).
   */
  commonUtWindow?: [number, number];
}

/**
 * An in-progress recording, surfaced so the UI can draw a REC dot and an
 * elapsed timer. `groupId` is set when the recording is part of a grouped set.
 */
export interface ActiveRecordingInfo {
  recordingId: string;
  flightId: number;
  /** `performance.now()`/`Date.now()` at start, for an elapsed timer. */
  startedAt: number;
  groupId?: string;
  /**
   * True while a single forced recording is armed (force sent, waiting for
   * the feed to reach full resolution) but the recorder has not started
   * yet. Always false for a non-forced recording and for grouped members
   * (which record immediately). A UI shows a distinct "arming" state while
   * this is true.
   */
  arming: boolean;
}

/**
 * Everything {@link RecordingController} currently knows, as one referentially
 * stable object: the same reference between mutations, a new one after each.
 * That stability is what makes it safe to hand straight to
 * `useSyncExternalStore` -- a fresh object on every call would spin components
 * into an infinite render loop.
 */
export interface RecordingsSnapshot {
  /** Finished standalone (non-grouped) clips, newest last. */
  recordings: RecordingHandle[];
  /** Finished grouped sets, newest last. */
  groups: GroupedRecordingHandle[];
  /** Recordings currently in progress (single + grouped members). */
  active: ActiveRecordingInfo[];
}

/**
 * Per-camera surface {@link RecordingController} needs: the live stream plus
 * enough of the full camera handle to drive a forced full-resolution
 * recording (send the force, observe the resulting render size).
 */
export interface RecordingClientCamera {
  readonly mediaStream: MediaStream | null;
  readonly state: CameraState | null;
  /**
   * The feed's physical/ceiling maximum render size, or `null` when not
   * known to the client (e.g. `discover()` was never called). When known,
   * lets the controller recognise a forced feed that has actually reached
   * its ceiling rather than one merely unchanged since before the force.
   */
  readonly maxRenderSize: { width: number; height: number } | null;
  setForceFullResolution(force: boolean): Promise<void>;
  on(event: "change", handler: (state: CameraState) => void): () => void;
}

/**
 * Minimal surface {@link RecordingController} needs from the client. The full
 * `KerbcastClient` satisfies it; a narrow interface keeps the controller
 * unit-testable without a whole client.
 */
export interface RecordingClient {
  camera(flightId: number): RecordingClientCamera;
  readonly clock: { readonly captureUt: number | null };
  on(event: "settings-change", handler: (data: unknown) => void): () => void;
}

/* MediaRecorder is a DOM lib global; keep a minimal structural view so this
   module builds without dom.iterable and stays mockable in jsdom. */
interface MediaRecorderLike {
  state: string;
  start(timeslice?: number): void;
  stop(): void;
  addEventListener(type: string, cb: (e: { data?: Blob }) => void): void;
  removeEventListener(type: string, cb: (e: { data?: Blob }) => void): void;
}
interface MediaRecorderCtor {
  new (stream: MediaStream, options?: { mimeType?: string }): MediaRecorderLike;
  isTypeSupported?(type: string): boolean;
}

/** Preference order for mime negotiation, after any caller-supplied choice. */
const MIME_CANDIDATES = [
  "video/mp4;codecs=avc1",
  "video/webm;codecs=vp9",
  "video/webm",
];

/**
 * Pick a MediaRecorder mime type. Tries `preferred` first (when given), then
 * the standard preference order, using `MediaRecorder.isTypeSupported`. Falls
 * back to `video/webm` when nothing reports support (or the API is absent).
 */
export function negotiateMimeType(preferred?: string): string {
  const ctor = (globalThis as { MediaRecorder?: MediaRecorderCtor }).MediaRecorder;
  const candidates = preferred ? [preferred, ...MIME_CANDIDATES] : MIME_CANDIDATES;
  if (ctor && typeof ctor.isTypeSupported === "function") {
    for (const candidate of candidates) {
      if (ctor.isTypeSupported(candidate)) return candidate;
    }
  }
  return "video/webm";
}

/** Monotonic clock for recording-time. Falls back to Date.now under jsdom. */
function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

/**
 * Intersection of the feeds' UT ranges: [max(utStart), min(utEnd)]. Returns
 * undefined if any clip lacks a full range or the spans don't overlap.
 */
export function commonUtWindow(recordings: RecordingHandle[]): [number, number] | undefined {
  if (recordings.length === 0) return undefined;
  let lo = -Infinity;
  let hi = Infinity;
  for (const rec of recordings) {
    if (rec.utStart == null || rec.utEnd == null) return undefined;
    lo = Math.max(lo, rec.utStart);
    hi = Math.min(hi, rec.utEnd);
  }
  return lo <= hi ? [lo, hi] : undefined;
}

/**
 * Recording-time (ms since clip start) for a mission UT, linearly interpolated
 * off a clip's `utSamples`. UT is linear in recording time at constant
 * time-warp (the launch/landing/docking moments a group captures), so this maps
 * the common UT window onto each clip's own timeline for a keyframe trim.
 * Clamps to the sampled span; returns null when the clip has no UT samples.
 */
export function utToRecordingTimeMs(samples: UtSample[], ut: number): number | null {
  const pts = samples.filter((s): s is { t: number; ut: number } => s.ut != null);
  if (pts.length === 0) return null;
  if (ut <= pts[0].ut) return pts[0].t;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (ut >= a.ut && ut <= b.ut) {
      if (b.ut === a.ut) return a.t;
      const frac = (ut - a.ut) / (b.ut - a.ut);
      return a.t + frac * (b.t - a.t);
    }
  }
  return pts[pts.length - 1].t;
}

/**
 * Remux-trims a grouped clip to a recording-time window. Implemented by a
 * lazily-loaded package (Mediabunny) so single recordings and non-recording
 * consumers never pull it. Keyframe-boundary remux only: no decode/re-encode.
 */
export interface GroupTrimmer {
  /** Cut `blob` to [startMs, endMs] of its own timeline; resolves a new Blob. */
  trim(blob: Blob, mimeType: string, startMs: number, endMs: number): Promise<Blob>;
}

/** Loads a {@link GroupTrimmer}, or resolves null when trimming is unavailable. */
export type TrimmerLoader = () => Promise<GroupTrimmer | null>;

/** Options for {@link RecordingController}. */
export interface RecordingControllerOptions {
  /**
   * Override the grouped-recording trimmer loader (tests inject a fake; a
   * consumer could supply mp4box.js instead). Defaults to a dynamic
   * `import("mediabunny")` keyframe remux.
   */
  loadTrimmer?: TrimmerLoader;
}

/**
 * Structural view of the Mediabunny module surface the remux trim needs.
 * Deliberately not `typeof import("mediabunny")`: keeping it a plain
 * structural type means a caller can hand in the module however it got
 * resolved -- the bare package (bundler consumers), or a pre-built bundle
 * served from elsewhere (the sidecar's embedded web page serves its own
 * copy locally; see {@link createMediabunnyTrimmerLoader}).
 */
interface MediabunnyModule {
  Input: new (opts: { source: unknown; formats: unknown }) => unknown;
  BlobSource: new (blob: Blob) => unknown;
  ALL_FORMATS: unknown;
  BufferTarget: new () => { buffer: ArrayBuffer | null };
  Output: new (opts: { format: unknown; target: unknown }) => unknown;
  Mp4OutputFormat: new () => unknown;
  Conversion: {
    init(opts: {
      input: unknown;
      output: unknown;
      trim: { start: number; end: number };
    }): Promise<{ execute(): Promise<void> }>;
  };
}

/**
 * Builds a {@link GroupTrimmer} from an already-resolved Mediabunny module
 * namespace: keyframe-boundary remux via its Conversion API, no re-encode.
 */
function mediabunnyTrimmer(mb: MediabunnyModule): GroupTrimmer {
  return {
    async trim(blob, mimeType, startMs, endMs): Promise<Blob> {
      const input = new mb.Input({
        source: new mb.BlobSource(blob),
        formats: mb.ALL_FORMATS,
      });
      const target = new mb.BufferTarget();
      const output = new mb.Output({ format: new mb.Mp4OutputFormat(), target });
      const conversion = await mb.Conversion.init({
        input,
        output,
        trim: { start: startMs / 1000, end: endMs / 1000 },
      });
      await conversion.execute();
      if (!target.buffer) throw new Error("mediabunny produced no output buffer");
      return new Blob([target.buffer], { type: mimeType });
    },
  };
}

/**
 * Builds a {@link TrimmerLoader} around a caller-supplied module import.
 * `loadMediabunnyTrimmer` (the default, below) resolves the bare
 * `import("mediabunny")` specifier for bundler consumers (e.g. gonogo). A
 * consumer that can't rely on that resolution -- the sidecar's embedded web
 * page, which serves its own copy of the package locally for an offline/LAN
 * install with no CDN -- supplies a different `importModule` (e.g. a dynamic
 * import of a served URL) and passes the result as
 * {@link RecordingControllerOptions.loadTrimmer}. Resolves null on any
 * failure, so a group degrades to metadata-only rather than failing.
 */
export function createMediabunnyTrimmerLoader(
  importModule: () => Promise<unknown>,
): TrimmerLoader {
  return async () => {
    try {
      return mediabunnyTrimmer((await importModule()) as MediabunnyModule);
    } catch {
      return null;
    }
  };
}

/**
 * Default trimmer: dynamically imports Mediabunny by its package name and
 * remuxes with its Conversion API. Loaded on group-start so it's ready by
 * stop.
 */
const loadMediabunnyTrimmer: TrimmerLoader = createMediabunnyTrimmerLoader(
  () => import("mediabunny"),
);

/** Live per-feed recording state, held between start and stop. */
interface ActiveRecording {
  recordingId: string;
  flightId: number;
  mimeType: string;
  recorder: MediaRecorderLike;
  chunks: Blob[];
  startedAt: number;
  utStart?: number;
  utSamples: UtSample[];
  /** Most recent UT seen (for the grouped coverage guarantee); undefined until first UT. */
  latestUt?: number;
  /** Detach from the client's settings-change clock feed. */
  unsubscribeClock: () => void;
  maxDurationTimer?: ReturnType<typeof setTimeout>;
  /** Resolves once the recorder's stop event has flushed the final chunk. */
  stopPromise?: Promise<RecordingHandle>;
  /**
   * Set when discarded while `stopPromise` was already settling (recorder
   * `inactive`, "stop" event not yet fired). Tells the pending `onStop` to
   * bail rather than resurrect a handle for a recording that was discarded.
   */
  discarded?: boolean;
  /**
   * True while a single forced recording is armed (force sent, recorder not
   * started yet). Never set for grouped members, which record immediately.
   */
  arming?: boolean;
  /** True once this recording has acquired the per-feed force ref-count. */
  forced?: boolean;
  /**
   * Grouped path only: recording-time (ms since `startedAt`) at which this
   * feed was observed at full resolution. Undefined until reached (or
   * always, if it never is before stop).
   */
  resolutionReadyAt?: number;
  /** Grouped path only: `client.clock.captureUt` at the same moment. */
  resolutionReadyUt?: number;
  /**
   * Cancels a pending arm-wait (single) or ready-watch (grouped)
   * subscription. Set while a {@link RecordingController.watchResolutionReady}
   * wait is outstanding; cleared once it settles or is cancelled. Always
   * cancelled on stop/discard so a torn-down recording never leaks a
   * "change" listener or starts its recorder late.
   */
  cancelResolutionWatch?: () => void;
}

let idCounter = 0;
function mintId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

/**
 * Owns every in-flight and finished recording for one client. Reached via
 * `client.recording`. All state is in-memory: a page reload discards it.
 *
 * Observable: {@link subscribe} + {@link getSnapshot} let every call site
 * (a tile's own REC control, a RecordingsTray mounted elsewhere) read the same
 * state, so a clip started or finished through one is visible to all the
 * others -- no per-instance state to fall out of sync.
 */
export class RecordingController {
  private readonly client: RecordingClient;
  private readonly active = new Map<string, ActiveRecording>();
  private readonly finished = new Map<string, RecordingHandle>();
  /** flightId -> recordingId, so a second start on a busy feed is rejected. */
  private readonly byFlight = new Map<number, string>();
  private readonly groups = new Map<string, string[]>();
  private readonly finishedGroups = new Map<string, GroupedRecordingHandle>();
  /** Per-group trimmer load kicked off at group-start, awaited at stop. */
  private readonly groupTrimmers = new Map<string, Promise<GroupTrimmer | null>>();
  private readonly loadTrimmer: TrimmerLoader;
  /** recordingIds in a grouped set, so they stay out of the standalone `recordings` list. */
  private readonly groupMemberIds = new Set<string>();
  /** recordingId -> groupId, so discarding one member can pull it out of its group's array. */
  private readonly memberOfGroup = new Map<string, string>();
  /**
   * Per-feed force ref-count. The sidecar OR-aggregates force across
   * viewers already; this is the local mirror so two overlapping
   * recordings of the same feed (in this one controller) release force
   * only when the last of them stops.
   */
  private readonly forceCounts = new Map<number, number>();
  /**
   * Per-feed force-true send status: "pending" while a send is in flight,
   * "sent" once it has actually succeeded. Absent means neither: either
   * never attempted, or a prior attempt failed. Distinct from
   * {@link forceCounts} so a failed send never masquerades as a completed
   * one; see {@link acquireForce}.
   */
  private readonly forceSendState = new Map<number, "pending" | "sent">();
  private readonly listeners = new Set<() => void>();
  private snapshot: RecordingsSnapshot = { recordings: [], groups: [], active: [] };
  /** While true, {@link rebuild} is a no-op; used to batch startGroupedRecording's
   *  per-member starts into a single notification once the group is fully set up. */
  private suppressRebuild = false;

  constructor(client: RecordingClient, options?: RecordingControllerOptions) {
    this.client = client;
    this.loadTrimmer = options?.loadTrimmer ?? loadMediabunnyTrimmer;
  }

  /** Subscribe to snapshot changes. Returns an unsubscribe function. */
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  /** The current snapshot; the same object reference until the next mutation. */
  getSnapshot = (): RecordingsSnapshot => this.snapshot;

  /**
   * Recompute the snapshot from current state and notify subscribers. Called
   * at the end of every state-mutating operation, including the async settle
   * points (recorder stop, grouped stop) where the data actually changes.
   */
  private rebuild(): void {
    if (this.suppressRebuild) return;
    const recordings = [...this.finished.values()].filter(
      (r) => !this.groupMemberIds.has(r.recordingId),
    );
    const groups = [...this.finishedGroups.values()];
    const active: ActiveRecordingInfo[] = [...this.active.values()].map((rec) => {
      let groupId: string | undefined;
      for (const [gid, ids] of this.groups) {
        if (ids.includes(rec.recordingId)) {
          groupId = gid;
          break;
        }
      }
      return {
        recordingId: rec.recordingId,
        flightId: rec.flightId,
        startedAt: rec.startedAt,
        groupId,
        arming: rec.arming ?? false,
      };
    });
    this.snapshot = { recordings, groups, active };
    for (const l of this.listeners) l();
  }

  /**
   * Acquire the local force ref-count for a feed; sends
   * `setForceFullResolution(true)` unless one is already in flight or has
   * already succeeded for this feed (tracked in {@link forceSendState}, not
   * just the ref-count reaching 1). The sidecar OR-aggregates force across
   * viewers already; this ref-count is the belt-and-braces local mirror for
   * two overlapping recordings of the same feed in this one controller.
   *
   * A send failure clears `forceSendState` instead of leaving it "sent", so
   * it never masquerades as done: a later acquire (e.g. a second overlapping
   * recording's 1->2 transition) sees the feed as not-yet-forced and retries
   * the send, rather than silently leaving the feed un-forced forever.
   */
  private acquireForce(flightId: number): void {
    const count = (this.forceCounts.get(flightId) ?? 0) + 1;
    this.forceCounts.set(flightId, count);
    if (this.forceSendState.has(flightId)) return;
    this.forceSendState.set(flightId, "pending");
    void this.client
      .camera(flightId)
      .setForceFullResolution(true)
      .then(() => {
        this.forceSendState.set(flightId, "sent");
      })
      .catch((err: unknown) => {
        this.forceSendState.delete(flightId);
        console.error(
          `kerbcast: setForceFullResolution(true) failed for feed ${flightId}; will retry on next acquire`,
          err,
        );
      });
  }

  /**
   * Release one holder of a feed's force ref-count; sends
   * `setForceFullResolution(false)` once the count reaches zero. Never goes
   * below zero (a stray extra release is a no-op, not an underflow). Clears
   * `forceSendState` too, so a later, unrelated recording of this feed
   * starts its own send from a clean slate.
   */
  private releaseForce(flightId: number): void {
    const count = (this.forceCounts.get(flightId) ?? 0) - 1;
    if (count <= 0) {
      this.forceCounts.delete(flightId);
      this.forceSendState.delete(flightId);
      void this.client
        .camera(flightId)
        .setForceFullResolution(false)
        .catch(() => {});
    } else {
      this.forceCounts.set(flightId, count);
    }
  }

  /**
   * Whether `state` shows a feed actually rendering at its full target size,
   * as opposed to merely having caught up to whatever small size it already
   * had. Two ways to know the target:
   *
   * - `target` known (from `maxRenderSize`): ready once the operator size
   *   has reached it and the rendered size has caught up to the operator
   *   size. Resolves promptly even when the feed was already at its ceiling
   *   before the force was sent (nothing ever "increases").
   * - `target` unknown: falls back to requiring the operator size to have
   *   increased past `baseline` (the first REAL state observed at or after
   *   watch-start; see {@link watchResolutionReady}) and the rendered size
   *   to have caught up. `baseline` is `null` until that first real state
   *   arrives, and a `null` baseline is never ready: a placeholder `{0,0}`
   *   would let any positive operator size look like an increase, so no
   *   verdict is possible until a genuine baseline exists. This is a
   *   strictly weaker guarantee than the known-target path: a feed already
   *   at its true ceiling when forced will not be recognised as ready until
   *   something else changes its operator size, or the wait simply times
   *   out, but it still refuses to treat the pre-force snapshot itself as
   *   ready.
   *
   * Either way, a state whose rendered size has not yet caught up to its own
   * operator size (adaptive shed still catching up) is never ready.
   */
  private isAtFullResolution(
    state: CameraState | null,
    target: { width: number; height: number } | null,
    baseline: { width: number; height: number } | null,
  ): boolean {
    if (!state) return false;
    if (state.renderWidth !== state.operatorWidth || state.renderHeight !== state.operatorHeight) {
      return false;
    }
    if (target) {
      return state.operatorWidth >= target.width && state.operatorHeight >= target.height;
    }
    if (!baseline) return false;
    return state.operatorWidth > baseline.width && state.operatorHeight > baseline.height;
  }

  /**
   * Seeds a fallback baseline from an observed state, or returns `null` if
   * the state isn't a REAL observation (operator size still zero, i.e. no
   * dimensions have ever been reported for this feed). A `null` result
   * means the caller must keep waiting for a state worth basing readiness
   * on, rather than latching onto a `{0,0}` placeholder.
   */
  private seedResolutionBaseline(
    state: CameraState | null,
  ): { width: number; height: number } | null {
    if (!state) return null;
    if (state.operatorWidth <= 0 && state.operatorHeight <= 0) return null;
    return { width: state.operatorWidth, height: state.operatorHeight };
  }

  /**
   * Waits for a forced feed to actually render at full resolution.
   * `timeoutMs` omitted means no bound: the wait only ends when the feed
   * becomes ready or the caller cancels it (the grouped path, bounded by the
   * recording's own lifetime instead; see {@link startRecording}).
   * Resolves `true` once ready, `false` on timeout. Returns a `cancel` next
   * to the promise so a caller can abandon the wait (stop/discard) without
   * leaking the underlying "change" subscription or timer; cancelling never
   * settles the promise.
   */
  private watchResolutionReady(
    flightId: number,
    timeoutMs?: number,
  ): { ready: Promise<boolean>; cancel: () => void } {
    const cam = this.client.camera(flightId);
    const target = cam.maxRenderSize;
    /* Known-ceiling path never consults baseline; unknown-ceiling path
       starts with no baseline until a real state seeds one, so a null
       cam.state at watch-start (e.g. no discover() yet, since state and
       the track are independent transports with no ordering guarantee)
       can never masquerade as a {0,0} baseline. */
    let baseline = target ? null : this.seedResolutionBaseline(cam.state);

    let settled = false;
    let unsubscribe: () => void = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;

    const ready = new Promise<boolean>((resolve) => {
      const finish = (reached: boolean): void => {
        if (settled) return;
        settled = true;
        if (timer != null) clearTimeout(timer);
        unsubscribe();
        resolve(reached);
      };

      if (this.isAtFullResolution(cam.state, target, baseline)) {
        finish(true);
        return;
      }

      unsubscribe = cam.on("change", (state) => {
        if (!target && !baseline) {
          /* This is the first real state we've ever seen: it becomes the
             baseline, but a state can't ready itself against its own
             just-established baseline, so wait for the NEXT state. */
          baseline = this.seedResolutionBaseline(state);
          return;
        }
        if (this.isAtFullResolution(state, target, baseline)) finish(true);
      });
      if (timeoutMs != null) {
        timer = setTimeout(() => finish(false), timeoutMs);
      }
    });

    return {
      ready,
      cancel: (): void => {
        if (settled) return;
        settled = true;
        if (timer != null) clearTimeout(timer);
        unsubscribe();
      },
    };
  }

  /**
   * Start recording a feed's live track. Returns a client-minted recordingId
   * synchronously. Throws if the feed has no live track or is already
   * recording.
   *
   * `inGroup` is internal (set by {@link startGroupedRecording}) and governs
   * how `opts.forceFullResolution` behaves: a single recording (`inGroup`
   * false) arms and waits, bounded by {@link ARM_TIMEOUT_MS}, for the feed to
   * reach full resolution before the recorder actually starts, so the clip
   * opens on full-res frames. A grouped member starts immediately and
   * instead records the moment it reaches full resolution
   * (`resolutionReadyAt`/`resolutionReadyUt`) so {@link stopGroupedRecording}
   * can fold it into the common trim window.
   */
  startRecording(flightId: number, opts?: StartRecordingOptions, inGroup = false): string {
    if (this.byFlight.has(flightId)) {
      throw new Error(`camera ${flightId} is already recording`);
    }
    const stream = this.client.camera(flightId).mediaStream;
    if (!stream || stream.getVideoTracks().length === 0) {
      throw new Error(`camera ${flightId} has no live track to record`);
    }

    const mimeType = negotiateMimeType(opts?.mimeType);
    const ctor = (globalThis as { MediaRecorder?: MediaRecorderCtor }).MediaRecorder;
    if (!ctor) throw new Error("MediaRecorder is not available in this environment");
    const recorder = new ctor(stream, { mimeType });

    const recordingId = mintId("rec");
    const startedAt = now();
    const utStart = this.client.clock.captureUt ?? undefined;

    const rec: ActiveRecording = {
      recordingId,
      flightId,
      mimeType,
      recorder,
      chunks: [],
      startedAt,
      utStart,
      utSamples: [{ t: 0, ut: utStart }],
      latestUt: utStart,
      unsubscribeClock: () => {},
    };

    recorder.addEventListener("dataavailable", (e) => {
      if (e.data && e.data.size > 0) rec.chunks.push(e.data);
    });

    /* Sample the capture clock on each ~1Hz settings-change push. Duplicates
       (a paused sim) are kept so `t` still advances; ut upgrades from absent
       to present automatically once out-of-flight becomes in-flight. */
    rec.unsubscribeClock = this.client.on("settings-change", () => {
      const ut = this.client.clock.captureUt ?? undefined;
      rec.utSamples.push({ t: now() - rec.startedAt, ut });
      if (ut != null) rec.latestUt = ut;
    });

    this.active.set(recordingId, rec);
    this.byFlight.set(flightId, recordingId);

    const forceRequested = opts?.forceFullResolution === true;
    if (forceRequested) {
      rec.forced = true;
      this.acquireForce(flightId);
    }

    if (opts?.maxDurationMs != null) {
      rec.maxDurationTimer = setTimeout(() => {
        void this.stopRecording(recordingId).catch(() => {});
      }, opts.maxDurationMs);
    }

    if (forceRequested && !inGroup) {
      /* Single path: arm-and-wait. Show "arming" immediately; the recorder
         itself doesn't start until the feed reaches full resolution (or the
         bounded wait gives up), so the clip never opens on low-res frames. */
      rec.arming = true;
      const watch = this.watchResolutionReady(flightId, ARM_TIMEOUT_MS);
      rec.cancelResolutionWatch = watch.cancel;
      void watch.ready.then(() => {
        rec.cancelResolutionWatch = undefined;
        /* Discarded while arming: the recorder was never started and this
           id is gone from `active`, so there is nothing left to do. */
        if (!this.active.has(recordingId)) return;
        rec.arming = false;
        /* The real recording starts now: reset the clock base so the
           elapsed timer and utSamples track begin at actual record start,
           not at arm time. */
        rec.startedAt = now();
        rec.utStart = this.client.clock.captureUt ?? undefined;
        rec.utSamples = [{ t: 0, ut: rec.utStart }];
        rec.latestUt = rec.utStart;
        rec.recorder.start();
        this.rebuild();
      });
    } else {
      recorder.start();
      if (forceRequested) {
        /* Grouped path: record immediately. Watch for the moment this feed
           actually reaches full resolution so stopGroupedRecording can fold
           it into the common trim window and cut the low-res lead-in. No
           bound here: the wait is naturally bounded by the recording's own
           lifetime (cancelled on stop/discard); a feed that never reaches
           full resolution simply keeps its lead-in untrimmed. */
        const watch = this.watchResolutionReady(flightId);
        rec.cancelResolutionWatch = watch.cancel;
        void watch.ready.then((reached) => {
          rec.cancelResolutionWatch = undefined;
          if (!reached) return;
          if (!this.active.has(recordingId)) return;
          if (rec.resolutionReadyAt == null) {
            rec.resolutionReadyAt = now() - rec.startedAt;
            rec.resolutionReadyUt = this.client.clock.captureUt ?? undefined;
          }
        });
      }
    }

    this.rebuild();
    return recordingId;
  }

  /**
   * Stop a recording and resolve its finished handle. Idempotent per id: a
   * second call (or a race with maxDurationMs auto-stop) returns the same
   * pending/settled result.
   */
  stopRecording(recordingId: string): Promise<RecordingHandle> {
    const rec = this.active.get(recordingId);
    if (!rec) {
      const done = this.finished.get(recordingId);
      if (done) return Promise.resolve(done);
      return Promise.reject(new Error(`no recording ${recordingId}`));
    }
    if (rec.stopPromise) return rec.stopPromise;

    if (rec.maxDurationTimer) clearTimeout(rec.maxDurationTimer);
    rec.unsubscribeClock();
    rec.cancelResolutionWatch?.();
    rec.cancelResolutionWatch = undefined;

    if (rec.arming) {
      /* Stopped (e.g. a short maxDurationMs firing) before the arm-wait
         ever let the recorder start: there is nothing to flush from
         MediaRecorder, and calling stop() on a never-started recorder would
         never fire its "stop" event (hanging this promise forever). Settle
         immediately with an empty clip instead. Force is still released
         unconditionally. */
      if (rec.forced) this.releaseForce(rec.flightId);
      const utEnd = this.client.clock.captureUt ?? undefined;
      const handle: RecordingHandle = {
        recordingId,
        flightId: rec.flightId,
        blob: new Blob([], { type: rec.mimeType }),
        mimeType: rec.mimeType,
        utStart: rec.utStart,
        utEnd,
        utSamples: [...rec.utSamples, { t: now() - rec.startedAt, ut: utEnd }],
        byteSize: 0,
        durationMs: now() - rec.startedAt,
      };
      rec.stopPromise = Promise.resolve(handle);
      this.finished.set(recordingId, handle);
      this.active.delete(recordingId);
      this.byFlight.delete(rec.flightId);
      this.rebuild();
      return rec.stopPromise;
    }

    const utEnd = this.client.clock.captureUt ?? undefined;
    rec.utSamples.push({ t: now() - rec.startedAt, ut: utEnd });

    rec.stopPromise = new Promise<RecordingHandle>((resolve) => {
      const onStop = (): void => {
        rec.recorder.removeEventListener("stop", onStop);
        const blob = new Blob(rec.chunks, { type: rec.mimeType });
        const handle: RecordingHandle = {
          recordingId,
          flightId: rec.flightId,
          blob,
          mimeType: rec.mimeType,
          utStart: rec.utStart,
          utEnd,
          utSamples: rec.utSamples,
          byteSize: blob.size,
          durationMs: now() - rec.startedAt,
        };
        /* Unconditional: a discarded-while-settling recording still held the
           force ref-count and must release it, even though it won't be
           resurrected into `finished` below. */
        if (rec.forced) this.releaseForce(rec.flightId);
        /* Discarded while this stop was settling: don't resurrect it into
           `finished`, standalone or grouped. Still resolve so a caller
           awaiting this same promise doesn't hang. */
        if (!rec.discarded) {
          this.finished.set(recordingId, handle);
          this.active.delete(recordingId);
          this.byFlight.delete(rec.flightId);
          this.rebuild();
        }
        resolve(handle);
      };
      rec.recorder.addEventListener("stop", onStop);
      rec.recorder.stop();
    });

    return rec.stopPromise;
  }

  /** Return a finished recording's handle, or undefined if unknown/still active. */
  fetchRecording(recordingId: string): RecordingHandle | undefined {
    return this.finished.get(recordingId);
  }

  /** Whether a feed currently has a recording in progress. */
  isRecording(flightId: number): boolean {
    return this.byFlight.has(flightId);
  }

  /**
   * Drop a recording. If still active, tears it down without producing a
   * handle; if finished, frees the stored handle/blob reference. If the id
   * is a member of a still-active group, pulls it out of that group's member
   * set too, so a later `stopGroupedRecording` only waits on (and stops) the
   * ids that remain -- discarding one member no longer corrupts the group.
   */
  discardRecording(recordingId: string): void {
    const rec = this.active.get(recordingId);
    let changed = false;
    if (rec) {
      if (rec.stopPromise) {
        /* stopRecording already called: the recorder is "inactive" but its
           "stop" event hasn't fired. Flag it so that pending onStop bails
           instead of resurrecting a "discarded" recording once it settles.
           That same onStop releases the force ref-count unconditionally, so
           it must not be released again here. */
        rec.discarded = true;
      } else {
        if (rec.maxDurationTimer) clearTimeout(rec.maxDurationTimer);
        rec.unsubscribeClock();
        rec.cancelResolutionWatch?.();
        rec.cancelResolutionWatch = undefined;
        try {
          if (rec.recorder.state !== "inactive") rec.recorder.stop();
        } catch {
          /* a recorder already torn down by the browser is fine to ignore */
        }
        /* No pending stopRecording to release it later (this is the only
           teardown path this recording will see): release the force
           ref-count now, unconditionally. Covers a discard mid-arm too --
           the recorder above was never started (still "inactive"), so this
           is the only place its force gets released. */
        if (rec.forced) this.releaseForce(rec.flightId);
      }
      this.active.delete(recordingId);
      this.byFlight.delete(rec.flightId);
      changed = true;
    }
    if (this.finished.delete(recordingId)) changed = true;

    const groupId = this.memberOfGroup.get(recordingId);
    if (groupId != null) {
      this.memberOfGroup.delete(recordingId);
      this.groupMemberIds.delete(recordingId);
      const ids = this.groups.get(groupId);
      if (ids) {
        const idx = ids.indexOf(recordingId);
        if (idx !== -1) {
          ids.splice(idx, 1);
          changed = true;
        }
      }
    }

    if (changed) this.rebuild();
  }

  // -------------------------------------------------------------------------
  // Grouped recording
  // -------------------------------------------------------------------------

  /**
   * Start recording several feeds as one synchronised moment. All recorders
   * open in a single tick to minimise skew. Returns the groupId plus the real
   * per-feed recordingIds (so a caller can cancel one member individually via
   * `stopRecording`/`discardRecording`, the same ids that end up on each
   * clip's `RecordingHandle`). If any feed can't start (no track / already
   * recording), the ones already started are discarded and the error
   * rethrows.
   */
  startGroupedRecording(
    flightIds: number[],
    opts?: StartRecordingOptions,
  ): GroupedRecordingStart {
    const started: string[] = [];
    /* Suppress the per-member rebuild() each startRecording call would fire:
       without this, a synchronous subscriber could observe a member as
       active with groupId undefined (this.groups doesn't have the entry yet).
       One rebuild happens below, once the group is fully set up. */
    this.suppressRebuild = true;
    try {
      try {
        for (const flightId of flightIds) {
          started.push(this.startRecording(flightId, opts, /* inGroup */ true));
        }
      } catch (err) {
        for (const id of started) this.discardRecording(id);
        throw err;
      }
      const groupId = mintId("grp");
      this.groups.set(groupId, started);
      for (const id of started) {
        this.groupMemberIds.add(id);
        this.memberOfGroup.set(id, groupId);
      }
      /* Grouped output is physically trimmed to the common window by default, so
         load the trim package now (never fail start over a loader error) so it is
         ready by stop. A single recording never reaches here, so it stays
         dependency-free. Accepted tradeoff: this eagerly imports Mediabunny even
         when every feed ends up negotiating webm (no mp4 clip to trim). */
      this.groupTrimmers.set(
        groupId,
        (async (): Promise<GroupTrimmer | null> => {
          try {
            return await this.loadTrimmer();
          } catch {
            return null;
          }
        })(),
      );
      return { groupId, recordingIds: [...started] };
    } finally {
      this.suppressRebuild = false;
      this.rebuild();
    }
  }

  /**
   * Stop a grouped recording. With `targetUt`, holds until every feed's latest
   * UT sample has passed it (coverage guarantee) before stopping any feed;
   * without it, stops all now. Resolves the grouped handle with the intersected
   * `commonUtWindow`. See {@link StopGroupedRecordingOptions.targetUt} for the
   * coverage caveat around a member's own `maxDurationMs`.
   */
  async stopGroupedRecording(
    groupId: string,
    opts?: StopGroupedRecordingOptions,
  ): Promise<GroupedRecordingHandle> {
    const done = this.finishedGroups.get(groupId);
    if (done) return done;
    const ids = this.groups.get(groupId);
    if (!ids) throw new Error(`no grouped recording ${groupId}`);

    if (opts?.targetUt != null) {
      await this.awaitCoverage(
        ids,
        opts.targetUt,
        opts.coverageTimeoutMs ?? DEFAULT_COVERAGE_TIMEOUT_MS,
      );
    }

    /* Capture each forced member's resolution-ready UT before stopRecording
       tears down its ActiveRecording bookkeeping below. */
    const resolutionReadyUts: number[] = [];
    for (const id of ids) {
      const ut = this.active.get(id)?.resolutionReadyUt;
      if (ut != null) resolutionReadyUts.push(ut);
    }

    const recordings = await Promise.all(ids.map((id) => this.stopRecording(id)));
    const window = commonUtWindow(recordings);

    /* Fold the low-res lead-in cut into the same common-window trim: extend
       the window's start to the latest point any forced member actually
       reached full resolution, so every clip stays cut to one shared window
       (UT-synced) rather than each clip getting its own start. A member that
       never reached full resolution before stop simply doesn't contribute
       (its own lead-in stays untrimmed, per the documented edge case). This
       only widens the physical trim cut: `commonUtWindow` on the returned
       handle keeps reporting the clips' own raw UT intersection, unchanged,
       since that's metadata about what the clips cover independent of
       whether (or how) they got physically cut. */
    let trimWindow = window;
    if (trimWindow && resolutionReadyUts.length > 0) {
      const windowStart = Math.max(trimWindow[0], ...resolutionReadyUts);
      trimWindow = [windowStart, trimWindow[1]];
    }

    /* Physically remux-trim each clip to the common window so the grouped
       output is pre-aligned by default. The UT metadata (utSamples +
       commonUtWindow) still rides along so a consumer can align the trimmed
       clips to telemetry. Trimming never fails the recording: any clip that
       can't be cut cleanly degrades to metadata-only. */
    let finalRecordings = recordings;
    if (trimWindow) {
      const trimmer = await (this.groupTrimmers.get(groupId) ?? Promise.resolve(null));
      if (trimmer) {
        finalRecordings = await Promise.all(
          recordings.map((rec) => this.maybeTrim(rec, trimWindow, trimmer)),
        );
      }
    }

    const handle: GroupedRecordingHandle = {
      groupId,
      recordings: finalRecordings,
      commonUtWindow: window,
    };
    this.groups.delete(groupId);
    this.groupTrimmers.delete(groupId);
    this.finishedGroups.set(groupId, handle);
    this.rebuild();
    return handle;
  }

  /**
   * Remux-trim one clip to the common UT window, or return it untouched
   * (metadata-only) when it can't be cut cleanly: a non-mp4 container, an
   * unmappable window, or a trimmer error. The stored per-clip handle is
   * replaced with the trimmed one so fetch/discard stay consistent.
   */
  private async maybeTrim(
    rec: RecordingHandle,
    window: [number, number],
    trimmer: GroupTrimmer,
  ): Promise<RecordingHandle> {
    /* MediaRecorder webm output isn't remuxed to mp4 here; degrade to
       metadata-only for those clips (mp4 is the default container). */
    if (!/mp4/i.test(rec.mimeType)) return rec;
    const startMs = utToRecordingTimeMs(rec.utSamples, window[0]);
    const endMs = utToRecordingTimeMs(rec.utSamples, window[1]);
    if (startMs == null || endMs == null || endMs <= startMs) return rec;
    try {
      const blob = await trimmer.trim(rec.blob, rec.mimeType, startMs, endMs);
      const trimmed: RecordingHandle = {
        ...rec,
        blob,
        byteSize: blob.size,
        durationMs: endMs - startMs,
      };
      this.finished.set(rec.recordingId, trimmed);
      return trimmed;
    } catch {
      return rec;
    }
  }

  /** Return a finished grouped recording, or undefined if unknown/still active. */
  fetchGroupedRecording(groupId: string): GroupedRecordingHandle | undefined {
    return this.finishedGroups.get(groupId);
  }

  /** Drop a grouped recording and each of its clips. */
  discardGroupedRecording(groupId: string): void {
    /* Accepted gap: racing this against an in-flight stopGroupedRecording(groupId)
       is untested and unlikely misuse (a caller wouldn't normally discard and
       stop the same group at once). */
    let changed = false;
    const active = this.groups.get(groupId);
    if (active) {
      /* discardRecording now splices ids out of this very array as it goes
         (fix for cancelling one grouped member); iterate a copy so removals
         mid-loop can't skip an id. */
      for (const id of [...active]) this.discardRecording(id);
      this.groups.delete(groupId);
      this.groupTrimmers.delete(groupId);
      changed = true;
    }
    const finished = this.finishedGroups.get(groupId);
    if (finished) {
      for (const rec of finished.recordings) this.discardRecording(rec.recordingId);
      this.finishedGroups.delete(groupId);
      changed = true;
    }
    if (changed) this.rebuild();
  }

  /**
   * Resolve once every listed recording's latest UT sample has reached
   * `targetUt`. UT arrives on the shared ~1Hz clock feed, so this polls the
   * settings-change stream rather than a wall-clock timer. Bounded by
   * `timeoutMs`: if coverage never arrives (feed out of flight, sim frozen,
   * warp reversed), gives up and resolves anyway so the group finalizes with
   * whatever UT each feed has captured, rather than hanging forever. Always
   * releases the settings-change subscription, on either exit path.
   */
  private awaitCoverage(
    recordingIds: string[],
    targetUt: number,
    timeoutMs: number,
  ): Promise<void> {
    const covered = (): boolean =>
      recordingIds.every((id) => {
        const rec = this.active.get(id);
        /* A recording already stopped counts as covered (nothing to wait on). */
        if (!rec) return true;
        return rec.latestUt != null && rec.latestUt >= targetUt;
      });

    if (covered()) return Promise.resolve();

    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve();
      };
      const unsubscribe = this.client.on("settings-change", () => {
        if (covered()) finish();
      });
      const timer = setTimeout(finish, timeoutMs);
    });
  }
}
