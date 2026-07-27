/**
 * FeedActionBar: the shared top-right action row rendered by BOTH
 * `CameraFeed` and `KerbalFaceFeed`, so a single overflow engine serves every
 * feed surface (part cams, crew faces, and any future host).
 *
 * Partition rule (issue #6 UI spec): stateful toggles (their at-rest state
 * must stay visible, e.g. auto-track, the coming REC) are PRIMARY and always
 * inline. Non-stateful actions (quality, PiP, fullscreen, plain consumer
 * actions) are overflow-eligible: they collapse into a ⋮ menu ONLY once the
 * row is genuinely crowded (total enabled >= 4 AND >= 2 non-stateful
 * eligible): a single item never collapses, since that would cost a click
 * to reach the one control that exists. Order is stable (an explicit `order`
 * wins, otherwise entries keep the relative position their caller gave them)
 * so chips don't reflow as buttons enable/disable around them.
 *
 * Close/remove is a THIRD category: `pinnedTrailing`. It is never
 * overflow-eligible, never counted toward the overflow threshold, and always
 * renders last (to the right of the ⋮ trigger itself), so dismissing a
 * feed always stays a single, persistent, rightmost click. Bar order is:
 * [stateful primaries] … [⋮ overflow, non-stateful] [pinned trailing close].
 *
 * Deliberately minimal: an entry is just (id, label, stateful?, order?,
 * pinnedTrailing?, render). The interactive node itself (icon, aria
 * attributes, onClick, any submenu it opens) is built by the caller
 * (CameraFeed / KerbalFaceFeed) exactly as before; this component only
 * decides WHERE it goes.
 */

import { Fragment, useId } from "react";
import { createPortal } from "react-dom";
import styled from "styled-components";
import { usePortalMenu } from "./menuPositioning";

/**
 * A consumer-supplied action rendered into a feed's action bar. Lets a host
 * page (e.g. the sidecar's spotlight toggle) inject controls without the
 * library knowing what they do.
 */
export interface FeedAction {
  /** Stable identity for the React key. */
  id: string;
  /** Accessible label; used for aria-label, the native tooltip, and the overflow-menu row's visible text. */
  label: string;
  /** Icon node, sized by the action bar (~14px). */
  icon: React.ReactNode;
  /** Toggle state: renders the button highlighted and sets aria-pressed. */
  active?: boolean;
  onClick: () => void;
  /**
   * Whether this action is a stateful toggle: stays PRIMARY / always
   * inline so its at-rest state is visible, never collapses into the ⋮
   * overflow. Defaults to `active !== undefined`. Override when a
   * tri-state/menu-driven action's "active" isn't a plain boolean, or to force
   * a boolean toggle to be overflow-eligible anyway.
   */
  stateful?: boolean;
  /**
   * Stable sort key for the action bar (lower sorts first). Actions without
   * an explicit order keep their natural (array) position; this exists so a
   * consumer can pin an action to a specific slot instead. Chips never
   * reflow as buttons enable/disable; this is what keeps that stable.
   */
  order?: number;
  /**
   * Marks this as the bar's pinned-trailing (close/remove) slot: it is NEVER
   * overflow-eligible, is excluded entirely from the overflow-threshold count
   * (both the total and the non-stateful-eligible count), and always renders
   * last (to the right of the ⋮ trigger), so dismissing a feed is always a
   * single, persistent, rightmost click. `CameraFeed`'s `trailingActions`
   * prop sets this automatically; a `KerbalFaceFeed`/`actions`-only consumer
   * sets it explicitly on its close action.
   */
  pinnedTrailing?: boolean;
}

// ---------------------------------------------------------------------------
// Partition logic (pure, unit-tested independently of any rendering)
// ---------------------------------------------------------------------------

const OVERFLOW_MIN_TOTAL = 4;
const OVERFLOW_MIN_NON_STATEFUL = 2;

interface Partitionable {
  stateful?: boolean;
  order?: number;
  pinnedTrailing?: boolean;
}

/**
 * Sort a list of action-bar entries into (primary, overflow, pinnedTrailing).
 * `entries` must already be filtered down to the currently-enabled set:
 * this function has no notion of "disabled", only "present".
 *
 * `pinnedTrailing` entries (close/remove) are pulled out FIRST and excluded
 * entirely from the overflow-threshold count. Both the total and the
 * non-stateful-eligible count run only over the remaining entries, then
 * always returned as their own group, to be rendered last (see
 * `FeedActionBar`, which places them after the ⋮ trigger).
 */
