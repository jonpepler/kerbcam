import {
  buildCameraLabeler,
  CameraFeed,
  useKerbcastCameras,
} from "@ksp-gonogo/kerbcast-react";
import type { FeedAction } from "@ksp-gonogo/kerbcast-react";
import { CameraKind } from "@ksp-gonogo/kerbcast";
import { Check, ListPlus, ListX, Pencil, Pin, PinOff, Plus, Trash2, WifiOff, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import styled from "styled-components";
import { loadLabel, saveLabel } from "./labels";
import { cameraKey } from "./tiles";

/**
 * How the tile is sized by its container:
 *  - "grid": fills its grid column at 16:9 (the default flat grid).
 *  - "cell": fills whatever grid cell it's placed in (spotlight mode). The
 *    feed letterboxes inside via object-fit, so the cell need not be 16:9.
 */
export type TileVariant = "grid" | "cell";

interface TileProps {
  flightId: number | null;
  index: number;
  showDebugInfo: boolean;
  /** Whether to show animated static (true) or frozen frame with badge (false). */
  showStatic: boolean;
  /** Whether this feed's own REC button records at full resolution. */
  recordFullResolution: boolean;
  spotlit: boolean;
  variant?: TileVariant;
  /** True when any tile is spotlit (drives spotlight grid placement). */
  spotlightActive?: boolean;
  /** When false (crew NOT merged), the camera picker offers ONLY part cams, so
   *  crew cams stay in the crew bar and can't be selected into a part tile. */
  mergeCrew: boolean;
  onSelectCamera: (flightId: number) => void;
  onRemove: () => void;
  onToggleSpotlight: () => void;
  /** REC+ grouped-recording selection mode: shows a checkbox overlay on every
   *  bound tile (additive CSS, never remounts the feed) instead of the normal
   *  chrome. */
  selectionMode: boolean;
  /** Whether this tile is currently selected for the pending grouped recording. */
  selected: boolean;
  onToggleSelect: () => void;
}

export function Tile({
  flightId,
  index,
  showDebugInfo,
  showStatic,
  recordFullResolution,
  spotlit,
  variant = "grid",
  spotlightActive = false,
  mergeCrew,
  onSelectCamera,
  onRemove,
  onToggleSpotlight,
  selectionMode,
  selected,
  onToggleSelect,
}: TileProps): React.JSX.Element {
  /*
   * Corner label: the name of the camera the feed actually displays, which
   * follows CameraFeed's auto-latch/fallback, not just this tile's requested
   * flightId. Tracking the requested id alone mislabels a slot that is showing
   * a borrowed/auto-picked camera (it would read "Tile N" over a live feed).
   * Falls back to the tile number only when the feed shows nothing. The feed's
   * own title chrome is hover-revealed, so this is the at-a-glance identifier.
   */
  const cameras = useKerbcastCameras();
  const [displayedFlightId, setDisplayedFlightId] = useState<number | null>(
    flightId,
  );

  /*
   * A tile is "missing" when it points at a flightId that no longer appears in
   * the live cameras list. KSP can reassign part.flightID on revert/recover, so
   * CameraReconciler (in App.tsx) first attempts to rebind the tile by stable
   * identity (vesselName|partName|cameraName) before we reach here. A tile that
   * is still missing after reconciliation is genuinely gone: a destroyed vessel,
   * a different craft, or a camera whose name changed. We must NOT mount a
   * CameraFeed in that case (it would auto-latch onto an unrelated camera,
   * breaking the "never remount a live feed" rule), so we render a reconnecting
   * placeholder instead. A null flightId is an empty slot, not a missing camera.
   */
  const cameraMissing =
    flightId !== null && !cameras.some((c) => c.flightId === flightId);

  /*
   * The displayed camera's stable identity (vesselName|partName|cameraName),
   * or null when the feed shows nothing. Custom labels are keyed off this, NOT
   * off flightId, so a label survives KSP revert/recover the same way tiles do.
   * It is derived here for display only; it never feeds CameraFeed's props.
   */
  const displayedKey = useMemo(() => {
    const cam = cameras.find((c) => c.flightId === displayedFlightId);
    return cam ? cameraKey(cam) : null;
  }, [cameras, displayedFlightId]);

  const autoLabel = useMemo(() => {
    const cam = cameras.find((c) => c.flightId === displayedFlightId);
    return cam ? buildCameraLabeler(cameras)(cam) : `Tile ${index + 1}`;
  }, [cameras, displayedFlightId, index]);

  /*
   * Custom label state: seeded from localStorage for the displayed camera and
   * re-seeded whenever the displayed camera changes. It overrides autoLabel
   * when set; a cleared label falls back to autoLabel. This lives in Tile chrome
   * only, so editing it re-renders the title, never the CameraFeed below.
   */
  const [customLabel, setCustomLabel] = useState<string | null>(() =>
    loadLabel(displayedKey),
  );
  useEffect(() => {
    setCustomLabel(loadLabel(displayedKey));
  }, [displayedKey]);

  const label = customLabel ?? autoLabel;

  // Inline label editor: open state and draft text.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const beginEdit = () => {
    setDraft(customLabel ?? autoLabel);
    setEditing(true);
  };

  const commitEdit = () => {
    if (displayedKey) setCustomLabel(saveLabel(displayedKey, draft));
    setEditing(false);
  };

  const cancelEdit = () => setEditing(false);

  // Only offer renaming when the feed is actually showing a camera.
  const canRename = displayedKey !== null;

  /*
   * Tile-level controls injected into the feed's action bar, so there's a
   * single tidy cluster rather than a separate floating close button that
   * collides with it. Spotlight only makes sense once a camera is bound.
   */
  const actions = useMemo<FeedAction[]>(() => {
    if (flightId === null) return [];
    return [
      {
        id: "spotlight",
        label: spotlit ? "Remove from spotlight" : "Spotlight this feed",
        active: spotlit,
        icon: spotlit ? <PinOff size={14} /> : <Pin size={14} />,
        onClick: onToggleSpotlight,
      },
    ];
  }, [flightId, spotlit, onToggleSpotlight]);

  // Remove sits at the far corner (after the built-in fullscreen/PiP controls).
  const trailingActions = useMemo<FeedAction[]>(
    () => [
      {
        id: "remove",
        label: `Remove tile ${index + 1}`,
        icon: <X size={14} />,
        onClick: onRemove,
      },
    ],
    [index, onRemove],
  );

  if (cameraMissing) {
    return (
      <TileRoot $variant={variant} $spotlit={spotlit} $spotlightActive={spotlightActive}>
        <MissingWrap>
          <MissingIcon aria-hidden="true">
            <WifiOff size={22} strokeWidth={1.5} />
          </MissingIcon>
          <MissingText>Camera reconnecting</MissingText>
          <MissingSub>
            Camera {flightId} is no longer reporting. It may return on a fresh
            launch, or you can remove this tile.
          </MissingSub>
          <MissingRemove
            type="button"
            aria-label={`Remove tile ${index + 1}`}
            onClick={onRemove}
          >
            <X size={14} strokeWidth={1.75} aria-hidden="true" />
            Remove tile
          </MissingRemove>
        </MissingWrap>
        <TileCornerLabel>
          <TileCornerText>{`Tile ${index + 1}`}</TileCornerText>
        </TileCornerLabel>
      </TileRoot>
    );
  }

  return (
    <TileRoot $variant={variant} $spotlit={spotlit} $spotlightActive={spotlightActive}>
      <FeedWrap>
        <CameraFeed
          flightId={flightId}
          showDebugInfo={showDebugInfo}
          showStatic={showStatic}
          recordFullResolution={recordFullResolution}
          showStandbyIcon={false}
          onSelectCamera={onSelectCamera}
          cameraFilter={mergeCrew ? undefined : (c) => c.kind === CameraKind.Part}
          onDisplayedCameraChange={setDisplayedFlightId}
          enableFullscreen
          enablePictureInPicture
          enableQualityControl
          enableTracking
          enableRecording
          actions={actions}
          trailingActions={trailingActions}
        />
      </FeedWrap>
      {selectionMode && flightId !== null && (
        <SelectionOverlay
          type="button"
          role="checkbox"
          aria-checked={selected}
          aria-label={
            selected
              ? `Deselect tile ${index + 1} for grouped recording`
              : `Select tile ${index + 1} for grouped recording`
          }
          $selected={selected}
          onClick={onToggleSelect}
        >
          <SelectionCheckbox $selected={selected}>
            {selected && <Check size={14} strokeWidth={3} aria-hidden="true" />}
          </SelectionCheckbox>
        </SelectionOverlay>
      )}
      {editing ? (
        <LabelEditor
          onSubmit={(e) => {
            e.preventDefault();
            commitEdit();
          }}
        >
          <LabelInput
            ref={inputRef}
            value={draft}
            maxLength={48}
            placeholder={autoLabel}
            aria-label="Custom feed label"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") cancelEdit();
            }}
            onBlur={commitEdit}
          />
          <LabelEditButton type="submit" aria-label="Save label" title="Save label">
            <Check size={12} strokeWidth={2} aria-hidden="true" />
          </LabelEditButton>
        </LabelEditor>
      ) : (
        <TileCornerLabel>
          <TileCornerText>{label}</TileCornerText>
          {canRename && (
            <TileRenameButton
              type="button"
              aria-label="Rename feed"
              title="Rename feed"
              onClick={beginEdit}
            >
              <Pencil size={11} strokeWidth={1.75} aria-hidden="true" />
            </TileRenameButton>
          )}
        </TileCornerLabel>
      )}
    </TileRoot>
  );
}

