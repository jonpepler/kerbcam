/*
 * REC+ grouped-recording toolbar: the selection -> start -> stop flow for
 * recording several feeds of one moment together (see the recording UX
 * design doc's "REC+ grouped recording" section).
 *
 * Controlled by the parent (App): `active` is REC+ selection mode, `groupId`
 * is the in-progress grouped recording once started. This component owns
 * only the store calls (startGroup/stopGroup) and its own elapsed timer;
 * every other bit of state (which tiles are selected, whether a group is
 * currently recording) lives in App so Grid/Tile and Header can read it too.
 */

import { formatElapsed, nowMs, useRecordings } from "@ksp-gonogo/kerbcast-react";
import { useEffect, useReducer } from "react";
import styled from "styled-components";

export interface RecGroupBarProps {
  /** REC+ selection mode is on (picking feeds, nothing recording yet). */
  active: boolean;
  selectedFlightIds: ReadonlySet<number>;
  /** The in-progress grouped recording's id, or null when none is running. */
  groupId: string | null;
  onCancel: () => void;
  onStarted: (groupId: string) => void;
  onStopped: () => void;
}

export function RecGroupBar({
  active,
  selectedFlightIds,
  groupId,
  onCancel,
  onStarted,
  onStopped,
}: RecGroupBarProps): React.JSX.Element | null {
  const recordings = useRecordings();

  const members = groupId
    ? recordings.active.filter((a) => a.groupId === groupId)
    : [];
  const startedAt = members.length > 0 ? Math.min(...members.map((m) => m.startedAt)) : null;

  // Ticks once a second while a grouped recording is running, so the shared
  // elapsed timer stays live (mirrors CameraFeed's own per-feed REC timer).
  const [, tick] = useReducer((c: number) => c + 1, 0);
  useEffect(() => {
    if (groupId === null) return;
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [groupId]);

  if (groupId !== null) {
    const elapsedMs = startedAt !== null ? nowMs() - startedAt : 0;
    return (
      <Bar role="status" aria-label="Grouped recording in progress">
        <Dot aria-hidden="true" />
        <Label>
          Recording {members.length} feed{members.length === 1 ? "" : "s"} &middot;{" "}
          {formatElapsed(elapsedMs)}
        </Label>
        <Spacer />
        <BarButton
          type="button"
          $danger
          onClick={() => {
            void recordings
              .stopGroup(groupId)
              .then(() => onStopped())
              .catch((err: unknown) => {
                /* A stuck "Stop grouped recording" control is worse than a
                   silently-failed stop: clear the bar either way. */
                console.error("kerbcast: grouped recording stop failed", err);
                onStopped();
              });
          }}
        >
          Stop grouped recording
        </BarButton>
      </Bar>
    );
  }

  if (active) {
    const count = selectedFlightIds.size;
    return (
      <Bar role="status" aria-label="Selecting feeds for a grouped recording">
        <Label>
          {count === 0
            ? "Select feeds to record together"
            : `${count} feed${count === 1 ? "" : "s"} selected`}
        </Label>
        <Spacer />
        <BarButton type="button" onClick={onCancel}>
          Cancel
        </BarButton>
        <BarButton
          type="button"
          $primary
          disabled={count === 0}
          onClick={() => {
            const groupId = recordings.startGroup([...selectedFlightIds]);
            onStarted(groupId);
          }}
        >
          Start grouped recording
        </BarButton>
      </Bar>
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Styled
// ---------------------------------------------------------------------------

const Bar = styled.div`
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.45rem 1rem;
  background: var(--kc-surface-raised);
  border-bottom: 1px solid var(--kc-border);
  flex-shrink: 0;
`;

const Dot = styled.span`
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--kerbcast-rec-active, #ff3b30);
  flex-shrink: 0;
  animation: kc-rec-pulse 1.4s ease-in-out infinite;

  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }

  @keyframes kc-rec-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
`;

const Label = styled.span`
  font-size: 0.78rem;
  letter-spacing: 0.01em;
  color: var(--kc-text);
`;

const Spacer = styled.div`
  flex: 1;
`;

const BarButton = styled.button<{ $primary?: boolean; $danger?: boolean }>`
  padding: 0.3rem 0.7rem;
  font-family: inherit;
  font-size: 0.75rem;
  letter-spacing: 0.02em;
  border-radius: 5px;
  cursor: pointer;
  transition: border-color 0.15s ease, color 0.15s ease, background 0.15s ease;

  background: none;
  border: 1px solid
    ${(p) =>
      p.$danger
        ? "var(--kerbcast-rec-active, #ff3b30)"
        : p.$primary
          ? "var(--kc-accent)"
          : "var(--kc-border)"};
  color: ${(p) =>
    p.$danger ? "var(--kerbcast-rec-active, #ff3b30)" : p.$primary ? "var(--kc-accent)" : "var(--kc-text-muted)"};

  &:hover:not(:disabled) {
    background: ${(p) => (p.$danger ? "rgba(255, 59, 48, 0.12)" : "var(--kc-accent-wash)")};
  }

  &:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  &:focus-visible {
    outline: 2px solid var(--kc-accent);
    outline-offset: 2px;
  }
`;