export function partitionActionBarEntries<T extends Partitionable>(
  entries: readonly T[],
): { primary: T[]; overflow: T[]; pinnedTrailing: T[] } {
  const sorted = [...entries].sort(
    (a, b) => (a.order ?? Number.POSITIVE_INFINITY) - (b.order ?? Number.POSITIVE_INFINITY),
  );
  const pinnedTrailing = sorted.filter((e) => e.pinnedTrailing);
  const overflowable = sorted.filter((e) => !e.pinnedTrailing);
  const nonStateful = overflowable.filter((e) => !e.stateful);
  const overflowActive =
    overflowable.length >= OVERFLOW_MIN_TOTAL && nonStateful.length >= OVERFLOW_MIN_NON_STATEFUL;

  if (!overflowActive) {
    return { primary: overflowable, overflow: [], pinnedTrailing };
  }
  return {
    primary: overflowable.filter((e) => e.stateful),
    overflow: nonStateful,
    pinnedTrailing,
  };
}

// ---------------------------------------------------------------------------
// Entry shape + the FeedAction -> entry adapter
// ---------------------------------------------------------------------------

/**
 * One slot in the bar. `render` produces the actual interactive element
 * (unchanged whether it lands inline or inside the overflow menu) so callers
 * keep full control of refs / aria attributes / submenus; FeedActionBar only
 * decides placement and, in the overflow menu, adds the visible label.
 */
export interface FeedActionBarEntry {
  id: string;
  label: string;
  stateful?: boolean;
  order?: number;
  pinnedTrailing?: boolean;
  render: () => React.ReactNode;
}

/**
 * Adapt a plain consumer/public `FeedAction` (id/label/icon/active/onClick,
 * plus the optional stateful?/order?/pinnedTrailing? flags) into a bar entry,
 * rendered as the standard icon button. `stateful` defaults to
 * `active !== undefined` per the #6 spec (stateful toggles, meaning
 * `active !== undefined`, stay primary).
 */
export function feedActionToEntry(action: FeedAction): FeedActionBarEntry {
  return {
    id: action.id,
    label: action.label,
    stateful: action.stateful ?? action.active !== undefined,
    order: action.order,
    pinnedTrailing: action.pinnedTrailing,
    render: () => (
      <OverlayIconButton
        key={action.id}
        type="button"
        aria-label={action.label}
        aria-pressed={action.active ?? undefined}
        title={action.label}
        $active={action.active ?? false}
        onClick={action.onClick}
      >
        {action.icon}
      </OverlayIconButton>
    ),
  };
}

// ---------------------------------------------------------------------------
// The bar itself
// ---------------------------------------------------------------------------

const OVERFLOW_MENU_MAX_WIDTH = 200;
const OVERFLOW_MENU_MAX_HEIGHT = 240;

export interface FeedActionBarProps {
  /** Non-partitioned content rendered before the partitioned entries (e.g. the camera step buttons). */
  leading?: React.ReactNode;
  entries: FeedActionBarEntry[];
  /** Forwarded to the root row; lets a host `styled(FeedActionBar)` override layout (e.g. KerbalFaceFeed's smaller, always-visible bar). */
  className?: string;
}

/**
 * Shared top-right action row. Renders `leading`, then the partitioned
 * entries: stateful ones always inline, non-stateful ones inline until the
 * row is crowded enough to warrant a ⋮ overflow menu, then the pinned
 * trailing (close/remove) entries: always last, to the right of the ⋮.
 */
