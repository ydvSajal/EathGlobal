import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AgentMeterError,
  DecisionInput,
  FakeAuditLog,
  FakeDecider,
  FakeFacilitator,
  FakeStepUp,
  ModelVerdict,
  decodeReceipt,
  encodeReceipt,
  generateNonce,
  generateSeedBase64,
  publicKeyFromSeedBase64,
  signReceipt,
  verifyReceipt,
  withTimeout,
  type Receipt,
} from "../src";

const vector = JSON.parse(readFileSync(new URL("../test-vectors/receipt.json", import.meta.url), "utf8"));

const sample = (over: Partial<Receipt> = {}): Receipt => ({
  deviceId: "dev-1",
  sessionId: "s_1",
  nonce: generateNonce(),
  notBefore: 1000,
  expiresAt: 2000,
  amount: "5",
  payer: "0.0.7",
  ...over,
});

describe("receipt", () => {
  const seed = generateSeedBase64();
  const pub = publicKeyFromSeedBase64(seed);
  const ctx = { deviceId: "dev-1", now: 1500, usedNonces: new Set<string>() };

  it("round-trips encode/decode and sign/verify", () => {
    const r = sample();
    const { canonical, sig } = signReceipt(r, seed);
    expect(decodeReceipt(canonical)).toEqual(r);
    expect(verifyReceipt(canonical, sig, pub, ctx)).toEqual({ ok: true });
  });

  it("rejects fields containing the separator or bad shapes", () => {
    expect(() => encodeReceipt(sample({ deviceId: "a|b" }))).toThrow();
    expect(() => encodeReceipt(sample({ nonce: "xyz" }))).toThrow();
    expect(() => encodeReceipt(sample({ expiresAt: 1000 }))).toThrow();
    expect(() => encodeReceipt(sample({ payer: "bad" }))).toThrow();
  });

  it("rejects a signature from another key", () => {
    const { canonical, sig } = signReceipt(sample(), generateSeedBase64());
    expect(verifyReceipt(canonical, sig, pub, ctx)).toEqual({ ok: false, reason: "signature" });
  });

  it("rejects before NTP sync", () => {
    const { canonical, sig } = signReceipt(sample(), seed);
    expect(verifyReceipt(canonical, sig, pub, { ...ctx, clockSynced: false })).toEqual({ ok: false, reason: "clock" });
  });

  it("matches the shared test vector (firmware contract)", () => {
    expect(publicKeyFromSeedBase64(vector.seedBase64)).toBe(vector.publicKeyBase64);
    for (const c of vector.cases) {
      const out = verifyReceipt(c.canonical, c.sigBase64, vector.publicKeyBase64, {
        deviceId: c.deviceId,
        now: c.now,
        usedNonces: new Set<string>(c.usedNonces),
      });
      const got = out.ok ? "ok" : out.reason;
      expect(got, c.name).toBe(c.expect);
    }
  });

  it("vector signature is reproducible (Ed25519 is deterministic)", () => {
    const valid = vector.cases.find((c: { name: string }) => c.name === "valid");
    const { canonical, sig } = signReceipt(decodeReceipt(valid.canonical), vector.seedBase64);
    expect(canonical).toBe(valid.canonical);
    expect(sig).toBe(valid.sigBase64);
  });
});

describe("withTimeout", () => {
  it("rejects with TIMEOUT and aborts the signal", async () => {
    let aborted = false;
    const p = withTimeout(
      (signal) => new Promise<string>((res) => { signal.addEventListener("abort", () => { aborted = true; }); setTimeout(() => res("late"), 200); }),
      20,
      "slow",
    );
    await expect(p).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(aborted).toBe(true);
  });
  it("passes results through", async () => {
    await expect(withTimeout(async () => 42, 50, "ok")).resolves.toBe(42);
  });
});

describe("fail-safe contract of Decider fakes", () => {
  const input = DecisionInput.parse({
    deviceId: "dev-1", deviceStatus: "ONLINE", relay: false, lastHeartbeatAgeSec: 2,
    recentSessions: [], requestedMinutes: 5, amount: "5", agentId: "a_1",
  });

  it("slow decider loses to the 4s-style deadline (never a default ALLOW)", async () => {
    const d = new FakeDecider();
    d.mode = "slow";
    await expect(withTimeout(() => d.decide(input), 20, "0G decide")).rejects.toBeInstanceOf(AgentMeterError);
  });
  it("throwing decider surfaces an error for the orchestrator to map to SAFE_STOP", async () => {
    const d = new FakeDecider();
    d.mode = "throw";
    await expect(d.decide(input)).rejects.toThrow();
  });
  it("model output without a strict verdict fails the schema", () => {
    expect(ModelVerdict.safeParse({ reason: "x" }).success).toBe(false);
    expect(ModelVerdict.safeParse({ verdict: "MAYBE", reason: "x" }).success).toBe(false);
    expect(ModelVerdict.safeParse({ verdict: "ALLOW", reason: "ok" }).success).toBe(true);
  });
});

describe("other fakes", () => {
  it("facilitator settle is idempotent and logs call order", async () => {
    const f = new FakeFacilitator();
    const req = await f.requirements({ deviceId: "d", minutes: 1, amount: "1", payTo: "0.0.9" });
    await f.verify("hdr", req);
    const a = await f.settle("hdr", req);
    const b = await f.settle("hdr", req);
    expect(a).toEqual(b);
    expect(f.calls.indexOf("verify")).toBeLessThan(f.calls.indexOf("settle"));
  });
  it("step-up state is single use", async () => {
    const s = new FakeStepUp();
    const { authorizeUrl } = await s.start({ sessionId: "s1", action: { deviceId: "d", minutes: 1, amount: "1", asset: "HBAR", expiresAt: 1 } });
    const state = new URL(authorizeUrl).searchParams.get("state")!;
    expect((await s.complete({ state, code: "c" })).result).toBe("APPROVED");
    await expect(s.complete({ state, code: "c" })).rejects.toBeInstanceOf(AgentMeterError);
  });
  it("audit log returns increasing sequence numbers", async () => {
    const l = new FakeAuditLog();
    const e = { v: 1 as const, sessionId: "s", state: "PENDING" as const, at: 1 };
    expect((await l.append(e)).seq).toBe(1);
    expect((await l.append(e)).seq).toBe(2);
  });
});
