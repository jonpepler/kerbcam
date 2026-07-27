/**
 * RecordingsTray: a presentational drawer over the client-side recordings
 * store (`useRecordings()`). Lists finished single clips and grouped SETS,
 * with a play/preview, a download, and a discard per clip; a group also gets
 * a download-all + a discard-set. Recording is client-local and in-memory (no
 * sidecar, no server state), so this is where an operator saves a clip before
 * a page reload discards it. The tray shows a quiet reminder of that.
 *
 * Deliberately dumb: it owns no recording logic, only formatting and the
 * per-clip object-URL lifecycle (create on first render, revoke on discard or
 * unmount). Starting/stopping recordings is CameraFeed's REC control (or a
 * host's own REC+ grouped flow); this component only ever reads the store and
 * calls its discard/discardGroup actions.
 *
 * Every `RecordingHandle` (standalone or a grouped member) carries its own
 * `flightId`, so camera names come straight off the clip, with no dependency
 * on the store's transient `active` list. That matters because the tray
 * commonly mounts after a recording has already finished (its `active` entry
 * long gone by then). A host supplies the flightId -> label step via
 * `cameraLabel` (e.g. `buildCameraLabeler(useKerbcastCameras())`, the same
 * labeller CameraFeed uses) so this stays decoupled from any particular
 * camera registry; omit it for a plain "Camera <flightId>" fallback.
 */

import type { GroupedRecordingHandle, RecordingHandle } from "@ksp-gonogo/kerbcast";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import styled from "styled-components";
import { useRecordings } from "./hooks/useRecordings";

export interface RecordingsTrayProps {
  /**
   * Resolve a flightId to a display label for a clip's camera name. Omit for
   * a plain "Camera <flightId>" fallback.
   */
  cameraLabel?: (flightId: number) => string;
  /** Forwarded to the root panel; lets a host lay out/size the tray. */
  className?: string;
}

/**
 * The shared drawer. Requires a `KerbcastProvider` ancestor (it calls
 * `useRecordings()` directly, same requirement as `CameraFeed`).
 */
export function RecordingsTray({ cameraLabel, className }: RecordingsTrayProps) {
  const store = useRecordings();

  const labelFor = useCallback(
    (flightId: number): string => (cameraLabel ? cameraLabel(flightId) : `Camera ${flightId}`),
    [cameraLabel],
  );

  const allClips = useMemo(
    () => [...store.recordings, ...store.groups.flatMap((g) => g.recordings)],
    [store.recordings, store.groups],
  );
  const objectUrls = useClipObjectUrls(allClips);

  const hasAny = store.recordings.length > 0 || store.groups.length > 0;

  return (
    <Tray className={className} aria-label="Recordings">
      {!hasAny ? (
        <Empty>No recordings yet. Press REC on a feed to start one.</Empty>
      ) : (
        <>
          <Notice>
            Unsaved clips are lost on reload. Download what you want to keep.
          </Notice>
          <ClipList>
            {store.recordings.map((rec) => (
              <ClipRow
                key={rec.recordingId}
                rec={rec}
                label={labelFor(rec.flightId)}
                url={objectUrls.get(rec.recordingId)}
                onDiscard={() => store.discard(rec.recordingId)}
              />
            ))}
            {store.groups.map((group) => (
              <GroupItem
                key={group.groupId}
                group={group}
                labelFor={labelFor}
                objectUrls={objectUrls}
                onDiscardGroup={() => store.discardGroup(group.groupId)}
              />
            ))}
          </ClipList>
        </>
      )}
    </Tray>
  );
}

// ---------------------------------------------------------------------------
// Sub-rows
// ---------------------------------------------------------------------------

interface ClipRowProps {
  rec: RecordingHandle;
  label: string;
  url: string | undefined;
  /** Omitted for a clip inside a grouped set: only the whole set discards. */
  onDiscard?: () => void;
}

function ClipRow({ rec, label, url, onDiscard }: ClipRowProps) {
  const utRange =
    rec.utStart != null && rec.utEnd != null
      ? `${formatUt(rec.utStart)} - ${formatUt(rec.utEnd)}`
      : "no UT (out of flight)";

  return (
    <Clip>
      {url ? (
        <ClipPreview controls preload="metadata" src={url} aria-label={`Preview: ${label}`} />
      ) : (
        <ClipPreviewPlaceholder aria-hidden="true" />
      )}
      <ClipMeta>
        <ClipName>{label}</ClipName>
        <ClipDetail>{utRange}</ClipDetail>
        <ClipDetail>
          {formatDuration(rec.durationMs)} &middot; {formatBytes(rec.byteSize)}
        </ClipDetail>
      </ClipMeta>
      <ClipActions>
        {url && (
          <TrayLink href={url} download={clipFileName(rec, label)}>
            Download
          </TrayLink>
        )}
        {onDiscard && (
          <TrayButton type="button" $danger onClick={onDiscard}>
            Discard
          </TrayButton>
        )}
      </ClipActions>
    </Clip>
  );
}

