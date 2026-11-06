/**
 * Simulated ESP32. Same protocol and checks the firmware must implement (docs/API.md §2-3).
 * Run: pnpm --filter @agentmeter/gateway sim:device
 *
 * Env:
 *  GATEWAY_WS      ws://localhost:8787
 *  DEVICE_ID       d1               DEVICE_TOKEN dev-token-d1      DEVICE_HMAC dev-hmac-d1
 *  PUBLIC_KEY_BASE64  receipt public key to pin (from gen-keys.ts)
 *  SIM_MODE        normal | silent (never acks) | reject (always nacks) | replay (acks, then reuses nonce)
 */
import {
  decodeReceipt,
  encodeReceipt,
  ServerToDevice,
  verifyReceipt,
} from "@agentmeter/shared";
import { WebSocket } from "ws";
import { ackMac } from "../src/ws/mac";

const base = process.env.GATEWAY_WS ?? "ws://localhost:8787";
const id = process.env.DEVICE_ID ?? "d1";
const token = process.env.DEVICE_TOKEN ?? "dev-token-d1";
const secret = process.env.DEVICE_HMAC ?? "dev-hmac-d1";
const pub = process.env.PUBLIC_KEY_BASE64;
const mode = process.env.SIM_MODE ?? "normal";
if (!pub) {
  console.error("PUBLIC_KEY_BASE64 is required (node packages/shared/scripts/gen-keys.ts)");
  process.exit(1);
}

const used = new Set<string>(); // nonce ring buffer
let relayOn = false;
let offTimer: ReturnType<typeof setTimeout> | undefined;
const now = () => Math.floor(Date.now() / 1000);

const ws = new WebSocket(`${base}/devices/${id}?token=${encodeURIComponent(token)}`);
const send = (o: unknown) => ws.send(JSON.stringify(o));

ws.on("open", () => {
  console.log(`[sim ${id}] connected, mode=${mode}`);
  send({ type: "hello", deviceId: id, fw: "sim-0.1", ts: now() });
  setInterval(() => send({ type: "heartbeat", deviceId: id, relay: relayOn, ts: now() }), 5000);
  send({ type: "heartbeat", deviceId: id, relay: relayOn, ts: now() });
});

ws.on("message", (raw) => {
  const parsed = ServerToDevice.safeParse(JSON.parse(raw.toString()));
  if (!parsed.success) return console.log(`[sim] ignoring unknown frame`);
  const m = parsed.data;

  if (m.type === "cancel") {
    relayOn = false;
    clearTimeout(offTimer);
    return console.log(`[sim] cancel ${m.sessionId} -> RELAY OFF`);
  }

  const r = m.receipt;
  console.log(`[sim] receipt for ${r.sessionId} (${r.amount} to ${r.expiresAt - r.notBefore}s window)`);
  if (mode === "silent") return console.log("[sim] silent mode: no ack");
  if (mode === "reject") return send({ type: "nack", sessionId: r.sessionId, nonce: r.nonce, reason: "signature" });

  const out = verifyReceipt(encodeReceipt(r), m.sig, pub, { deviceId: id, now: now(), usedNonces: used });
  if (!out.ok) {
    console.log(`[sim] REJECT: ${out.reason}`);
    return send({ type: "nack", sessionId: r.sessionId, nonce: r.nonce, reason: out.reason });
  }
  used.add(r.nonce);
  relayOn = true;
  const ms = Math.max(0, (r.expiresAt - now()) * 1000);
  clearTimeout(offTimer);
  offTimer = setTimeout(() => {
    relayOn = false;
    console.log(`[sim] timer expired -> RELAY OFF (no server needed)`);
  }, ms);
  const ts = now();
  send({ type: "ack", sessionId: r.sessionId, nonce: r.nonce, relay: true, ts, mac: ackMac(secret, r.sessionId, r.nonce, ts) });
  console.log(`[sim] ACK sent, RELAY ON for ${Math.round(ms / 1000)}s`);

  if (mode === "replay") {
    // Prove the device rejects a second use of the same receipt.
    setTimeout(() => {
      const again = verifyReceipt(encodeReceipt(decodeReceipt(encodeReceipt(r))), m.sig, pub, { deviceId: id, now: now(), usedNonces: used });
      console.log(`[sim] replay check -> ${again.ok ? "ACCEPTED (BUG)" : again.reason}`);
    }, 200);
  }
});

ws.on("close", (code) => {
  console.log(`[sim] disconnected (${code})`);
  process.exit(0);
});
ws.on("error", (e) => console.error(`[sim] error: ${e.message}`));
