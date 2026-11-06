import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { encodeReceipt, verifyReceipt, type FakeClock } from "@agentmeter/shared";
import { createDb, createRepos, type Db, type Repos } from "@agentmeter/db";
import type { DeliveryResult, DeviceChannel, ReceiptMessage } from "../src/core/device-channel";

/** Behaves like the ESP32: verifies the receipt itself before acking. */
export class FakeDevice implements DeviceChannel {
  mode: "verify" | "silent" | "offline" = "verify";
  used = new Set<string>();
  received: ReceiptMessage[] = [];
  cancelled: string[] = [];
  constructor(
    private pub: string,
    private clock: FakeClock,
  ) {}
  isOnline() {
    return this.mode !== "offline";
  }
  onStatus() {
    return () => undefined;
  }
  async deliver(_id: string, msg: ReceiptMessage): Promise<DeliveryResult> {
    this.received.push(msg);
    if (this.mode === "offline") return { type: "offline" };
    if (this.mode === "silent") return { type: "timeout" };
    const out = verifyReceipt(encodeReceipt(msg.receipt), msg.sig, this.pub, {
      deviceId: "d1",
      now: this.clock.now(),
      usedNonces: this.used,
    });
    if (!out.ok) return { type: "nack", reason: out.reason };
    this.used.add(msg.receipt.nonce);
    return { type: "ack" };
  }
  cancel(_id: string, sessionId: string) {
    this.cancelled.push(sessionId);
  }
}

/** Fresh SQLite file with the real schema. Call `close()` in afterAll. */
export function makeTestDb(prefix: string): { db: Db; repos: Repos; close: () => Promise<void> } {
  const dir = mkdtempSync(join(tmpdir(), `agentmeter-${prefix}-`));
  const url = `file:${join(dir, "t.db").replace(/\\/g, "/")}`;
  execSync("npx prisma db push --skip-generate", {
    cwd: resolve(__dirname, "../../../packages/db"),
    env: { ...process.env, DATABASE_URL: url },
    stdio: "ignore",
  });
  const db = createDb(url);
  return {
    db,
    repos: createRepos(db),
    close: async () => {
      await db.$disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
