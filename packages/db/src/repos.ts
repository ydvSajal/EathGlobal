/**
 * Typed repositories over Prisma (L1). The gateway core talks to these, never to Prisma directly.
 * State changes are compare-and-set on the current state and append a SessionEvent in one transaction,
 * so two concurrent callers can never both move a session.
 */
import { createHash } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { AgentMeterError, type SessionState } from "@agentmeter/shared";

export type Db = PrismaClient;

export function createDb(url?: string): Db {
  return new PrismaClient(url ? { datasources: { db: { url } } } : undefined);
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** UTC calendar day for a unix-seconds timestamp. */
export const utcDay = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);

const isUniqueViolation = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

export type SessionPatch = Partial<{
  payer: string;
  nonce: string;
  notBefore: number;
  expiresAt: number;
  hederaTxId: string;
  zgRequestId: string;
  zgRootHash: string;
  hcsSeq: number;
}>;

export function createRepos(db: Db) {
  const devices = {
    get: (id: string) => db.device.findUnique({ where: { id } }),
    list: () => db.device.findMany({ orderBy: { id: "asc" } }),
    /** Constant-time-ish check is unnecessary: tokens are compared as sha256 digests. */
    async authenticate(id: string, token: string) {
      const d = await db.device.findUnique({ where: { id } });
      return d && d.tokenHash === sha256(token) ? d : null;
    },
    heartbeat: (id: string, at: number, relay: boolean) =>
      db.device.update({ where: { id }, data: { lastHeartbeat: at, relay, status: "ONLINE" } }),
    setStatus: (id: string, status: "ONLINE" | "OFFLINE") => db.device.update({ where: { id }, data: { status } }),
  };

  const agents = {
    get: (id: string) => db.agent.findUnique({ where: { id } }),
    list: () => db.agent.findMany({ orderBy: { id: "asc" } }),
    allowedDeviceIds(agent: { allowedDeviceIds: string }): string[] {
      const v: unknown = JSON.parse(agent.allowedDeviceIds);
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    },
    /** Spend that counts toward today's cap (resets when the UTC day changes). */
    spentOn(agent: { spentToday: string; spentDay: string }, now: number): bigint {
      return agent.spentDay === utcDay(now) ? BigInt(agent.spentToday) : 0n;
    },
    /** Add settled spend for `now`'s UTC day. */
    async addSpend(id: string, amount: bigint, now: number) {
      return db.$transaction(async (tx) => {
        const a = await tx.agent.findUniqueOrThrow({ where: { id } });
        const day = utcDay(now);
        const prev = a.spentDay === day ? BigInt(a.spentToday) : 0n;
        return tx.agent.update({ where: { id }, data: { spentToday: (prev + amount).toString(), spentDay: day } });
      });
    },
  };

  const sessions = {
    get: (id: string) =>
      db.session.findUnique({ where: { id }, include: { events: { orderBy: { id: "asc" } } } }),
    /** Creates a PENDING session. Throws PAYMENT_REPLAY if the payment payload was used before. */
    async create(s: {
      id: string;
      deviceId: string;
      agentId: string;
      amount: string;
      asset: string;
      minutes: number;
      paymentPayloadHash: string;
      payer?: string;
      now: number;
    }) {
      try {
        return await db.$transaction(async (tx) => {
          const created = await tx.session.create({
            data: {
              id: s.id,
              deviceId: s.deviceId,
              agentId: s.agentId,
              amount: s.amount,
              asset: s.asset,
              minutes: s.minutes,
              paymentPayloadHash: s.paymentPayloadHash,
              payer: s.payer,
              state: "PENDING",
              createdAt: s.now,
              updatedAt: s.now,
            },
          });
          await tx.sessionEvent.create({ data: { sessionId: s.id, state: "PENDING", at: s.now } });
          return created;
        });
      } catch (e) {
        if (isUniqueViolation(e)) throw new AgentMeterError("PAYMENT_REPLAY", "payment payload already used", s.id);
        throw e;
      }
    },
    /**
     * Compare-and-set: moves `from -> to` only if the session is still in `from`.
     * Legality of the transition is checked by the caller (core/session-machine).
     */
    async move(id: string, from: SessionState, to: SessionState, at: number, patch: SessionPatch = {}, detail?: string) {
      return db.$transaction(async (tx) => {
        const res = await tx.session.updateMany({ where: { id, state: from }, data: { state: to, updatedAt: at, ...patch } });
        if (res.count !== 1) throw new AgentMeterError("INTERNAL", `session ${id} not in ${from}`, id);
        const ev = await tx.sessionEvent.create({ data: { sessionId: id, state: to, at, detail: detail ?? null } });
        return ev.id;
      });
    },
    /** Patch fields without a state change (e.g. late hcsSeq / zgRootHash from background loggers). */
    patch: (id: string, patch: SessionPatch, at: number) =>
      db.session.update({ where: { id }, data: { ...patch, updatedAt: at } }),
    setEventHcsSeq: (eventId: number, hcsSeq: number) =>
      db.sessionEvent.update({ where: { id: eventId }, data: { hcsSeq } }),
    countForDeviceSince: (deviceId: string, since: number) =>
      db.session.count({ where: { deviceId, createdAt: { gte: since } } }),
    recentForDevice: (deviceId: string, limit = 5) =>
      db.session.findMany({ where: { deviceId }, orderBy: { createdAt: "desc" }, take: limit, select: { state: true, createdAt: true } }),
    list: (limit = 50) => db.session.findMany({ orderBy: { createdAt: "desc" }, take: limit }),
  };

  const nonces = {
    /** Returns false if the nonce was already used (server-side replay guard). */
    async use(nonce: string, at: number) {
      try {
        await db.usedNonce.create({ data: { nonce, createdAt: at } });
        return true;
      } catch (e) {
        if (isUniqueViolation(e)) return false;
        throw e;
      }
    },
  };

  const stepUps = {
    create: (s: { id: string; sessionId: string; state: string; nonce: string; codeVerifier: string; now: number; ttlSec: number }) =>
      db.stepUp.create({
        data: {
          id: s.id,
          sessionId: s.sessionId,
          state: s.state,
          nonce: s.nonce,
          codeVerifier: s.codeVerifier,
          createdAt: s.now,
          expiresAt: s.now + s.ttlSec,
        },
      }),
    /** Single use: returns the PENDING record for this OIDC state and marks it consumed atomically. */
    async consume(state: string, status: "APPROVED" | "DENIED" | "EXPIRED", extra: { worldSub?: string; authTime?: number } = {}) {
      return db.$transaction(async (tx) => {
        const res = await tx.stepUp.updateMany({ where: { state, status: "PENDING" }, data: { status, ...extra } });
        if (res.count !== 1) throw new AgentMeterError("STEP_UP_DENIED", "unknown or already used step-up state");
        return tx.stepUp.findUniqueOrThrow({ where: { state } });
      });
    },
    findByState: (state: string) => db.stepUp.findUnique({ where: { state } }),
  };

  return { devices, agents, sessions, nonces, stepUps, ping: () => db.$queryRaw`SELECT 1` };
}

export type Repos = ReturnType<typeof createRepos>;
