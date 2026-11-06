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
import { HederaFacilitator } from "@agentmeter/chain";
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
  const pick = <T>(port: PortName, fake: () => T, real?: () => T): T =>
    m[port] === "fake" ? fake() : real ? real() : notWired(port);
  const e = config.env;
  return {
    facilitator: pick<PaymentFacilitator>(
      "facilitator",
      () => new FakeFacilitator(),
      () =>
        new HederaFacilitator({
          facilitatorUrl: e.X402_FACILITATOR_URL!, // presence enforced by loadConfig for real adapters
          network: `hedera:${e.HEDERA_NETWORK}`,
          resourceBaseUrl: e.PUBLIC_BASE_URL ?? `http://localhost:${e.PORT}`,
        }),
    ),
    decider: pick("decider", () => new FakeDecider()),
    episodes: pick("episodes", () => new FakeEpisodeStore()),
    audit: pick("audit", () => new FakeAuditLog()),
    stepUp: pick("stepup", () => new FakeStepUp()),
    clock: systemClock,
  };
}
