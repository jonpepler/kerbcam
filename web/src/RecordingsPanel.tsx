/*
 * RecordingsPanel: a header-toggled drawer wrapping the shared
 * `RecordingsTray` (kerbcast-react) with this page's own camera labels.
 * Follows SettingsPanel's own dialog/positioning/close conventions so the two
 * drawers read as one family of chrome.
 */

import { useCallback, useEffect, useRef } from "react";
import { buildCameraLabeler, RecordingsTray, useKerbcastCameras } from "@ksp-gonogo/kerbcast-react";
import { X } from "lucide-react";
import styled from "styled-components";

export interface RecordingsPanelProps {
  onClose: () => void;
}

export function RecordingsPanel({ onClose }: RecordingsPanelProps): React.JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape, same behaviour as SettingsPanel.
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const handlePointer = (e: PointerEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("keydown", handleKey);
    document.addEventListener("pointerdown", handlePointer);
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.removeEventListener("pointerdown", handlePointer);
    };
  }, [onClose]);

  const cameras = useKerbcastCameras();
  const cameraLabel = useCallback(
    (flightId: number): string => {
      const cam = cameras.find((c) => c.flightId === flightId);
      return cam ? buildCameraLabeler(cameras)(cam) : `Camera ${flightId}`;
    },
    [cameras],
  );

  return (
    <Panel ref={panelRef} role="dialog" aria-label="Recordings">
      <PanelHeader>
        <PanelTitle>Recordings</PanelTitle>
        <CloseIconButton type="button" onClick={onClose} aria-label="Close">
          <X size={14} strokeWidth={1.75} aria-hidden="true" />
        </CloseIconButton>
      </PanelHeader>
      <Tray cameraLabel={cameraLabel} />
    </Panel>
  );
}

const Panel = styled.div`
  position: absolute;
  top: calc(var(--kc-header-h) + 0.5rem);
  right: 1rem;
  z-index: 100;
  background: var(--kc-surface);
  border: 1px solid var(--kc-border);
  border-radius: 8px;
  overflow: hidden;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18), 0 2px 6px rgba(0, 0, 0, 0.12);
`;

const PanelHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.65rem 0.85rem 0.6rem;
  border-bottom: 1px solid var(--kc-border);
  background: var(--kc-surface-raised);
`;

const PanelTitle = styled.h2`
  margin: 0;
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--kc-text-muted);
`;

const CloseIconButton = styled.button`
  background: none;
  border: none;
  cursor: pointer;
  color: var(--kc-text-muted);
  padding: 0.1rem;
  line-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 3px;
  transition: color 0.12s ease;

  &:hover {
    color: var(--kc-text);
  }

  &:focus-visible {
    outline: 2px solid var(--kc-accent);
    outline-offset: 2px;
  }
`;

/* RecordingsTray already brings its own scroll/max-height/background chrome;
   just strip its own border radius corners so it sits flush under the panel
   header. */
const Tray = styled(RecordingsTray)`
  border: none;
  border-radius: 0;
  min-width: 300px;
`;
