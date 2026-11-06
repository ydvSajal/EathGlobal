/**
 * Real PaymentFacilitator (L1) over the x402 v2 facilitator HTTP API, Hedera `exact` scheme.
 *  - requirements(): builds the 402 payload; the fee payer comes from the facilitator's /supported.
 *  - verify(): checks the payment WITHOUT moving funds (spec: separate /verify and /settle).
 *  - settle(): called by the orchestrator only after a valid device ack; idempotent per payload hash.
 * Never invents a success: any facilitator error becomes a typed AgentMeterError.
 */
import { createHash } from "node:crypto";
import { HTTPFacilitatorClient, decodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements as X402Requirements, SettleResponse, SupportedResponse, VerifyResponse } from "@x402/core/types";
import {
  AgentMeterError,
  type PaymentFacilitator,
  type PaymentRequirements,
  type SettleResult,
  type VerifyResult,
} from "@agentmeter/shared";

/** The slice of HTTPFacilitatorClient we use; tests inject a fake. */
export interface FacilitatorClientLike {
  verify(payload: PaymentPayload, requirements: X402Requirements): Promise<VerifyResponse>;
  settle(payload: PaymentPayload, requirements: X402Requirements): Promise<SettleResponse>;
  getSupported(): Promise<SupportedResponse>;
}

export interface HederaFacilitatorConfig {
  facilitatorUrl: string;
  network?: "hedera:testnet" | "hedera:mainnet";
  /** `0.0.0` is HBAR; an HTS token id (e.g. testnet USDC 0.0.429274) enables token payments. */
  asset?: string;
  /** Public base URL used in the x402 `resource` field. */
  resourceBaseUrl: string;
  maxTimeoutSeconds?: number;
  /** Per-request HTTP timeout to the facilitator. */
  timeoutMs?: number;
  client?: FacilitatorClientLike;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export class HederaFacilitator implements PaymentFacilitator {
  private readonly client: FacilitatorClientLike;
  private readonly network: "hedera:testnet" | "hedera:mainnet";
  private readonly asset: string;
  private feePayer?: string;
  private readonly settled = new Map<string, SettleResult>(); // idempotent settle per payload hash

  constructor(private readonly cfg: HederaFacilitatorConfig) {
    this.network = cfg.network ?? "hedera:testnet";
    this.asset = cfg.asset ?? "0.0.0";
    this.client = cfg.client ?? new HTTPFacilitatorClient({ url: cfg.facilitatorUrl, timeoutMs: cfg.timeoutMs ?? 10_000 } as ConstructorParameters<typeof HTTPFacilitatorClient>[0]);
  }

  /** Fee payer account the facilitator advertises for our network (cached). */
  private async getFeePayer(): Promise<string> {
    if (this.feePayer) return this.feePayer;
    let supported: SupportedResponse;
    try {
      supported = await this.client.getSupported();
    } catch (e) {
      throw new AgentMeterError("PAYMENT_UNVERIFIED", `facilitator /supported failed: ${msg(e)}`, undefined, { cause: e });
    }
    const kind = supported.kinds.find((k) => k.x402Version === 2 && k.scheme === "exact" && k.network === this.network);
    const fp = kind?.extra?.["feePayer"];
    if (typeof fp !== "string") {
      throw new AgentMeterError("PAYMENT_UNVERIFIED", `facilitator does not support exact on ${this.network}`);
    }
    return (this.feePayer = fp);
  }

  async requirements(i: { deviceId: string; minutes: number; amount: string; payTo: string }): Promise<PaymentRequirements> {
    const feePayer = await this.getFeePayer();
    const accepts: X402Requirements = {
      scheme: "exact",
      network: this.network,
      asset: this.asset,
      amount: i.amount, // HBAR: tinybars; HTS: token base units
      payTo: i.payTo,
      maxTimeoutSeconds: this.cfg.maxTimeoutSeconds ?? 300,
      extra: { feePayer },
    };
    return {
      x402Version: 2,
      resource: { url: `${this.cfg.resourceBaseUrl.replace(/\/$/, "")}/devices/${i.deviceId}/session`, description: `${i.minutes} min on ${i.deviceId}` },
      accepts: [accepts],
    } as PaymentRequirements;
  }

  async verify(paymentHeader: string, requirements: PaymentRequirements): Promise<VerifyResult> {
    const payloadHash = sha256(paymentHeader);
    const want = requirements.accepts[0] as X402Requirements | undefined;
    if (!want) return { valid: false, payloadHash, invalidReason: "no payment requirements" };

    let payload: PaymentPayload;
    try {
      payload = decodePaymentSignatureHeader(paymentHeader);
    } catch {
      return { valid: false, payloadHash, invalidReason: "malformed payment header" };
    }
    // Defense in depth: the payer must have signed exactly what we asked for.
    const a = payload.accepted;
    if (!a || a.scheme !== want.scheme || a.network !== want.network || a.asset !== want.asset || a.amount !== want.amount || a.payTo !== want.payTo) {
      return { valid: false, payloadHash, invalidReason: "payment does not match requirements" };
    }
    try {
      const r = await this.client.verify(payload, want);
      return r.isValid
        ? { valid: true, payer: r.payer, payloadHash }
        : { valid: false, payer: r.payer, payloadHash, invalidReason: r.invalidMessage ?? r.invalidReason ?? "facilitator rejected payment" };
    } catch (e) {
      throw new AgentMeterError("PAYMENT_UNVERIFIED", `facilitator verify failed: ${msg(e)}`, undefined, { cause: e });
    }
  }

  async settle(paymentHeader: string, requirements: PaymentRequirements): Promise<SettleResult> {
    const key = sha256(paymentHeader);
    const prior = this.settled.get(key);
    if (prior?.success) return prior; // never settle twice
    const want = requirements.accepts[0] as X402Requirements | undefined;
    if (!want) return { success: false, error: "no payment requirements" };
    let result: SettleResult;
    try {
      const r = await this.client.settle(decodePaymentSignatureHeader(paymentHeader), want);
      result = r.success && r.transaction ? { success: true, txId: r.transaction } : { success: false, error: r.errorMessage ?? r.errorReason ?? "settle failed" };
    } catch (e) {
      throw new AgentMeterError("SETTLE_FAILED", `facilitator settle failed: ${msg(e)}`, undefined, { cause: e });
    }
    if (result.success) this.settled.set(key, result);
    return result;
  }
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
