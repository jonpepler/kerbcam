/**
 * Persistent settings for the kerbcast web page.
 * Backed by localStorage. Each getter reads the stored value on every call
 * so callers always see the latest.
 */

export type ThemePreference = "auto" | "light" | "dark";

/** Where the crew bar docks: a horizontal bottom filmstrip or a vertical side
 *  column. Squares stay square in both. */
export type CrewBarPlacement = "row" | "column";

const KEY_THEME = "kerbcast:theme";
const KEY_DEBUG = "kerbcast:debug";
const KEY_SHOW_STATIC = "kerbcast:showStatic";
const KEY_SHOW_PERF_WARNINGS = "kerbcast:showPerfWarnings";
const KEY_CREW_BAR_PLACEMENT = "kerbcast:crewBarPlacement";
// Kept for continuity though the semantics are now "merge into the camera list"
// (kerbal cams become regular grid tiles) rather than the old inline-dissolve.
const KEY_CREW_MERGE = "kerbcast:crewBarDissolve";
const KEY_CREW_CLOSED = "kerbcast:crewClosed";
const KEY_CREW_SPOTLIGHT = "kerbcast:crewSpotlight";
const KEY_RECORD_FULL_RESOLUTION = "kerbcast:recordFullResolution";

export function loadTheme(): ThemePreference {
  const raw = localStorage.getItem(KEY_THEME);
  if (raw === "light" || raw === "dark" || raw === "auto") return raw;
  return "auto";
}

export function saveTheme(theme: ThemePreference): void {
  localStorage.setItem(KEY_THEME, theme);
}

/** Apply data-theme to <html>. Call whenever theme changes. */
export function applyTheme(theme: ThemePreference): void {
  if (theme === "auto") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", theme);
  }
}

export function loadDebug(): boolean {
  return localStorage.getItem(KEY_DEBUG) === "true";
}

export function saveDebug(enabled: boolean): void {
  localStorage.setItem(KEY_DEBUG, String(enabled));
}

/**
 * Show-static preference. Returns `null` when no explicit value has been
 * stored (auto mode: resolved from `prefers-reduced-motion` at the call
 * site), `true`/`false` for an explicit override.
 */
export function loadShowStatic(): boolean | null {
  const raw = localStorage.getItem(KEY_SHOW_STATIC);
  if (raw === null) return null;
  return raw !== "false";
}

export function saveShowStatic(enabled: boolean): void {
  localStorage.setItem(KEY_SHOW_STATIC, String(enabled));
}

/**
 * Show-performance-warnings preference. Returns `true` when the key is absent
 * (default on: new users see throttle warnings). Returns `false` only when
 * explicitly stored as "false".
 */
export function loadShowPerfWarnings(): boolean {
  return localStorage.getItem(KEY_SHOW_PERF_WARNINGS) !== "false";
}

export function saveShowPerfWarnings(enabled: boolean): void {
  localStorage.setItem(KEY_SHOW_PERF_WARNINGS, String(enabled));
}

/** Crew-bar placement. Defaults to a bottom row when unset. */
export function loadCrewBarPlacement(): CrewBarPlacement {
  const raw = localStorage.getItem(KEY_CREW_BAR_PLACEMENT);
  // "wrap" was removed; a stored "wrap" (or anything unknown) falls back to row.
  if (raw === "row" || raw === "column") return raw;
  return "row";
}

export function saveCrewBarPlacement(placement: CrewBarPlacement): void {
  localStorage.setItem(KEY_CREW_BAR_PLACEMENT, placement);
}

/**
 * Merge preference. When true, kerbal face cams are merged into the regular
 * camera list: they become ordinary grid tiles (seedable / addable / in the
 * camera dropdowns) and NO separate crew bar is shown. Defaults to false (crew
 * shown only in the docked crew bar) when unset.
 */
export function loadCrewMerge(): boolean {
  return localStorage.getItem(KEY_CREW_MERGE) === "true";
}

export function saveCrewMerge(merge: boolean): void {
  localStorage.setItem(KEY_CREW_MERGE, String(merge));
}

/**
 * Closed crew wire-ids (the faces a user has closed out of the crew bar).
 * Absent = none closed = all crew open. Crew wire-ids are name-stable, so a
 * closed face stays closed across seat<->EVA and reload.
 */
export function loadClosedCrew(): number[] {
  try {
    const raw = localStorage.getItem(KEY_CREW_CLOSED);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is number => typeof v === "number");
  } catch {
    return [];
  }
}

export function saveClosedCrew(flightIds: number[]): void {
  try {
    localStorage.setItem(KEY_CREW_CLOSED, JSON.stringify(flightIds));
  } catch {
    // ignore (private browsing / storage full)
  }
}

/**
 * Spotlit crew face (single wire-id) or null. Persisted so a spotlit face
 * survives reload; name-stable wire-ids keep it pinned across seat<->EVA.
 */
export function loadCrewSpotlight(): number | null {
  const raw = localStorage.getItem(KEY_CREW_SPOTLIGHT);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function saveCrewSpotlight(flightId: number | null): void {
  try {
    if (flightId === null) localStorage.removeItem(KEY_CREW_SPOTLIGHT);
    else localStorage.setItem(KEY_CREW_SPOTLIGHT, String(flightId));
  } catch {
    // ignore (private browsing / storage full)
  }
}

/**
 * Record-at-full-resolution preference: the persisted default for single-feed
 * REC and the seed for the REC+ group banner's own checkbox. Defaults to
 * false (unset) so a clip is display-size sized unless the operator opts in.
 */
export function loadRecordFullResolution(): boolean {
  return localStorage.getItem(KEY_RECORD_FULL_RESOLUTION) === "true";
}

export function saveRecordFullResolution(enabled: boolean): void {
  localStorage.setItem(KEY_RECORD_FULL_RESOLUTION, String(enabled));
}
