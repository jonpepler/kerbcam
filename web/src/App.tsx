import { CameraKind } from "@ksp-gonogo/kerbcast";
import type { KerbcastClient } from "@ksp-gonogo/kerbcast";
import { KerbcastProvider, useKerbcastCameras } from "@ksp-gonogo/kerbcast-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import styled from "styled-components";
import { ConnectionManager } from "./connectionManager";
import { CrewBar } from "./CrewBar";
import { DevPanel } from "./DevPanel";
import { ErrorToast } from "./ErrorToast";
import { Grid } from "./Grid";
import { Header } from "./Header";
import { RecGroupBar } from "./RecGroupBar";
import { RecordingsPanel } from "./RecordingsPanel";
import { Settings } from "./SettingsPanel";
import { ShedBanner } from "./ShedBanner";
import { StandbyOverlay } from "./StandbyOverlay";
import { useRecordingsUnloadGuard } from "./useRecordingsUnloadGuard";
import {
  applyTheme,
  loadClosedCrew,
  loadCrewBarPlacement,
  loadCrewMerge,
  loadCrewSpotlight,
  loadDebug,
  loadShowPerfWarnings,
  loadShowStatic,
  loadTheme,
  saveClosedCrew,
  saveCrewBarPlacement,
  saveCrewMerge,
  saveCrewSpotlight,
  saveDebug,
  saveShowPerfWarnings,
  saveShowStatic,
  saveTheme,
} from "./settings";
import type { CrewBarPlacement, ThemePreference } from "./settings";
import { loadTiles, pruneCrewTiles, reconcileTiles, saveTiles, seedTiles } from "./tiles";
import type { Tile as TileData } from "./tiles";

interface AppProps {
  client: KerbcastClient;
}

/**
 * Root app component. Accepts a KerbcastClient injected from main.tsx (or tests).
 * Creates a connection manager, manages tile state, and renders the full UI.
 */
