/*
 * Guards an accidental tab close/reload/navigate while the recordings store
 * holds anything that would be lost: finished clips (single or grouped,
 * downloaded or not -- a download doesn't remove a clip from the store) and
 * recordings still in progress. Recording is client-side and entirely
 * in-memory (see the recording UX design doc), so this is the one active
 * protection against losing a captured moment to a stray reload; there is no
 * DB persistence to fall back on.
 *
 * Session-lifetime only: the handler is added while the store is non-empty
 * and removed the moment it empties (every clip discarded, no recording
 * active), never persisted across a reload itself.
 */

import { useEffect } from "react";
import { useRecordings } from "@ksp-gonogo/kerbcast-react";

export function useRecordingsUnloadGuard(): void {
  const { recordings, groups, active } = useRecordings();
  const hasUnsaved = recordings.length > 0 || groups.length > 0 || active.length > 0;

  useEffect(() => {
    if (!hasUnsaved) return;

    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [hasUnsaved]);
}
