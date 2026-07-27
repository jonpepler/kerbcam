/**
 * CrewBar — the crew face-camera surface (shown when crew are NOT merged into
 * the regular camera list).
 *
 * Camera-driven: renders every OPEN `kind === "kerbal"` camera as a square
 * KerbalFaceFeed (keyed by flightId), with a name label, an IVA/EVA badge from
 * crewLocation, and a SIGNAL LOST treatment for a destroyed kerbal.
 *
 * Open/close mirrors the part cameras' add/remove: each face has a close (x);
 * closed crew move into an "Add crew" menu in the header and can be reopened.
 * The open/closed set is owned + persisted by the App (like the tile grid), so
 * it survives reload; default (nothing stored) is all-open.
 *
 * Placement (row / column) and minimise are CSS-only reflows of the SAME
 * mounted feeds — switching either never remounts a KerbalFaceFeed.
 */

import { CameraKind, CrewLocation } from "@ksp-gonogo/kerbcast";
import type { CameraState } from "@ksp-gonogo/kerbcast";
import { KerbalFaceFeed, buildCameraLabeler, isCameraDestroyed, useKerbcastCameras } from "@ksp-gonogo/kerbcast-react";
import type { FeedAction } from "@ksp-gonogo/kerbcast-react";
import { Maximize2, PanelBottomClose, PanelBottomOpen, PictureInPicture2, Pin, PinOff, Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import styled from "styled-components";
import type { CrewBarPlacement } from "./settings";

interface CrewBarProps {
  placement: CrewBarPlacement;
  /** Collapsed out of the way (feeds stay mounted). Transient. */
  minimised: boolean;
  onToggleMinimise: () => void;
  /** Wire-ids of closed (hidden) crew faces. */
  closed: ReadonlySet<number>;
  onClose: (flightId: number) => void;
  onOpen: (flightId: number) => void;
  /** Spotlit crew face (single) or null. */
  spotlight: number | null;
  onToggleSpotlight: (flightId: number) => void;
}

export function CrewBar({
  placement,
  minimised,
  onToggleMinimise,
  closed,
  onClose,
  onOpen,
  spotlight,
  onToggleSpotlight,
}: CrewBarProps): React.JSX.Element | null {
  const cameras = useKerbcastCameras();
  const kerbals = useMemo(
    () => cameras.filter((c) => c.kind === CameraKind.Kerbal),
    [cameras],
  );
  const labelFor = useMemo(() => buildCameraLabeler(cameras), [cameras]);

  // No crew cameras at all -> render nothing (don't reserve empty space). When
  // crew exist but are all closed we still render the header so "Add crew" is
  // reachable to reopen them.
  if (kerbals.length === 0) return null;

  const openFaces = kerbals.filter((k) => !closed.has(k.flightId));
  const closedKerbals = kerbals.filter((k) => closed.has(k.flightId));

  // Float the spotlit face to the FRONT of the roster. Faces are keyed by
  // flightId, so reordering the array MOVES the existing DOM node (keyed
  // reconciliation), it does NOT rebuild the <video> — never-remount holds.
  const open =
    spotlight != null && openFaces.some((k) => k.flightId === spotlight)
      ? [
          ...openFaces.filter((k) => k.flightId === spotlight),
          ...openFaces.filter((k) => k.flightId !== spotlight),
        ]
      : openFaces;

  const hasSpotlit = spotlight != null && open.some((k) => k.flightId === spotlight);

  return (
    <Root $placement={placement} $hasSpotlit={hasSpotlit} data-testid="crew-bar" data-placement={placement}>
      <Bar>
        <BarTitle>Crew</BarTitle>
        <BarControls>
          {closedKerbals.length > 0 && (
            <AddCrew>
              <AddCrewSummary aria-label="Add crew">
                <Plus size={14} strokeWidth={2} aria-hidden="true" />
                Add crew
              </AddCrewSummary>
              <AddCrewMenu>
                {closedKerbals.map((k) => (
                  <AddCrewItem
                    key={k.flightId}
                    type="button"
                    onClick={(e) => {
                      onOpen(k.flightId);
                      // Close the native disclosure after picking.
                      e.currentTarget.closest("details")?.removeAttribute("open");
                    }}
                  >
                    {labelFor(k)}
                  </AddCrewItem>
                ))}
              </AddCrewMenu>
            </AddCrew>
          )}
          <MinButton
            type="button"
            aria-label={minimised ? "Show crew" : "Hide crew"}
            aria-pressed={minimised}
            onClick={onToggleMinimise}
          >
            {minimised ? <PanelBottomOpen size={15} aria-hidden="true" /> : <PanelBottomClose size={15} aria-hidden="true" />}
          </MinButton>
        </BarControls>
      </Bar>
      {/* Faces stay mounted when minimised — collapsed via CSS, never unmounted. */}
      <Faces $placement={placement} $spotlit={hasSpotlit} $minimised={minimised} aria-hidden={minimised}>
        {open.map((k) => (
          <CrewFace
            key={k.flightId}
            cam={k}
            spotlit={spotlight === k.flightId}
            onToggleSpotlight={() => onToggleSpotlight(k.flightId)}
            onClose={() => {
              // Releasing spotlight is the App's job; closing a spotlit face
              // just closes it (the App clears a stale spotlight on next render
              // since the face leaves `open`).
              onClose(k.flightId);
            }}
          />
        ))}
      </Faces>
    </Root>
  );
}

// ---------------------------------------------------------------------------
// A single crew face
// ---------------------------------------------------------------------------

interface CrewFaceProps {
  cam: CameraState;
  spotlit: boolean;
  onToggleSpotlight: () => void;
  onClose: () => void;
}

function CrewFace({ cam, spotlit, onToggleSpotlight, onClose }: CrewFaceProps): React.JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null);
  const destroyed = isCameraDestroyed(cam);
  const eva = cam.crewLocation === CrewLocation.Eva;
  const name = cam.cameraName || "Kerbal";

  // Bring a newly-spotlit face into view (it floats to the front + grows, so it
  // may be off-screen in a scrolled strip). scrollIntoView is a no-op in jsdom.
  useEffect(() => {
    if (spotlit) wrapRef.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [spotlit]);

  // Visible hover controls, mirroring the part-cam CameraFeed set: spotlight,
  // fullscreen, PiP, close. Fullscreen targets the face CONTAINER (the video
  // goes fullscreen with it); PiP needs the <video> element itself, which the
  // KerbalFaceFeed primitive doesn't expose, so we take the one <video> inside
  // this wrapper (a primitive-exposed ref is the cleaner long-term path). Close
  // hides the face from the bar (persisted; reopen via the Add crew menu).
  const actions = useMemo<FeedAction[]>(
    () => [
      {
        id: "spotlight",
        label: spotlit ? "Remove from spotlight" : "Spotlight this feed",
        icon: spotlit
          ? <PinOff size={13} strokeWidth={2} aria-hidden="true" />
          : <Pin size={13} strokeWidth={2} aria-hidden="true" />,
        active: spotlit,
        onClick: onToggleSpotlight,
      },
      {
        id: "fullscreen",
        label: "Fullscreen",
        icon: <Maximize2 size={13} strokeWidth={2} aria-hidden="true" />,
        onClick: () => toggleFullscreen(wrapRef.current),
      },
      {
        id: "pip",
        label: "Picture in picture",
        icon: <PictureInPicture2 size={13} strokeWidth={2} aria-hidden="true" />,
        onClick: () => togglePictureInPicture(wrapRef.current),
      },
      {
        id: "close",
        label: "Close",
        icon: <X size={13} strokeWidth={2} aria-hidden="true" />,
        onClick: onClose,
        // Pinned trailing: never overflow-eligible, always the rightmost,
        // persistent, single-click control (excluded from the overflow
        // threshold count entirely).
        pinnedTrailing: true,
      },
    ],
    [spotlit, onToggleSpotlight, onClose],
  );

  return (
    <FaceWrap
      ref={wrapRef}
      $spotlit={spotlit}
      data-testid="crew-face"
      data-flight-id={cam.flightId}
      data-destroyed={destroyed}
      data-spotlit={spotlit}
      onDoubleClick={() => toggleFullscreen(wrapRef.current)}
    >
      <KerbalFaceFeed flightId={cam.flightId} actions={actions} showStandby={!destroyed}>
        <Overlay>
          <Badge $eva={eva}>{eva ? "EVA" : "IVA"}</Badge>
          {destroyed && <Lost>SIGNAL LOST</Lost>}
          <Name title={name}>{name}</Name>
        </Overlay>
      </KerbalFaceFeed>
    </FaceWrap>
  );
}

