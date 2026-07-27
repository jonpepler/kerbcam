/**
 * Shared geometry + behaviour for a dropdown portaled to document.body.
 * Used by CameraFeed's camera / quality / tracking menus and by
 * FeedActionBar's overflow menu, so the anchoring, dismissal, and Escape
 * handling live in exactly one place.
 */

import { useCallback, useEffect, useRef, useState } from "react";

const MENU_GAP = 4; // trigger-to-menu spacing
const MENU_EDGE = 8; // minimum inset from the viewport edge

/*
 * Geometry of a portaled dropdown: the CSS size caps of the menu (the
 * helper clamps as if the menu fills them) and which edge of the trigger
 * the menu hangs from: "start" lines the menu's left edge up with the
 * trigger's, "end" lines the right edges up.
 */
export interface MenuAnchor {
  maxWidth: number;
  maxHeight: number;
  align: "start" | "end";
}

/*
 * Fixed-position style for a portaled menu, anchored to its trigger button.
 * Opens downward by default; flips above the trigger when there is not
 * enough room below but there is above, otherwise clamps to the viewport.
 */
export function computeMenuPosition(
  trigger: HTMLElement,
  anchor: MenuAnchor,
): React.CSSProperties {
  const rect = trigger.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(anchor.maxWidth, vw - 2 * MENU_EDGE);
  /* Inline offset from the aligned viewport edge, clamped so a full-width
     menu still fits inside the opposite edge. */
  const inset = Math.max(MENU_EDGE, vw - width - MENU_EDGE);
  const inline: React.CSSProperties =
    anchor.align === "start"
      ? { left: Math.min(Math.max(rect.left, MENU_EDGE), inset) }
      : { right: Math.min(Math.max(vw - rect.right, MENU_EDGE), inset) };
  const menuH = Math.min(0.4 * vh, anchor.maxHeight);
  const fitsBelow = rect.bottom + MENU_GAP + menuH <= vh - MENU_EDGE;
  const fitsAbove = rect.top - MENU_GAP - menuH >= MENU_EDGE;
  if (!fitsBelow && fitsAbove) {
    return { ...inline, bottom: vh - rect.top + MENU_GAP };
  }
  const top = Math.min(
    rect.bottom + MENU_GAP,
    Math.max(MENU_EDGE, vh - MENU_EDGE - menuH),
  );
  return { ...inline, top };
}

/*
 * Shared behaviour for a dropdown portaled to document.body: fixed position
 * computed from the trigger's rect (so tile overflow cannot clip it),
 * re-anchored on window resize/scroll while open, Escape to close with focus
 * returned to the trigger, and portal-aware outside-pointer-down dismissal
 * (menuRef points at the portaled menu, so clicks inside it stay "inside").
 * One menu at a time falls out of the dismissal: opening another menu's
 * trigger is an outside press for this one.
 */
export function usePortalMenu({ maxWidth, maxHeight, align }: MenuAnchor) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<React.CSSProperties | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const update = () => {
      const trigger = triggerRef.current;
      if (trigger) {
        setPosition(computeMenuPosition(trigger, { maxWidth, maxHeight, align }));
      }
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, maxWidth, maxHeight, align]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      if (
        !menuRef.current?.contains(e.target as Node) &&
        !triggerRef.current?.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  const toggle = useCallback(() => setOpen((v) => !v), []);
  /** Close after an item pick, returning focus to the trigger. */
  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  return { open, toggle, close, position, menuRef, triggerRef };
}
