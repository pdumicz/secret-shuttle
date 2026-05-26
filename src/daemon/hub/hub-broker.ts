// src/daemon/hub/hub-broker.ts
import { randomUUID, timingSafeEqual } from "node:crypto";

export const SPAWN_TIMEOUT_MS = 5000;

export type HubEvent =
  | { type: "navigate"; url: string; seq: number }
  | { type: "displaced" };

/**
 * Payload for the C11 bootstrap-capture SSE event. C14 will turn this into a
 * real wire format + UI card; for C11 the executor just calls
 * `emitBootstrapCaptureStep(payload)` and the broker records it (no SSE wire
 * yet). The capture_token is the only piece the UI cannot derive itself — it
 * has to come over the SSE channel because the executor mints it just before
 * register-then-emit-then-await.
 */
export interface BootstrapCaptureStepEvent {
  batch_id: string;
  secret_name: string;
  url: string;
  step_idx: number;
  step_total: number;
  capture_token: string;
}

export interface HubSubscriber {
  write(e: HubEvent): void;
  close(): void;
}

export interface HubBrokerOptions {
  /** REQUIRED — caller must provide an opener. Production passes the real
   * `openUrl` from src/daemon/approvals/open-url.ts; tests pass a spy.
   * No default — a forgotten injection would silently never open the hub. */
  openUrlImpl: (url: string) => void;
  now?: () => number;
}

/**
 * Append (or replace) `hub_seq` on an operation URL. Preserves all other
 * query params (id, token). Used by the broker to mark each navigate with
 * the activeSeq the hub will echo back via /ui/hub/done.
 */
export function withHubSeq(raw: string, seq: number): string {
  const u = new URL(raw);
  u.searchParams.set("hub_seq", String(seq));
  return u.toString();
}

/**
 * Daemon-owned FIFO queue + active-operation slot for the persistent hub
 * tab. Pure state machine; all I/O happens via the injected openUrlImpl.
 *
 * Invariants:
 *   - activeUrl is the operation currently in the iframe.
 *   - queue holds operations waiting their turn.
 *   - subscriber is the SSE connection (null when no hub is attached).
 *   - spawnInFlightSince debounces concurrent surfaces from re-spawning
 *     the browser; cleared on attach.
 *
 * See docs/superpowers/specs/2026-05-23-plan4b-tab-reuse-design.md
 * Component 1 for the full contract.
 */
export class HubBroker {
  private readonly tokenValue: string = randomUUID();
  private readonly openUrlImpl: (url: string) => void;
  private readonly nowFn: () => number;

  private queue: string[] = [];
  private activeUrl: string | null = null;
  private activeSeq: number | null = null;
  private nextSeq = 1;
  private currentSubscriber: HubSubscriber | null = null;
  private spawnInFlightSince: number | null = null;

  constructor(opts: HubBrokerOptions) {
    this.openUrlImpl = opts.openUrlImpl;
    this.nowFn = opts.now ?? (() => Date.now());
  }

  /** Daemon-lifetime auth token for /ui/hub*. Never written to disk. */
  hubToken(): string {
    return this.tokenValue;
  }

  /** Constant-time token compare for routes. */
  tokenMatches(supplied: string): boolean {
    const expected = Buffer.from(this.tokenValue);
    const actual = Buffer.from(supplied);
    if (actual.byteLength !== expected.byteLength) return false;
    return timingSafeEqual(actual, expected);
  }

  /** Absolute URL the platform openUrl call points at. */
  hubUrl(port: number): string {
    return `http://127.0.0.1:${port}/ui/hub?token=${encodeURIComponent(this.tokenValue)}`;
  }

