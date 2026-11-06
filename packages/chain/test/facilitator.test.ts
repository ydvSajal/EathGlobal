import { describe, expect, it } from "vitest";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements as X402Requirements, SettleResponse, VerifyResponse } from "@x402/core/types";
import { AgentMeterError, FakeFacilitator, type PaymentFacilitator } from "@agentmeter/shared";
import { HederaFacilitator, type FacilitatorClientLike } from "../src/facilitator";

const FEE_PAYER = "0.0.9185802";

class FakeX402Client implements FacilitatorClientLike {
  calls: string[] = [];
  verifyResp: VerifyResponse = { isValid: true, payer: "0.0.1001" };
  settleResp: SettleResponse = { success: true, transaction: "0.0.1001@1789000000.123456789", network: "hedera:testnet" };
  throwOn?: "verify" | "settle" | "supported";
  async getSupported() {
    this.calls.push("supported");
    if (this.throwOn === "supported") throw new Error("down");
    return { kinds: [{ x402Version: 2, scheme: "exact", network: "hedera:testnet", extra: { feePayer: FEE_PAYER } }], extensions: [], signers: {} } as never;
  }
  async verify(_p: PaymentPayload, _r: X402Requirements) {
    this.calls.push("verify");
    if (this.throwOn === "verify") throw new Error("boom");
    return this.verifyResp;
  }
  async settle(_p: PaymentPayload, _r: X402Requirements) {
    this.calls.push("settle");
    if (this.throwOn === "settle") throw new Error("boom");
    return this.settleResp;
  }
}

const input = { deviceId: "d1", minutes: 2, amount: "20000000", payTo: "0.0.9" };
const make = () => {
  const client = new FakeX402Client();
  const f = new HederaFacilitator({ facilitatorUrl: "http://x", resourceBaseUrl: "http://gw/", client });
  return { client, f };
};
/** A payment header whose `accepted` matches what the facilitator asked for. */
const headerFor = (accepted: unknown) =>
  encodePaymentSignatureHeader({ x402Version: 2, accepted, payload: { transaction: "AAAA" } } as unknown as PaymentPayload);

describe("HederaFacilitator", () => {
  it("builds x402 v2 requirements with the facilitator's fee payer", async () => {
    const { f, client } = make();
    const r = await f.requirements(input);
    expect(r.x402Version).toBe(2);
    expect(r.accepts[0]).toMatchObject({
      scheme: "exact", network: "hedera:testnet", asset: "0.0.0", amount: "20000000", payTo: "0.0.9", extra: { feePayer: FEE_PAYER },
    });
    expect((r as unknown as { resource: { url: string } }).resource.url).toBe("http://gw/devices/d1/session");
    await f.requirements(input);
    expect(client.calls.filter((c) => c === "supported")).toHaveLength(1); // fee payer cached
  });

  it("verify never settles and returns a stable payload hash", async () => {
    const { f, client } = make();
    const req = await f.requirements(input);
    const header = headerFor(req.accepts[0]);
    const v = await f.verify(header, req);
    expect(v).toMatchObject({ valid: true, payer: "0.0.1001" });
    expect(v.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await f.verify(header, req)).payloadHash).toBe(v.payloadHash);
    expect(client.calls).not.toContain("settle");
  });

  it("rejects a payment that does not match the requirements (wrong amount / payTo) without calling the facilitator", async () => {
    const { f, client } = make();
    const req = await f.requirements(input);
    for (const bad of [{ ...(req.accepts[0] as object), amount: "1" }, { ...(req.accepts[0] as object), payTo: "0.0.666" }]) {
      const v = await f.verify(headerFor(bad), req);
      expect(v.valid).toBe(false);
      expect(v.invalidReason).toMatch(/does not match/);
    }
    expect(client.calls).not.toContain("verify");
  });

  it("returns invalid (not an exception) for a malformed header", async () => {
    const { f } = make();
    const req = await f.requirements(input);
    expect((await f.verify("not-base64-json!!", req)).valid).toBe(false);
  });

  it("maps a facilitator rejection to invalid with its reason", async () => {
    const { f, client } = make();
    const req = await f.requirements(input);
    client.verifyResp = { isValid: false, invalidReason: "invalid_signature", invalidMessage: "bad sig" };
    expect(await f.verify(headerFor(req.accepts[0]), req)).toMatchObject({ valid: false, invalidReason: "bad sig" });
  });

  it("turns facilitator outages into typed errors, never a fake success", async () => {
    const { f, client } = make();
    const req = await f.requirements(input);
    const header = headerFor(req.accepts[0]);
    client.throwOn = "verify";
    await expect(f.verify(header, req)).rejects.toMatchObject({ code: "PAYMENT_UNVERIFIED" });
    client.throwOn = "settle";
    await expect(f.settle(header, req)).rejects.toMatchObject({ code: "SETTLE_FAILED" });
    const down = new FakeX402Client();
    down.throwOn = "supported";
    const f2 = new HederaFacilitator({ facilitatorUrl: "http://x", resourceBaseUrl: "http://gw", client: down });
    await expect(f2.requirements(input)).rejects.toBeInstanceOf(AgentMeterError);
  });

  it("settle returns the Hedera tx id and is idempotent per payload", async () => {
    const { f, client } = make();
    const req = await f.requirements(input);
    const header = headerFor(req.accepts[0]);
    const a = await f.settle(header, req);
    const b = await f.settle(header, req);
    expect(a).toEqual({ success: true, txId: "0.0.1001@1789000000.123456789" });
    expect(b).toEqual(a);
    expect(client.calls.filter((c) => c === "settle")).toHaveLength(1);
  });

  it("a failed settle is reported as failure and can be retried", async () => {
    const { f, client } = make();
    const req = await f.requirements(input);
    const header = headerFor(req.accepts[0]);
    client.settleResp = { success: false, errorReason: "insufficient_funds", transaction: "", network: "hedera:testnet" };
    expect(await f.settle(header, req)).toMatchObject({ success: false });
    client.settleResp = { success: true, transaction: "0.0.1@1.2", network: "hedera:testnet" };
    expect(await f.settle(header, req)).toMatchObject({ success: true, txId: "0.0.1@1.2" });
  });
});