export function App({ client }: AppProps): React.JSX.Element {
  // Connection manager -- stable per client
  const managerRef = useRef<ConnectionManager | null>(null);
  if (managerRef.current === null) {
    managerRef.current = new ConnectionManager(client);
  }
  const manager = managerRef.current;

  const status = useSyncExternalStore(
    (cb) => manager.subscribe(cb),
    () => manager.getStatus(),
  );

  useEffect(() => {
    manager.start();
    return () => manager.stop();
  }, [manager]);

  // Theme + debug settings
  const [theme, setTheme] = useState<ThemePreference>(() => {
    const t = loadTheme();
    applyTheme(t);
    return t;
  });
  const [debug, setDebug] = useState<boolean>(() => loadDebug());
  /*
   * showStaticExplicit: null = auto (resolve from prefers-reduced-motion),
   * true/false = explicit user override stored in localStorage.
   */
  const [showStaticExplicit, setShowStaticExplicit] = useState<boolean | null>(
    () => loadShowStatic(),
  );
  const showStatic =
    showStaticExplicit !== null
      ? showStaticExplicit
      : !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const [showPerfWarnings, setShowPerfWarnings] = useState<boolean>(() => loadShowPerfWarnings());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [recordingsOpen, setRecordingsOpen] = useState(false);
  const toggleSettings = useCallback(() => {
    setRecordingsOpen(false);
    setSettingsOpen((v) => !v);
  }, []);
  const toggleRecordings = useCallback(() => {
    setSettingsOpen(false);
    setRecordingsOpen((v) => !v);
  }, []);

  /*
   * REC+ grouped recording: `recSelectMode` + `selectedFlightIds` drive the
   * Grid/Tile checkbox overlay (see Tile's own doc-comment); `activeGroupId`
   * is lifted here (not owned by RecGroupBar) so the Header can disable REC+
   * while a group is already recording. RecGroupBar itself owns the actual
   * store calls (startGroup/stopGroup) since it renders inside the provider.
   */
  const [recSelectMode, setRecSelectMode] = useState(false);
  const [selectedFlightIds, setSelectedFlightIds] = useState<ReadonlySet<number>>(new Set());
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);

  const toggleRecSelectMode = useCallback(() => {
    setRecSelectMode((v) => {
      const next = !v;
      if (!next) setSelectedFlightIds(new Set());
      return next;
    });
  }, []);
  const cancelRecSelection = useCallback(() => {
    setRecSelectMode(false);
    setSelectedFlightIds(new Set());
  }, []);
  const toggleTileSelected = useCallback((flightId: number) => {
    setSelectedFlightIds((prev) => {
      const next = new Set(prev);
      if (next.has(flightId)) next.delete(flightId);
      else next.add(flightId);
      return next;
    });
  }, []);
  const handleGroupStarted = useCallback((groupId: string) => {
    setActiveGroupId(groupId);
    setRecSelectMode(false);
    setSelectedFlightIds(new Set());
  }, []);
  const handleGroupStopped = useCallback(() => {
    setActiveGroupId(null);
  }, []);

  // Crew settings. Placement + merge persist; minimise is transient (a bar
  // control, resets on reload). Merge OFF (default): kerbal cams are filtered
  // out of the tile grid and shown only in the docked crew bar. Merge ON: they
  // flow through the SAME grid/add-camera path as part cams, no crew bar.
  const [crewPlacement, setCrewPlacement] = useState<CrewBarPlacement>(() => loadCrewBarPlacement());
  const [crewMerge, setCrewMerge] = useState<boolean>(() => loadCrewMerge());
  const [crewMinimised, setCrewMinimised] = useState(false);
  // Closed crew faces (persisted). Default (empty) = all open; a new kerbal is
  // open by default. Keyed on the name-stable wire-id, so closed-ness survives
  // seat<->EVA + reload.
  const [closedCrew, setClosedCrew] = useState<ReadonlySet<number>>(() => new Set(loadClosedCrew()));
  const setCrewClosed = useCallback((flightId: number, isClosed: boolean) => {
    setClosedCrew((prev) => {
      const next = new Set(prev);
      if (isClosed) next.add(flightId);
      else next.delete(flightId);
      saveClosedCrew([...next]);
      return next;
    });
  }, []);
  // Spotlit crew face (single, persisted). Toggling the same id clears it.
  const [crewSpotlight, setCrewSpotlight] = useState<number | null>(() => loadCrewSpotlight());
  const toggleCrewSpotlight = useCallback((flightId: number) => {
    setCrewSpotlight((cur) => {
      const next = cur === flightId ? null : flightId;
      saveCrewSpotlight(next);
      return next;
    });
  }, []);

  // Tile state
  const storedTiles = loadTiles();
  const [tiles, setTiles] = useState<TileData[]>(() => storedTiles ?? []);
  const [tilesSeeded, setTilesSeeded] = useState<boolean>(() => storedTiles !== null);

  const tileFlightIds = useMemo(
    () => tiles.map((t) => t.flightId),
    [tiles],
  );

  const handleReconcile = useCallback((reconciled: TileData[]) => {
    setTiles(reconciled);
    saveTiles(reconciled);
  }, []);

  return (
    <KerbcastProvider client={client}>
      <UnloadGuard />
      <PageShell>
        <Header
          status={status}
          client={client}
          onOpenSettings={toggleSettings}
          recordingsOpen={recordingsOpen}
          onToggleRecordings={toggleRecordings}
          recSelectMode={recSelectMode}
          onToggleRecSelectMode={toggleRecSelectMode}
          recordingGroupActive={activeGroupId !== null}
        />
        {settingsOpen && (
          <Settings
            theme={theme}
            debug={debug}
            showStatic={showStatic}
            showPerfWarnings={showPerfWarnings}
            crewPlacement={crewPlacement}
            crewMerge={crewMerge}
            onThemeChange={(t: ThemePreference) => { saveTheme(t); applyTheme(t); setTheme(t); }}
            onDebugChange={(d: boolean) => { saveDebug(d); setDebug(d); }}
            onShowStaticChange={(s: boolean) => { saveShowStatic(s); setShowStaticExplicit(s); }}
            onShowPerfWarningsChange={(v: boolean) => { saveShowPerfWarnings(v); setShowPerfWarnings(v); }}
            onCrewPlacementChange={(p: CrewBarPlacement) => { saveCrewBarPlacement(p); setCrewPlacement(p); }}
            onCrewMergeChange={(m: boolean) => { saveCrewMerge(m); setCrewMerge(m); }}
            onClose={() => setSettingsOpen(false)}
          />
        )}
        {recordingsOpen && <RecordingsPanel onClose={() => setRecordingsOpen(false)} />}
        <RecGroupBar
          active={recSelectMode}
          selectedFlightIds={selectedFlightIds}
          groupId={activeGroupId}
          onCancel={cancelRecSelection}
          onStarted={handleGroupStarted}
          onStopped={handleGroupStopped}
        />
        {showPerfWarnings && <ShedBanner client={client} />}
        <ErrorToast client={client} />
        <MainArea>
          {/* ScrollArea stays at one tree position (always inside DockLayout) so
              toggling merge / placement / minimise never remounts the grid. */}
          <DockLayout $side={!crewMerge && crewPlacement === "column"}>
            <ScrollArea>
              {/* CameraSeeder and CameraReconciler use useKerbcastCameras inside KerbcastProvider */}
              <CameraSeeder
                mergeCrew={crewMerge}
                tilesSeeded={tilesSeeded}
                onSeed={(seeded) => {
                  setTiles(seeded);
                  saveTiles(seeded);
                  setTilesSeeded(true);
                }}
              />
              <CameraReconciler
                mergeCrew={crewMerge}
                tiles={tiles}
                onReconcile={handleReconcile}
              />
              <Grid
                mergeCrew={crewMerge}
                tiles={tiles}
                onTilesChange={setTiles}
                showDebugInfo={debug}
                showStatic={showStatic}
                selectionMode={recSelectMode}
                selectedFlightIds={selectedFlightIds}
                onToggleSelect={toggleTileSelected}
              />
              {debug && (
                <DevPanel client={client} tileFlightIds={tileFlightIds} />
              )}
            </ScrollArea>
            {/* Docked crew bar (merge OFF only). Same CrewBar instance across
                placement / minimise / open-close changes — CSS reflow, feeds
                never remount. Merge ON: kerbals live in the grid, no bar. */}
            {!crewMerge && (
              <CrewBar
                placement={crewPlacement}
                minimised={crewMinimised}
                onToggleMinimise={() => setCrewMinimised((v) => !v)}
                closed={closedCrew}
                onClose={(flightId) => setCrewClosed(flightId, true)}
                onOpen={(flightId) => setCrewClosed(flightId, false)}
                spotlight={crewSpotlight}
                onToggleSpotlight={toggleCrewSpotlight}
              />
            )}
          </DockLayout>
          <StandbyOverlay />
        </MainArea>
      </PageShell>
    </KerbcastProvider>
  );
}

