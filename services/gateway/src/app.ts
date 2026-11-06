/** Hono app factory. Routes are added per task (B5); B1 ships /health and the error contract. */
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { AgentMeterError, type ErrorCode } from "@agentmeter/shared";
import type { Logger } from "pino";
import type { AdapterModes } from "./config";

export interface AppDeps {
  log: Logger;
  adapters: AdapterModes;
  startedAt: number; // unix seconds
  now: () => number;
}

/** HTTP status for each stable error code (docs/API.md). */
export const STATUS: Record<ErrorCode, ContentfulStatusCode> = {
  PAYMENT_REQUIRED: 402,
  PAYMENT_UNVERIFIED: 402,
  PAYMENT_REPLAY: 409,
  POLICY_DENIED: 403,
  STEP_UP_REQUIRED: 402,
  STEP_UP_DENIED: 403,
  STEP_UP_EXPIRED: 403,
  DECISION_DENIED: 403,
  SAFE_STOP: 409, // terminal, device stays off; not a server fault
  DEVICE_OFFLINE: 409,
  DEVICE_NO_ACK: 504,
  DEVICE_REJECTED: 409,
  SETTLE_FAILED: 502,
  RATE_LIMITED: 429,
  TIMEOUT: 504,
  INTERNAL: 500,
};

export function createApp(deps: AppDeps) {
  const app = new Hono();

  app.use("*", cors({ origin: "*", exposeHeaders: ["X-PAYMENT-RESPONSE"] }));

  app.get("/health", (c) =>
    c.json({
      ok: true,
      // db and per-dependency last-success times are filled in by B2 and the adapters.
      db: "unconfigured",
      adapters: deps.adapters,
      deps: {},
      uptimeSec: deps.now() - deps.startedAt,
    }),
  );

  app.onError((err, c) => {
    if (err instanceof AgentMeterError) {
      deps.log.warn({ code: err.code, sessionId: err.sessionId }, err.message);
      return c.json({ error: { code: err.code, message: err.message, sessionId: err.sessionId } }, STATUS[err.code]);
    }
    deps.log.error({ err: err.message }, "unhandled error");
    return c.json({ error: { code: "INTERNAL" as const, message: "internal error" } }, 500);
  });

  app.notFound((c) => c.json({ error: { code: "INTERNAL" as const, message: "not found" } }, 404));

  return app;
}
