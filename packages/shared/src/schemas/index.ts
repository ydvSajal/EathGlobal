/** Wire types. zod is the source of truth; docs/API.md mirrors it. */
import { z } from "zod";
import { ERROR_CODES } from "../errors";

export const Money = z.string().regex(/^\d+$/, "base units as decimal string");
export const UnixSeconds = z.number().int().nonnegative();
export const HederaAccountId = z.string().regex(/^0\.0\.\d+$/);

export const SessionState = z.enum([
  "PENDING",
  "STEP_UP",
  "DECIDING",
  "ISSUED",
  "ACTIVE",
  "SETTLED",
  "CANCELLED",
  "SAFE_STOP",
]);
export type SessionState = z.infer<typeof SessionState>;
export const TERMINAL_STATES: readonly SessionState[] = ["SETTLED", "CANCELLED", "SAFE_STOP"];

export const DeviceStatus = z.enum(["ONLINE", "OFFLINE"]);

export const DeviceView = z.object({
  id: z.string(),
  name: z.string(),
  status: DeviceStatus,
  lastHeartbeat: UnixSeconds.nullable(),
  relay: z.boolean(),
  pricePerMinute: Money,
  asset: z.string(),
});
export type DeviceView = z.infer<typeof DeviceView>;

export const AgentView = z.object({
  id: z.string(),
  name: z.string(),
  hederaAccountId: HederaAccountId,
  dailyCap: Money,
  spentToday: Money,
  asset: z.string(),
});
export type AgentView = z.infer<typeof AgentView>;

export const SessionEventView = z.object({
  state: SessionState,
  at: UnixSeconds,
  detail: z.string().nullable(),
});

export const SessionView = z.object({
  id: z.string(),
  deviceId: z.string(),
  agentId: z.string(),
  state: SessionState,
  amount: Money,
  asset: z.string(),
  minutes: z.number().int().positive(),
  expiresAt: UnixSeconds.nullable(),
  hederaTxId: z.string().nullable(),
  zgRequestId: z.string().nullable(),
  zgRootHash: z.string().nullable(),
  hcsSeq: z.number().int().nullable(),
  events: z.array(SessionEventView),
});
export type SessionView = z.infer<typeof SessionView>;

export const CreateSessionBody = z.object({
  minutes: z.number().int().min(1).max(240),
  agentId: z.string(),
});
export type CreateSessionBody = z.infer<typeof CreateSessionBody>;

export const CreateSessionResponse = z.object({
  sessionId: z.string(),
  state: SessionState,
  stepUpUrl: z.string().url().optional(),
});

export const ErrorBody = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    sessionId: z.string().optional(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

export const AuditRow = z.object({
  sessionId: z.string(),
  state: SessionState,
  at: UnixSeconds,
  hederaTxId: z.string().nullable(),
  hashscanUrl: z.string().nullable(),
  hcsSeq: z.number().int().nullable(),
  zgRequestId: z.string().nullable(),
  zgRootHash: z.string().nullable(),
});
export type AuditRow = z.infer<typeof AuditRow>;

/** SSE payloads from GET /events */
export const SessionEvent = z.object({ sessionId: z.string(), state: SessionState, at: UnixSeconds, detail: z.string().nullable() });
export const DeviceEvent = z.object({ deviceId: z.string(), status: DeviceStatus, relay: z.boolean() });

/** Device WebSocket frames (docs/API.md §2) */
export const ReceiptBody = z.object({
  deviceId: z.string(),
  sessionId: z.string(),
  nonce: z.string().regex(/^[0-9a-f]{32}$/),
  notBefore: UnixSeconds,
  expiresAt: UnixSeconds,
  amount: Money,
  payer: HederaAccountId,
});

export const DeviceToServer = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), deviceId: z.string(), fw: z.string(), ts: UnixSeconds }),
  z.object({ type: z.literal("heartbeat"), deviceId: z.string(), relay: z.boolean(), ts: UnixSeconds }),
  z.object({ type: z.literal("ack"), sessionId: z.string(), nonce: z.string(), relay: z.literal(true), ts: UnixSeconds, mac: z.string() }),
  z.object({
    type: z.literal("nack"),
    sessionId: z.string(),
    nonce: z.string(),
    reason: z.enum(["signature", "device", "expired", "not_yet_valid", "replay", "clock"]),
  }),
]);
export type DeviceToServer = z.infer<typeof DeviceToServer>;

export const ServerToDevice = z.discriminatedUnion("type", [
  z.object({ type: z.literal("receipt"), receipt: ReceiptBody, sig: z.string() }),
  z.object({ type: z.literal("cancel"), sessionId: z.string() }),
]);
export type ServerToDevice = z.infer<typeof ServerToDevice>;

/** Decider (docs/API.md §4) */
export const DecisionInput = z.object({
  deviceId: z.string(),
  deviceStatus: DeviceStatus,
  relay: z.boolean(),
  lastHeartbeatAgeSec: z.number().nullable(),
  recentSessions: z.array(z.object({ state: SessionState, at: UnixSeconds })),
  requestedMinutes: z.number().int().positive(),
  amount: Money,
  agentId: z.string(),
});
export type DecisionInput = z.infer<typeof DecisionInput>;

/** Strict model output; anything that fails this parse is a failure -> SAFE_STOP. */
export const ModelVerdict = z.object({ verdict: z.enum(["ALLOW", "DENY"]), reason: z.string().max(500) });
export const Decision = ModelVerdict.extend({ requestId: z.string().min(1) });
export type Decision = z.infer<typeof Decision>;

/** 0G Storage episode and HCS audit entry (docs/API.md §5) */
export const Episode = z.object({
  v: z.literal(1),
  sessionId: z.string(),
  deviceId: z.string(),
  agentId: z.string(),
  input: DecisionInput,
  decision: Decision.nullable(),
  outcome: z.enum(["ALLOW", "DENY", "SAFE_STOP"]),
  receiptHash: z.string().optional(),
  at: UnixSeconds,
});
export type Episode = z.infer<typeof Episode>;

export const AuditEntry = z.object({
  v: z.literal(1),
  sessionId: z.string(),
  state: SessionState,
  at: UnixSeconds,
  hederaTxId: z.string().optional(),
  zgRequestId: z.string().optional(),
  zgRootHash: z.string().optional(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;
