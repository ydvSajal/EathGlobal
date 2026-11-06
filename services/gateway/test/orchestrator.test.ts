import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  FakeAuditLog,
  FakeClock,
  FakeDecider,
  FakeEpisodeStore,
  FakeFacilitator,
  FakeStepUp,
  encodeReceipt,
  generateSeedBase64,
  publicKeyFromSeedBase64,
  verifyReceipt,
} from "@agentmeter/shared";
import { createDb, createRepos, sha256, type Db, type Repos } from "@agentmeter/db";
import { pino } from "pino";
import type { DeliveryResult, DeviceChannel, ReceiptMessage } from "../src/core/device-channel";
import { Orchestrator } from "../src/core/orchestrator";
import type { Ports } from "../src/ports";

/** Behaves like the ESP32: verifies the receipt itself before acking. */
class FakeDevice implements DeviceChannel {
  mode: "verify" | "silent" | "offline" = "verify";
  used = new Set<string>();
  received: ReceiptMessage[] = [];
  cancelled: string[] = [];
  constructor(private pub: string, private clock: FakeClock) {}
  isOnline() {
    return this.mode !== "offline";
  }
  async deliver(_id: string, msg: ReceiptMessage): Promise<DeliveryResult> {
    this.received.push(msg);
    if (this.mode === "offline") return { type: "offline" };
    if (this.mode === "silent") return { type: "timeout" };
    const out = verifyReceipt(encodeReceipt(msg.receipt), msg.sig, this.pub, {
      deviceId: "d1",
      now: this.clock.now(),
      usedNonces: this.used,
    });
    if (!out.ok) return { type: "nack", reason: out.reason };
    this.used.add(msg.receipt.nonce);
    return { type: "ack" };
  }
  cancel(_id: string, sessionId: string) {
    this.cancelled.push(sessionId);
  }
}

let dir: string;
let db: Db;
let repos: Repos;
const seed = generateSeedBase64();
const log = pino({ level: "silent" });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agentmeter-orch-"));
  const url = `file:${join(dir, "t.db").replace(/\\/g, "/")}`;
  execSync("npx prisma db push --skip-generate", {
    cwd: resolve(__dirname, "../../../packages/db"),
    env: { ...process.env, DATABASE_URL: url },
    stdio: "ignore",
  });
  db = createDb(url);
  repos = createRepos(db);
}, 60_000);

