import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, createRepos, sha256, utcDay, type Db, type Repos } from "../src";

let dir: string;
let db: Db;
let repos: Repos;
const T = 1_789_000_000;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agentmeter-db-"));
  const url = `file:${join(dir, "test.db").replace(/\\/g, "/")}`;
  execSync("npx prisma db push --skip-generate", { env: { ...process.env, DATABASE_URL: url }, stdio: "ignore" });
  db = createDb(url);
  repos = createRepos(db);
  await db.device.create({
    data: { id: "d1", name: "x", pricePerMinute: "10", payTo: "0.0.9", tokenHash: sha256("tok"), hmacSecret: "h" },
  });
  await db.agent.create({
    data: { id: "a1", name: "x", hederaAccountId: "0.0.1001", dailyCap: "100", allowedDeviceIds: JSON.stringify(["d1"]) },
  });
}, 60_000);

afterAll(async () => {
  await db?.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

const newSession = (id: string, hash: string) =>
  repos.sessions.create({ id, deviceId: "d1", agentId: "a1", amount: "10", asset: "HBAR", minutes: 1, paymentPayloadHash: hash, now: T });

describe("repos", () => {
  it("creates a PENDING session with a first event", async () => {
    await newSession("s1", "h1");
    const s = await repos.sessions.get("s1");
    expect(s?.state).toBe("PENDING");
    expect(s?.events.map((e) => e.state)).toEqual(["PENDING"]);
  });

  it("rejects a reused payment payload hash as PAYMENT_REPLAY", async () => {
    await expect(newSession("s2", "h1")).rejects.toMatchObject({ code: "PAYMENT_REPLAY" });
  });

  it("move is compare-and-set and appends events", async () => {
    await repos.sessions.move("s1", "PENDING", "DECIDING", T + 1);
    await expect(repos.sessions.move("s1", "PENDING", "DECIDING", T + 2)).rejects.toMatchObject({ code: "INTERNAL" });
    await repos.sessions.move("s1", "DECIDING", "ISSUED", T + 3, { nonce: "n".repeat(32), expiresAt: T + 60 });
    const s = await repos.sessions.get("s1");
    expect(s?.state).toBe("ISSUED");
    expect(s?.events.map((e) => e.state)).toEqual(["PENDING", "DECIDING", "ISSUED"]);
    expect(s?.expiresAt).toBe(T + 60);
  });

  it("server-side nonce guard is single use", async () => {
    expect(await repos.nonces.use("abc", T)).toBe(true);
    expect(await repos.nonces.use("abc", T)).toBe(false);
  });

  it("device auth checks the token hash", async () => {
    expect(await repos.devices.authenticate("d1", "tok")).not.toBeNull();
    expect(await repos.devices.authenticate("d1", "wrong")).toBeNull();
  });

  it("agent spend resets per UTC day and parses the allowlist", async () => {
    await repos.agents.addSpend("a1", 30n, T);
    await repos.agents.addSpend("a1", 20n, T + 10);
    let a = (await repos.agents.get("a1"))!;
    expect(repos.agents.spentOn(a, T)).toBe(50n);
    expect(repos.agents.spentOn(a, T + 86_400)).toBe(0n); // next day
    await repos.agents.addSpend("a1", 5n, T + 86_400);
    a = (await repos.agents.get("a1"))!;
    expect(a.spentToday).toBe("5");
    expect(a.spentDay).toBe(utcDay(T + 86_400));
    expect(repos.agents.allowedDeviceIds(a)).toEqual(["d1"]);
  });

  it("step-up state is consumed exactly once", async () => {
    await repos.stepUps.create({ id: "su1", sessionId: "s1", state: "st1", nonce: "n", codeVerifier: "v", now: T, ttlSec: 300 });
    const r = await repos.stepUps.consume("st1", "APPROVED", { worldSub: "sub", authTime: T });
    expect(r.status).toBe("APPROVED");
    await expect(repos.stepUps.consume("st1", "APPROVED")).rejects.toMatchObject({ code: "STEP_UP_DENIED" });
  });

  it("counts recent sessions per device for rate limiting", async () => {
    expect(await repos.sessions.countForDeviceSince("d1", T - 1)).toBe(1);
    expect(await repos.sessions.countForDeviceSince("d1", T + 1)).toBe(0);
  });
});
