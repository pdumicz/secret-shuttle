// src/daemon/services-blind.ts
import { ShuttleError } from "../shared/errors.js";
import { normalizeDomain } from "../policy/domain-policy.js";

export interface ActiveBlind {
  domain: string;
  reason: string;
  started_at: string;
}

export class DaemonBlindModeState {
  private active: ActiveBlind | null = null;

  start(domain: string, reason: string): ActiveBlind {
    this.active = {
      domain: normalizeDomain(domain),
      reason,
      started_at: new Date().toISOString(),
    };
    return this.active;
  }

  end(): { ended_at: string } {
    this.active = null;
    return { ended_at: new Date().toISOString() };
  }

  current(): ActiveBlind | null {
    return this.active;
  }

  assertForDomain(domain: string): void {
    const cur = this.active;
    if (cur === null) {
      throw new ShuttleError(
        "blind_mode_required",
        "Capture requires blind mode. Run `secret-shuttle blind start --domain <domain> --reason <reason>`.",
      );
    }
    const n = normalizeDomain(domain);
    if (cur.domain !== n) {
      throw new ShuttleError(
        "blind_mode_domain_mismatch",
        `Blind mode is active for ${cur.domain}, but the browser is on ${n}.`,
      );
    }
  }
}
