import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export interface BootstrapSource {
  kind: "capture" | "random_32_bytes" | "random_64_bytes" | "existing";
  url?: string;       // for capture
  ref?: string;       // for existing
}

export interface ResolvedDestination {
  shorthand: string;
  template_id: string;
  template_params: Record<string, string>;
  domain: string;
}

export interface PlanEntry {
  secret: string;       // env var name
  ref: string;          // ss://source/env/name
  source: BootstrapSource;
  destinations: ResolvedDestination[];
  /**
   * Set when the user passed --force AND the ref exists in the vault at
   * plan time. Propagates to generateSecretCore so upsertSecret will
   * overwrite the existing entry instead of throwing secret_exists.
   * Always false for source: existing (no generation step runs).
   */
  force?: boolean;
}

export interface StepResult {
  ok: boolean;
  ref?: string;
  destinations_pushed?: Array<{ destination: string; ok: boolean; error_code?: string; message?: string }>;
  error_code?: string;
  message?: string;
}

export interface BatchState {
  batch_id: string;
  approval_id: string;
  plan_file_path: string;
  plan: PlanEntry[];
  step_results: Record<string, StepResult>; // keyed by secret name
  created_at: number;
  status: "pending" | "in_progress" | "completed" | "failed_partial";
  /**
   * Agent id that created this batch. Stamped at /plan time from the ALS
   * AuthContext (or "daemon" defensively). Persisted on disk and used by
   * owner-enforcement checks to ensure only the originating agent can
   * /continue or /abandon the batch.
   */
  owner_agent_id: string;
}

export interface BootstrapStoreOpts {
  rootDir: string; // typically `${SHUTTLE_HOME}/bootstrap-batches`
}

export class BootstrapStore {
  private readonly rootDir: string;
  private readonly cache = new Map<string, BatchState>();

  constructor(opts: BootstrapStoreOpts) {
    this.rootDir = opts.rootDir;
  }

  async save(state: BatchState): Promise<void> {
    this.cache.set(state.batch_id, state);
    await mkdir(this.rootDir, { recursive: true });
    const filePath = path.join(this.rootDir, `${state.batch_id}.json`);
    await writeFile(filePath, JSON.stringify(state, null, 2), { mode: 0o600 });
  }

  async get(batchId: string): Promise<BatchState | null> {
    const cached = this.cache.get(batchId);
    if (cached !== undefined) return cached;
    const filePath = path.join(this.rootDir, `${batchId}.json`);
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as BatchState;
      this.cache.set(batchId, parsed);
      return parsed;
    } catch {
      return null;
    }
  }

  async list(): Promise<BatchState[]> {
    try {
      const entries = await readdir(this.rootDir);
      const states: BatchState[] = [];
      for (const e of entries) {
        if (!e.endsWith(".json")) continue;
        const id = e.slice(0, -5);
        const s = await this.get(id);
        if (s !== null) states.push(s);
      }
      return states;
    } catch {
      return [];
    }
  }

  async delete(batchId: string): Promise<void> {
    this.cache.delete(batchId);
    try {
      await unlink(path.join(this.rootDir, `${batchId}.json`));
    } catch {
      // not found is fine
    }
  }

  /** Remove batches whose created_at is older than thresholdMs ago. */
  async pruneOlderThan(thresholdMs: number): Promise<void> {
    const deadline = Date.now() - thresholdMs;
    const all = await this.list();
    for (const s of all) {
      if (s.created_at < deadline) {
        await this.delete(s.batch_id);
      }
    }
  }

  private readonly inFlightExecutions = new Set<string>();

  /**
   * Attempts to acquire the in-memory execution lock for `batchId`. Returns
   * true on success (caller must release in finally), false if another
   * execution is currently in flight for this batch.
   *
   * The lock is in-memory only — daemon restart clears it. Combined with the
   * disk-persisted status field, this preserves crash-recovery: if a daemon
   * crashes mid-execution, the new daemon process starts with an empty lock
   * set and a fresh /continue can resume the in_progress batch.
   */
  tryAcquireExecutionLock(batchId: string): boolean {
    if (this.inFlightExecutions.has(batchId)) return false;
    this.inFlightExecutions.add(batchId);
    return true;
  }

  releaseExecutionLock(batchId: string): void {
    this.inFlightExecutions.delete(batchId);
  }
}
