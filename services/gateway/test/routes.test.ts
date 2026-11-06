import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  AgentView,
  AuditRow,
  DeviceView,
  ErrorBody,
  FakeAuditLog,
  FakeClock,
  FakeDecider,
  FakeEpisodeStore,
  FakeFacilitator,
  FakeStepUp,
  SessionView,
  generateSeedBase64,
  publicKeyFromSeedBase64,
} from "@agentmeter/shared";
import { sha256, type Db, type Repos } from "@agentmeter/db";
import { pino } from "pino";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { Orchestrator } from "../src/core/orchestrator";
import { hashscanUrl } from "../src/http/views";
import type { Ports } from "../src/ports";
import { FakeDevice, makeTestDb } from "./helpers";

let db: Db;
let repos: Repos;
let close: () => Promise<void>;
const seed = generateSeedBase64();
const log = pino({ level: "silent" });

let ports: Ports & { facilitator: FakeFacilitator; decider: FakeDecider; stepUp: FakeStepUp };
let device: FakeDevice;
let orch: Orchestrator;
let app: ReturnType<typeof createApp>;
let n = 0;

beforeAll(() => {
  ({ db, repos, close } = makeTestDb("routes"));
}, 60_000);
afterAll(async () => close?.());

beforeEach(async () => {
  for (const m of [db.sessionEvent, db.stepUp, db.session, db.usedNonce, db.agent, db.device]) await (m as any).deleteMany();
  await db.device.create({
    data: { id: "d1", name: "Charger", pricePerMinute: "10000000", payTo: "0.0.9", tokenHash: sha256("t"), hmacSecret: "h" },
  });
  await db.agent.create({
    data: { id: "a1", name: "Bot", hederaAccountId: "0.0.1001", dailyCap: "1000000000", allowedDeviceIds: JSON.stringify(["d1"]) },
  });
  const clock = new FakeClock();
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
    stepUpThreshold: 200_000_000n,
    ackTimeoutMs: 100,
    zgTimeoutMs: 50,
  });
  app = createApp({
    log,
    adapters: loadConfig({}).adapters,
    startedAt: 0,
    now: () => clock.now(),
    checkDb: async () => (await repos.ping(), true),
    api: { orchestrator: orch, repos, hub: device, clock, rateLimit: { max: 5, windowSec: 60 } },
  });
});

