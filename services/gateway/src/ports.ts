/** Builds the port set the domain core receives. The only place that chooses fake vs real. */
import {
  FakeAuditLog,
  FakeDecider,
  FakeEpisodeStore,
  FakeFacilitator,
  FakeStepUp,
  type AuditLog,
  type Clock,
  type Decider,
  type EpisodeStore,
  type PaymentFacilitator,
  type StepUpProvider,
} from "@agentmeter/shared";
import type { Config, PortName } from "./config";

export interface Ports {
  facilitator: PaymentFacilitator;
  decider: Decider;
  episodes: EpisodeStore;
  audit: AuditLog;
  stepUp: StepUpProvider;
  clock: Clock;
}

const systemClock: Clock = { now: () => Math.floor(Date.now() / 1000) };

function notWired(port: PortName): never {
  // Fail loudly: never silently substitute a fake when `real` was requested.
  throw new Error(
    `real ${port} adapter is not wired yet (packages/chain, web3 lane). Set ${port.toUpperCase()}=fake or ADAPTERS=fake.`,
  );
}

export function buildPorts(config: Config): Ports {
  const m = config.adapters;
  const pick = <T>(port: PortName, fake: () => T): T => (m[port] === "fake" ? fake() : notWired(port));
  return {
    facilitator: pick("facilitator", () => new FakeFacilitator()),
    decider: pick("decider", () => new FakeDecider()),
    episodes: pick("episodes", () => new FakeEpisodeStore()),
    audit: pick("audit", () => new FakeAuditLog()),
    stepUp: pick("stepup", () => new FakeStepUp()),
    clock: systemClock,
  };
}
