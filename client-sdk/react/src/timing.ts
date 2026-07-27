/*
 * Shared elapsed-timer helpers for REC-style live-duration displays: the
 * per-feed REC badge (CameraFeed) and the REC+ grouped-recording toolbar
 * (a host's own RecGroupBar). Framework-free so both places read the same
 * clock and format the same way instead of drifting apart.
 */

/** Monotonic clock for elapsed-timer math. Falls back to Date.now under jsdom. */
export function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

/** Formats a millisecond duration as m:ss (e.g. "REC 1:05", "Recording 3 feeds - 0:42"). */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
