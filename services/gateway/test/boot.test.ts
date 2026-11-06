import { describe, expect, it } from "vitest";
import { AgentMeterError } from "@agentmeter/shared";
import { createApp } from "../src/app";
import { ConfigError, loadConfig } from "../src/config";
import { createLogger } from "../src/logger";
import { buildPorts } from "../src/ports";

describe("config", () => {
  it("boots on defaults with all adapters fake and no keys", () => {
    const c = loadConfig({});
    expect(c.env.PORT).toBe(8787);
    expect(c.env.ACK_TIMEOUT_MS).toBe(8000);
    expect(c.env.ZG_TIMEOUT_MS).toBe(4000);
    expect(Object.values(c.adapters).every((m) => m === "fake")).toBe(true);
  });

  it("fails fast listing every key a real adapter is missing", () => {
    expect(() => loadConfig({ ADAPTERS: "real" })).toThrow(ConfigError);
    try {
      loadConfig({ DECIDER: "real" });
    } catch (e) {
      expect((e as Error).message).toContain("ZG_COMPUTE_API_KEY");
      expect((e as Error).message).toContain("real decider");
    }
  });

  it("per-port override beats ADAPTERS", () => {
    const c = loadConfig({
      ADAPTERS: "real",
      DECIDER: "fake",
      FACILITATOR: "fake",
      EPISODES: "fake",
      AUDIT: "fake",
      STEPUP: "fake",
    });
    expect(c.adapters.decider).toBe("fake");
  });

  it("rejects invalid values", () => {
    expect(() => loadConfig({ PORT: "-1" })).toThrow(ConfigError);
    expect(() => loadConfig({ ADAPTERS: "maybe" })).toThrow(ConfigError);
  });
});

describe("ports", () => {
  it("refuses to silently fall back to a fake when real is requested but unwired", () => {
    const c = loadConfig({
      DECIDER: "real",
      ZG_COMPUTE_BASE_URL: "https://router-api.0g.ai/v1",
      ZG_COMPUTE_API_KEY: "k",
      ZG_MODEL: "m",
    });
    expect(() => buildPorts(c)).toThrow(/not wired yet/);
  });
});

describe("app", () => {
  const log = createLogger("silent");
  const app = createApp({
    log,
    adapters: loadConfig({}).adapters,
    startedAt: 1000,
    now: () => 1010,
  });

  it("GET /health", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, uptimeSec: 10 });
    expect(body.adapters.decider).toBe("fake");
  });

  it("maps AgentMeterError to the documented error body and status", async () => {
    const a = createApp({ log, adapters: loadConfig({}).adapters, startedAt: 0, now: () => 0 });
    a.get("/boom", () => {
      throw new AgentMeterError("PAYMENT_REPLAY", "seen before", "s_1");
    });
    const res = await a.request("/boom");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: "PAYMENT_REPLAY", message: "seen before", sessionId: "s_1" } });
  });

  it("does not leak internals on unexpected errors", async () => {
    const a = createApp({ log, adapters: loadConfig({}).adapters, startedAt: 0, now: () => 0 });
    a.get("/boom", () => {
      throw new Error("secret stack detail");
    });
    const res = await a.request("/boom");
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("secret");
  });
});
