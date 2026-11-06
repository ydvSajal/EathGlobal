import { pino, type Logger } from "pino";

/** Structured JSON logs. Secrets are redacted if they ever land in a log object (TRD §3.5). */
export function createLogger(level: string): Logger {
  return pino({
    level,
    redact: {
      paths: [
        "*.HEDERA_OPERATOR_KEY",
        "*.AGENT_HEDERA_PRIVATE_KEY",
        "*.ZG_PRIVATE_KEY",
        "*.ZG_COMPUTE_API_KEY",
        "*.WORLD_CLIENT_SECRET",
        "*.RECEIPT_SIGNING_KEY_ED25519",
        "*.paymentHeader",
        "*.token",
      ],
      censor: "[redacted]",
    },
  });
}
