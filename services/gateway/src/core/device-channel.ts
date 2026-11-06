/** How the orchestrator reaches a device. Implemented by the WebSocket hub (B6) and by test fakes. */
import type { RejectReason } from "@agentmeter/shared";

export interface ReceiptMessage {
  receipt: {
    deviceId: string;
    sessionId: string;
    nonce: string;
    notBefore: number;
    expiresAt: number;
    amount: string;
    payer: string;
  };
  sig: string;
}

export type DeliveryResult = { type: "ack" } | { type: "nack"; reason: RejectReason } | { type: "timeout" } | { type: "offline" };

export interface DeviceChannel {
  isOnline(deviceId: string): boolean;
  /** Push a receipt and wait for a verified ack or nack. Never throws; reports timeout/offline. */
  deliver(deviceId: string, msg: ReceiptMessage, timeoutMs: number): Promise<DeliveryResult>;
  /** Best effort: tell the device to switch off this session. */
  cancel(deviceId: string, sessionId: string): void;
}
