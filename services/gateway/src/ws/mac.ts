import { createHmac, timingSafeEqual } from "node:crypto";

/** Ack MAC: lowercase hex HMAC-SHA256(deviceSecret, `${sessionId}|${nonce}|${ts}`). Firmware computes the same. */
export function ackMac(secret: string, sessionId: string, nonce: string, ts: number): string {
  return createHmac("sha256", secret).update(`${sessionId}|${nonce}|${ts}`).digest("hex");
}

export function macEquals(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}
