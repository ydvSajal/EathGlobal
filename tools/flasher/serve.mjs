// Tiny static server for the flasher. Web Serial needs a secure context; http://localhost counts.
// Run: pnpm --filter @agentmeter/flasher start   then open http://localhost:5174 in Chrome or Edge.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const esptoolBundle = join(dirname(require.resolve("esptool-js/package.json")), "bundle.js");

// Whitelist only: nothing else on disk is reachable.
const routes = {
  "/": [join(here, "index.html"), "text/html; charset=utf-8"],
  "/app.js": [join(here, "app.js"), "text/javascript; charset=utf-8"],
  "/vendor/esptool.js": [esptoolBundle, "text/javascript; charset=utf-8"],
};

const port = Number(process.env.PORT ?? 5174);
createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  const route = routes[path];
  if (!route) {
    res.writeHead(404).end("not found");
    return;
  }
  try {
    res.writeHead(200, { "content-type": route[1], "cache-control": "no-store" }).end(await readFile(route[0]));
  } catch {
    res.writeHead(500).end("read error");
  }
}).listen(port, "127.0.0.1", () => console.log(`AgentMeter flasher: http://localhost:${port}  (Chrome or Edge)`));
