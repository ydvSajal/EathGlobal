import { AgentMeterError } from "@agentmeter/shared";

/**
 * Per-key sliding window (TRD §3.3: rate limit the session endpoint per agent).
 * ponytail: in-memory, single process; fine for one gateway. Use a shared store if it ever scales out.
 */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowSec: number,
  ) {}

  check(key: string, nowSec: number): void {
    const recent = (this.hits.get(key) ?? []).filter((t) => nowSec - t < this.windowSec);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      throw new AgentMeterError("RATE_LIMITED", `too many requests (max ${this.max} per ${this.windowSec}s)`);
    }
    recent.push(nowSec);
    this.hits.set(key, recent);
  }
}
