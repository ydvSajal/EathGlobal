/**
 * Device hub (L3). Devices connect OUTBOUND to ws://<gateway>/devices/:id?token=...
 * Implements DeviceChannel for the orchestrator. Protocol: docs/API.md §2.
 *
 * Safety: an ack only counts if its MAC verifies against the device secret AND its timestamp is
 * fresh AND it matches a receipt we are actually waiting on. Anything else is ignored.
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { DeviceToServer, type Clock } from "@agentmeter/shared";
import type { Repos } from "@agentmeter/db";
import type { Logger } from "pino";
import { WebSocket, WebSocketServer } from "ws";
import type { DeliveryResult, DeviceChannel, ReceiptMessage } from "../core/device-channel";
import { ackMac, macEquals } from "./mac";

export const HEARTBEAT_OFFLINE_SEC = 15;
const ACK_SKEW_SEC = 30;

interface Conn {
  ws: WebSocket;
  lastSeen: number; // unix seconds of last frame
  relay: boolean;
}

export interface DeviceStatusEvent {
  deviceId: string;
  status: "ONLINE" | "OFFLINE";
  relay: boolean;
}

export class DeviceHub implements DeviceChannel {
  private wss = new WebSocketServer({ noServer: true });
  private conns = new Map<string, Conn>();
  private waiting = new Map<string, (r: DeliveryResult) => void>(); // key: sessionId|nonce
  private listeners = new Set<(e: DeviceStatusEvent) => void>();
  private sweeper?: ReturnType<typeof setInterval>;

  constructor(
    private readonly repos: Repos,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {}

  onStatus(fn: (e: DeviceStatusEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Mark devices OFFLINE when heartbeats stop. Call once at boot. */
  startSweeper(everyMs = 5000) {
    this.sweeper = setInterval(() => void this.sweep(), everyMs);
    this.sweeper.unref();
  }

  async sweep() {
    const now = this.clock.now();
    for (const [id, c] of this.conns) {
      if (now - c.lastSeen > HEARTBEAT_OFFLINE_SEC) {
        this.log.warn({ deviceId: id }, "heartbeat lost, marking offline");
        c.ws.terminate(); // triggers the close handler
      }
    }
  }

  close() {
    if (this.sweeper) clearInterval(this.sweeper);
    for (const c of this.conns.values()) c.ws.terminate();
    this.wss.close();
  }

  isOnline(deviceId: string): boolean {
    const c = this.conns.get(deviceId);
    return !!c && c.ws.readyState === WebSocket.OPEN && this.clock.now() - c.lastSeen <= HEARTBEAT_OFFLINE_SEC;
  }

  /** Wire to `server.on("upgrade", hub.handleUpgrade)`. */
  handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    void this.authenticateAndUpgrade(req, socket, head).catch((e: unknown) => {
      this.log.error({ err: (e as Error).message }, "ws upgrade failed");
      this.reject(socket, 500);
    });
  };

  private async authenticateAndUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const m = /^\/devices\/([A-Za-z0-9_-]{1,64})$/.exec(url.pathname);
    const token = url.searchParams.get("token");
    if (!m || !token) return this.reject(socket, 400);
    const deviceId = m[1]!;
    const device = await this.repos.devices.authenticate(deviceId, token);
    if (!device) {
      this.log.warn({ deviceId }, "device auth failed");
      return this.reject(socket, 401);
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => void this.attach(deviceId, device.hmacSecret, ws));
  }

  private reject(socket: Duplex, status: number) {
    socket.write(`HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : "Error"}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }

  private async attach(deviceId: string, secret: string, ws: WebSocket) {
    // A reconnect replaces the old socket.
    this.conns.get(deviceId)?.ws.terminate();
    const conn: Conn = { ws, lastSeen: this.clock.now(), relay: false };
    this.conns.set(deviceId, conn);
    // Attach listeners BEFORE any await: a device may send its first frame right after connecting.
    ws.on("message", (data) => void this.onMessage(deviceId, secret, conn, data.toString()));
    ws.on("close", () => void this.onClose(deviceId, conn));
    ws.on("error", (e) => this.log.warn({ deviceId, err: e.message }, "ws error"));

    await this.repos.devices.setStatus(deviceId, "ONLINE").catch(() => undefined);
    this.emit({ deviceId, status: "ONLINE", relay: false });
    this.log.info({ deviceId }, "device connected");
  }

  private async onClose(deviceId: string, conn: Conn) {
    if (this.conns.get(deviceId) !== conn) return; // already replaced by a reconnect
    this.conns.delete(deviceId);
    for (const [key, resolve] of this.waiting) {
      if (key.startsWith(`${deviceId}|`)) {
        this.waiting.delete(key);
        resolve({ type: "offline" });
      }
    }
    await this.repos.devices.setStatus(deviceId, "OFFLINE").catch(() => undefined);
    this.emit({ deviceId, status: "OFFLINE", relay: conn.relay });
    this.log.info({ deviceId }, "device disconnected");
  }

  private async onMessage(deviceId: string, secret: string, conn: Conn, raw: string) {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return this.log.warn({ deviceId }, "ignoring non-JSON frame");
    }
    const parsed = DeviceToServer.safeParse(json);
    if (!parsed.success) return this.log.warn({ deviceId }, "ignoring unknown/invalid frame");
    const msg = parsed.data;
    const now = this.clock.now();
    conn.lastSeen = now;

    switch (msg.type) {
      case "hello":
        break;
      case "heartbeat":
        conn.relay = msg.relay;
        await this.repos.devices.heartbeat(deviceId, now, msg.relay).catch(() => undefined);
        this.emit({ deviceId, status: "ONLINE", relay: msg.relay });
        break;
      case "ack": {
        const key = `${deviceId}|${msg.sessionId}|${msg.nonce}`;
        const resolve = this.waiting.get(key);
        if (!resolve) return this.log.warn({ deviceId }, "ack for unknown receipt ignored");
        const okMac = macEquals(msg.mac, ackMac(secret, msg.sessionId, msg.nonce, msg.ts));
        const fresh = Math.abs(now - msg.ts) <= ACK_SKEW_SEC;
        if (!okMac || !fresh) return this.log.warn({ deviceId, okMac, fresh }, "ack rejected");
        this.waiting.delete(key);
        conn.relay = true;
        resolve({ type: "ack" });
        break;
      }
      case "nack": {
        // A nack only ever cancels, so it needs no MAC.
        const key = `${deviceId}|${msg.sessionId}|${msg.nonce}`;
        const resolve = this.waiting.get(key);
        if (!resolve) return;
        this.waiting.delete(key);
        resolve({ type: "nack", reason: msg.reason });
        break;
      }
    }
  }

  async deliver(deviceId: string, msg: ReceiptMessage, timeoutMs: number): Promise<DeliveryResult> {
    const conn = this.conns.get(deviceId);
    if (!conn || !this.isOnline(deviceId)) return { type: "offline" };
    const key = `${deviceId}|${msg.receipt.sessionId}|${msg.receipt.nonce}`;
    return new Promise<DeliveryResult>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(key);
        resolve({ type: "timeout" });
      }, timeoutMs);
      this.waiting.set(key, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      conn.ws.send(JSON.stringify({ type: "receipt", receipt: msg.receipt, sig: msg.sig }), (err) => {
        if (err) {
          clearTimeout(timer);
          this.waiting.delete(key);
          resolve({ type: "offline" });
        }
      });
    });
  }

  cancel(deviceId: string, sessionId: string): void {
    const conn = this.conns.get(deviceId);
    if (conn?.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify({ type: "cancel", sessionId }));
  }

  private emit(e: DeviceStatusEvent) {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        /* listener errors must not break the hub */
      }
    }
  }
}
