import { defineConfig } from "vitest/config";

// Tests use real SQLite + Prisma + WebSocket servers. Shared CI runners are slow, so give them room,
// and run files one at a time so they do not fight over CPU while Prisma starts its engine.
export default defineConfig({
  test: { testTimeout: 30_000, hookTimeout: 60_000, fileParallelism: false },
});