// ---------------------------------------------------------------------------
// UnloadGuard: warns before a reload/close while unsaved recordings exist
// ---------------------------------------------------------------------------

/* useRecordingsUnloadGuard reads useRecordings(), which needs a
   KerbcastProvider ancestor -- a bare hook call, same pattern as
   CameraSeeder/CameraReconciler below. */
function UnloadGuard(): null {
  useRecordingsUnloadGuard();
  return null;
}

// ---------------------------------------------------------------------------
// CameraSeeder: seeds default tiles once on first camera arrival
// ---------------------------------------------------------------------------

interface CameraSeederProps {
  mergeCrew: boolean;
  tilesSeeded: boolean;
  onSeed: (tiles: TileData[]) => void;
}

function CameraSeeder({ mergeCrew, tilesSeeded, onSeed }: CameraSeederProps): null {
  // Merge OFF: part cams only (kerbal face cams live in the crew bar). Merge ON:
  // kerbal cams are seedable/addable grid tiles like part cams.
  const all = useKerbcastCameras();
  const cameras = useMemo(
    () => (mergeCrew ? all : all.filter((c) => c.kind === CameraKind.Part)),
    [all, mergeCrew],
  );

  useEffect(() => {
    if (tilesSeeded) return;
    if (cameras.length === 0) return;
    onSeed(seedTiles(cameras));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameras, tilesSeeded]);

  return null;
}