interface GroupItemProps {
  group: GroupedRecordingHandle;
  labelFor: (flightId: number) => string;
  objectUrls: Map<string, string>;
  onDiscardGroup: () => void;
}

function GroupItem({ group, labelFor, objectUrls, onDiscardGroup }: GroupItemProps) {
  return (
    <GroupCard aria-label={`Grouped recording, ${group.recordings.length} feeds`}>
      <GroupHeader>
        <GroupHeaderText>
          <GroupTitle>
            Grouped recording &middot; {group.recordings.length} feeds
          </GroupTitle>
          {group.commonUtWindow && (
            <GroupMeta>
              common UT {formatUt(group.commonUtWindow[0])} -{" "}
              {formatUt(group.commonUtWindow[1])}
            </GroupMeta>
          )}
        </GroupHeaderText>
        <GroupActions>
          <TrayButton
            type="button"
            onClick={() => downloadAll(group.recordings, objectUrls, labelFor)}
          >
            Download all
          </TrayButton>
          <TrayButton type="button" $danger onClick={onDiscardGroup}>
            Discard set
          </TrayButton>
        </GroupActions>
      </GroupHeader>
      {group.recordings.map((rec) => (
        <ClipRow
          key={rec.recordingId}
          rec={rec}
          label={labelFor(rec.flightId)}
          url={objectUrls.get(rec.recordingId)}
        />
      ))}
    </GroupCard>
  );
}

// ---------------------------------------------------------------------------
// Object-URL lifecycle
// ---------------------------------------------------------------------------

/**
 * Creates one `URL.createObjectURL` per clip and revokes it once the clip
 * disappears from `clips` (discarded) or on unmount. The map itself lives in
 * a ref (not state) so the unmount cleanup always sees every URL ever
 * created, even ones added after the effect that captured it first ran; a
 * cheap reducer bump re-renders the caller whenever the map actually changes.
 */
function useClipObjectUrls(clips: RecordingHandle[]): Map<string, string> {
  const mapRef = useRef(new Map<string, string>());
  const [, bump] = useReducer((c: number) => c + 1, 0);

  useEffect(() => {
    const map = mapRef.current;
    const liveIds = new Set(clips.map((c) => c.recordingId));
    let changed = false;

    for (const [id, url] of map) {
      if (!liveIds.has(id)) {
        URL.revokeObjectURL(url);
        map.delete(id);
        changed = true;
      }
    }
    for (const clip of clips) {
      if (!map.has(clip.recordingId)) {
        map.set(clip.recordingId, URL.createObjectURL(clip.blob));
        changed = true;
      }
    }
    if (changed) bump();
  }, [clips]);

  useEffect(() => {
    const map = mapRef.current;
    return () => {
      for (const url of map.values()) URL.revokeObjectURL(url);
      map.clear();
    };
  }, []);

  return mapRef.current;
}

// ---------------------------------------------------------------------------
// Formatting + download helpers
// ---------------------------------------------------------------------------

/* KSP mission time (seconds); the tray shows the raw value rather than the
   in-game calendar breakdown, which needs the epoch this component doesn't have. */
function formatUt(ut: number): string {
  return `T+${Math.round(ut)}s`;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = hours > 0 ? minutes.toString().padStart(2, "0") : minutes.toString();
  const ss = seconds.toString().padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function clipFileName(rec: RecordingHandle, label: string): string {
  const ext = /mp4/i.test(rec.mimeType) ? "mp4" : "webm";
  const safeLabel = label.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "") || "clip";
  return `${safeLabel}-${rec.recordingId}.${ext}`;
}

/* A set's "download all": one <a> per member, clicked in turn. Each still
   downloads under its own clip filename (no zipping); good enough for an
   operator who wants every feed of the moment without N separate clicks. */
