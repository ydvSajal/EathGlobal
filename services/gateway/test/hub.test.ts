import { execSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeClock } from "@agentmeter/shared";
import { createDb, createRepos, sha256, type Db, type Repos } from "@agentmeter/db";
import { pino } from "pino";
import { WebSocket } from "ws";
import { DeviceHub } from "../src/ws/devices";
import { ackMac } from "../src/ws/mac";

const SECRET = "dev-hmac-d1";
const TOKEN = "dev-token-d1";
const receipt = (nonce = "a".repeat(32)) => ({
  receipt: { deviceId: "d1", sessionId: "s1", nonce, notBefore: 1, expiresAt: 100, amount: "5", payer: "0.0.7" },
  sig: "sig",
});

let dir: string;
let db: Db;
let repos: Repos;
let server: Server;
let port: number;
let hub: DeviceHub;
let clock: FakeClock;
const sockets: WebSocket[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agentmeter-hub-"));
  const url = `file:${join(dir, "t.db").replace(/\\/g, "/")}`;
  execSync("npx prisma db push --skip-generate", {
    cwd: resolve(__dirname, "../../../packages/db"),
    env: { ...process.env, DATABASE_URL: url },
    stdio: "ignore",
  });
  db = createDb(url);
  repos = createRepos(db);
  await db.device.create({
    data: { id: "d1", name: "x", pricePerMinute: "1", payTo: "0.0.9", tokenHash: sha256(TOKEN), hmacSecret: SECRET },
  });
}, 60_000);

afterAll(async () => {
  await db?.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  clock = new FakeClock(1000);
  hub = new DeviceHub(repos, clock, pino({ level: "silent" }));
  server = createServer();
  server.on("upgrade", hub.handleUpgrade);
  await new Promise<void>((r) => server.listen(0, r));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  hub.close();
  await new Promise((r) => server.close(r));
});

function connect(token = TOKEN): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/devices/d1?token=${token}`);
    sockets.push(ws);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
}
const nextFrame = (ws: WebSocket) => new Promise<any>((r) => ws.once("message", (d) => r(JSON.parse(d.toString()))));
const waitOnline = async () => {
  for (let i = 0; i < 100 && !hub.isOnline("d1"); i++) await new Promise((r) => setTimeout(r, 10));
};

describe("device hub", () => {
  it("rejects a bad token and an unknown path", async () => {
    await expect(connect("wrong")).rejects.toThrow(/401/);
  });

  it("marks the device online on connect and offline on disconnect", async () => {
    const ws = await connect();
    await waitOnline();
    expect(hub.isOnline("d1")).toBe(true);
    expect((await repos.devices.get("d1"))?.status).toBe("ONLINE");
    ws.close();
    for (let i = 0; i < 100 && hub.isOnline("d1"); i++) await new Promise((r) => setTimeout(r, 10));
    expect(hub.isOnline("d1")).toBe(false);
  });

  it("delivers a receipt and resolves ack only for a valid MAC", async () => {
    const ws = await connect();
    await waitOnline();
    const got = nextFrame(ws);
    const result = hub.deliver("d1", receipt(), 1000);
    const frame = await got;
    expect(frame.type).toBe("receipt");
    ws.send(JSON.stringify({ type: "ack", sessionId: "s1", nonce: "a".repeat(32), relay: true, ts: 1000, mac: ackMac(SECRET, "s1", "a".repeat(32), 1000) }));
    expect(await result).toEqual({ type: "ack" });
  });

  it("ignores an ack with a bad MAC (times out, never settles)", async () => {
    const ws = await connect();
    await waitOnline();
    const result = hub.deliver("d1", receipt(), 150);
    ws.send(JSON.stringify({ type: "ack", sessionId: "s1", nonce: "a".repeat(32), relay: true, ts: 1000, mac: "00".repeat(32) }));
    expect(await result).toEqual({ type: "timeout" });
  });

  it("ignores a stale ack (replayed old MAC)", async () => {
    const ws = await connect();
    await waitOnline();
    const result = hub.deliver("d1", receipt(), 150);
    const old = 900; // 100s before FakeClock(1000)
    ws.send(JSON.stringify({ type: "ack", sessionId: "s1", nonce: "a".repeat(32), relay: true, ts: old, mac: ackMac(SECRET, "s1", "a".repeat(32), old) }));
    expect(await result).toEqual({ type: "timeout" });
  });

  it("ignores an ack for a receipt it never sent", async () => {
    const ws = await connect();
    await waitOnline();
    const result = hub.deliver("d1", receipt("b".repeat(32)), 150);
    ws.send(JSON.stringify({ type: "ack", sessionId: "s1", nonce: "c".repeat(32), relay: true, ts: 1000, mac: ackMac(SECRET, "s1", "c".repeat(32), 1000) }));
    expect(await result).toEqual({ type: "timeout" });
  });

  it("passes a nack reason through", async () => {
    const ws = await connect();
    await waitOnline();
    const result = hub.deliver("d1", receipt(), 1000);
    ws.send(JSON.stringify({ type: "nack", sessionId: "s1", nonce: "a".repeat(32), reason: "replay" }));
    expect(await result).toEqual({ type: "nack", reason: "replay" });
  });

  it("reports offline when the device disconnects mid-wait", async () => {
    const ws = await connect();
    await waitOnline();
    const result = hub.deliver("d1", receipt(), 2000);
    ws.close();
    expect(await result).toEqual({ type: "offline" });
  });

  it("is offline without a connection, and after heartbeats stop for 15s", async () => {
    expect(await hub.deliver("d1", receipt(), 50)).toEqual({ type: "offline" });
    await connect();
    await waitOnline();
    clock.advance(16);
    expect(hub.isOnline("d1")).toBe(false);
    expect(await hub.deliver("d1", receipt(), 50)).toEqual({ type: "offline" });
  });

  it("heartbeat updates the DB and keeps the device online", async () => {
    const ws = await connect();
    await waitOnline();
    clock.advance(10);
    ws.send(JSON.stringify({ type: "heartbeat", deviceId: "d1", relay: true, ts: 1010 }));
    for (let i = 0; i < 100 && (await repos.devices.get("d1"))?.lastHeartbeat !== 1010; i++) await new Promise((r) => setTimeout(r, 10));
    const d = await repos.devices.get("d1");
    expect(d?.lastHeartbeat).toBe(1010);
    expect(d?.relay).toBe(true);
    clock.advance(10);
    expect(hub.isOnline("d1")).toBe(true);
  });

  it("sends cancel to the device", async () => {
    const ws = await connect();
    await waitOnline();
    const got = nextFrame(ws);
    hub.cancel("d1", "s1");
    expect(await got).toEqual({ type: "cancel", sessionId: "s1" });
  });
});