export function FeedActionBar({ leading, entries, className }: FeedActionBarProps) {
  const { primary, overflow, pinnedTrailing } = partitionActionBarEntries(entries);
  const menuId = useId();
  const overflowMenu = usePortalMenu({
    maxWidth: OVERFLOW_MENU_MAX_WIDTH,
    maxHeight: OVERFLOW_MENU_MAX_HEIGHT,
    align: "end",
  });
  const closeOverflowMenu = overflowMenu.close;

  if (!leading && entries.length === 0) return null;

  return (
    <ActionBarRow className={className}>
      {leading}
      {primary.map((e) => (
        <Fragment key={e.id}>{e.render()}</Fragment>
      ))}
      {overflow.length > 0 && (
        <OverlayIconButton
          ref={overflowMenu.triggerRef}
          type="button"
          aria-label="More actions"
          aria-haspopup="menu"
          aria-expanded={overflowMenu.open}
          aria-controls={menuId}
          title="More actions"
          $active={overflowMenu.open}
          onClick={overflowMenu.toggle}
        >
          <MoreIcon />
        </OverlayIconButton>
      )}
      {overflow.length > 0 &&
        overflowMenu.open &&
        overflowMenu.position &&
        createPortal(
          <OverflowMenu
            ref={overflowMenu.menuRef}
            id={menuId}
            role="menu"
            aria-label="More actions"
            style={overflowMenu.position}
          >
            {overflow.map((e) => (
              // The wrapping row's onClick fires in the BUBBLE phase, after
              // the entry's own button click handler, so this closes the
              // menu once the action has actually fired rather than
              // pre-empting it.
              <OverflowMenuItem key={e.id} onClick={closeOverflowMenu}>
                {e.render()}
                <OverflowMenuItemLabel aria-hidden="true">{e.label}</OverflowMenuItemLabel>
              </OverflowMenuItem>
            ))}
          </OverflowMenu>,
          document.body,
        )}
      {pinnedTrailing.map((e) => (
        <Fragment key={e.id}>{e.render()}</Fragment>
      ))}
    </ActionBarRow>
  );
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

/* Overflow trigger: vertical ellipsis (three dots). */
function MoreIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={14}
      height={14}
      fill="currentColor"
      stroke="none"
      aria-hidden="true"
    >
      <circle cx="8" cy="3" r="1.4" />
      <circle cx="8" cy="8" r="1.4" />
      <circle cx="8" cy="13" r="1.4" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Styled components
// ---------------------------------------------------------------------------

/** Icon-button shared by every action-bar entry (built-in or consumer). */
export const OverlayIconButton = styled.button<{ $active?: boolean }>`
  position: relative;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  /* Active-toggle fill (quality / tracking / PiP / fullscreen / custom actions
     all share this button). Its own token so a consumer can recolour just the
     action-row highlight without touching the general accent; defaults to
     --kerbcast-accent, so the sidecar web page (which maps its accent onto that)
     is unchanged. */
  background: ${(p) =>
    p.$active
      ? "var(--kerbcast-action-active, var(--kerbcast-accent, #00ff88))"
      : "rgba(0, 0, 0, 0.5)"};
  border: 1px solid
    ${(p) =>
      p.$active
        ? "var(--kerbcast-action-active, var(--kerbcast-accent, #00ff88))"
        : "rgba(255, 255, 255, 0.3)"};
  border-radius: 3px;
  color: ${(p) => (p.$active ? "#000" : "#fff")};
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s, color 0.12s;

  @media (hover: hover) {
    &:hover {
      background: ${(p) =>
        p.$active
          ? "var(--kerbcast-action-active, var(--kerbcast-accent, #00ff88))"
          : "rgba(0, 0, 0, 0.7)"};
      border-color: rgba(255, 255, 255, 0.6);
    }
  }

  &:focus-visible {
    outline: 2px solid var(--kerbcast-accent, #00ff88);
    outline-offset: 2px;
  }

  &:disabled {
    opacity: 0.4;
  }

  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }
`;

/* Top-right cluster of overlay controls (custom actions + built-ins + overflow). */
export const ActionBarRow = styled.div`
  position: absolute;
  top: 6px;
  right: 8px;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 4px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s;

  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }
`;

/* The ⋮ overflow dropdown: same portal/anchor contract as CameraFeed's other
   menus (fixed position set inline from the trigger rect) so tile clipping
   cannot cut it off. */
const OverflowMenu = styled.div`
  position: fixed;
  z-index: 1000;
  min-width: 140px;
  max-width: min(200px, calc(100vw - 16px));
  max-height: min(40vh, 240px);
  display: flex;
  flex-direction: column;
  padding: 4px;
  gap: 2px;
  background: rgba(0, 0, 0, 0.85);
  border: 1px solid rgba(255, 255, 255, 0.3);
  border-radius: 4px;
  overflow-x: hidden;
  overflow-y: auto;
`;

const OverflowMenuItem = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 4px;
  border-radius: 3px;

  @media (hover: hover) {
    &:hover {
      background: rgba(255, 255, 255, 0.1);
    }
  }
`;

const OverflowMenuItemLabel = styled.span`
  font-size: 11px;
  letter-spacing: 0.04em;
  color: #fff;
  white-space: nowrap;
`;
