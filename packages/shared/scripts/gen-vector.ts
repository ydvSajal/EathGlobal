/**
 * Regenerates test-vectors/receipt.json. Run: node packages/shared/scripts/gen-vector.ts
 * The seed below is a PUBLIC TEST KEY. Never use it for anything real.
 * Ed25519 is deterministic, so the Node test re-derives every signature and compares.
 */
import { writeFileSync } from "node:fs";
import { encodeReceipt, publicKeyFromSeedBase64, signReceipt, type Receipt } from "../src/receipt.ts";

const seedBase64 = Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString("base64"); // 0x00..0x1f
const publicKeyBase64 = publicKeyFromSeedBase64(seedBase64);

const base: Receipt = {
  deviceId: "dev-1",
  sessionId: "s_0001",
  nonce: "00112233445566778899aabbccddeeff",
  notBefore: 1_789_000_000,
  expiresAt: 1_789_000_600,
  amount: "100000000",
  payer: "0.0.1001",
};
const good = signReceipt(base, seedBase64);

const cases = [
  { name: "valid", canonical: good.canonical, sigBase64: good.sig, deviceId: "dev-1", now: 1_789_000_100, usedNonces: [] as string[], expect: "ok" },
  { name: "valid_inside_skew_after_expiry", canonical: good.canonical, sigBase64: good.sig, deviceId: "dev-1", now: 1_789_000_620, usedNonces: [], expect: "ok" },
  { name: "tampered_amount", canonical: encodeReceipt({ ...base, amount: "999999999" }), sigBase64: good.sig, deviceId: "dev-1", now: 1_789_000_100, usedNonces: [], expect: "signature" },
  { name: "wrong_device", canonical: good.canonical, sigBase64: good.sig, deviceId: "dev-2", now: 1_789_000_100, usedNonces: [], expect: "device" },
  { name: "expired", canonical: good.canonical, sigBase64: good.sig, deviceId: "dev-1", now: 1_789_000_700, usedNonces: [], expect: "expired" },
  { name: "not_yet_valid", canonical: good.canonical, sigBase64: good.sig, deviceId: "dev-1", now: 1_788_999_900, usedNonces: [], expect: "not_yet_valid" },
  { name: "replay", canonical: good.canonical, sigBase64: good.sig, deviceId: "dev-1", now: 1_789_000_100, usedNonces: [base.nonce], expect: "replay" },
];

writeFileSync(
  new URL("../test-vectors/receipt.json", import.meta.url),
  JSON.stringify(
    {
      note: "TEST ONLY key. Firmware: verify Ed25519(publicKeyBase64) over canonical bytes; expect must match for every case. Skew is 30s.",
      seedBase64,
      publicKeyBase64,
      skewSeconds: 30,
      cases,
    },
    null,
    2,
  ) + "\n",
);
console.log("wrote receipt.json with", cases.length, "cases");
