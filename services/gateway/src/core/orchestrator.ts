/**
 * The ONLY place the order of operations lives (docs/ARCHITECTURE.md §7):
 * verify -> policy -> (step-up) -> 0G decide -> sign receipt -> push to device -> ack -> settle -> log.
 *
 * Hard rules (TRD §3.2):
 *  - Any 0G error, timeout, DENY, or malformed output => SAFE_STOP. Never a default ALLOW.
 *  - Payment settles only after a valid device ack.
 *  - Logging (HCS, 0G Storage) runs in the background and never changes a decision.
 */
import { randomUUID } from "node:crypto";
import {
  AgentMeterError,
  Decision,
  generateNonce,
  signReceipt,
  withTimeout,
  type DecisionInput,
  type PaymentRequirements,
  type SessionState,
} from "@agentmeter/shared";
import type { Repos, SessionPatch } from "@agentmeter/db";
import type { Logger } from "pino";
import type { Ports } from "../ports";
import type { DeviceChannel } from "./device-channel";
import { evaluatePolicy } from "./policy";
import { transition } from "./session-machine";

export interface OrchestratorOptions {
  receiptSeedBase64: string;
  stepUpThreshold: bigint; // base units
  ackTimeoutMs: number;
  zgTimeoutMs: number;
  verifyTimeoutMs?: number;
  settleTimeoutMs?: number;
  rateWindowSec?: number;
  maxSessionsPerWindow?: number;
}

export interface SessionEventMsg {
  sessionId: string;
  state: SessionState;
  at: number;
  detail: string | null;
}

export interface StartResult {
  sessionId: string;
  state: SessionState;
  stepUpUrl?: string;
  /** Resolves when the async part (decide -> settle) finishes. HTTP ignores it; tests await it. */
  done: Promise<void>;
}

interface PendingPayment {
  paymentHeader: string;
  requirements: PaymentRequirements;
}

export class Orchestrator {
  // ponytail: in-memory pending payments; a gateway restart drops unsettled sessions (they never settle, which is the safe side).
  private pending = new Map<string, PendingPayment>();
  private background = new Set<Promise<unknown>>();
  private listeners = new Set<(e: SessionEventMsg) => void>();
  private readonly o: Required<OrchestratorOptions>;

  constructor(
    private readonly repos: Repos,
    private readonly ports: Ports,
    private readonly devices: DeviceChannel,
    private readonly log: Logger,
    opts: OrchestratorOptions,
  ) {
    this.o = { verifyTimeoutMs: 5000, settleTimeoutMs: 10_000, rateWindowSec: 3600, maxSessionsPerWindow: 20, ...opts };
  }

