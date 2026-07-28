import { describe, expect, it, vi } from "vitest";
import { ConnectionManager } from "./connectionManager";
import type { KerbcastClient } from "@ksp-gonogo/kerbcast";

/**
 * Drain the microtask queue by crossing a real macrotask boundary. Safer
 * than counting `await Promise.resolve()` hops by hand: `_connect()` now
 * chains `discover()` before `connect()` (see connectionManager.ts), and the
 * exact number of microtask ticks that takes depends on how each fake
 * resolves, which is an implementation detail tests shouldn't hardcode.
 * Under `vi.useFakeTimers()`, `setTimeout(0)` still needs a timer advance to
 * fire, so callers there should use `vi.advanceTimersByTimeAsync(0)` instead.
 */
function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Minimal client double: just what ConnectionManager touches. The full
 * MockSidecar path is covered by App.test.tsx; this file pins the manager's
 * own lifecycle, which App tests miss because they render without
 * StrictMode's double-mount.
 */
function fakeClient() {
  const handlers = new Map<string, (data: unknown) => void>();
  const client = {
    connect: vi.fn().mockResolvedValue(undefined),
    discover: vi.fn().mockResolvedValue([]),
    disconnect: vi.fn(),
    on: vi.fn((event: string, h: (data: unknown) => void) => {
      handlers.set(event, h);
      return () => handlers.delete(event);
    }),
  };
  return { client: client as unknown as KerbcastClient, raw: client, handlers };
}

describe("ConnectionManager lifecycle", () => {
  it("start after stop connects again (StrictMode double-mount)", async () => {
    const { client, raw } = fakeClient();
    const mgr = new ConnectionManager(client);

    mgr.start();
    mgr.stop();
    mgr.start();
    await flushAsync();

    expect(raw.connect).toHaveBeenCalledTimes(2);
    expect(mgr.getStatus().kind).toBe("connecting");
  });

  it("stop while started cancels reconnect scheduling", async () => {
    vi.useFakeTimers();
    try {
      const { client, raw, handlers } = fakeClient();
      const mgr = new ConnectionManager(client);
      mgr.start();
      await vi.advanceTimersByTimeAsync(0);

      handlers.get("state-change")?.("failed");
      expect(mgr.getStatus().kind).toBe("reconnecting");
      mgr.stop();

      await vi.advanceTimersByTimeAsync(60_000);
      expect(raw.connect).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("calls discover() before connect() on every connect attempt, so maxRenderSize is populated for real feeds", async () => {
    const { client, raw } = fakeClient();
    const order: string[] = [];
    raw.discover.mockImplementation(async () => {
      order.push("discover");
      return [];
    });
    raw.connect.mockImplementation(async () => {
      order.push("connect");
    });
    const mgr = new ConnectionManager(client);

    mgr.start();
    await flushAsync();

    expect(raw.discover).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["discover", "connect"]);
  });

  it("does not let discover() failure block connect()", async () => {
    const { client, raw } = fakeClient();
    raw.discover.mockRejectedValue(new Error("cameras endpoint unreachable"));
    const mgr = new ConnectionManager(client);

    mgr.start();
    await flushAsync();

    expect(raw.connect).toHaveBeenCalledTimes(1);
    expect(mgr.getStatus().kind).toBe("connecting");
  });
});
