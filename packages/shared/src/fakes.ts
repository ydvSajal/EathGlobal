/** In-memory fakes for every port so each lane can run without the others (TRD §7). */
import { createHash, randomBytes } from "node:crypto";
import { AgentMeterError } from "./errors";
import type {
  AuditLog,
  Clock,
  Decider,
  EpisodeStore,
  PaymentFacilitator,
  PaymentRequirements,
  SettleResult,
  StepUpProvider,
  StepUpRequest,
  StepUpResult,
  VerifyResult,
} from "./ports";
import type { AuditEntry, Decision, DecisionInput, Episode } from "./schemas";

export class FakeClock implements Clock {
  constructor(private t = 1_789_000_000) {}
  now() {
    return this.t;
  }
  advance(seconds: number) {
    this.t += seconds;
  }
}

export class FakeFacilitator implements PaymentFacilitator {
  /** Ordered log of calls; tests assert verify happens before settle. */
  calls: Array<"requirements" | "verify" | "settle"> = [];
  verifyValid = true;
  settleOk = true;
  private settled = new Map<string, SettleResult>();

  async requirements(i: { deviceId: string; minutes: number; amount: string; payTo: string }): Promise<PaymentRequirements> {
    this.calls.push("requirements");
    return {
      x402Version: 2,
      accepts: [{ scheme: "exact", network: "hedera:testnet", asset: "0.0.0", amount: i.amount, payTo: i.payTo }],
    };
  }
  async verify(header: string, _req?: PaymentRequirements): Promise<VerifyResult> {
    this.calls.push("verify");
    const payloadHash = createHash("sha256").update(header).digest("hex");
    return this.verifyValid
      ? { valid: true, payer: "0.0.1001", payloadHash }
      : { valid: false, payloadHash, invalidReason: "fake: invalid" };
  }
  async settle(header: string, _req?: PaymentRequirements): Promise<SettleResult> {
    this.calls.push("settle");
    const key = createHash("sha256").update(header).digest("hex");
    const prior = this.settled.get(key);
    if (prior) return prior; // idempotent
    const res: SettleResult = this.settleOk
      ? { success: true, txId: `0.0.1001@1789000000.${randomBytes(4).readUInt32BE(0)}` }
      : { success: false, error: "fake: settle failed" };
    this.settled.set(key, res);
    return res;
  }
}

export type FakeDeciderMode = "allow" | "deny" | "throw" | "slow" | "malformed";

export class FakeDecider implements Decider {
  mode: FakeDeciderMode = "allow";
  slowMs = 10_000;
  private n = 0;
  async decide(_input: DecisionInput): Promise<Decision> {
    this.n++;
    if (this.mode === "throw") throw new AgentMeterError("INTERNAL", "fake: 0G unreachable");
    if (this.mode === "slow") await new Promise((r) => setTimeout(r, this.slowMs)); // caller's timeout must win
    if (this.mode === "malformed") return { verdict: "ALLOW" } as unknown as Decision; // missing requestId
    return {
      verdict: this.mode === "deny" ? "DENY" : "ALLOW",
      reason: `fake ${this.mode}`,
      requestId: `fake-req-${this.n}`,
    };
  }
}

export class FakeEpisodeStore implements EpisodeStore {
  episodes: Episode[] = [];
  async put(e: Episode) {
    this.episodes.push(e);
    return { rootHash: `0x${createHash("sha256").update(JSON.stringify(e)).digest("hex")}` };
  }
}

export class FakeAuditLog implements AuditLog {
  entries: AuditEntry[] = [];
  async append(e: AuditEntry) {
    this.entries.push(e);
    return { seq: this.entries.length };
  }
}

export class FakeStepUp implements StepUpProvider {
  outcome: "APPROVED" | "DENIED" | "EXPIRED" = "APPROVED";
  private pending = new Map<string, StepUpRequest>();
  async start(req: StepUpRequest) {
    const state = `fake-state-${req.sessionId}`;
    this.pending.set(state, req);
    return { authorizeUrl: `http://localhost:3000/step-up/${req.sessionId}?state=${state}` };
  }
  async complete(cb: { code?: string; state: string; error?: string }): Promise<StepUpResult> {
    const req = this.pending.get(cb.state);
    if (!req) throw new AgentMeterError("STEP_UP_DENIED", "unknown or reused state");
    this.pending.delete(cb.state); // single use
    if (cb.error || this.outcome !== "APPROVED") {
      return { result: this.outcome === "EXPIRED" ? "EXPIRED" : "DENIED", sessionId: req.sessionId };
    }
    return { result: "APPROVED", sessionId: req.sessionId, worldSub: "fake-pairwise-sub", authTime: 1_789_000_000 };
  }
}
