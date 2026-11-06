/**
 * Ports: what the domain (L2) needs from the outside world. Real adapters live in
 * packages/chain (L1); in-memory fakes live in ./fakes. Every adapter must honor the TRD §3.1
 * timeout, throw AgentMeterError, and never return a made-up success.
 */
import type { AuditEntry, Decision, DecisionInput, Episode } from "./schemas";

/** x402 payment requirements; exact shape comes from @x402/core, treated as opaque here. */
export interface PaymentRequirements {
  x402Version: number;
  accepts: unknown[];
}

export interface VerifyResult {
  valid: boolean;
  payer?: string; // Hedera account id
  payloadHash: string; // sha256 of the payment payload, single-use guard
  invalidReason?: string;
}

export interface SettleResult {
  success: boolean;
  txId?: string; // Hedera transaction id
  error?: string;
}

export interface PaymentFacilitator {
  requirements(input: { deviceId: string; minutes: number; amount: string; payTo: string }): Promise<PaymentRequirements>;
  /** Verify only. Must NOT move funds. */
  verify(paymentHeader: string, requirements: PaymentRequirements): Promise<VerifyResult>;
  /** Called only after a valid device ack. Must be idempotent per payloadHash. */
  settle(paymentHeader: string, requirements: PaymentRequirements): Promise<SettleResult>;
}

export interface Decider {
  /** Throws on any error or timeout. The orchestrator maps a throw to SAFE_STOP. Never default-ALLOW. */
  decide(input: DecisionInput): Promise<Decision>;
}

export interface EpisodeStore {
  put(episode: Episode): Promise<{ rootHash: string }>;
}

export interface AuditLog {
  append(entry: AuditEntry): Promise<{ seq: number }>;
}

export interface StepUpRequest {
  sessionId: string;
  action: { deviceId: string; minutes: number; amount: string; asset: string; expiresAt: number };
}
export type StepUpResult =
  | { result: "APPROVED"; sessionId: string; worldSub: string; authTime: number }
  | { result: "DENIED" | "EXPIRED"; sessionId: string };

export interface StepUpProvider {
  start(req: StepUpRequest): Promise<{ authorizeUrl: string }>;
  /** Validates server-side (state, nonce, iss/aud/exp, acr, auth_time of this attempt). Unknown state throws. */
  complete(callback: { code?: string; state: string; error?: string }): Promise<StepUpResult>;
}

export interface Clock {
  now(): number; // unix seconds
}
