/**
 * Session state machine (L2, pure). Only these transitions exist; anything else is a bug.
 * Rule: payment settles only on ACTIVE -> SETTLED. If settle still fails after 3 attempts the device
 * is switched off and the session goes ACTIVE -> CANCELLED unpaid (TRD §3.1).
 */
import { AgentMeterError, TERMINAL_STATES, type SessionState } from "@agentmeter/shared";

const TRANSITIONS: Record<SessionState, readonly SessionState[]> = {
  PENDING: ["STEP_UP", "DECIDING", "CANCELLED"], // CANCELLED: policy deny
  STEP_UP: ["DECIDING", "CANCELLED"], // CANCELLED: denied / expired / cancelled
  DECIDING: ["ISSUED", "SAFE_STOP"], // SAFE_STOP: 0G DENY, error, timeout, or malformed
  ISSUED: ["ACTIVE", "CANCELLED"], // CANCELLED: no ack within 8s, or device nack
  ACTIVE: ["SETTLED", "CANCELLED"], // CANCELLED: settle failed, fail-safe, or restart; device switched off, unpaid
  SETTLED: [],
  CANCELLED: [],
  SAFE_STOP: [],
};

export function canTransition(from: SessionState, to: SessionState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(state: SessionState): boolean {
  return TERMINAL_STATES.includes(state);
}

/** Returns `to` when legal; throws INTERNAL otherwise so illegal flows never persist. */
export function transition(from: SessionState, to: SessionState, sessionId?: string): SessionState {
  if (!canTransition(from, to)) {
    throw new AgentMeterError("INTERNAL", `illegal session transition ${from} -> ${to}`, sessionId);
  }
  return to;
}
