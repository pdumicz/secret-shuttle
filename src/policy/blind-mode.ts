import { ensureShuttleHome, getShuttlePaths, readJsonFile, writeJsonFileAtomic, fileExists } from "../shared/config.js";
import { ShuttleError } from "../shared/errors.js";
import { normalizeDomain } from "./domain-policy.js";

export interface BlindModeState {
  active: boolean;
  domain: string;
  reason: string;
  started_at: string;
  screenshots: "must_not_be_used_by_agent";
  dom_observation: "must_not_be_used_by_agent";
  clipboard: "must_not_be_used_by_agent";
}

export interface ShuttleStateFile {
  version: 1;
  blind_mode: BlindModeState | null;
}

export async function startBlindMode(input: { domain: string; reason: string }): Promise<BlindModeState> {
  const state: BlindModeState = {
    active: true,
    domain: normalizeDomain(input.domain),
    reason: input.reason,
    started_at: new Date().toISOString(),
    screenshots: "must_not_be_used_by_agent",
    dom_observation: "must_not_be_used_by_agent",
    clipboard: "must_not_be_used_by_agent",
  };
  await writeState({
    version: 1,
    blind_mode: state,
  });
  return state;
}

export async function endBlindMode(): Promise<{ blind_mode: false; ended_at: string }> {
  await writeState({
    version: 1,
    blind_mode: null,
  });
  return {
    blind_mode: false,
    ended_at: new Date().toISOString(),
  };
}

export async function getBlindMode(): Promise<BlindModeState | null> {
  const state = await readState();
  return state.blind_mode;
}

export async function assertBlindModeForDomain(domain: string): Promise<void> {
  const state = await getBlindMode();
  if (state === null || !state.active) {
    throw new ShuttleError(
      "blind_mode_required",
      "Capture requires blind mode. Run `secret-shuttle blind start --domain <domain> --reason <reason>` after stopping browser observation.",
    );
  }

  const current = normalizeDomain(domain);
  if (state.domain !== current && !current.endsWith(`.${state.domain}`)) {
    throw new ShuttleError(
      "blind_mode_domain_mismatch",
      `Blind mode is active for ${state.domain}, but the browser is on ${current}.`,
    );
  }
}

async function readState(): Promise<ShuttleStateFile> {
  const paths = getShuttlePaths();
  if (!(await fileExists(paths.statePath))) {
    return {
      version: 1,
      blind_mode: null,
    };
  }
  return readJsonFile<ShuttleStateFile>(paths.statePath);
}

async function writeState(state: ShuttleStateFile): Promise<void> {
  const paths = getShuttlePaths();
  await ensureShuttleHome(paths);
  await writeJsonFileAtomic(paths.statePath, state);
}