// ---------------------------------------------------------------------------
// CameraReconciler: rebinds stale tile flightIds after KSP revert/recover
// ---------------------------------------------------------------------------

interface CameraReconcilerProps {
  mergeCrew: boolean;
  tiles: TileData[];
  onReconcile: (tiles: TileData[]) => void;
}

/*
 * Watches the live camera list and rebinds any tile whose flightId has gone
 * missing but whose stable key (vesselName|partName|cameraName) matches a
 * live camera under a new flightId. This covers KSP revert/recover, which
 * reassigns part.flightID while the camera itself survives.
 *
 * Tiles without a key (stored before this feature shipped) are left as
 * "reconnecting" until the user manually rebinds them.
 */
function CameraReconciler({ mergeCrew, tiles, onReconcile }: CameraReconcilerProps): null {
  // Merge OFF: part cams only (never rebind a grid tile onto a kerbal). Merge
  // ON: kerbal cams reconcile like part cams. Memoised so a new filtered-array
  // identity doesn't re-run the effect every commit.
  const all = useKerbcastCameras();
  const cameras = useMemo(
    () => (mergeCrew ? all : all.filter((c) => c.kind === CameraKind.Part)),
    [all, mergeCrew],
  );

  useEffect(() => {
    // Guard on the unfiltered list: a craft with ONLY kerbal cams has an empty
    // filtered `cameras` but still needs pruning below.
    if (all.length === 0) return;
    // Merge OFF: evict any kerbal tile stranded by a prior merge-ON session
    // (kerbals belong in the crew bar, not the grid) before reconciling. Needs
    // the unfiltered `all` to see kerbal ids. Merge ON: kerbals stay grid tiles.
    const pruned = mergeCrew ? tiles : pruneCrewTiles(tiles, all);
    const reconciled = reconcileTiles(pruned, cameras);
    if (reconciled !== tiles) onReconcile(reconciled);
  }, [all, cameras, tiles, mergeCrew, onReconcile]);

  return null;
}

// ---------------------------------------------------------------------------
// Styled
// ---------------------------------------------------------------------------

const PageShell = styled.div`
  display: flex;
  flex-direction: column;
  /* A definite height (not just min-height) so flex children further down --
     notably the spotlight Stage -- get a bounded height to size against.
     Without it, the spotlit feed's aspect-ratio height resolves against an
     indefinite parent and grows past the viewport. */
  height: 100dvh;
  background: var(--kc-bg);
  position: relative;
`;

const MainArea = styled.main`
  flex: 1;
  min-height: 0;
  /* Positioned, non-scrolling frame so the out-of-flight standby scrim
     covers the content area (not the header) and stays put while the tile
     grid scrolls inside ScrollArea. */
  position: relative;
  overflow: hidden;
  display: flex;
  flex-direction: column;
`;

/* Holds the scrolling grid area plus the docked crew bar. Row when the crew
   bar docks to the side (column placement); column otherwise (bottom dock). */
const DockLayout = styled.div<{ $side: boolean }>`
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: ${(p) => (p.$side ? "row" : "column")};
`;

const ScrollArea = styled.div`
  flex: 1;
  min-height: 0;
  /* The tile area scrolls internally; the header/banner stay put above it. */
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  /* Subtle vignette to ground the tile grid */
  background: radial-gradient(ellipse at 50% 0%, transparent 60%, rgba(0,0,0,0.06) 100%);
`;