function toggleFullscreen(el: HTMLElement | null): void {
  if (!el) return;
  const d = document as Document & {
    webkitFullscreenElement?: Element | null;
    webkitExitFullscreen?: () => void;
  };
  const e = el as HTMLElement & { webkitRequestFullscreen?: () => void };
  const current = document.fullscreenElement ?? d.webkitFullscreenElement ?? null;
  if (current) {
    (document.exitFullscreen ?? d.webkitExitFullscreen)?.call(document);
  } else {
    (e.requestFullscreen ?? e.webkitRequestFullscreen)?.call(e);
  }
}

/* PiP needs the HTMLVideoElement (element fullscreen accepts any element, PiP
   does not). The primitive renders exactly one <video> in the face frame; grab
   it from the wrapper. No-op where PiP is unsupported (iOS Safari, etc). */
function togglePictureInPicture(wrap: HTMLElement | null): void {
  const video = wrap?.querySelector("video") as HTMLVideoElement | null;
  if (!video) return;
  const d = document as Document & { pictureInPictureEnabled?: boolean };
  if (!d.pictureInPictureEnabled) return;
  if (document.pictureInPictureElement === video) {
    void document.exitPictureInPicture().catch(() => {});
  } else {
    void video.requestPictureInPicture().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Styled
// ---------------------------------------------------------------------------

/** Fixed square edge for a crew face (px). */
const FACE = 132;

const Root = styled.div<{ $placement: CrewBarPlacement; $hasSpotlit: boolean }>`
  display: flex;
  flex-direction: column;
  min-height: 0;
  ${(p) =>
    p.$placement === "column"
      ? `
    /* Side column: vertical dock. Widen to fit a spotlit 2x face so it stays
       inside the sidebar (never renders off-screen); relaxes when none spotlit. */
    width: ${(p.$hasSpotlit ? FACE * 2 : FACE) + 32}px;
    flex: 0 0 auto;
    border-left: 1px solid var(--kc-border, rgba(255,255,255,0.1));
    background: var(--kc-surface, rgba(0,0,0,0.15));
  `
      : `
    /* Bottom dock (row): full-width horizontal strip. */
    flex: 0 0 auto;
    border-top: 1px solid var(--kc-border, rgba(255,255,255,0.1));
    background: var(--kc-surface, rgba(0,0,0,0.15));
  `}
`;

const Bar = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.3rem 0.6rem;
  flex: 0 0 auto;
`;

const BarTitle = styled.span`
  font-size: 0.68rem;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--kc-text-muted, rgba(255,255,255,0.6));
`;

const BarControls = styled.div`
  display: flex;
  align-items: center;
  gap: 0.3rem;
`;

const AddCrew = styled.details`
  position: relative;
`;

const AddCrewSummary = styled.summary`
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.15rem 0.4rem;
  font-size: 0.68rem;
  border-radius: 3px;
  cursor: pointer;
  list-style: none;
  color: var(--kc-text-muted, rgba(255,255,255,0.6));

  &::-webkit-details-marker {
    display: none;
  }
  &:hover {
    color: var(--kc-text, #fff);
    background: rgba(255, 255, 255, 0.08);
  }
  &:focus-visible {
    outline: 2px solid var(--kc-accent, #6ab0ff);
    outline-offset: 2px;
  }
`;

const AddCrewMenu = styled.div`
  position: absolute;
  top: 100%;
  right: 0;
  z-index: 20;
  margin-top: 4px;
  min-width: 160px;
  display: flex;
  flex-direction: column;
  padding: 4px;
  border-radius: 6px;
  background: var(--kc-surface-raised, #222);
  border: 1px solid var(--kc-border, rgba(255,255,255,0.12));
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.24);
`;

const AddCrewItem = styled.button`
  text-align: left;
  padding: 0.3rem 0.5rem;
  font-size: 0.75rem;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--kc-text, #fff);
  cursor: pointer;

  &:hover {
    background: rgba(255, 255, 255, 0.1);
  }
  &:focus-visible {
    outline: 2px solid var(--kc-accent, #6ab0ff);
    outline-offset: -2px;
  }
`;

const MinButton = styled.button`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 3px;
  cursor: pointer;
  background: transparent;
  color: var(--kc-text-muted, rgba(255,255,255,0.6));

  &:hover {
    color: var(--kc-text, #fff);
    background: rgba(255, 255, 255, 0.08);
  }
  &:focus-visible {
    outline: 2px solid var(--kc-accent, #6ab0ff);
    outline-offset: 2px;
  }
`;

const Faces = styled.div<{ $placement: CrewBarPlacement; $spotlit: boolean; $minimised: boolean }>`
  display: grid;
  gap: 0.6rem;
  padding: 0.6rem;
  grid-auto-rows: ${FACE}px;
  grid-auto-columns: ${FACE}px;
  /* When a face is spotlit the dock is 2 tracks deep (the spotlit face spans a
     real 2x2), so the 1x1 faces pack 2-up to fill the second track via dense
     flow instead of sitting single-file beside a half-empty band. No spotlight:
     a single track of squares. */
  ${(p) =>
    p.$placement === "column"
      ? p.$spotlit
        ? `grid-template-columns: repeat(2, ${FACE}px); grid-auto-flow: row dense;
           justify-content: center; overflow-y: auto;`
        : `grid-template-columns: ${FACE}px; grid-auto-flow: row;
           justify-content: center; overflow-y: auto;`
      : p.$spotlit
        ? `grid-template-rows: repeat(2, ${FACE}px); grid-auto-flow: column dense;
           align-content: start; overflow-x: auto;`
        : `grid-template-rows: ${FACE}px; grid-auto-flow: column;
           align-content: start; overflow-x: auto;`}

  /* Minimise collapses the strip without unmounting the feeds. visibility:hidden
     takes the faces (and their action buttons) out of the tab order + a11y tree,
     so a keyboard user can't focus controls inside the aria-hidden collapsed bar. */
  ${(p) =>
    p.$minimised
      ? `max-height: 0; padding-top: 0; padding-bottom: 0; overflow: hidden; opacity: 0; visibility: hidden; pointer-events: none;`
      : ``}
  transition: max-height 0.18s ease, opacity 0.18s ease;

  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }
`;

const FaceWrap = styled.div<{ $spotlit: boolean }>`
  position: relative;
  /* Fills its grid cell (FACE square). Spotlight spans a real 2x2 of the
     FACE-sized grid on the SAME mounted feed (CSS only, never a remount) and
     floats to the front; the 1x1 faces dense-pack around it (2-up in the second
     track). Stays square. */
  width: 100%;
  height: 100%;
  ${(p) => (p.$spotlit ? "grid-column: span 2; grid-row: span 2;" : "")}
  transition: width 0.18s ease, height 0.18s ease;

  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }

  /* Fullscreen: the face is SQUARE, so letterbox it (black bars) rather than
     stretch to the viewport. Native fullscreen sizes this element to the screen;
     center the inner square feed at min(100vw,100vh) so its aspect is preserved.
     The primitive's video is object-fit:cover of a square frame, so a square
     frame means no crop/stretch. */
  &:fullscreen,
  &:-webkit-full-screen {
    display: flex;
    align-items: center;
    justify-content: center;
    background: #000;
  }
  &:fullscreen [data-testid="kerbal-face-feed"],
  &:-webkit-full-screen [data-testid="kerbal-face-feed"] {
    width: min(100vw, 100vh);
    height: min(100vw, 100vh);
  }

  /* Actions (top-right, from the primitive) hover-reveal: hidden until the face
     is hovered or a control is focused (keyboard reachable). */
  & button {
    opacity: 0;
    transition: opacity 0.12s ease;
  }
  &:hover button,
  &:focus-within button {
    opacity: 1;
  }
  @media (prefers-reduced-motion: reduce) {
    & button {
      transition: none;
    }
  }
`;

const Overlay = styled.div`
  position: absolute;
  inset: 0;
  pointer-events: none;
`;

const Badge = styled.span<{ $eva: boolean }>`
  position: absolute;
  top: 4px;
  left: 4px;
  padding: 1px 5px;
  font-size: 0.6rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  border-radius: 3px;
  color: #fff;
  background: ${(p) => (p.$eva ? "rgba(230,140,30,0.85)" : "rgba(60,120,200,0.85)")};
`;

const Name = styled.span`
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 3px 6px;
  font-size: 0.68rem;
  font-weight: 600;
  color: #fff;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.7), transparent);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const Lost = styled.span`
  position: absolute;
  top: 50%;
  left: 0;
  right: 0;
  transform: translateY(-50%);
  text-align: center;
  font-size: 0.62rem;
  font-weight: 700;
  letter-spacing: 0.14em;
  color: #ff6b6b;
`;