interface AddTileProps {
  onClick: () => void;
  isEmpty?: boolean;
  /** Spotlight mode: render as a small 1x1 grid cell rather than a 16:9 tile. */
  compact?: boolean;
  /** Flat fill mode: a slim full-width bar below the feeds. */
  bar?: boolean;
}

export function AddTile({ onClick, isEmpty, compact, bar }: AddTileProps): React.JSX.Element {
  return (
    <AddRoot
      type="button"
      aria-label="Add tile"
      onClick={onClick}
      $isEmpty={isEmpty ?? false}
      $compact={compact ?? false}
      $bar={bar ?? false}
    >
      <AddIcon aria-hidden="true">
        <Plus size={20} strokeWidth={1.5} />
      </AddIcon>
      {(isEmpty || bar) && <AddLabel>Add camera</AddLabel>}
    </AddRoot>
  );
}

/**
 * "Add all cameras" sibling of AddTile: one click points a tile at every
 * camera the grid is not already showing. Same look and sizing variants as
 * AddTile so the two read as one control cluster.
 */
export function AddAllTile({ onClick, isEmpty, compact, bar }: AddTileProps): React.JSX.Element {
  return (
    <AddRoot
      type="button"
      aria-label="Add all cameras"
      title="Add all cameras"
      onClick={onClick}
      $isEmpty={isEmpty ?? false}
      $compact={compact ?? false}
      $bar={bar ?? false}
    >
      <AddIcon aria-hidden="true">
        <ListPlus size={20} strokeWidth={1.5} />
      </AddIcon>
      {(isEmpty || bar) && <AddLabel>Add all cameras</AddLabel>}
    </AddRoot>
  );
}

