/**
 * Receipt: the Node <-> firmware contract (docs/API.md §3).
 * Canonical string: AMv1|deviceId|sessionId|nonceHex32|notBefore|expiresAt|amount|payer
 * Signature: Ed25519 over the UTF-8 bytes of that string, base64.
 * Dependency-free on purpose (node:crypto only) so it is trivial to audit and port.
 */
import {
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign as edSign,
  verify as edVerify,
} from "node:crypto";

export interface Receipt {
  deviceId: string;
  sessionId: string;
  nonce: string; // 32 lowercase hex chars (128-bit)
  notBefore: number; // unix seconds
  expiresAt: number; // unix seconds
  amount: string; // base units, decimal
  payer: string; // Hedera account id 0.0.n
}

export type RejectReason =
  | "signature"
  | "device"
  | "expired"
  | "not_yet_valid"
  | "replay"
  | "clock";

export type VerifyOutcome = { ok: true } | { ok: false; reason: RejectReason };

export const SKEW_SECONDS = 30;

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const NONCE = /^[0-9a-f]{32}$/;
const DIGITS = /^\d+$/;
const ACCOUNT = /^0\.0\.\d+$/;

function assertReceipt(r: Receipt): void {
  const bad = (f: string) => {
    throw new Error(`invalid receipt field: ${f}`);
  };
  if (!ID.test(r.deviceId)) bad("deviceId");
  if (!ID.test(r.sessionId)) bad("sessionId");
  if (!NONCE.test(r.nonce)) bad("nonce");
  if (!Number.isSafeInteger(r.notBefore) || r.notBefore < 0) bad("notBefore");
  if (!Number.isSafeInteger(r.expiresAt) || r.expiresAt <= r.notBefore) bad("expiresAt");
  if (!DIGITS.test(r.amount)) bad("amount");
  if (!ACCOUNT.test(r.payer)) bad("payer");
}

export function encodeReceipt(r: Receipt): string {
  assertReceipt(r);
  return ["AMv1", r.deviceId, r.sessionId, r.nonce, r.notBefore, r.expiresAt, r.amount, r.payer].join("|");
}

/** Inverse of encodeReceipt. Throws on any malformed input. */
export function decodeReceipt(canonical: string): Receipt {
  const p = canonical.split("|");
  if (p.length !== 8 || p[0] !== "AMv1") throw new Error("invalid receipt encoding");
  const [, deviceId, sessionId, nonce, nb, exp, amount, payer] = p as [
    string, string, string, string, string, string, string, string,
  ];
  const r: Receipt = { deviceId, sessionId, nonce, notBefore: Number(nb), expiresAt: Number(exp), amount, payer };
  assertReceipt(r);
  if (encodeReceipt(r) !== canonical) throw new Error("non-canonical receipt");
  return r;
}

export function generateNonce(): string {
  return randomBytes(16).toString("hex");
}

export function generateSeedBase64(): string {
  return randomBytes(32).toString("base64");
}

function privateKeyFromSeed(seedBase64: string) {
  const seed = Buffer.from(seedBase64, "base64");
  if (seed.length !== 32) throw new Error("ed25519 seed must be 32 bytes");
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
}

export function publicKeyFromSeedBase64(seedBase64: string): string {
  const spki = createPublicKey(privateKeyFromSeed(seedBase64)).export({ format: "der", type: "spki" });
  return Buffer.from(spki).subarray(-32).toString("base64");
}

/** Sign a receipt. Returns the canonical string and the base64 signature. */
export function signReceipt(r: Receipt, seedBase64: string): { canonical: string; sig: string } {
  const canonical = encodeReceipt(r);
  const sig = edSign(null, Buffer.from(canonical, "utf8"), privateKeyFromSeed(seedBase64));
  return { canonical, sig: sig.toString("base64") };
}

export interface VerifyContext {
  deviceId: string; // the verifying device's own id
  now: number; // unix seconds
  usedNonces: ReadonlySet<string>;
  clockSynced?: boolean; // default true; device passes false before NTP sync
  skew?: number; // default SKEW_SECONDS
}

/**
 * Same rule set the firmware must implement. Order matters for the reported reason:
 * clock, signature, device, window, replay.
 */
export function verifyReceipt(canonical: string, sigBase64: string, publicKeyBase64: string, ctx: VerifyContext): VerifyOutcome {
  if (ctx.clockSynced === false) return { ok: false, reason: "clock" };

  const pub = Buffer.from(publicKeyBase64, "base64");
  if (pub.length !== 32) return { ok: false, reason: "signature" };
  let sigOk = false;
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, pub]), format: "der", type: "spki" });
    sigOk = edVerify(null, Buffer.from(canonical, "utf8"), key, Buffer.from(sigBase64, "base64"));
  } catch {
    sigOk = false;
  }
  if (!sigOk) return { ok: false, reason: "signature" };

  let r: Receipt;
  try {
    r = decodeReceipt(canonical);
  } catch {
    return { ok: false, reason: "signature" };
  }
  const skew = ctx.skew ?? SKEW_SECONDS;
  if (r.deviceId !== ctx.deviceId) return { ok: false, reason: "device" };
  if (ctx.now < r.notBefore - skew) return { ok: false, reason: "not_yet_valid" };
  if (ctx.now > r.expiresAt + skew) return { ok: false, reason: "expired" };
  if (ctx.usedNonces.has(r.nonce)) return { ok: false, reason: "replay" };
  return { ok: true };
}