// Same port contract as the shared fake: both must satisfy it (docs: chain lane rule).
describe.each<[string, () => Promise<{ f: PaymentFacilitator; header: (r: Awaited<ReturnType<PaymentFacilitator["requirements"]>>) => string }>]>([
  ["FakeFacilitator", async () => ({ f: new FakeFacilitator(), header: () => "any-header" })],
  ["HederaFacilitator", async () => ({ f: make().f, header: (r) => headerFor(r.accepts[0]) })],
])("PaymentFacilitator contract: %s", (_name, build) => {
  it("verify does not settle; settle is idempotent; payload hash is stable", async () => {
    const { f, header } = await build();
    const req = await f.requirements(input);
    const h = header(req);
    const v1 = await f.verify(h, req);
    const v2 = await f.verify(h, req);
    expect(v1.valid).toBe(true);
    expect(v1.payloadHash).toBe(v2.payloadHash);
    const s1 = await f.settle(h, req);
    const s2 = await f.settle(h, req);
    expect(s1.success).toBe(true);
    expect(s2).toEqual(s1);
  });
});

// Opt-in: talks to the real public facilitator. No keys and no funds needed.
describe.skipIf(!process.env["LIVE"])("live x402 facilitator (LIVE=1)", () => {
  const url = process.env["X402_FACILITATOR_URL"] ?? "https://x402.org/facilitator";

  it("advertises hedera:testnet and builds requirements from the real fee payer", async () => {
    const f = new HederaFacilitator({ facilitatorUrl: url, resourceBaseUrl: "http://localhost:8787" });
    const r = await f.requirements(input);
    expect((r.accepts[0] as { extra: { feePayer: string } }).extra.feePayer).toMatch(/^0\.0\.\d+$/);
  }, 30_000);

  it("rejects a forged payment (verify returns invalid, no funds move)", async () => {
    const f = new HederaFacilitator({ facilitatorUrl: url, resourceBaseUrl: "http://localhost:8787" });
    const req = await f.requirements(input);
    const forged = headerFor(req.accepts[0]); // matches requirements but carries a junk transaction
    let result: { valid: boolean } | "error";
    try {
      result = await f.verify(forged, req);
    } catch (e) {
      expect(e).toBeInstanceOf(AgentMeterError); // a typed rejection is also acceptable
      result = "error";
    }
    if (result !== "error") expect(result.valid).toBe(false);
  }, 30_000);
});