/**
 * "Remove all lost cameras" sibling of AddAllTile: one click drops every
 * SIGNAL-LOST tile, keeping live feeds and empty slots. Same look and sizing
 * variants as AddTile so the controls read as one cluster.
 */
export function RemoveLostTile({ onClick, isEmpty, compact, bar }: AddTileProps): React.JSX.Element {
  return (
    <AddRoot
      type="button"
      aria-label="Remove all lost cameras"
      title="Remove all lost cameras"
      onClick={onClick}
      $isEmpty={isEmpty ?? false}
      $compact={compact ?? false}
      $bar={bar ?? false}
    >
      <AddIcon aria-hidden="true">
        <ListX size={20} strokeWidth={1.5} />
      </AddIcon>
      {(isEmpty || bar) && <AddLabel>Remove lost cameras</AddLabel>}
    </AddRoot>
  );
}

/**
 * "Remove all cameras" sibling of AddAllTile: one click clears the grid. Same
 * look and sizing variants as AddTile so the controls read as one cluster.
 */
export function RemoveAllTile({ onClick, isEmpty, compact, bar }: AddTileProps): React.JSX.Element {
  return (
    <AddRoot
      type="button"
      aria-label="Remove all cameras"
      title="Remove all cameras"
      onClick={onClick}
      $isEmpty={isEmpty ?? false}
      $compact={compact ?? false}
      $bar={bar ?? false}
    >
      <AddIcon aria-hidden="true">
        <Trash2 size={20} strokeWidth={1.5} />
      </AddIcon>
      {(isEmpty || bar) && <AddLabel>Remove all cameras</AddLabel>}
    </AddRoot>
  );
}

// ---------------------------------------------------------------------------
// Styled
// ---------------------------------------------------------------------------

interface TileRootProps {
  $variant: TileVariant;
  $spotlit: boolean;
  $spotlightActive: boolean;
}

