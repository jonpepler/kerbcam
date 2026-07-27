/**
 * Tests for the REC+ and Recordings buttons added to the Header toolbar.
 * Header is a plain prop-driven component for these controls (it doesn't
 * call `useRecordings` itself -- App/RecGroupBar own the recording state),
 * so it renders standalone here without a KerbcastProvider.
 */

import type { KerbcastClient } from "@ksp-gonogo/kerbcast";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Header } from "./Header";
import type { ManagerStatus } from "./connectionManager";

function renderHeader(overrides: Partial<Parameters<typeof Header>[0]> = {}) {
  const status: ManagerStatus = { kind: "idle" };
  const client = { on: () => () => {} } as unknown as KerbcastClient;

  return render(
    <Header
      status={status}
      client={client}
      onOpenSettings={() => {}}
      recordingsOpen={false}
      onToggleRecordings={() => {}}
      recSelectMode={false}
      onToggleRecSelectMode={() => {}}
      recordingGroupActive={false}
      {...overrides}
    />,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Header - REC+ and Recordings buttons", () => {
  it("renders a REC+ toggle and a Recordings toggle", () => {
    renderHeader();
    expect(screen.getByRole("button", { name: /rec\+/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /recordings/i })).toBeTruthy();
  });

  it("clicking REC+ calls onToggleRecSelectMode", () => {
    const onToggleRecSelectMode = vi.fn();
    renderHeader({ onToggleRecSelectMode });
    fireEvent.click(screen.getByRole("button", { name: /rec\+/i }));
    expect(onToggleRecSelectMode).toHaveBeenCalledTimes(1);
  });

  it("REC+ is disabled while a grouped recording is in progress", () => {
    renderHeader({ recordingGroupActive: true });
    const btn = screen.getByRole("button", { name: /rec\+/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("REC+ reflects recSelectMode as pressed", () => {
    renderHeader({ recSelectMode: true });
    const btn = screen.getByRole("button", { name: /rec\+/i });
    expect(btn.getAttribute("aria-pressed")).toBe("true");
  });

  it("clicking Recordings calls onToggleRecordings", () => {
    const onToggleRecordings = vi.fn();
    renderHeader({ onToggleRecordings });
    fireEvent.click(screen.getByRole("button", { name: /recordings/i }));
    expect(onToggleRecordings).toHaveBeenCalledTimes(1);
  });
});
