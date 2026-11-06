# Project State (live)

**Read this first after any context compaction.** It is auto-printed by the `SessionStart` (compact) hook in `.claude/settings.json`. Update it at every milestone and before ending a session (rule in `CLAUDE.md`). Keep it short: facts that survive compaction, not narrative.

_Last updated: 2026-11-06 by core session_

## Where we are
- Phase: setup. Gate **G0** in progress (stack PR1–3, see `docs/WORKFLOW.md` §6).
- Nothing is implemented yet except repo scaffolding. No Hedera/0G/World keys exist yet.

## Repo and PRs
- GitHub: https://github.com/ydvSajal/agentmeter (public, MIT). Default branch `main`.
- Stack: #1 `feat/docs-foundation` (base `main`, open) → #2 `feat/monorepo-scaffold` (base #1 branch) → #3 `feat/shared-contracts` (base #2 branch, not yet created).
- Local: Windows, Node 26, pnpm 11. `reference/paybot` cloned (git-ignored).
- Git identity in repo config: Sajal. Commits end with the Co-Authored-By and Claude-Session trailer lines.

## Lanes (parallel sessions via worktrees, see `docs/WORKFLOW.md`)
| Lane | Status | Next task |
|---|---|---|
| core | PR1–3 in progress | PR3: shared contracts (schemas, ports, fakes, receipt crypto, test vector) |
| web | not started | W1 scaffold Next.js after G0 |
| backend | not started | B1 gateway skeleton with fakes after G0 |
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