const TileRoot = styled.div<TileRootProps>`
  position: relative;
  display: flex;
  flex-direction: column;
  background: var(--kc-surface);
  border: 1px solid var(--kc-border);
  border-radius: var(--kc-tile-radius);
  overflow: hidden;

  /* Subtle inner shadow to give depth without distraction */
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18), 0 0 0 0.5px rgba(0, 0, 0, 0.08);

  ${(p) =>
    p.$variant === "grid"
      ? `
    /* --tile-w is set by Grid in fill mode (the grid is sized to the
       viewport); without it the tile just fills its column. aspect-ratio
       derives the height either way, and the max-* guards keep a stale
       measurement from overflowing. */
    width: var(--tile-w, 100%);
    max-width: 100%;
    max-height: 100%;
    aspect-ratio: 16 / 9;
  `
      : `
    /* Fill the grid cell; the feed letterboxes inside (object-fit: contain),
       so a non-16:9 cell just adds bars rather than stretching the video. */
    width: 100%;
    height: 100%;
    min-height: 0;
  `}

  ${(p) =>
    p.$spotlightActive &&
    (p.$spotlit
      ? `
    /* Spotlit feeds enlarge and sort ahead of the rest. */
    grid-column: span 2;
    grid-row: span 2;
    order: 0;
  `
      : `order: 1;`)}

  ${(p) =>
    p.$spotlit &&
    `
    border-color: var(--kc-accent);
    box-shadow: 0 0 0 1px var(--kc-accent), 0 2px 8px rgba(0, 0, 0, 0.3);
  `}
`;

/* Label: bottom-left corner, barely visible. On hover the feed's own title
   chrome appears and would duplicate the name, so the text fades out; the
   rename affordance fades IN instead so the operator can edit it. */
const TileCornerLabel = styled.span`
  position: absolute;
  bottom: 0.4rem;
  left: 0.5rem;
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.6rem;
  letter-spacing: 0.06em;
  color: rgba(255, 255, 255, 0.35);
  user-select: none;
  text-shadow: 0 1px 3px rgba(0,0,0,0.6);
  z-index: 2;
`;

/* The name text itself: fades out on hover (the feed chrome covers naming). */
const TileCornerText = styled.span`
  pointer-events: none;
  transition: opacity 0.15s ease;

  ${TileRoot}:hover & {
    opacity: 0;
  }

  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }
`;

/* Rename pencil: hidden until hover/focus, then fades in where the text was. */
const TileRenameButton = styled.button`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.1rem;
  line-height: 0;
  background: none;
  border: none;
  border-radius: 3px;
  color: rgba(255, 255, 255, 0.6);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s ease, color 0.12s ease;

  ${TileRoot}:hover & {
    opacity: 1;
  }

  &:hover {
    color: var(--kc-accent);
  }

  &:focus-visible {
    opacity: 1;
    outline: 2px solid var(--kc-accent);
    outline-offset: 1px;
  }

  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }
`;

/* Inline editor shown in place of the corner label while renaming. */
const LabelEditor = styled.form`
  position: absolute;
  bottom: 0.4rem;
  left: 0.5rem;
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  z-index: 3;
`;

const LabelInput = styled.input`
  font-family: inherit;
  font-size: 0.62rem;
  letter-spacing: 0.04em;
  color: var(--kc-text);
  background: var(--kc-surface);
  border: 1px solid var(--kc-accent);
  border-radius: 4px;
  padding: 0.2rem 0.35rem;
  width: 12ch;
  max-width: 60vw;

  &:focus {
    outline: none;
  }
`;

const LabelEditButton = styled.button`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.2rem;
  line-height: 0;
  color: var(--kc-accent);
  background: var(--kc-surface);
  border: 1px solid var(--kc-accent);
  border-radius: 4px;
  cursor: pointer;

  &:focus-visible {
    outline: 2px solid var(--kc-accent);
    outline-offset: 1px;
  }
`;

const FeedWrap = styled.div`
  flex: 1;
  min-height: 0;
  position: relative;

  /* Let CameraFeed Stage fill the tile */
  & > div {
    height: 100%;
    min-height: 0;
  }

  /* The feed's Next/Previous step buttons land exactly where the tile's
     action cluster sits, and the title menu already covers camera selection
     on this page, so suppress them here. */
  & button[aria-label="Next camera"],
  & button[aria-label="Previous camera"] {
    display: none;
  }
`;

/*
 * REC+ selection-mode overlay: an ADDITIVE sibling of FeedWrap, never a
 * wrapper around it, so toggling selection mode never remounts the live
 * CameraFeed underneath. Covers the whole tile so the operator can click
 * anywhere on it to select/deselect, with a checkbox glyph in the corner.
 */
