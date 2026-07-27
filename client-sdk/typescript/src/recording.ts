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
}

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
 * Minimal surface {@link RecordingController} needs from the client. The full
 * `KerbcastClient` satisfies it; a narrow interface keeps the controller
 * unit-testable without a whole client.
 */
export interface RecordingClient {
  camera(flightId: number): { readonly mediaStream: MediaStream | null };
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
      };
    });
    this.snapshot = { recordings, groups, active };
    for (const l of this.listeners) l();
  }

  /**
   * Start recording a feed's live track. Returns a client-minted recordingId
   * synchronously. Throws if the feed has no live track or is already
   * recording.
   */
  startRecording(flightId: number, opts?: StartRecordingOptions): string {
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

    recorder.start();

    if (opts?.maxDurationMs != null) {
      rec.maxDurationTimer = setTimeout(() => {
        void this.stopRecording(recordingId).catch(() => {});
      }, opts.maxDurationMs);
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
           instead of resurrecting a "discarded" recording once it settles. */
        rec.discarded = true;
      } else {
        if (rec.maxDurationTimer) clearTimeout(rec.maxDurationTimer);
        rec.unsubscribeClock();
        try {
          if (rec.recorder.state !== "inactive") rec.recorder.stop();
        } catch {
          /* a recorder already torn down by the browser is fine to ignore */
        }
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
          started.push(this.startRecording(flightId, opts));
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

    const recordings = await Promise.all(ids.map((id) => this.stopRecording(id)));
    const window = commonUtWindow(recordings);

    /* Physically remux-trim each clip to the common window so the grouped
       output is pre-aligned by default. The UT metadata (utSamples +
       commonUtWindow) still rides along so a consumer can align the trimmed
       clips to telemetry. Trimming never fails the recording: any clip that
       can't be cut cleanly degrades to metadata-only. */
    let finalRecordings = recordings;
    if (window) {
      const trimmer = await (this.groupTrimmers.get(groupId) ?? Promise.resolve(null));
      if (trimmer) {
        finalRecordings = await Promise.all(
          recordings.map((rec) => this.maybeTrim(rec, window, trimmer)),
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
