import { useCallback, useSyncExternalStore } from "react";
import type {
  ActiveRecordingInfo,
  GroupedRecordingHandle,
  RecordingHandle,
  StartRecordingOptions,
  StopGroupedRecordingOptions,
} from "@ksp-gonogo/kerbcast";
import { useKerbcastClient } from "../context";

/* Re-exported for compatibility: consumers importing ActiveRecordingInfo from
   this module keep working now that the SDK owns the definition. */
export type { ActiveRecordingInfo };

/**
 * Reactive recordings store over the SDK's `client.recording` controller.
 *
 * Holds the in-session, in-memory clips: standalone singles in `recordings`,
 * synchronised sets in `groups`, and the still-running ones in `active`. This
 * is the headless data layer the recordings tray + REC controls sit on; it
 * owns no chrome. All state is in-memory, so a page reload discards it (the UI
 * guards navigation while unsaved clips exist).
 */
export interface RecordingsStore {
  /** Finished standalone (non-grouped) clips, newest last. */
  recordings: RecordingHandle[];
  /** Finished grouped sets, newest last. */
  groups: GroupedRecordingHandle[];
  /** Recordings currently in progress (single + grouped members). */
  active: ActiveRecordingInfo[];
  /** Whether a feed currently has a recording in progress. */
  isRecording(flightId: number): boolean;

  start(flightId: number, opts?: StartRecordingOptions): string;
  stop(recordingId: string): Promise<RecordingHandle>;
  startGroup(flightIds: number[], opts?: StartRecordingOptions): string;
  stopGroup(
    groupId: string,
    opts?: StopGroupedRecordingOptions,
  ): Promise<GroupedRecordingHandle>;
  discard(recordingId: string): void;
  discardGroup(groupId: string): void;
}

/**
 * Subscribe a component to the recording store for the context client. The
 * controller itself is the single source of truth for every call site;
 * `useSyncExternalStore` re-renders this component whenever the controller's
 * snapshot changes, no matter which call site (or which component) drove the
 * change.
 */
export function useRecordings(): RecordingsStore {
  const client = useKerbcastClient();
  const controller = client.recording;

  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);

  const start = useCallback(
    (flightId: number, opts?: StartRecordingOptions): string =>
      controller.startRecording(flightId, opts),
    [controller],
  );

  const stop = useCallback(
    (recordingId: string): Promise<RecordingHandle> => controller.stopRecording(recordingId),
    [controller],
  );

  const startGroup = useCallback(
    (flightIds: number[], opts?: StartRecordingOptions): string =>
      controller.startGroupedRecording(flightIds, opts).groupId,
    [controller],
  );

  const stopGroup = useCallback(
    (
      groupId: string,
      opts?: StopGroupedRecordingOptions,
    ): Promise<GroupedRecordingHandle> => controller.stopGroupedRecording(groupId, opts),
    [controller],
  );

  const discard = useCallback(
    (recordingId: string): void => controller.discardRecording(recordingId),
    [controller],
  );

  const discardGroup = useCallback(
    (groupId: string): void => controller.discardGroupedRecording(groupId),
    [controller],
  );

  const isRecording = useCallback(
    (flightId: number): boolean => controller.isRecording(flightId),
    [controller],
  );

  return {
    recordings: snapshot.recordings,
    groups: snapshot.groups,
    active: snapshot.active,
    isRecording,
    start,
    stop,
    startGroup,
    stopGroup,
    discard,
    discardGroup,
  };
}