const SelectionOverlay = styled.button<{ $selected: boolean }>`
  position: absolute;
  inset: 0;
  z-index: 6;
  display: flex;
  align-items: flex-start;
  justify-content: flex-start;
  padding: 0.5rem;
  margin: 0;
  border: none;
  border-radius: inherit;
  cursor: pointer;
  background: ${(p) => (p.$selected ? "var(--kc-accent-wash)" : "transparent")};
  box-shadow: ${(p) => (p.$selected ? "inset 0 0 0 2px var(--kc-accent)" : "none")};

  &:focus-visible {
    outline: 2px solid var(--kc-accent);
    outline-offset: -2px;
  }
`;

const SelectionCheckbox = styled.span<{ $selected: boolean }>`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 4px;
  border: 1.5px solid ${(p) => (p.$selected ? "var(--kc-accent)" : "rgba(255, 255, 255, 0.7)")};
  background: ${(p) => (p.$selected ? "var(--kc-accent)" : "rgba(0, 0, 0, 0.35)")};
  color: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
`;

/* Missing-camera placeholder: shown in place of the feed when the tile's
   flightId has vanished from the live cameras list. */
const MissingWrap = styled.div`
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 1rem;
  text-align: center;
  color: var(--kc-text-muted);
`;

const MissingIcon = styled.span`
  line-height: 0;
  opacity: 0.6;
`;

const MissingText = styled.span`
  font-size: 0.85rem;
  letter-spacing: 0.03em;
  color: var(--kc-text);
`;

const MissingSub = styled.span`
  font-size: 0.7rem;
  line-height: 1.4;
  max-width: 26ch;
  opacity: 0.8;
`;

const MissingRemove = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  margin-top: 0.35rem;
  padding: 0.35rem 0.7rem;
  font-family: inherit;
  font-size: 0.72rem;
  letter-spacing: 0.03em;
  color: var(--kc-text-muted);
  background: none;
  border: 1px solid var(--kc-border);
  border-radius: 5px;
  cursor: pointer;
  transition: border-color 0.15s ease, color 0.15s ease, background 0.15s ease;

  &:hover {
    border-color: var(--kc-accent);
    color: var(--kc-accent);
    background: var(--kc-accent-wash);
  }

  &:focus-visible {
    outline: 2px solid var(--kc-accent);
    outline-offset: 2px;
  }
`;

interface AddRootProps {
  $isEmpty: boolean;
  $compact: boolean;
  $bar: boolean;
}

const AddRoot = styled.button<AddRootProps>`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  background: none;
  border: 1.5px dashed var(--kc-border);
  border-radius: var(--kc-tile-radius);
  aspect-ratio: 16 / 9;
  cursor: pointer;
  color: var(--kc-text-muted);
  font-family: inherit;
  transition: border-color 0.15s ease, color 0.15s ease, background 0.15s ease;

  ${(p) => p.$isEmpty && `
    /* When it's the only element, don't force 16:9; be more of a CTA bar */
    aspect-ratio: unset;
    min-height: 80px;
    max-height: 100px;
  `}

  ${(p) => p.$compact && `
    /* Spotlight mode: fill a 1x1 grid cell, sorted after the feeds. */
    aspect-ratio: unset;
    width: 100%;
    height: 100%;
    min-height: 0;
    order: 1;
  `}

  ${(p) => p.$bar && `
    /* Flat fill mode: a slim bar below the feeds. grid-column applies when
       the button is a grid item; flex applies when it shares the add-controls
       row with a sibling button. */
    grid-column: 1 / -1;
    flex: 1;
    flex-direction: row;
    aspect-ratio: unset;
    min-height: 0;
    height: 52px;
    gap: 0.4rem;
  `}

  &:hover {
    border-color: var(--kc-accent);
    color: var(--kc-accent);
    background: var(--kc-accent-wash);
  }

  &:focus-visible {
    outline: 2px solid var(--kc-accent);
    outline-offset: 2px;
  }
`;

const AddIcon = styled.span`
  opacity: 0.6;
  line-height: 0;

  ${AddRoot}:hover & {
    opacity: 1;
  }
`;

const AddLabel = styled.span`
  font-size: 0.72rem;
  letter-spacing: 0.05em;
  opacity: 0.7;

  ${AddRoot}:hover & {
    opacity: 1;
  }
`;
