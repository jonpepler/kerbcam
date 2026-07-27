import type { KerbcastClient } from "@ksp-gonogo/kerbcast";
import { CircleDot, Clapperboard, Settings } from "lucide-react";
import { useEffect, useState } from "react";
import styled from "styled-components";
import type { ManagerStatus } from "./connectionManager";

interface HeaderProps {
  status: ManagerStatus;
  client: KerbcastClient;
  onOpenSettings: () => void;
  /** Whether the recordings tray drawer is open. */
  recordingsOpen: boolean;
  onToggleRecordings: () => void;
  /** REC+ grouped-recording selection mode is on. */
  recSelectMode: boolean;
  onToggleRecSelectMode: () => void;
  /** A grouped recording is currently running; REC+ is unavailable to start
   *  a second one while it is (keep the fixed-set rule simple at the toolbar
   *  level too). */
  recordingGroupActive: boolean;
}

export function Header({
  status,
  client,
  onOpenSettings,
  recordingsOpen,
  onToggleRecordings,
  recSelectMode,
  onToggleRecSelectMode,
  recordingGroupActive,
}: HeaderProps): React.JSX.Element {
  const [sidecarVersion, setSidecarVersion] = useState<string | null>(null);
  const [encoderBackend, setEncoderBackend] = useState<string | null>(null);

  useEffect(() => {
    // cameras-change fires after hello + snapshot, so sidecarVersion and
    // encoderBackend are already populated on the client by this point.
    const offCamerasChange = client.on("cameras-change", () => {
      setSidecarVersion(client.sidecarVersion);
      setEncoderBackend(client.encoderBackend);
    });
    // Clear on disconnect so stale info doesn't linger across reconnects.
    const offStateChange = client.on("state-change", (s) => {
      if (s !== "connected") {
        setSidecarVersion(null);
        setEncoderBackend(null);
      }
    });
    return () => {
      offCamerasChange();
      offStateChange();
    };
  }, [client]);

  const statusText = formatStatus(status);
  const statusColor = getStatusColor(status);
  const isPulse = status.kind === "connecting" || status.kind === "reconnecting";

  return (
    <Root>
      <Wordmark>kerbcast</Wordmark>
      <Divider />
      <StatusArea>
        <StatusDot $color={statusColor} $pulse={isPulse} />
        <StatusLabel>{statusText}</StatusLabel>
        {sidecarVersion && (
          <Meta>
            {sidecarVersion}
            {encoderBackend ? ` / ${encoderBackend}` : ""}
          </Meta>
        )}
      </StatusArea>
      <Actions>
        <ToolbarButton
          type="button"
          aria-label="REC+"
          title="Select feeds to record together"
          aria-pressed={recSelectMode}
          $active={recSelectMode}
          disabled={recordingGroupActive}
          onClick={onToggleRecSelectMode}
        >
          <CircleDot size={16} strokeWidth={1.75} aria-hidden="true" />
          REC+
        </ToolbarButton>
        <GearButton
          type="button"
          aria-label="Recordings"
          title="Recordings"
          aria-pressed={recordingsOpen}
          onClick={onToggleRecordings}
        >
          <Clapperboard size={16} strokeWidth={1.75} aria-hidden="true" />
        </GearButton>
        <GearButton
          type="button"
          aria-label="Settings"
          onClick={onOpenSettings}
        >
          <Settings size={16} strokeWidth={1.75} aria-hidden="true" />
        </GearButton>
      </Actions>
    </Root>
  );
}

function formatStatus(status: ManagerStatus): string {
  switch (status.kind) {
    case "idle":
      return "idle";
    case "connecting":
      return "connecting";
    case "connected":
      return "connected";
    case "reconnecting":
      return `reconnecting in ${Math.round(status.delayMs / 1000)}s`;
    case "disconnected":
      return "disconnected";
  }
}

function getStatusColor(status: ManagerStatus): string {
  switch (status.kind) {
    case "connected":
      return "var(--kc-ok)";
    case "reconnecting":
    case "connecting":
      return "var(--kc-warn)";
    case "disconnected":
    case "idle":
      return "var(--kc-text-muted)";
  }
}

// ---------------------------------------------------------------------------
// Styled components
// ---------------------------------------------------------------------------

const Root = styled.header`
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0 1rem;
  height: var(--kc-header-h);
  background: var(--kc-surface);
  border-bottom: 1px solid var(--kc-border);
  flex-shrink: 0;
`;

const Wordmark = styled.h1`
  margin: 0;
  font-size: 0.85rem;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: lowercase;
  color: var(--kc-text);
  font-family: inherit;
`;

const Divider = styled.span`
  width: 1px;
  height: 18px;
  background: var(--kc-border);
  flex-shrink: 0;
`;

const StatusArea = styled.div`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex: 1;
  min-width: 0;
`;

interface DotProps {
  $color: string;
  $pulse: boolean;
}

const StatusDot = styled.span<DotProps>`
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: ${(p) => p.$color};
  flex-shrink: 0;
  transition: background 0.2s ease;

  ${(p) =>
    p.$pulse &&
    `
    animation: kc-pulse 1.4s ease-in-out infinite;
    @media (prefers-reduced-motion: reduce) {
      animation: none;
    }
  `}

  @keyframes kc-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
  }
`;

const StatusLabel = styled.span`
  font-size: 0.75rem;
  letter-spacing: 0.02em;
  color: var(--kc-text-muted);
`;

const Meta = styled.span`
  font-size: 0.7rem;
  color: var(--kc-text-muted);
  opacity: 0.7;
  font-family: inherit;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const Actions = styled.div`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-left: auto;
`;

const GearButton = styled.button`
  background: none;
  border: 1px solid transparent;
  border-radius: 4px;
  padding: 0.3rem;
  cursor: pointer;
  color: var(--kc-text-muted);
  line-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color 0.15s ease, border-color 0.15s ease, background 0.15s ease;

  &:hover {
    color: var(--kc-text);
    border-color: var(--kc-border);
    background: var(--kc-surface-raised);
  }

  &:focus-visible {
    outline: 2px solid var(--kc-accent);
    outline-offset: 2px;
  }
`;

/* REC+ toolbar toggle: GearButton's icon-button chrome plus a text label and
   an active (selecting) state. */
const ToolbarButton = styled(GearButton)<{ $active: boolean }>`
  width: auto;
  gap: 0.3rem;
  padding: 0.3rem 0.5rem;
  font-size: 0.7rem;
  letter-spacing: 0.04em;

  ${(p) =>
    p.$active &&
    `
    color: var(--kc-accent);
    border-color: var(--kc-accent);
    background: var(--kc-accent-wash);
  `}

  &:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
`;
