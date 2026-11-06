import { describe, expect, it } from "vitest";
import { TERMINAL_STATES, type SessionState } from "@agentmeter/shared";
import { evaluatePolicy, hbarToTinybar, type PolicyInput } from "../src/core/policy";
import { canTransition, isTerminal, transition } from "../src/core/session-machine";

const ALL: SessionState[] = ["PENDING", "STEP_UP", "DECIDING", "ISSUED", "ACTIVE", "SETTLED", "CANCELLED", "SAFE_STOP"];

describe("session machine", () => {
  const legal: Array<[SessionState, SessionState]> = [
    ["PENDING", "STEP_UP"], ["PENDING", "DECIDING"], ["PENDING", "CANCELLED"],
    ["STEP_UP", "DECIDING"], ["STEP_UP", "CANCELLED"],
    ["DECIDING", "ISSUED"], ["DECIDING", "SAFE_STOP"],
    ["ISSUED", "ACTIVE"], ["ISSUED", "CANCELLED"],
    ["ACTIVE", "SETTLED"],
  ];

  it("allows exactly the documented transitions, nothing else", () => {
    for (const from of ALL) {
      for (const to of ALL) {
        const expected = legal.some(([f, t]) => f === from && t === to);
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(expected);
      }
    }
  });

  it("payment can only settle from ACTIVE (never from ISSUED, DECIDING or a cancelled path)", () => {
    for (const from of ALL.filter((s) => s !== "ACTIVE")) expect(canTransition(from, "SETTLED")).toBe(false);
  });

  it("a denied 0G decision or failure can never reach ISSUED except through ALLOW path", () => {
    expect(canTransition("SAFE_STOP", "ISSUED")).toBe(false);
    expect(canTransition("PENDING", "ISSUED")).toBe(false); // must pass DECIDING
    expect(canTransition("STEP_UP", "ISSUED")).toBe(false);
  });

  it("terminal states have no exits and match shared TERMINAL_STATES", () => {
    for (const s of ALL) expect(isTerminal(s)).toBe(TERMINAL_STATES.includes(s));
    for (const s of TERMINAL_STATES) for (const to of ALL) expect(canTransition(s, to)).toBe(false);
  });

  it("transition() throws INTERNAL on illegal moves", () => {
    expect(transition("PENDING", "DECIDING")).toBe("DECIDING");
    expect(() => transition("SETTLED", "ACTIVE", "s_1")).toThrowError(/illegal session transition/);
  });
});

describe("policy", () => {
  const base = (over: Partial<PolicyInput> = {}, dev: Partial<PolicyInput["device"]> = {}, ag: Partial<PolicyInput["agent"]> = {}): PolicyInput => ({
    amount: 100n,
    stepUpThreshold: 200n,
    agent: { dailyCap: 1000n, spentToday: 0n, allowedDeviceIds: ["d1"], ...ag },
    device: { id: "d1", online: true, recentSessionCount: 0, maxSessionsPerWindow: 3, ...dev },
    ...over,
  });

  const cases: Array<[string, PolicyInput, string, string?]> = [
    ["within limits", base(), "ALLOW"],
    ["amount equal to threshold is still ALLOW", base({ amount: 200n }), "ALLOW"],
    ["above threshold needs step-up", base({ amount: 201n }), "STEP_UP"],
    ["device offline", base({}, { online: false }), "DENY", "DEVICE_OFFLINE"],
    ["not on allowlist", base({}, {}, { allowedDeviceIds: ["d2"] }), "DENY", "POLICY_DENIED"],
    ["empty allowlist denies", base({}, {}, { allowedDeviceIds: [] }), "DENY", "POLICY_DENIED"],
    ["device rate limit", base({}, { recentSessionCount: 3 }), "DENY", "RATE_LIMITED"],
    ["cap exactly reached is allowed", base({ amount: 100n }, {}, { spentToday: 900n }), "ALLOW"],
    ["cap exceeded", base({ amount: 101n }, {}, { spentToday: 900n }), "DENY", "POLICY_DENIED"],
    ["cap beats step-up (deny, not step-up)", base({ amount: 5000n }), "DENY", "POLICY_DENIED"],
    ["non-positive amount", base({ amount: 0n }), "DENY", "POLICY_DENIED"],
  ];

  it.each(cases)("%s", (_name, input, verdict, code) => {
    const r = evaluatePolicy(input);
    expect(r.verdict).toBe(verdict);
    if (code && r.verdict === "DENY") expect(r.code).toBe(code);
  });

  it("offline is reported before allowlist and cap problems", () => {
    const r = evaluatePolicy(base({ amount: 9999n }, { online: false }, { allowedDeviceIds: [] }));
    expect(r).toMatchObject({ verdict: "DENY", code: "DEVICE_OFFLINE" });
  });

  it("converts HBAR threshold to tinybar", () => {
    expect(hbarToTinybar(2)).toBe(200_000_000n);
    expect(() => hbarToTinybar(-1)).toThrow();
    expect(() => hbarToTinybar(1.5)).toThrow();
  });
});
