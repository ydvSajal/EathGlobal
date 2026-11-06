export const ERROR_CODES = [
  "PAYMENT_REQUIRED",
  "PAYMENT_UNVERIFIED",
  "PAYMENT_REPLAY",
  "POLICY_DENIED",
  "STEP_UP_REQUIRED",
  "STEP_UP_DENIED",
  "STEP_UP_EXPIRED",
  "DECISION_DENIED",
  "SAFE_STOP",
  "DEVICE_OFFLINE",
  "DEVICE_NO_ACK",
  "DEVICE_REJECTED",
  "SETTLE_FAILED",
  "RATE_LIMITED",
  "BAD_REQUEST",
  "NOT_FOUND",
  "TIMEOUT",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Typed error carried across layers. `code` is stable and part of the API contract (TRD §6). */
export class AgentMeterError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly sessionId?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "AgentMeterError";
  }
}
