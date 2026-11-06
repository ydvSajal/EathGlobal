# Decisions (ADR log)

One line per decision. Newest at the bottom. Format: `ID | date | decision | why | status`. Status: `accepted`, `proposed` (needs owner OK), `superseded by ADxxx`.
For bigger decisions add a short section below the table using the template at the end.

| ID | Date | Decision | Why | Status |
|---|---|---|---|---|
| AD001 | 2026-11-06 | One gateway process (Hono) with modules, not microservices | Hackathon speed; matches Paybot's Hono resource server | accepted |
| AD002 | 2026-11-06 | pnpm workspaces; TypeScript everywhere except firmware | CLAUDE.md working rules | accepted |
| AD003 | 2026-11-06 | Do not fork Paybot; port Hono resource-server shape and UX ideas only | Paybot is EVM/bun/Vite/QUSD; we are Hedera/pnpm/Next.js | accepted |
| AD004 | 2026-11-06 | No Solidity: settle with native Hedera transfers, no Escrow port | Unlocks Hedera "No Solidity Allowed" track | accepted |
| AD005 | 2026-11-06 | Settle-on-ack is the primary design (verify first, settle after device ack) | Hedera exact spec has separate `/verify` and `/settle`; fallback: settle then refund on no-ack | accepted |
| AD006 | 2026-11-06 | Receipt = Ed25519 over canonical string `AMv1\|deviceId\|sessionId\|nonce\|notBefore\|expiresAt\|amount\|payer` | Trivial to parse on ESP32, no JSON canonicalization risk | proposed |
| AD007 | 2026-11-06 | Device ack authenticated by HMAC-SHA256 with per-device secret | Firmware needs Ed25519 verify only, no signing | proposed |
| AD008 | 2026-11-06 | 0G via Compute Router `https://router-api.0g.ai/v1`; switch to Direct SDK if no request ID | Router docs do not describe request IDs | proposed |
| AD009 | 2026-11-06 | Any 0G error, timeout (4s), or unparseable output yields `SAFE_STOP`, never ALLOW | 0G prize disqualifies faked decisions | accepted |
| AD010 | 2026-11-06 | Ports in `packages/shared` with in-memory fakes; composition root picks `ADAPTERS=fake|real` | Lets lanes work in parallel; simulation fallback for demo | accepted |
| AD011 | 2026-11-06 | Layered architecture L0 contracts / L1 adapters / L2 domain / L3 delivery; imports go downward only | Prevents lane collisions | accepted |
| AD012 | 2026-11-06 | Lanes: web, backend, web3, firmware, plus core owning `packages/shared` and docs | Parallel Claude sessions via git worktrees | accepted |
| AD013 | 2026-11-06 | Gateway not on Vercel serverless; runs on laptop, Render/Fly as backup | Needs WebSockets and SQLite file | accepted |
| AD014 | 2026-11-06 | Device connects outbound over WebSocket; phone hotspot at venue | Venue Wi-Fi client isolation | accepted |
| AD015 | 2026-11-06 | World step-up uses `max_age=0` + `prompt=login`, PKCE S256, `auth_time` checked against attempt start | World step-up guide | accepted |
| AD016 | 2026-11-06 | Money as integer base-unit strings plus asset; timestamps as unix seconds | Avoid float and timezone bugs | accepted |
| AD017 | 2026-11-06 | Stacked PRs: docs → scaffold → shared contracts; lanes branch from `main` after | Small reviewable diffs | accepted |

## Template

```
### ADxxx Title
Context: what forces the decision.
Options: A, B (one line each).
Decision: what we chose.
Consequences: what gets easier/harder, what to revisit.
```
