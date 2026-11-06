/** Map DB rows to the shared wire types. Every response is parsed with the shared zod schemas before sending. */
import type { Repos } from "@agentmeter/db";
import { AgentView, AuditRow, DeviceView, SessionView, type SessionState } from "@agentmeter/shared";

type SessionWithEvents = NonNullable<Awaited<ReturnType<Repos["sessions"]["get"]>>>;
type SessionRow = Awaited<ReturnType<Repos["sessions"]["list"]>>[number];

/** Hedera tx id `0.0.x@sec.nanos` -> HashScan path form `0.0.x-sec-nanos`. */
export function hashscanUrl(txId: string | null, network = "testnet"): string | null {
  if (!txId) return null;
  const [acct, ts] = txId.split("@");
  if (!acct || !ts) return null;
  return `https://hashscan.io/${network}/transaction/${acct}-${ts.replace(".", "-")}`;
}

export const sessionView = (s: SessionWithEvents) =>
  SessionView.parse({
    id: s.id,
    deviceId: s.deviceId,
    agentId: s.agentId,
    state: s.state as SessionState,
    amount: s.amount,
    asset: s.asset,
    minutes: s.minutes,
    expiresAt: s.expiresAt,
    hederaTxId: s.hederaTxId,
    zgRequestId: s.zgRequestId,
    zgRootHash: s.zgRootHash,
    hcsSeq: s.hcsSeq,
    events: s.events.map((e) => ({ state: e.state, at: e.at, detail: e.detail })),
  });

export const deviceView = (d: Awaited<ReturnType<Repos["devices"]["list"]>>[number], online: boolean) =>
  DeviceView.parse({
    id: d.id,
    name: d.name,
    status: online ? "ONLINE" : "OFFLINE",
    lastHeartbeat: d.lastHeartbeat,
    relay: d.relay,
    pricePerMinute: d.pricePerMinute,
    asset: d.asset,
  });

export const agentView = (a: Awaited<ReturnType<Repos["agents"]["list"]>>[number], spent: bigint) =>
  AgentView.parse({
    id: a.id,
    name: a.name,
    hederaAccountId: a.hederaAccountId,
    dailyCap: a.dailyCap,
    spentToday: spent.toString(),
    asset: a.asset,
  });

export const auditRow = (s: SessionRow, network = "testnet") =>
  AuditRow.parse({
    sessionId: s.id,
    state: s.state as SessionState,
    at: s.updatedAt,
    hederaTxId: s.hederaTxId,
    hashscanUrl: hashscanUrl(s.hederaTxId, network),
    hcsSeq: s.hcsSeq,
    zgRequestId: s.zgRequestId,
    zgRootHash: s.zgRootHash,
  });
