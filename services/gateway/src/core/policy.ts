/**
 * Policy engine (L2, pure function over supplied state; no IO).
 * Check order: device online -> agent allowlist -> device rate -> agent daily cap -> step-up threshold.
 * All amounts are base units (bigint) in ONE asset; the caller converts and guarantees same asset.
 */
import type { ErrorCode } from "@agentmeter/shared";

export interface PolicyInput {
  amount: bigint;
  agent: {
    dailyCap: bigint;
    spentToday: bigint;
    /** Device ids this agent may rent. Empty list means none. */
    allowedDeviceIds: readonly string[];
  };
  device: {
    id: string;
    online: boolean;
    /** Sessions already created for this device inside the rate window. */
    recentSessionCount: number;
    maxSessionsPerWindow: number;
  };
  /** Amounts strictly above this need World ID step-up. */
  stepUpThreshold: bigint;
}

export type PolicyResult =
  | { verdict: "ALLOW" }
  | { verdict: "STEP_UP"; reason: string }
  | { verdict: "DENY"; code: Extract<ErrorCode, "POLICY_DENIED" | "DEVICE_OFFLINE" | "RATE_LIMITED">; reason: string };

const HBAR_TINYBAR = 100_000_000n;

/** STEP_UP_THRESHOLD_HBAR (whole HBAR) -> tinybar. */
export function hbarToTinybar(hbar: number): bigint {
  if (!Number.isInteger(hbar) || hbar < 0) throw new Error("threshold must be a non-negative integer of HBAR");
  return BigInt(hbar) * HBAR_TINYBAR;
}

export function evaluatePolicy(i: PolicyInput): PolicyResult {
  if (i.amount <= 0n) return { verdict: "DENY", code: "POLICY_DENIED", reason: "amount must be positive" };
  if (!i.device.online) return { verdict: "DENY", code: "DEVICE_OFFLINE", reason: "device is offline" };
  if (!i.agent.allowedDeviceIds.includes(i.device.id)) {
    return { verdict: "DENY", code: "POLICY_DENIED", reason: "device not in agent allowlist" };
  }
  if (i.device.recentSessionCount >= i.device.maxSessionsPerWindow) {
    return { verdict: "DENY", code: "RATE_LIMITED", reason: "device session rate limit reached" };
  }
  if (i.agent.spentToday + i.amount > i.agent.dailyCap) {
    return { verdict: "DENY", code: "POLICY_DENIED", reason: "agent daily cap exceeded" };
  }
  if (i.amount > i.stepUpThreshold) {
    return { verdict: "STEP_UP", reason: "amount above step-up threshold" };
  }
  return { verdict: "ALLOW" };
}
