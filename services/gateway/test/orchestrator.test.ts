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
  orch = new Orchestrator(repos, ports, device, log, OPTS);
});

const OPTS = {
  receiptSeedBase64: seed,
  stepUpThreshold: 200_000_000n, // 2 HBAR
  ackTimeoutMs: 100,
  zgTimeoutMs: 50,
  settleBackoffMs: 0,
};

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

  it("settle failing all 3 attempts switches the device off and cancels unpaid (no free usage)", async () => {
    ports.facilitator.settleOk = false;
    const s = await finish(await start());
    expect(s.state).toBe("CANCELLED");
    expect(s.events.map((e) => e.state)).toEqual(["PENDING", "DECIDING", "ISSUED", "ACTIVE", "CANCELLED"]);
    expect(s.events.at(-1)?.detail).toBe("settle failed: device switched off, unpaid");
    expect(s.hederaTxId).toBeNull();
    expect(device.cancelled).toContain(s.id);
    expect(ports.facilitator.calls.filter((c) => c === "settle")).toHaveLength(3);
    expect((await repos.agents.get("a1"))!.spentToday).toBe("0");
  });

  it("settle that fails twice (error, then failure) and succeeds on the 3rd attempt ends SETTLED", async () => {
    const realSettle = ports.facilitator.settle.bind(ports.facilitator);
    let tries = 0;
    ports.facilitator.settle = async (h, req) => {
      tries++;
      if (tries === 1) throw new Error("facilitator 503");
      if (tries === 2) return { success: false, error: "flaky" };
      return realSettle(h, req);
    };
    const s = await finish(await start());
    expect(tries).toBe(3);
    expect(s.state).toBe("SETTLED");
    expect(s.hederaTxId).toBeTruthy();
    expect(device.cancelled).toHaveLength(0);
  });

  it("a bookkeeping failure AFTER a successful settle never re-settles or switches the paid device off", async () => {
    const realAddSpend = repos.agents.addSpend;
    repos.agents.addSpend = async () => {
      throw new Error("db write failed after settle");
    };
    try {
      const s = await finish(await start());
      expect(s.state).toBe("SETTLED"); // the state move happened before the failing spend write
      expect(s.hederaTxId).toBeTruthy();
      expect(device.cancelled).toHaveLength(0); // paid device stays on
      expect(ports.facilitator.calls.filter((c) => c === "settle")).toHaveLength(1); // money moved exactly once
    } finally {
      repos.agents.addSpend = realAddSpend;
    }
  });

  describe("catch-all fail-safe (unexpected errors after PENDING)", () => {
    const dbDown = async (): Promise<boolean> => {
      throw new Error("disk I/O error");
    };

    it("device channel throws while ISSUED => CANCELLED, device told to cancel, no settle, done resolves", async () => {
      device.deliver = async () => {
        throw new Error("socket exploded");
      };
      const r = await start();
      await expect(r.done).resolves.toBeUndefined();
      const s = await finish(r);
      expect(s.state).toBe("CANCELLED");
      expect(s.events.at(-1)?.detail).toBe("fail-safe: socket exploded");
      expect(device.cancelled).toContain(s.id);
      expect(ports.facilitator.calls).not.toContain("settle");
    });

    it("DB fails at the nonce step while DECIDING => SAFE_STOP, device never receives a receipt", async () => {
      orch = new Orchestrator({ ...repos, nonces: { use: dbDown } }, ports, device, log, OPTS);
      const s = await finish(await start());
      expect(s.state).toBe("SAFE_STOP");
      expect(device.received).toHaveLength(0);
      expect(ports.facilitator.calls).not.toContain("settle");
    });

    it("the catch-all itself never rejects, even when it cannot read the session", async () => {
      let gets = 0;
      const sessions = {
        ...repos.sessions,
        get: async (id: string) => {
          if (++gets > 1) throw new Error("db gone"); // 1st read: the flow; 2nd read: the catch-all
          return repos.sessions.get(id);
        },
      };
      orch = new Orchestrator({ ...repos, sessions, nonces: { use: dbDown } } as unknown as Repos, ports, device, log, OPTS);
      const r = await start();
      await expect(r.done).resolves.toBeUndefined();
      await orch.idle();
      expect(gets).toBe(2);
      expect(device.received).toHaveLength(0);
      expect(ports.facilitator.calls).not.toContain("settle");
    });
  });

  describe("step-up TTL", () => {
    it("a step-up older than the TTL is cancelled by the sweeper; nothing settles", async () => {
      const r = await start(30);
      clock.advance(299);
      await orch.expireStaleStepUps();
      expect((await repos.sessions.get(r.sessionId))!.state).toBe("STEP_UP"); // still inside the TTL
      clock.advance(2);
      await orch.expireStaleStepUps();
      await orch.idle();
      const s = (await repos.sessions.get(r.sessionId))!;
      expect(s.state).toBe("CANCELLED");
      expect(s.events.at(-1)?.detail).toBe("step-up expired");
      expect(ports.audit.entries.at(-1)).toMatchObject({ sessionId: r.sessionId, state: "CANCELLED" });
      expect(device.received).toHaveLength(0);
      expect(ports.facilitator.calls).not.toContain("settle");
    });

    it("a late approve after expiry is rejected with STEP_UP_EXPIRED and never resumes the flow", async () => {
      const r = await start(30);
      clock.advance(301);
      await orch.expireStaleStepUps();
      const state = new URL(r.stepUpUrl!).searchParams.get("state")!;
      await expect(orch.completeStepUp({ state, code: "c" })).rejects.toMatchObject({ code: "STEP_UP_EXPIRED" });
      await orch.idle();
      expect((await repos.sessions.get(r.sessionId))!.state).toBe("CANCELLED");
      expect(device.received).toHaveLength(0);
      expect(ports.facilitator.calls).not.toContain("settle");
    });
  });

  it("in-flight sessions reserve the daily cap: a concurrent second session over the cap is denied", async () => {
    await db.agent.update({ where: { id: "a1" }, data: { dailyCap: "10000000" } }); // exactly one 1-minute session
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const deliver = device.deliver.bind(device);
    device.deliver = async (id, msg) => {
      await gate; // hold the first session before the device acks
      return deliver(id, msg);
    };
    const first = await start();
    await expect(start()).rejects.toMatchObject({ code: "POLICY_DENIED", message: "agent daily cap exceeded" });
    release();
    expect((await finish(first)).state).toBe("SETTLED");
    expect(device.received).toHaveLength(1);
    expect(ports.facilitator.calls.filter((c) => c === "settle")).toHaveLength(1);
  });

  it("recoverOrphans (boot) moves every unsettled session to a terminal state and never settles", async () => {
    const seedSession = (id: string, state: string) =>
      db.session.create({
        data: {
          id, deviceId: "d1", agentId: "a1", amount: "10000000", asset: "HBAR", minutes: 1, state,
          paymentPayloadHash: `h-${id}`, createdAt: clock.now(), updatedAt: clock.now(),
          ...(state === "SETTLED" ? { hederaTxId: "0.0.1001@1789000000.1" } : {}),
        },
      });
    const expected: Record<string, [string, string]> = {
      PENDING: ["CANCELLED", "gateway restarted"],
      STEP_UP: ["CANCELLED", "gateway restarted"],
      DECIDING: ["SAFE_STOP", "gateway restarted"],
      ISSUED: ["CANCELLED", "gateway restarted"],
      ACTIVE: ["CANCELLED", "gateway restarted before settlement"],
    };
    for (const st of [...Object.keys(expected), "SETTLED", "SAFE_STOP"]) await seedSession(`o-${st}`, st);

    await orch.recoverOrphans();
    await orch.idle();

    for (const [from, [to, detail]] of Object.entries(expected)) {
      const s = (await repos.sessions.get(`o-${from}`))!;
      expect(s.state, from).toBe(to);
      expect(s.events.at(-1)?.detail, from).toBe(detail);
      expect(s.hederaTxId, from).toBeNull();
    }
    expect((await repos.sessions.get("o-SETTLED"))!.state).toBe("SETTLED"); // terminal sessions untouched
    expect((await repos.sessions.get("o-SAFE_STOP"))!.events).toHaveLength(0);
    expect([...device.cancelled].sort()).toEqual(["o-ACTIVE", "o-ISSUED"]);
    expect(ports.facilitator.calls).not.toContain("settle");
    expect(ports.audit.entries).toHaveLength(5); // one HCS entry per recovered session
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
