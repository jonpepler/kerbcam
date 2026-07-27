import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import styled from "styled-components";
import type { CrewBarPlacement, ThemePreference } from "./settings";

interface SettingsProps {
  theme: ThemePreference;
  debug: boolean;
  /** Effective (resolved) value of the show-static setting. */
  showStatic: boolean;
  showPerfWarnings: boolean;
  recordFullResolution: boolean;
  crewPlacement: CrewBarPlacement;
  crewMerge: boolean;
  onThemeChange: (t: ThemePreference) => void;
  onDebugChange: (enabled: boolean) => void;
  onShowStaticChange: (enabled: boolean) => void;
  onShowPerfWarningsChange: (enabled: boolean) => void;
  onRecordFullResolutionChange: (enabled: boolean) => void;
  onCrewPlacementChange: (placement: CrewBarPlacement) => void;
  onCrewMergeChange: (merge: boolean) => void;
  onClose: () => void;
}

export function Settings({
  theme,
  debug,
  showStatic,
  showPerfWarnings,
  recordFullResolution,
  crewPlacement,
  crewMerge,
  onThemeChange,
  onDebugChange,
  onShowStaticChange,
  onShowPerfWarningsChange,
  onRecordFullResolutionChange,
  onCrewPlacementChange,
  onCrewMergeChange,
  onClose,
}: SettingsProps): React.JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape
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

  return (
    <Panel ref={panelRef} role="dialog" aria-label="Settings">
      <PanelHeader>
        <PanelTitle>Settings</PanelTitle>
        <CloseIconButton type="button" onClick={onClose} aria-label="Close">
          <X size={14} strokeWidth={1.75} aria-hidden="true" />
        </CloseIconButton>
      </PanelHeader>

      <Sections>
        <SectionLabel>Display</SectionLabel>

        <FieldRow>
          <FieldLabel htmlFor="kc-theme-select">Theme</FieldLabel>
          <NativeSelect
            id="kc-theme-select"
            value={theme}
            onChange={(e) => onThemeChange(e.target.value as ThemePreference)}
          >
            <option value="auto">Auto</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </NativeSelect>
        </FieldRow>

        <FieldRow>
          <div>
            <FieldLabel htmlFor="kc-static-toggle">Show static</FieldLabel>
            <FieldHint>Default follows your system reduced-motion preference</FieldHint>
          </div>
          <input
            id="kc-static-toggle"
            type="checkbox"
            checked={showStatic}
            onChange={(e) => onShowStaticChange(e.target.checked)}
            style={{ accentColor: "var(--kc-accent)", width: "1rem", height: "1rem" }}
          />
        </FieldRow>

        <FieldRow>
          <div>
            <FieldLabel htmlFor="kc-perf-warnings-toggle">Show performance warnings</FieldLabel>
            <FieldHint>Corner overlay when KSP throttles stream quality</FieldHint>
          </div>
          <input
            id="kc-perf-warnings-toggle"
            type="checkbox"
            checked={showPerfWarnings}
            onChange={(e) => onShowPerfWarningsChange(e.target.checked)}
            style={{ accentColor: "var(--kc-accent)", width: "1rem", height: "1rem" }}
          />
        </FieldRow>

        <SectionLabel style={{ marginTop: "0.75rem" }}>Recording</SectionLabel>

        <FieldRow>
          <div>
            <FieldLabel htmlFor="kc-record-full-res-toggle">Record at full resolution</FieldLabel>
            <FieldHint>Recorded clips capture at full resolution regardless of on-screen size</FieldHint>
          </div>
          <input
            id="kc-record-full-res-toggle"
            type="checkbox"
            checked={recordFullResolution}
            onChange={(e) => onRecordFullResolutionChange(e.target.checked)}
            style={{ accentColor: "var(--kc-accent)", width: "1rem", height: "1rem" }}
          />
        </FieldRow>

        <SectionLabel style={{ marginTop: "0.75rem" }}>Crew</SectionLabel>

        <FieldRow>
          <div>
            <FieldLabel htmlFor="kc-crew-merge-toggle">Merge crew into the camera list</FieldLabel>
            <FieldHint>Show crew as ordinary camera tiles instead of a separate crew bar</FieldHint>
          </div>
          <input
            id="kc-crew-merge-toggle"
            type="checkbox"
            checked={crewMerge}
            onChange={(e) => onCrewMergeChange(e.target.checked)}
            style={{ accentColor: "var(--kc-accent)", width: "1rem", height: "1rem" }}
          />
        </FieldRow>

        <FieldRow>
          <FieldLabel htmlFor="kc-crew-placement-select">Crew bar position</FieldLabel>
          <NativeSelect
            id="kc-crew-placement-select"
            value={crewPlacement}
            disabled={crewMerge}
            onChange={(e) => onCrewPlacementChange(e.target.value as CrewBarPlacement)}
          >
            <option value="row">Bottom row</option>
            <option value="column">Side column</option>
          </NativeSelect>
        </FieldRow>

        <SectionLabel style={{ marginTop: "0.75rem" }}>Developer</SectionLabel>

        <FieldRow>
          <FieldLabel htmlFor="kc-debug-toggle">Show debug info</FieldLabel>
          <input
            id="kc-debug-toggle"
            type="checkbox"
            checked={debug}
            onChange={(e) => onDebugChange(e.target.checked)}
            style={{ accentColor: "var(--kc-accent)", width: "1rem", height: "1rem" }}
          />
        </FieldRow>
      </Sections>
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
  min-width: 240px;
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

const Sections = styled.div`
  padding: 0.85rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
`;

const SectionLabel = styled.p`
  margin: 0 0 0.3rem;
  font-size: 0.65rem;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--kc-text-muted);
  opacity: 0.7;
`;

const FieldRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
`;

const FieldLabel = styled.label`
  font-size: 0.8rem;
  color: var(--kc-text);
  cursor: pointer;
`;

const FieldHint = styled.p`
  margin: 0.15rem 0 0;
  font-size: 0.68rem;
  color: var(--kc-text-muted);
  opacity: 0.7;
`;

const NativeSelect = styled.select`
  color: var(--kc-text);
  background: var(--kc-surface-raised);
  border: 1px solid var(--kc-border);
  border-radius: 4px;
  padding: 0.2rem 0.4rem;
  font-size: 0.8rem;
  font-family: inherit;
  accent-color: var(--kc-accent);
  cursor: pointer;

  &:focus-visible {
    outline: 2px solid var(--kc-accent);
    outline-offset: 1px;
  }
`;
