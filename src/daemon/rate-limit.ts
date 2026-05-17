import { ShuttleError } from "../shared/errors.js";

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  check(key: string): void {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (recent.length >= this.limit) {
      throw new ShuttleError("compare_rate_limited", `Too many compares for ${key}; slow down.`);
    }
    recent.push(t);
    this.hits.set(key, recent);
  }
}
