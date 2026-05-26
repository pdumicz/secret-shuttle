// src/daemon/bootstrap/pending-captures.ts
//
// Token-keyed registry of in-flight bootstrap captures. Each entry is the
// daemon-side Promise that the executor (C11) awaits while the UI tab waits
// for the human to perform a capture; the tokenized raw UI routes (C13) call
// resolveByToken / rejectByToken to settle it.
//
// Why register() is SYNCHRONOUS:
//   The executor must (a) put the entry in the map, (b) emit the SSE event
//   carrying the capture_token, and (c) await the Promise — in that order.
//   If register() were async, the UI could observe the SSE event and POST
//   to /capture-step before the entry exists, racing the Promise into a
//   404. Synchronous register() makes the happens-before relationship
//   trivial: register returns the Promise; SSE goes out; await.
import { ShuttleError } from "../../shared/errors.js";

export interface PendingCaptureEntry {
  resolve: (val: { value: string; field_fingerprint: string }) => void;
  reject: (err: Error) => void;
  capture_token: string;
  batchId: string;
  secretName: string;
  target_id: string;
  expected_host: string;
  owner_agent_id: string;
  started_at: number;
  timer: NodeJS.Timeout;
}

export class PendingCapturesRegistry {
  private readonly byToken = new Map<string, PendingCaptureEntry>();
  private readonly byStep = new Map<string, PendingCaptureEntry>();

  register(opts: {
    batchId: string;
    secretName: string;
    capture_token: string;
    target_id: string;
    expected_host: string;
    owner_agent_id: string;
    timeoutMs: number;
    onTimeout: (err: Error) => void;
  }): Promise<{ value: string; field_fingerprint: string }> {
    const stepKey = `${opts.batchId}:${opts.secretName}`;

    // Re-register: a fresh register() for the same (batch, secret) invalidates
    // any prior pending capture. The prior UI token is closed immediately so
    // a human who left a stale tab open cannot resolve into the new flow.
    const prior = this.byStep.get(stepKey);
    if (prior !== undefined) {
      clearTimeout(prior.timer);
      this.byToken.delete(prior.capture_token);
      this.byStep.delete(stepKey);
      prior.reject(new ShuttleError(
        "bootstrap_capture_aborted",
        `Pending capture for ${stepKey} replaced by a new register call.`,
      ));
    }

    let resolve!: (val: { value: string; field_fingerprint: string }) => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<{ value: string; field_fingerprint: string }>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const timer = setTimeout(() => {
      this.byToken.delete(opts.capture_token);
      this.byStep.delete(stepKey);
      const err = new ShuttleError("bootstrap_capture_timeout", "5 minutes elapsed without a capture.");
      opts.onTimeout(err);
      reject(err);
    }, opts.timeoutMs);
    const entry: PendingCaptureEntry = {
      resolve,
      reject,
      capture_token: opts.capture_token,
      batchId: opts.batchId,
      secretName: opts.secretName,
      target_id: opts.target_id,
      expected_host: opts.expected_host,
      owner_agent_id: opts.owner_agent_id,
      started_at: Date.now(),
      timer,
    };
    this.byToken.set(opts.capture_token, entry);
    this.byStep.set(stepKey, entry);
    return promise;
  }

  lookup(token: string): PendingCaptureEntry | undefined {
    return this.byToken.get(token);
  }

  resolveByToken(token: string, val: { value: string; field_fingerprint: string }): boolean {
    const e = this.byToken.get(token);
    if (e === undefined) return false;
    clearTimeout(e.timer);
    this.byToken.delete(token);
    this.byStep.delete(`${e.batchId}:${e.secretName}`);
    e.resolve(val);
    return true;
  }

  rejectByToken(token: string, err: Error): boolean {
    const e = this.byToken.get(token);
    if (e === undefined) return false;
    clearTimeout(e.timer);
    this.byToken.delete(token);
    this.byStep.delete(`${e.batchId}:${e.secretName}`);
    e.reject(err);
    return true;
  }
}