  /**
   * Push a new operation URL into the hub flow.
   *   - Attached + idle: set active, write navigate.
   *   - Attached + busy: enqueue.
   *   - Detached: enqueue; spawn hub iff !isSpawnInFlight().
   */
  surface(operationUrl: string, port: number): void {
    if (this.currentSubscriber !== null && this.activeUrl === null) {
      this.activeUrl = operationUrl;
      this.activeSeq = this.nextSeq++;
      this.currentSubscriber.write({
        type: "navigate",
        url: withHubSeq(operationUrl, this.activeSeq),
        seq: this.activeSeq,
      });
      return;
    }
    this.queue.push(operationUrl);
    if (this.currentSubscriber === null && !this.isSpawnInFlight()) {
      this.spawnInFlightSince = this.nowFn();
      this.openUrlImpl(this.hubUrl(port));
    }
  }

  /**
   * Attach a new subscriber. Displaces any prior. Resends the active
   * operation (recovery path) OR promotes the front of the queue.
   * Returns a detach callback that nulls currentSubscriber iff it
   * still equals this subscriber.
   */
  attach(sub: HubSubscriber): () => void {
    if (this.currentSubscriber !== null) {
      this.currentSubscriber.write({ type: "displaced" });
      this.currentSubscriber.close();
    }
    this.currentSubscriber = sub;
    this.spawnInFlightSince = null;
    if (this.activeUrl !== null && this.activeSeq !== null) {
      sub.write({
        type: "navigate",
        url: withHubSeq(this.activeUrl, this.activeSeq),
        seq: this.activeSeq,
      });
    } else if (this.queue.length > 0) {
      const front = this.queue.shift() as string;
      this.activeUrl = front;
      this.activeSeq = this.nextSeq++;
      sub.write({
        type: "navigate",
        url: withHubSeq(front, this.activeSeq),
        seq: this.activeSeq,
      });
    }
    return () => {
      if (this.currentSubscriber === sub) {
        this.currentSubscriber = null;
      }
    };
  }

  /**
   * Mark the current active operation done. If seq matches, clear active
   * and promote the next queued URL. Otherwise no-op (idempotent: stale
   * or duplicate done events ignored).
   */
  markDone(seq: number): void {
    if (this.activeSeq !== seq) return;
    this.activeUrl = null;
    this.activeSeq = null;
    if (this.queue.length > 0 && this.currentSubscriber !== null) {
      const front = this.queue.shift() as string;
      this.activeUrl = front;
      this.activeSeq = this.nextSeq++;
      this.currentSubscriber.write({
        type: "navigate",
        url: withHubSeq(front, this.activeSeq),
        seq: this.activeSeq,
      });
    }
  }

  /** @internal — exposed only for tests. */
  peekState(): {
    queueLength: number;
    activeUrl: string | null;
    activeSeq: number | null;
    isAttached: boolean;
    spawnInFlight: boolean;
  } {
    return {
      queueLength: this.queue.length,
      activeUrl: this.activeUrl,
      activeSeq: this.activeSeq,
      isAttached: this.currentSubscriber !== null,
      spawnInFlight: this.isSpawnInFlight(),
    };
  }

  /**
   * C11 stub. The executor calls this synchronously right after registering a
   * pending capture so the UI can pick up the capture_token via SSE. C14 will
   * wire the actual SSE channel + render a coordinator card; for C11 the
   * payload is just recorded into `lastBootstrapCaptureStep` so tests can
   * assert ordering ("emit happened after register, before await"). Production
   * callers that race a real human-driven UI will see this become a no-op
   * until C14 lands — the executor's contract (register → emit → await) does
   * not change.
   */
  emitBootstrapCaptureStep(event: BootstrapCaptureStepEvent): void {
    this.lastBootstrapCaptureStep = event;
  }

  /**
   * @internal — exposed only for tests + the C14 transition. Holds the last
   * BootstrapCaptureStepEvent recorded by `emitBootstrapCaptureStep`. Lets
   * C11 tests assert that emit() fired with the right payload between
   * register and await.
   */
  lastBootstrapCaptureStep: BootstrapCaptureStepEvent | null = null;

  private isSpawnInFlight(): boolean {
    if (this.spawnInFlightSince === null) return false;
    return this.nowFn() - this.spawnInFlightSince < SPAWN_TIMEOUT_MS;
  }
}