const post = (body: unknown, headers: Record<string, string> = {}, id = "d1") =>
  app.request(`/devices/${id}/session`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const pay = () => ({ "X-PAYMENT": `pay-${++n}` });

describe("POST /devices/:id/session", () => {
  it("returns 402 with x402 requirements and a PAYMENT-REQUIRED header when unpaid", async () => {
    const res = await post({ minutes: 2, agentId: "a1" });
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.x402Version).toBe(2);
    expect(body.accepts[0]).toMatchObject({ scheme: "exact", network: "hedera:testnet", amount: "20000000", payTo: "0.0.9" });
    const hdr = JSON.parse(Buffer.from(res.headers.get("PAYMENT-REQUIRED")!, "base64").toString());
    expect(hdr.accepts[0].amount).toBe("20000000");
    expect(ports.facilitator.calls).not.toContain("settle");
  });

  it("paid request is accepted (202) and ends SETTLED with a tx id and HashScan link", async () => {
    const res = await post({ minutes: 1, agentId: "a1" }, pay());
    expect(res.status).toBe(202);
    const { sessionId, state } = await res.json();
    expect(state).toBe("DECIDING");
    await orch.idle();
    for (let i = 0; i < 100 && (await repos.sessions.get(sessionId))?.state !== "SETTLED"; i++) await new Promise((r) => setTimeout(r, 20));
    const s = SessionView.parse(await (await app.request(`/sessions/${sessionId}`)).json());
    expect(s.state).toBe("SETTLED");
    expect(s.hederaTxId).toBeTruthy();
    expect(s.events.map((e) => e.state)).toEqual(["PENDING", "DECIDING", "ISSUED", "ACTIVE", "SETTLED"]);
    const audit = (await (await app.request("/audit")).json()).map((r: unknown) => AuditRow.parse(r));
    expect(audit[0].hashscanUrl).toMatch(/^https:\/\/hashscan\.io\/testnet\/transaction\/0\.0\.1001-\d+-\d+$/);
  });

  it("rejects a replayed payment with 409 PAYMENT_REPLAY", async () => {
    const h = pay();
    expect((await post({ minutes: 1, agentId: "a1" }, h)).status).toBe(202);
    await orch.idle();
    const res = await post({ minutes: 1, agentId: "a1" }, h);
    expect(res.status).toBe(409);
    expect(ErrorBody.parse(await res.json()).error.code).toBe("PAYMENT_REPLAY");
  });

  it("validates the body (400) and the device (404)", async () => {
    expect((await post({ minutes: 0, agentId: "a1" })).status).toBe(400);
    expect((await post({ agentId: "a1" })).status).toBe(400);
    const res = await post({ minutes: 1, agentId: "a1" }, pay(), "nope");
    expect(res.status).toBe(404);
    expect(ErrorBody.parse(await res.json()).error.code).toBe("NOT_FOUND");
  });

  it("over threshold answers 202 STEP_UP with a URL; callback approve resumes, deny cancels", async () => {
    const res = await post({ minutes: 30, agentId: "a1" }, pay());
    expect(res.status).toBe(202);
    const { sessionId, state, stepUpUrl } = await res.json();
    expect(state).toBe("STEP_UP");
    const st = new URL(stepUpUrl).searchParams.get("state")!;
    const cb = await app.request(`/stepup/callback?state=${st}&code=c`);
    expect(await cb.json()).toEqual({ sessionId, result: "APPROVED" });
    await orch.idle();
    for (let i = 0; i < 100 && (await repos.sessions.get(sessionId))?.state !== "SETTLED"; i++) await new Promise((r) => setTimeout(r, 20));
    expect((await repos.sessions.get(sessionId))?.state).toBe("SETTLED");

    ports.stepUp.outcome = "DENIED";
    const r2 = await (await post({ minutes: 30, agentId: "a1" }, pay())).json();
    const st2 = new URL(r2.stepUpUrl).searchParams.get("state")!;
    expect(await (await app.request(`/stepup/callback?state=${st2}&error=access_denied`)).json()).toMatchObject({ result: "DENIED" });
    expect((await repos.sessions.get(r2.sessionId))?.state).toBe("CANCELLED");
    expect(device.received).toHaveLength(1); // only the approved one reached the device
  });

  it("step-up callback state is single use and required", async () => {
    expect((await app.request("/stepup/callback")).status).toBe(400);
    expect((await app.request("/stepup/callback?state=bogus")).status).toBe(403);
  });

  it("rate limits per agent (429)", async () => {
    for (let i = 0; i < 5; i++) await post({ minutes: 1, agentId: "a1" });
    const res = await post({ minutes: 1, agentId: "a1" });
    expect(res.status).toBe(429);
    expect(ErrorBody.parse(await res.json()).error.code).toBe("RATE_LIMITED");
  });
});

describe("reads", () => {
  it("GET /sessions/:id 404s for unknown ids", async () => {
    expect((await app.request("/sessions/nope")).status).toBe(404);
  });

  it("GET /devices and /agents match the shared schemas", async () => {
    const devices = (await (await app.request("/devices")).json()).map((d: unknown) => DeviceView.parse(d));
    expect(devices[0]).toMatchObject({ id: "d1", status: "ONLINE", pricePerMinute: "10000000" });
    device.mode = "offline";
    expect((await (await app.request("/devices")).json())[0].status).toBe("OFFLINE");
    const agents = (await (await app.request("/agents")).json()).map((a: unknown) => AgentView.parse(a));
    expect(agents[0]).toMatchObject({ id: "a1", spentToday: "0" });
  });

  it("hashscanUrl converts a Hedera tx id", () => {
    expect(hashscanUrl("0.0.1001@1789000000.123456789")).toBe("https://hashscan.io/testnet/transaction/0.0.1001-1789000000-123456789");
    expect(hashscanUrl(null)).toBeNull();
  });
});

describe("GET /events (SSE)", () => {
  it("streams session events as they happen", async () => {
    const res = await app.request("/events");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = "";
    const pump = (async () => {
      while (!text.includes('"state":"SETTLED"')) {
        const { value, done } = await reader.read();
        if (done) break;
        text += dec.decode(value);
      }
    })();
    await post({ minutes: 1, agentId: "a1" }, pay());
    await Promise.race([pump, new Promise((_, rej) => setTimeout(() => rej(new Error(`SSE timeout; got: ${text}`)), 5000))]);
    await reader.cancel();
    expect(text).toContain("event: ready");
    expect(text).toContain("event: session");
    expect(text).toContain('"state":"PENDING"');
  });
});
