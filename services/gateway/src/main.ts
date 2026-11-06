/** Composition root: parse config, build ports (fake or real), start HTTP + device WebSocket. */
import { serve } from "@hono/node-server";
import { createDb, createRepos } from "@agentmeter/db";
import { generateSeedBase64, publicKeyFromSeedBase64 } from "@agentmeter/shared";
import { createApp } from "./app";
import { ConfigError, loadConfig } from "./config";
import { Orchestrator } from "./core/orchestrator";
import { hbarToTinybar } from "./core/policy";
import { createLogger } from "./logger";
import { buildPorts } from "./ports";
import { DeviceHub } from "./ws/devices";

async function main() {
  const config = loadConfig();
  const log = createLogger(config.env.LOG_LEVEL);
  const ports = buildPorts(config); // throws if a requested real adapter is not wired
  const db = createDb(config.env.DATABASE_URL);
  const repos = createRepos(db);

  // Receipt key. Fake-only dev runs may use an ephemeral key; the device must then pin the printed public key.
  let seed = config.env.RECEIPT_SIGNING_KEY_ED25519;
  if (!seed) {
    if (Object.values(config.adapters).includes("real")) {
      throw new ConfigError("RECEIPT_SIGNING_KEY_ED25519 is required when any real adapter is enabled (node packages/shared/scripts/gen-keys.ts)");
    }
    seed = generateSeedBase64();
    log.warn({ publicKeyBase64: publicKeyFromSeedBase64(seed) }, "RECEIPT_SIGNING_KEY_ED25519 not set: using an EPHEMERAL dev key; devices must pin this public key");
  }

  const hub = new DeviceHub(repos, ports.clock, log);
  hub.startSweeper();
  const orchestrator = new Orchestrator(repos, ports, hub, log, {
    receiptSeedBase64: seed,
    stepUpThreshold: hbarToTinybar(config.env.STEP_UP_THRESHOLD_HBAR),
    ackTimeoutMs: config.env.ACK_TIMEOUT_MS,
    zgTimeoutMs: config.env.ZG_TIMEOUT_MS,
  });

  const app = createApp({
    log,
    adapters: config.adapters,
    startedAt: ports.clock.now(),
    now: () => ports.clock.now(),
    checkDb: async () => (await repos.ping(), true),
    api: { orchestrator, repos, hub, clock: ports.clock, hederaNetwork: config.env.HEDERA_NETWORK },
  });

  const server = serve({ fetch: app.fetch, port: config.env.PORT }, (info) =>
    log.info({ port: info.port, adapters: config.adapters }, "gateway listening"),
  );
  server.on("upgrade", hub.handleUpgrade); // devices connect outbound: ws://<host>/devices/:id?token=
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof ConfigError ? `config error: ${err.message}` : err);
  process.exit(1);
});
