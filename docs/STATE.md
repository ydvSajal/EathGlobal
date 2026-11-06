# Project State (live)

**Read this first after any context compaction.** It is auto-printed by the `SessionStart` (compact) hook in `.claude/settings.json`. Update it at every milestone and before ending a session (rule in `CLAUDE.md`). Keep it short: facts that survive compaction, not narrative.

_Last updated: 2026-11-06 by backend session (B1, B3 done)_

## Where we are
- Phase: lanes open. Gate **G0 passed** (2026-11-06). Next gates: G1 first Hedera payment (needs owner keys), G2 firmware verify.
- Recommended first lanes (no keys needed): backend B1–B6 (`services/gateway`) and web W1–W3 (`apps/web`); firmware F1 if the ESP32 is in hand; web3 C1 is blocked on Hedera keys.
- Implemented: scaffolding + shared contracts only. No Hedera/0G/World keys exist yet; no lane code yet.

## Repo and PRs
- GitHub: https://github.com/ydvSajal/agentmeter (public, MIT). Default branch `main`.
- PRs #1 (docs), #2 (scaffold), #3 (shared contracts) are **merged into `main`** (merge commits, CI green). Lanes may now branch from `main`. Stacked-PR procedure for future work: `docs/WORKFLOW.md` §3.
- `packages/shared` now has: zod schemas, ports, fakes, `AgentMeterError` codes, `withTimeout`, receipt encode/sign/verify, typed gateway client, test vector `test-vectors/receipt.json` (public TEST key). 14 tests pass.
- Scripts: `node packages/shared/scripts/gen-keys.ts` (new signing seed + public key), `gen-vector.ts` (regenerate vector). Node ≥22.18 or 26 needed to run `.ts` scripts directly.
- Local: Windows, Node 26, pnpm 11. `reference/paybot` cloned (git-ignored).
- Git identity in repo config: Sajal. Commits end with the Co-Authored-By and Claude-Session trailer lines.

## Lanes (parallel sessions via worktrees, see `docs/WORKFLOW.md`)
| Lane | Status | Next task |
|---|---|---|
| core | K1–K4 done | K5 handle `contract` issues; K6 final docs |
| web | not started | W1 scaffold Next.js after G0 |
| backend | B1 (PR #5), B3 done (stacked on #5) | B2 db (add Agent.allowedDeviceIds, not in PRD §7), then B4 orchestrator |
| web3 | not started | C1 first x402 Hedera payment (needs owner keys) |
| firmware | not started | F1 verify test vector (needs PR3) |

## Decisions in force
See `docs/DECISIONS.md` (AD001–AD017). Key ones: settle-on-ack; no Solidity; any 0G failure → SAFE_STOP; ports + fakes; layers L0–L3; gateway not serverless.

## Blocked on the owner (ask, never invent)
- Hedera testnet accounts and keys: operator, payTo, agent (payer).
- 0G API key + credits (pc.0g.ai, booth); 0G Storage wallet.
- World portal client (auth.world.org/portal) and redirect URI.
- Hardware: ESP32, relay, low-voltage load.
- Submission deadline (reported Sun 8 Nov 09:00 IST, not on prizes page).

## Open technical questions
0G request ID on Router path · 0G Storage SDK package/API · Hedera SDK package (`@hashgraph/sdk` vs `@hiero-ledger/sdk`) · `@x402/hedera` on npm or monorepo source · x402 middleware verify/settle split · Ed25519 on ESP32 (`rweather/arduinolibs`).

## Gotchas learned
- pnpm 11 needs `allowBuilds` in `pnpm-workspace.yaml` (esbuild: true).
- Prizes page lists no deadline. Definitive and Chainlink resources are irrelevant to us.
- Paybot has no ESP32/receipt/policy/World/0G code; only the Hono resource-server shape and UX ideas are reusable.
