import { useKerbcastCameras } from "@ksp-gonogo/kerbcast-react";
import { Video, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import styled from "styled-components";
import { bestGrid } from "./bestGrid";
import { AddAllTile, AddTile, RemoveAllTile, RemoveLostTile, Tile } from "./Tile";
import {
  addAllCameras,
  addTile,
  cameraKey,
  loadPerfNoteDismissed,
  PERF_NOTE_TILE_THRESHOLD,
  removeAllCameras,
  removeAllLostCameras,
  removeTile,
  savePerfNoteDismissed,
  saveTiles,
  toggleSpotlight,
  updateTile,
} from "./tiles";
import { CameraKind, CameraLifecycle } from "@ksp-gonogo/kerbcast";
import type { Tile as TileData } from "./tiles";

interface GridProps {
  /** When true, kerbal face cams are regular grid cameras (merged). When false
   *  they are filtered out (shown only in the crew bar). */
  mergeCrew: boolean;
  tiles: TileData[];
  onTilesChange: (tiles: TileData[]) => void;
  showDebugInfo: boolean;
  showStatic: boolean;
  /** Whether single-feed REC records this feed at full resolution (the
   *  persisted Settings toggle, threaded straight into CameraFeed). */
  recordFullResolution: boolean;
  /** REC+ grouped-recording selection mode (see Tile's own doc-comment). */
  selectionMode: boolean;
  selectedFlightIds: ReadonlySet<number>;
  onToggleSelect: (flightId: number) => void;
}

const GAP = 16; // 1rem; keep in sync with Root `gap`

export function Grid({
  mergeCrew,
  tiles,
  onTilesChange,
  showDebugInfo,
  showStatic,
  recordFullResolution,
  selectionMode,
  selectedFlightIds,
  onToggleSelect,
}: GridProps): React.JSX.Element {
  // Merge OFF: kerbal face cams live in the crew bar, so the grid's seeding /
  // add-all / missing-count / reconcile never pull one in. Merge ON: kerbal cams
  // are regular grid cameras, indistinguishable from part cams. Part-camera grid
  // behaviour is unchanged either way.
  const all = useKerbcastCameras();
  const cameras = mergeCrew ? all : all.filter((c) => c.kind === CameraKind.Part);
  const [showPerfNote, setShowPerfNote] = useState(false);

  const commit = (next: TileData[]) => {
    saveTiles(next);
    onTilesChange(next);
  };

  const handleSelectCamera = (index: number, flightId: number) => {
    const cam = cameras.find((c) => c.flightId === flightId);
    const key = cam ? cameraKey(cam) : null;
    commit(updateTile(tiles, index, flightId, key));
  };
  const handleRemove = (index: number) => commit(removeTile(tiles, index));
  const handleToggleSpotlight = (index: number) =>
    commit(toggleSpotlight(tiles, index));
  const handleAdd = () => commit(addTile(tiles));

  // Cameras the grid does not show yet (drives add-all) and tiles pointing at a
  // dead/absent camera (drives remove-lost). Only live cameras count as shown
  // targets; Destroyed tombstones are neither missing targets nor live tiles.
  const { missingCount, lostCount } = useMemo(() => {
    const liveIds = new Set(
      cameras
        .filter((c) => c.lifecycle !== CameraLifecycle.Destroyed)
        .map((c) => c.flightId),
    );
    const shownIds = new Set(tiles.map((t) => t.flightId));
    const missingCount = cameras.filter(
      (c) => c.lifecycle !== CameraLifecycle.Destroyed && !shownIds.has(c.flightId),
    ).length;
    const lostCount = tiles.filter(
      (t) => t.flightId !== null && !liveIds.has(t.flightId),
    ).length;
    return { missingCount, lostCount };
  }, [tiles, cameras]);

  const handleAddAll = () => {
    const next = addAllCameras(tiles, cameras);
    if (next === tiles) return;
    commit(next);
    if (next.length > PERF_NOTE_TILE_THRESHOLD && !loadPerfNoteDismissed()) {
      setShowPerfNote(true);
    }
  };
  const handleRemoveAll = () => commit(removeAllCameras(tiles));
  const handleRemoveLost = () => {
    const next = removeAllLostCameras(tiles, cameras);
    if (next.length === tiles.length) return;
    commit(next);
  };

  const dismissPerfNote = () => {
    savePerfNoteDismissed();
    setShowPerfNote(false);
  };

  const isEmpty = tiles.length === 0;
  const spotlightActive = tiles.some((t) => t.spotlit);

  // Measure the container so the flat grid can grow tiles to fill it.
  const rootRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setSize({ w: r.width, h: r.height });
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  /*
   * Flat grid: size the FEEDS to fill the viewport. Pick the column/row split
   * that makes the feeds the largest 16:9 they can be for the measured area
   * (minus a slim strip reserved for the add bar), hand them an explicit width
   * via --tile-w, and center the block. The add control is a slim full-width
   * bar rather than a feed-sized cell, so it doesn't shrink the feeds or leave
   * a big empty cell. When spotlit, layout switches to the span grid instead.
   */
  const ADD_BAR_H = 52;
  const flatFill = !spotlightActive && !isEmpty && size.w > 0 && size.h > 0;
  let rootStyle: React.CSSProperties | undefined;
  if (flatFill) {
    // contentRect already excludes Root's padding, so size is the usable area.
    const availW = size.w;
    const availH = size.h - (ADD_BAR_H + GAP);
    const { cols, rows } = bestGrid(tiles.length, availW, availH);
    const cellW = (availW - GAP * (cols - 1)) / cols;
    const cellH = (availH - GAP * (rows - 1)) / rows;
    const tileW = Math.max(0, Math.min(cellW, (cellH * 16) / 9));
    rootStyle = {
      gridTemplateColumns: `repeat(${cols}, auto)`,
      justifyContent: "center",
      alignContent: "center",
      ["--tile-w" as string]: `${Math.floor(tileW)}px`,
    };
  }

  return (
    <>
      {showPerfNote && (
        <PerfNote role="status">
          <PerfNoteText>
            Many simultaneous streams increase load on the game machine.
            kerbcast throttles itself automatically, but feed rates may drop.
          </PerfNoteText>
          <PerfNoteDismiss
            type="button"
            aria-label="Dismiss performance note"
            onClick={dismissPerfNote}
          >
            <X size={12} strokeWidth={1.75} aria-hidden="true" />
          </PerfNoteDismiss>
        </PerfNote>
      )}
      <Root ref={rootRef} $spotlight={spotlightActive} $fill={flatFill} style={rootStyle}>
      {tiles.map((tile, i) => (
        <Tile
          key={i}
          index={i}
          flightId={tile.flightId}
          spotlit={tile.spotlit}
          variant={spotlightActive ? "cell" : "grid"}
          spotlightActive={spotlightActive}
          mergeCrew={mergeCrew}
          showDebugInfo={showDebugInfo}
          showStatic={showStatic}
          recordFullResolution={recordFullResolution}
          onSelectCamera={(fid) => handleSelectCamera(i, fid)}
          onRemove={() => handleRemove(i)}
          onToggleSpotlight={() => handleToggleSpotlight(i)}
          selectionMode={selectionMode}
          selected={tile.flightId !== null && selectedFlightIds.has(tile.flightId)}
          onToggleSelect={() => {
            if (tile.flightId !== null) onToggleSelect(tile.flightId);
          }}
        />
      ))}
      <AddControls $bar={flatFill}>
        <AddTile
          onClick={handleAdd}
          isEmpty={isEmpty}
          compact={spotlightActive}
          bar={flatFill}
        />
        {missingCount > 0 && (
          <AddAllTile
            onClick={handleAddAll}
            isEmpty={isEmpty}
            compact={spotlightActive}
            bar={flatFill}
          />
        )}
        {lostCount > 0 && (
          <RemoveLostTile
            onClick={handleRemoveLost}
            isEmpty={isEmpty}
            compact={spotlightActive}
            bar={flatFill}
          />
        )}
        {!isEmpty && (
          <RemoveAllTile
            onClick={handleRemoveAll}
            isEmpty={isEmpty}
            compact={spotlightActive}
            bar={flatFill}
          />
        )}
      </AddControls>
      {isEmpty && (
        <EmptyHint>
          <EmptyIcon aria-hidden="true">
            <Video size={32} strokeWidth={1.5} />
          </EmptyIcon>
          <EmptyTitle>No cameras active</EmptyTitle>
          <EmptyBody>
            Connect kerbcast to a running KSP session, then add a tile to watch a camera feed.
          </EmptyBody>
        </EmptyHint>
      )}
      </Root>
    </>
  );
}

// ---------------------------------------------------------------------------
// Styled
// ---------------------------------------------------------------------------

const Root = styled.div<{ $spotlight: boolean; $fill: boolean }>`
  display: grid;
  gap: 1rem;
  padding: 1rem;
  flex: 1;
  min-height: 0;

  ${(p) =>
    p.$spotlight
      ? `
    /* Spotlight: a fixed 4-column grid that fills the height. Spotlit tiles
       span 2x2 (sorted first); everything else stays 1x1 and dense-packs into
       the remaining cells. Row tracks share the height equally. */
    grid-template-columns: repeat(4, 1fr);
    grid-auto-rows: 1fr;
    grid-auto-flow: dense;
  `
      : p.$fill
        ? `
    /* Flat grid, grown to fill: columns/centering come from inline style;
       tiles take their width from --tile-w. */
    `
        : `
    grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
    align-content: start;
  `}
`;

/* Holds AddTile and AddAllTile. In flat-fill bar mode it is the single
   full-width grid row the two bars share; otherwise it dissolves
   (display: contents) so each button stays an ordinary grid item. */
const AddControls = styled.div<{ $bar: boolean }>`
  ${(p) =>
    p.$bar
      ? `
    grid-column: 1 / -1;
    display: flex;
    gap: 1rem;
  `
      : `display: contents;`}
`;

/* One-time note shown when add-all pushes the grid past the comfortable
   simultaneous-stream count. Styled after ShedBanner; informational only. */
const PerfNote = styled.div`
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.45rem 1rem;
  background: var(--kc-warn-bg);
  border-bottom: 1px solid var(--kc-warn);
  color: var(--kc-warn);
  flex-shrink: 0;
`;

const PerfNoteText = styled.span`
  font-size: 0.78rem;
  flex: 1;
  letter-spacing: 0.01em;
`;

const PerfNoteDismiss = styled.button`
  background: none;
  border: none;
  cursor: pointer;
  color: var(--kc-warn);
  padding: 0.15rem;
  line-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 3px;
  opacity: 0.7;
  flex-shrink: 0;
  transition: opacity 0.12s ease;

  &:hover {
    opacity: 1;
  }

  &:focus-visible {
    outline: 2px solid var(--kc-warn);
    outline-offset: 2px;
    opacity: 1;
  }
`;

const EmptyHint = styled.div`
  grid-column: 1 / -1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.6rem;
  padding: 3rem 1rem;
  color: var(--kc-text-muted);
  text-align: center;
`;

const EmptyIcon = styled.div`
  opacity: 0.4;
  margin-bottom: 0.25rem;
`;

const EmptyTitle = styled.p`
  margin: 0;
  font-size: 0.85rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--kc-text-muted);
`;

const EmptyBody = styled.p`
  margin: 0;
  font-size: 0.75rem;
  opacity: 0.7;
  max-width: 28ch;
  line-height: 1.5;
`;
