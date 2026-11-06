/** Composition root: parse config, build ports (fake or real), start the HTTP server. */
import { serve } from "@hono/node-server";
import { createDb, createRepos } from "@agentmeter/db";
import { createApp } from "./app";
import { ConfigError, loadConfig } from "./config";
import { createLogger } from "./logger";
import { buildPorts } from "./ports";

async function main() {
  const config = loadConfig();
  const log = createLogger(config.env.LOG_LEVEL);
  const ports = buildPorts(config); // throws if a requested real adapter is not wired
  const db = createDb(config.env.DATABASE_URL);
  const repos = createRepos(db);
  const app = createApp({
    log,
    adapters: config.adapters,
    startedAt: ports.clock.now(),
    now: () => ports.clock.now(),
    checkDb: async () => (await repos.ping(), true),
  });
  serve({ fetch: app.fetch, port: config.env.PORT }, (info) =>
    log.info({ port: info.port, adapters: config.adapters }, "gateway listening"),
  );
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof ConfigError ? `config error: ${err.message}` : err);
  process.exit(1);
});