  onEvent(fn: (e: SessionEventMsg) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Await all background logging (tests, graceful shutdown). */
  async idle(): Promise<void> {
    while (this.background.size) await Promise.allSettled([...this.background]);
  }

  /** Price and x402 requirements for a 402 response. */
  async quote(deviceId: string, minutes: number) {
    const device = await this.repos.devices.get(deviceId);
    if (!device) throw new AgentMeterError("POLICY_DENIED", `unknown device ${deviceId}`);
    const amount = (BigInt(device.pricePerMinute) * BigInt(minutes)).toString();
    const requirements = await this.ports.facilitator.requirements({ deviceId, minutes, amount, payTo: device.payTo });
    return { device, amount, requirements };
  }

  async startSession(input: { deviceId: string; agentId: string; minutes: number; paymentHeader: string }): Promise<StartResult> {
    const now = this.ports.clock.now();
    const agent = await this.repos.agents.get(input.agentId);
    if (!agent) throw new AgentMeterError("POLICY_DENIED", `unknown agent ${input.agentId}`);
    const { device, amount, requirements } = await this.quote(input.deviceId, input.minutes);

    const verified = await withTimeout(
      () => this.ports.facilitator.verify(input.paymentHeader, requirements),
      this.o.verifyTimeoutMs,
      "facilitator verify",
    );
    if (!verified.valid) throw new AgentMeterError("PAYMENT_UNVERIFIED", verified.invalidReason ?? "payment not valid");
    if (verified.payer && verified.payer !== agent.hederaAccountId) {
      throw new AgentMeterError("POLICY_DENIED", "payer account does not belong to this agent");
    }

    // Count before creating so this request is not rate-limited by itself.
    const recent = await this.repos.sessions.countForDeviceSince(device.id, now - this.o.rateWindowSec);
    const sessionId = `s_${randomUUID()}`;
    await this.repos.sessions.create({
      id: sessionId,
      deviceId: device.id,
      agentId: agent.id,
      amount,
      asset: device.asset,
      minutes: input.minutes,
      paymentPayloadHash: verified.payloadHash,
      payer: verified.payer ?? agent.hederaAccountId,
      now,
    }); // throws PAYMENT_REPLAY on a reused payload
    this.emit({ sessionId, state: "PENDING", at: now, detail: null });

    const policy = evaluatePolicy({
      amount: BigInt(amount),
      stepUpThreshold: this.o.stepUpThreshold,
      agent: {
        dailyCap: BigInt(agent.dailyCap),
        spentToday: this.repos.agents.spentOn(agent, now),
        allowedDeviceIds: this.repos.agents.allowedDeviceIds(agent),
      },
      device: {
        id: device.id,
        online: this.devices.isOnline(device.id),
        recentSessionCount: recent,
        maxSessionsPerWindow: this.o.maxSessionsPerWindow,
      },
    });

    if (policy.verdict === "DENY") {
      await this.move(sessionId, "PENDING", "CANCELLED", {}, policy.reason);
      throw new AgentMeterError(policy.code, policy.reason, sessionId);
    }

    this.pending.set(sessionId, { paymentHeader: input.paymentHeader, requirements });

    if (policy.verdict === "STEP_UP") {
      await this.move(sessionId, "PENDING", "STEP_UP", {}, policy.reason);
      const { authorizeUrl } = await this.ports.stepUp.start({
        sessionId,
        action: { deviceId: device.id, minutes: input.minutes, amount, asset: device.asset, expiresAt: now + 300 },
      });
      return { sessionId, state: "STEP_UP", stepUpUrl: authorizeUrl, done: Promise.resolve() };
    }

    await this.move(sessionId, "PENDING", "DECIDING");
    return { sessionId, state: "DECIDING", done: this.decideAndIssue(sessionId) };
  }

  /** World callback. Approve resumes the flow; deny/expire cancels and nothing is ever settled. */
  async completeStepUp(cb: { code?: string; state: string; error?: string }) {
    const r = await this.ports.stepUp.complete(cb); // throws on unknown/reused state
    if (r.result === "APPROVED") {
      await this.move(r.sessionId, "STEP_UP", "DECIDING", {}, "world id approved");
      return { ...r, done: this.decideAndIssue(r.sessionId) };
    }
    this.pending.delete(r.sessionId);
    await this.move(r.sessionId, "STEP_UP", "CANCELLED", {}, `step-up ${r.result.toLowerCase()}`);
    return { ...r, done: Promise.resolve() };
  }

  private async decideAndIssue(sessionId: string): Promise<void> {
    const s = await this.repos.sessions.get(sessionId);
    if (!s) throw new AgentMeterError("INTERNAL", "session vanished", sessionId);
    const device = await this.repos.devices.get(s.deviceId);
    const now = this.ports.clock.now();
    const recent = await this.repos.sessions.recentForDevice(s.deviceId);
    const input: DecisionInput = {
      deviceId: s.deviceId,
      deviceStatus: this.devices.isOnline(s.deviceId) ? "ONLINE" : "OFFLINE",
      relay: device?.relay ?? false,
      lastHeartbeatAgeSec: device?.lastHeartbeat != null ? now - device.lastHeartbeat : null,
      recentSessions: recent.map((r) => ({ state: r.state as SessionState, at: r.createdAt })),
      requestedMinutes: s.minutes,
      amount: s.amount,
      agentId: s.agentId,
    };

    // 1. 0G decision. Anything but a well-formed ALLOW is SAFE_STOP.
    let decision: Decision | null = null;
    let failure: string | null = null;
    try {
      const raw = await withTimeout(() => this.ports.decider.decide(input), this.o.zgTimeoutMs, "0G decide");
      const parsed = Decision.safeParse(raw);
      if (!parsed.success) failure = "malformed decision";
      else decision = parsed.data;
    } catch (e) {
      failure = e instanceof Error ? e.message : "decider error";
    }
    const outcome = decision?.verdict === "ALLOW" ? "ALLOW" : decision ? "DENY" : "SAFE_STOP";
    this.recordEpisode(sessionId, s.deviceId, s.agentId, input, decision, outcome, now);

    if (!decision || decision.verdict !== "ALLOW") {
      this.pending.delete(sessionId);
      await this.move(sessionId, "DECIDING", "SAFE_STOP", decision ? { zgRequestId: decision.requestId } : {},
        decision ? `0G deny: ${decision.reason}` : `safe stop: ${failure}`);
      return;
    }

    // 2. Sign the receipt and push it to the device.
    const nonce = generateNonce();
    if (!(await this.repos.nonces.use(nonce, now))) throw new AgentMeterError("INTERNAL", "nonce collision", sessionId);
    const receipt = {
      deviceId: s.deviceId,
      sessionId,
      nonce,
      notBefore: now,
      expiresAt: now + s.minutes * 60,
      amount: s.amount,
      payer: s.payer ?? "0.0.0",
    };
    const { sig } = signReceipt(receipt, this.o.receiptSeedBase64);
    await this.move(sessionId, "DECIDING", "ISSUED", {
      zgRequestId: decision.requestId,
      nonce,
      notBefore: receipt.notBefore,
      expiresAt: receipt.expiresAt,
    });

    const delivery = await this.devices.deliver(s.deviceId, { receipt, sig }, this.o.ackTimeoutMs);
    if (delivery.type !== "ack") {
      this.pending.delete(sessionId);
      this.devices.cancel(s.deviceId, sessionId);
      const detail = delivery.type === "nack" ? `device rejected: ${delivery.reason}` : `no ack: ${delivery.type}`;
      await this.move(sessionId, "ISSUED", "CANCELLED", {}, detail); // payment is never settled
      return;
    }
    await this.move(sessionId, "ISSUED", "ACTIVE", {}, "device ack");

    // 3. Settle only now. A failed settle leaves the session ACTIVE for an idempotent retry.
    const pay = this.pending.get(sessionId);
    if (!pay) throw new AgentMeterError("INTERNAL", "pending payment missing", sessionId);
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await withTimeout(
          () => this.ports.facilitator.settle(pay.paymentHeader, pay.requirements),
          this.o.settleTimeoutMs,
          "facilitator settle",
        );
        if (res.success && res.txId) {
          this.pending.delete(sessionId);
          await this.move(sessionId, "ACTIVE", "SETTLED", { hederaTxId: res.txId }, "settled");
          await this.repos.agents.addSpend(s.agentId, BigInt(s.amount), this.ports.clock.now());
          return;
        }
        this.log.warn({ sessionId, attempt, error: res.error }, "settle failed");
      } catch (e) {
        this.log.warn({ sessionId, attempt, err: (e as Error).message }, "settle error");
      }
    }
    this.log.error({ sessionId }, "settle failed after retries; session left ACTIVE");
  }

  /** Legal transition + DB compare-and-set + live event + background HCS audit. */
  private async move(sessionId: string, from: SessionState, to: SessionState, patch: SessionPatch = {}, detail?: string) {
    transition(from, to, sessionId);
    const at = this.ports.clock.now();
    const eventId = await this.repos.sessions.move(sessionId, from, to, at, patch, detail);
    this.emit({ sessionId, state: to, at, detail: detail ?? null });
    this.bg(async () => {
      const { seq } = await this.ports.audit.append({
        v: 1,
        sessionId,
        state: to,
        at,
        ...(patch.hederaTxId ? { hederaTxId: patch.hederaTxId } : {}),
        ...(patch.zgRequestId ? { zgRequestId: patch.zgRequestId } : {}),
      });
      await this.repos.sessions.setEventHcsSeq(eventId, seq);
      await this.repos.sessions.patch(sessionId, { hcsSeq: seq }, at);
    }, "hcs audit");
  }

  private recordEpisode(
    sessionId: string,
    deviceId: string,
    agentId: string,
    input: DecisionInput,
    decision: Decision | null,
    outcome: "ALLOW" | "DENY" | "SAFE_STOP",
    at: number,
  ) {
    this.bg(async () => {
      const { rootHash } = await this.ports.episodes.put({ v: 1, sessionId, deviceId, agentId, input, decision, outcome, at });
      await this.repos.sessions.patch(sessionId, { zgRootHash: rootHash }, this.ports.clock.now());
    }, "0G episode");
  }

  private bg(fn: () => Promise<unknown>, label: string) {
    const p = fn().catch((e: unknown) => this.log.warn({ err: (e as Error).message }, `${label} failed (decision unaffected)`));
    this.background.add(p);
    void p.finally(() => this.background.delete(p));
  }

  private emit(e: SessionEventMsg) {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        /* a broken listener must not break the flow */
      }
    }
  }
}