function downloadAll(
  members: RecordingHandle[],
  urls: Map<string, string>,
  labelFor: (flightId: number) => string,
): void {
  for (const member of members) {
    const url = urls.get(member.recordingId);
    if (!url) continue;
    const a = document.createElement("a");
    a.href = url;
    a.download = clipFileName(member, labelFor(member.flightId));
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
}

// ---------------------------------------------------------------------------
// Styled components
// ---------------------------------------------------------------------------

const Tray = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 260px;
  max-height: min(70vh, 520px);
  overflow-y: auto;
  overflow-x: hidden;
  padding: 10px;
  background: var(--kerbcast-tray-bg, rgba(0, 0, 0, 0.85));
  border: 1px solid var(--kerbcast-tray-border, rgba(255, 255, 255, 0.3));
  border-radius: 6px;
  color: var(--kerbcast-tray-text, #fff);
  font-size: 12px;
`;

const Empty = styled.div`
  padding: 16px 8px;
  text-align: center;
  color: var(--kerbcast-tray-text-muted, rgba(255, 255, 255, 0.65));
  font-style: italic;
`;

const Notice = styled.div`
  padding: 2px 2px 4px;
  color: var(--kerbcast-tray-text-muted, rgba(255, 255, 255, 0.55));
  font-size: 10.5px;
  font-style: italic;
  letter-spacing: 0.01em;
`;

const ClipList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
`;

const Clip = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 0;
  border-top: 1px solid var(--kerbcast-tray-border-subtle, rgba(255, 255, 255, 0.12));

  &:first-child {
    border-top: none;
    padding-top: 0;
  }
`;

const ClipPreview = styled.video`
  width: 120px;
  aspect-ratio: 16 / 9;
  background: #000;
  border-radius: 4px;
  flex-shrink: 0;
  object-fit: cover;
`;

const ClipPreviewPlaceholder = styled.div`
  width: 120px;
  aspect-ratio: 16 / 9;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 4px;
  flex-shrink: 0;
`;

const ClipMeta = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1 1 140px;
  min-width: 0;
`;

const ClipName = styled.div`
  font-weight: 600;
  letter-spacing: 0.03em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const ClipDetail = styled.div`
  color: var(--kerbcast-tray-text-muted, rgba(255, 255, 255, 0.65));
  font-size: 11px;
`;

const ClipActions = styled.div`
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  flex-shrink: 0;
`;

const trayButtonBase = `
  padding: 3px 8px;
  border-radius: 3px;
  font-size: 11px;
  letter-spacing: 0.03em;
  text-decoration: none;
  cursor: pointer;
  white-space: nowrap;
`;

const TrayButton = styled.button<{ $danger?: boolean }>`
  ${trayButtonBase}
  background: transparent;
  border: 1px solid
    ${(p) =>
      p.$danger
        ? "var(--kerbcast-tray-danger, #ff6b5e)"
        : "var(--kerbcast-accent, #00ff88)"};
  color: ${(p) => (p.$danger ? "var(--kerbcast-tray-danger, #ff6b5e)" : "var(--kerbcast-accent, #00ff88)")};

  @media (hover: hover) {
    &:hover {
      background: ${(p) =>
        p.$danger ? "rgba(255, 107, 94, 0.15)" : "var(--kerbcast-accent-wash, rgba(0, 255, 136, 0.15))"};
    }
  }
`;

const TrayLink = styled.a`
  ${trayButtonBase}
  display: inline-block;
  background: transparent;
  border: 1px solid var(--kerbcast-accent, #00ff88);
  color: var(--kerbcast-accent, #00ff88);

  @media (hover: hover) {
    &:hover {
      background: var(--kerbcast-accent-wash, rgba(0, 255, 136, 0.15));
    }
  }
`;

const GroupCard = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px;
  background: var(--kerbcast-tray-surface-raised, rgba(255, 255, 255, 0.04));
  border: 1px solid var(--kerbcast-tray-border-subtle, rgba(255, 255, 255, 0.12));
  border-left: 2px solid var(--kerbcast-accent, #00ff88);
  border-radius: 4px;

  ${Clip} {
    border-top-color: var(--kerbcast-tray-border-subtle, rgba(255, 255, 255, 0.12));
  }
`;

const GroupHeader = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
`;

const GroupHeaderText = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
`;

const GroupTitle = styled.div`
  font-weight: 600;
  letter-spacing: 0.03em;
`;

const GroupMeta = styled.div`
  color: var(--kerbcast-tray-text-muted, rgba(255, 255, 255, 0.65));
  font-size: 11px;
`;

const GroupActions = styled.div`
  display: flex;
  gap: 6px;
  flex-shrink: 0;
`;