afterAll(async () => {
  await db?.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

let clock: FakeClock;
let ports: Ports & { facilitator: FakeFacilitator; decider: FakeDecider; audit: FakeAuditLog; episodes: FakeEpisodeStore; stepUp: FakeStepUp };
let device: FakeDevice;
let orch: Orchestrator;
let n = 0;

beforeEach(async () => {
  await db.sessionEvent.deleteMany();
  await db.stepUp.deleteMany();
  await db.session.deleteMany();
  await db.usedNonce.deleteMany();
  await db.agent.deleteMany();
  await db.device.deleteMany();
  await db.device.create({
    data: { id: "d1", name: "x", pricePerMinute: "10000000", payTo: "0.0.9", tokenHash: sha256("t"), hmacSecret: "h" },
  });
  await db.agent.create({
    data: { id: "a1", name: "x", hederaAccountId: "0.0.1001", dailyCap: "1000000000", allowedDeviceIds: JSON.stringify(["d1"]) },
  });
  clock = new FakeClock();
  ports = {
    facilitator: new FakeFacilitator(),
    decider: new FakeDecider(),
    episodes: new FakeEpisodeStore(),
    audit: new FakeAuditLog(),
    stepUp: new FakeStepUp(),
    clock,
  };
  device = new FakeDevice(publicKeyFromSeedBase64(seed), clock);
  orch = new Orchestrator(repos, ports, device, log, {
    receiptSeedBase64: seed,
    stepUpThreshold: 200_000_000n, // 2 HBAR
    ackTimeoutMs: 100,
    zgTimeoutMs: 50,
  });
});

const start = (minutes = 1, header = `pay-${++n}`) =>
  orch.startSession({ deviceId: "d1", agentId: "a1", minutes, paymentHeader: header });

async function finish(r: { sessionId: string; done: Promise<void> }) {
  await r.done;
  await orch.idle();
  return (await repos.sessions.get(r.sessionId))!;
}

describe("orchestrator", () => {
  it("happy path: verify -> decide -> receipt -> ack -> settle, with audit and episode", async () => {
    const s = await finish(await start(1));
    expect(s.state).toBe("SETTLED");
    expect(s.events.map((e) => e.state)).toEqual(["PENDING", "DECIDING", "ISSUED", "ACTIVE", "SETTLED"]);
    expect(s.hederaTxId).toBeTruthy();
    expect(s.zgRequestId).toMatch(/^fake-req-/);
    expect(s.zgRootHash).toMatch(/^0x/);
    expect(s.hcsSeq).toBeGreaterThan(0);
    expect(ports.facilitator.calls).toEqual(["requirements", "verify", "settle"]);
    expect(ports.audit.entries.map((e) => e.state)).toEqual(["DECIDING", "ISSUED", "ACTIVE", "SETTLED"]);
    expect(ports.episodes.episodes[0]?.outcome).toBe("ALLOW");
    const a = (await repos.agents.get("a1"))!;
    expect(a.spentToday).toBe("10000000");
  });

  it("rejects a replayed payment payload before anything happens", async () => {
    await finish(await start(1, "same"));
    await expect(start(1, "same")).rejects.toMatchObject({ code: "PAYMENT_REPLAY" });
    expect(device.received).toHaveLength(1);
  });

  it("unverified payment never creates a session", async () => {
    ports.facilitator.verifyValid = false;
    await expect(start()).rejects.toMatchObject({ code: "PAYMENT_UNVERIFIED" });
    expect(await db.session.count()).toBe(0);
  });

  it("over the daily cap is denied and cancelled, nothing settles", async () => {
    await db.agent.update({ where: { id: "a1" }, data: { dailyCap: "5" } });
    await expect(start()).rejects.toMatchObject({ code: "POLICY_DENIED" });
    const s = await db.session.findFirstOrThrow();
    expect(s.state).toBe("CANCELLED");
    expect(ports.facilitator.calls).not.toContain("settle");
    expect(device.received).toHaveLength(0);
  });

  it("offline device is denied with DEVICE_OFFLINE", async () => {
    device.mode = "offline";
    await expect(start()).rejects.toMatchObject({ code: "DEVICE_OFFLINE" });
  });

  it("above threshold requires step-up; approve resumes and settles", async () => {
    const r = await start(30); // 3 HBAR > 2 HBAR threshold
    expect(r.state).toBe("STEP_UP");
    expect(r.stepUpUrl).toBeTruthy();
    expect(device.received).toHaveLength(0);
    const state = new URL(r.stepUpUrl!).searchParams.get("state")!;
    const res = await orch.completeStepUp({ state, code: "c" });
    expect(res.result).toBe("APPROVED");
    const s = await finish({ sessionId: r.sessionId, done: res.done });
    expect(s.state).toBe("SETTLED");
  });

  it("step-up denied: cancelled, no receipt, no settle", async () => {
    ports.stepUp.outcome = "DENIED";
    const r = await start(30);
    const state = new URL(r.stepUpUrl!).searchParams.get("state")!;
    const res = await orch.completeStepUp({ state, code: "c" });
    expect(res.result).toBe("DENIED");
    const s = await finish({ sessionId: r.sessionId, done: res.done });
    expect(s.state).toBe("CANCELLED");
    expect(device.received).toHaveLength(0);
    expect(ports.facilitator.calls).not.toContain("settle");
  });

  for (const mode of ["throw", "slow", "malformed", "deny"] as const) {
    it(`0G ${mode} => SAFE_STOP, device never receives a receipt`, async () => {
      ports.decider.mode = mode;
      ports.decider.slowMs = 500;
      const s = await finish(await start());
      expect(s.state).toBe("SAFE_STOP");
      expect(device.received).toHaveLength(0);
      expect(ports.facilitator.calls).not.toContain("settle");
      expect(ports.episodes.episodes[0]?.outcome).toBe(mode === "deny" ? "DENY" : "SAFE_STOP");
    });
  }

  it("no ack => CANCELLED and the payment is never settled", async () => {
    device.mode = "silent";
    const s = await finish(await start());
    expect(s.state).toBe("CANCELLED");
    expect(device.cancelled).toContain(s.id);
    expect(ports.facilitator.calls).not.toContain("settle");
  });

  it("device nack (bad signature) => CANCELLED, no settle", async () => {
    orch = new Orchestrator(repos, ports, device, log, {
      receiptSeedBase64: generateSeedBase64(), // not the key pinned on the device
      stepUpThreshold: 200_000_000n,
      ackTimeoutMs: 100,
      zgTimeoutMs: 50,
    });
    const s = await finish(await start());
    expect(s.state).toBe("CANCELLED");
    expect(s.events.at(-1)?.detail).toContain("signature");
    expect(ports.facilitator.calls).not.toContain("settle");
  });

  it("settle failure leaves the session ACTIVE (never marked settled)", async () => {
    ports.facilitator.settleOk = false;
    const s = await finish(await start());
    expect(s.state).toBe("ACTIVE");
    expect(s.hederaTxId).toBeNull();
  });

  it("audit/episode logging failures never change the decision", async () => {
    ports.audit.append = async () => {
      throw new Error("hcs down");
    };
    ports.episodes.put = async () => {
      throw new Error("storage down");
    };
    const s = await finish(await start());
    expect(s.state).toBe("SETTLED");
  });

  it("emits live events for SSE", async () => {
    const seen: string[] = [];
    orch.onEvent((e) => seen.push(e.state));
    await finish(await start());
    expect(seen).toEqual(["PENDING", "DECIDING", "ISSUED", "ACTIVE", "SETTLED"]);
  });
});
