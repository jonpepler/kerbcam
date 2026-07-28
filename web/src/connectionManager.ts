/**
 * Connection manager for the kerbcast web page.
 *
 * Wraps a KerbcastClient and adds:
 *  - auto-connect on start()
 *  - exponential backoff reconnect on failure (2s base, 2x each attempt, 30s max)
 *  - ping watchdog: no ping for 15s while connected triggers reconnect
 *  - status subscription for React (useSyncExternalStore-compatible)
 *
 * Does NOT read location or construct the client -- callers inject the client
 * so tests can substitute a mock-backed one.
 */

import type { KerbcastClient, KerbcastConnectionState } from "@ksp-gonogo/kerbcast";

const BACKOFF_BASE_MS = 2000;
const BACKOFF_MAX_MS = 30000;
const PING_WATCHDOG_MS = 15000;
const CONNECT_SLOTS = 8;

export type ManagerStatus =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "connected" }
  | { kind: "reconnecting"; delayMs: number; attempt: number }
  | { kind: "disconnected" };

type Listener = () => void;

export class ConnectionManager {
  private readonly _client: KerbcastClient;
  private _status: ManagerStatus = { kind: "idle" };
  private _attempt = 0;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _pingTimer: ReturnType<typeof setTimeout> | null = null;
  private _stopped = false;
  private readonly _listeners = new Set<Listener>();
  private _offStateChange: (() => void) | null = null;
  private _offPing: (() => void) | null = null;

  constructor(client: KerbcastClient) {
    this._client = client;
  }

  /** Subscribe to status changes. Returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  getStatus(): ManagerStatus {
    return this._status;
  }

  /**
   * Begin auto-connecting. Safe to call again after stop(): React StrictMode
   * runs the mount effect twice (start, stop, start), so a permanent stop
   * would leave the second mount dead.
   */
  start(): void {
    this._stopped = false;
    this._offStateChange = this._client.on("state-change", (state) => {
      this._handleStateChange(state);
    });
    this._offPing = this._client.on("ping", () => {
      this._resetPingTimer();
    });
    void this._connect();
  }

  /** Tear down cleanly (app unmount). Does not reconnect. */
  stop(): void {
    this._stopped = true;
    this._clearReconnect();
    this._clearPingTimer();
    this._offStateChange?.();
    this._offPing?.();
    this._offStateChange = null;
    this._offPing = null;
    try {
      this._client.disconnect();
    } catch {
      // ignore
    }
  }

  private async _connect(): Promise<void> {
    if (this._stopped) return;
    this._setStatus({ kind: "connecting" });
    try {
      await this._discover();
      await this._client.connect([], { slots: CONNECT_SLOTS });
    } catch {
      this._scheduleReconnect();
    }
  }

  /**
   * Best-effort camera discovery (`GET /cameras`) ahead of the peer connect,
   * so `KerbcastCameraHandle.maxRenderSize` is populated for every feed
   * before subscriptions start. Without this, a force-full-resolution arm
   * on a feed already at its render ceiling has no known target to check
   * against (see `RecordingController.watchResolutionReady`) and falls back
   * to the weaker "operator size increased" heuristic, which never fires for
   * a feed that was already at its ceiling -- burning the full
   * `ARM_TIMEOUT_MS` before recording starts and losing the clip's opening
   * seconds.
   *
   * Failure here must never block the actual connect: discovery is a
   * nice-to-have (it only sharpens the arm-and-wait check), not a
   * precondition for streaming.
   */
  private async _discover(): Promise<void> {
    try {
      await this._client.discover();
    } catch {
      // best-effort; connect() proceeds regardless.
    }
  }

  private _handleStateChange(state: KerbcastConnectionState): void {
    if (this._stopped) return;
    switch (state) {
      case "connected":
        this._attempt = 0;
        this._clearReconnect();
        this._resetPingTimer();
        this._setStatus({ kind: "connected" });
        break;
      case "connecting":
        this._setStatus({ kind: "connecting" });
        break;
      case "failed":
      case "disconnected":
        this._clearPingTimer();
        this._setStatus({ kind: "disconnected" });
        this._scheduleReconnect();
        break;
    }
  }

  private _scheduleReconnect(): void {
    if (this._stopped) return;
    if (this._reconnectTimer !== null) return;
    const delayMs = Math.min(
      BACKOFF_BASE_MS * Math.pow(2, this._attempt),
      BACKOFF_MAX_MS,
    );
    this._attempt += 1;
    this._setStatus({ kind: "reconnecting", delayMs, attempt: this._attempt });
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (!this._stopped) void this._connect();
    }, delayMs);
  }

  private _clearReconnect(): void {
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  private _resetPingTimer(): void {
    this._clearPingTimer();
    if (this._stopped) return;
    this._pingTimer = setTimeout(() => {
      this._pingTimer = null;
      if (this._stopped) return;
      // Watchdog fired: force disconnect and schedule reconnect
      try {
        this._client.disconnect();
      } catch {
        // ignore
      }
      this._setStatus({ kind: "disconnected" });
      this._scheduleReconnect();
    }, PING_WATCHDOG_MS);
  }

  private _clearPingTimer(): void {
    if (this._pingTimer !== null) {
      clearTimeout(this._pingTimer);
      this._pingTimer = null;
    }
  }

  private _setStatus(status: ManagerStatus): void {
    this._status = status;
    this._notify();
  }

  private _notify(): void {
    this._listeners.forEach((l) => l());
  }
}
