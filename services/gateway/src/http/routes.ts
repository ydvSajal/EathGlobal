/** REST + SSE routes (docs/API.md §1). Thin: parse, call the orchestrator or repos, shape the response. */
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { AgentMeterError, CreateSessionBody, type Clock } from "@agentmeter/shared";
import type { Repos } from "@agentmeter/db";
import type { Logger } from "pino";
import type { Orchestrator } from "../core/orchestrator";
import type { DeviceHub } from "../ws/devices";
import { RateLimiter } from "./ratelimit";
import { agentView, auditRow, deviceView, sessionView } from "./views";

export interface ApiContext {
  orchestrator: Orchestrator;
  repos: Repos;
  hub: Pick<DeviceHub, "isOnline" | "onStatus">;
  clock: Clock;
  hederaNetwork?: string;
  rateLimit?: { max: number; windowSec: number };
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");

export function mountApi(app: Hono, ctx: ApiContext, log: Logger) {
  const { orchestrator, repos, hub, clock } = ctx;
  // The orchestrator's flow never rejects (it fails safe); if it ever does, say so loudly.
  const flowRejected = (sessionId: string) => (e: unknown) =>
    log.error({ sessionId, err: e instanceof Error ? e.message : String(e) }, "session flow rejected unexpectedly");
  const limiter = new RateLimiter(ctx.rateLimit?.max ?? 10, ctx.rateLimit?.windowSec ?? 60);
  const network = ctx.hederaNetwork ?? "testnet";

  // --- x402-protected: POST /devices/:id/session ---------------------------------------------
  app.post("/devices/:id/session", async (c) => {
    const deviceId = c.req.param("id");
    const parsed = CreateSessionBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new AgentMeterError("BAD_REQUEST", "body must be {minutes: 1-240, agentId}");
    const { minutes, agentId } = parsed.data;
    limiter.check(agentId, clock.now());

    const paymentHeader = c.req.header("X-PAYMENT") ?? c.req.header("PAYMENT-SIGNATURE");
    if (!paymentHeader) {
      const { requirements } = await orchestrator.quote(deviceId, minutes);
      c.header("PAYMENT-REQUIRED", b64(requirements)); // x402 v2 clients read this header
      return c.json({ ...requirements, error: "PAYMENT_REQUIRED" }, 402);
    }

    const r = await orchestrator.startSession({ deviceId, agentId, minutes, paymentHeader });
    r.done.catch(flowRejected(r.sessionId)); // outcome is observed via /sessions and /events
    return c.json({ sessionId: r.sessionId, state: r.state, ...(r.stepUpUrl ? { stepUpUrl: r.stepUpUrl } : {}) }, 202);
  });

  app.get("/sessions/:id", async (c) => {
    const s = await repos.sessions.get(c.req.param("id"));
    if (!s) throw new AgentMeterError("NOT_FOUND", "session not found");
    return c.json(sessionView(s));
  });

  // --- World step-up callback (forwarded server-side by apps/web /api/world/callback) ---------
  app.get("/stepup/callback", async (c) => {
    const state = c.req.query("state");
    if (!state) throw new AgentMeterError("BAD_REQUEST", "state is required");
    const res = await orchestrator.completeStepUp({ state, code: c.req.query("code"), error: c.req.query("error") });
    res.done.catch(flowRejected(res.sessionId));
    return c.json({ sessionId: res.sessionId, result: res.result });
  });

  // --- reads for the dashboard ----------------------------------------------------------------
  app.get("/devices", async (c) =>
    c.json((await repos.devices.list()).map((d) => deviceView(d, hub.isOnline(d.id)))),
  );

  app.get("/agents", async (c) => {
    const now = clock.now();
    return c.json((await repos.agents.list()).map((a) => agentView(a, repos.agents.spentOn(a, now))));
  });

  app.get("/audit", async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200);
    return c.json((await repos.sessions.list(limit)).map((s) => auditRow(s, network)));
  });

  // --- live events (SSE): `session` and `device` ----------------------------------------------
  app.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      const offSession = orchestrator.onEvent((e) => void stream.writeSSE({ event: "session", data: JSON.stringify(e) }));
      const offDevice = hub.onStatus((e) => void stream.writeSSE({ event: "device", data: JSON.stringify(e) }));
      let open = true;
      stream.onAbort(() => {
        open = false;
        offSession();
        offDevice();
      });
      await stream.writeSSE({ event: "ready", data: "{}" });
      while (open) {
        await stream.sleep(15_000);
        if (open) await stream.write(": keepalive\n\n");
      }
    }),
  );
}
