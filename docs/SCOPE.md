# AgentMeter — Full Project Scope

Synthesis of `PRD.md`, `CLAUDE.md`, Paybot (`reference/paybot`), the ETHGlobal Mumbai prizes page, and the sponsor docs checked on 2026-11-06. Where this file disagrees with the PRD, this file wins (see "Corrections").

## 1. What we build

Agents rent physical devices per minute by paying over x402 on Hedera. The ESP32 only switches on after verifying a signed, expiring receipt itself. Spend above a threshold needs fresh World ID. Every decision runs through 0G; if 0G fails the device stays off (`SAFE_STOP`).

## 2. Prize map (what each feature earns)

| Prize | Pool | Features that satisfy it | Must-have evidence |
|---|---|---|---|
| Hedera: AI Agents That Pay (x402) | $6,500 | x402 endpoint, agent autopay, caps/allowlist/step-up, HCS audit, USDC (HTS) | Hedera tx ID in README, HashScan link in ≤5 min demo |
| Hedera: No Solidity Allowed (bonus) | $2,000 | Whole app on JS/TS SDK, HTS + HCS, zero Solidity | Don't use Escrow.sol; settle via native transfers |
| 0G: Physical AI, Agents with a Body | $5,000 (+$1k real hardware) | 0G call in decision loop, Storage episode per decision, SAFE_STOP | Request ID per decision, replayable sim or live HW, no faked fallback |
| World: ID Agent Pass | $5,000 | OIDC step-up, backend validation, approve + deny/expired paths | `docs/WORLD_DEBRIEF.md` |
| ETHGlobal Finalist | per-person | Steady commits, video, README | ≤3 min video, no sped-up footage |

Optional extras (only if P0 done): World "Best Use of IDKit" ($2,500), 0G "Agents That Pay for Themselves" ($2,000). Don't chase them early.

## 3. Where each piece comes from

| Piece | Source | What we take | What we drop/replace |
|---|---|---|---|
| Gateway skeleton | Paybot `apps/x402-facilitator/src/example-resource-server.ts` | Hono app layout, CORS, `/health`, `x402Middleware` shape, protected-route pattern | EVM/QUSD, `localhost` network, viem |
| Verify/settle split | Paybot `facilitator.ts` + Hedera exact spec | `/verify` then `/settle` ordering, base64 payload decode | We call an external Hedera facilitator instead of running one |
| x402 server/client | `x402-foundation/x402` (`@x402/hedera`, `@x402/fetch`, `@x402/core`) | `ExactHederaScheme`, `cryptoTransfer` method, `wrapFetchWithPaymentFromConfig` | `transferExecutor` (contract-based) |
| Agent payer | `OkeyAmy/hbar402` | `createClientHederaSigner` + `ExactHederaScheme` + `buy()` receipt decode | Next.js app, data catalog |
| Escrow/refund idea | Paybot `Escrow.sol` | State machine only (PENDING/CLAIMED/EXPIRED/REFUNDED) | The contract itself (No-Solidity track) |
| Frontend UX | Paybot `BotAccessGate`, `CountdownTimer`, `usePayment` | Locked/unlocked states, countdown, orchestration flow | Vite, wagmi, MetaMask signing |
| Approval pattern | `Lyons800/remit` | Bind approval to a digest of the exact action; mark used atomically; don't store agent→human map | Domain logic (accounts payable), AgentBook |
| Step-up flow | `auth.world.org/docs/guides/step-up` | `max_age=0` + `prompt=login`, PKCE S256, `acr` check, `auth_time` vs attempt start | Mocked proofs where needed |
| Decision loop shape | `0gfoundation/zerobot` | Mock-robot idea (`startMockRobot`) for sim fallback | Contract dispatch flow; README doesn't describe loop/logging, so we define our own `Decider` |
| 0G inference | 0G Compute Router `https://router-api.0g.ai/v1` (OpenAI-compatible) | API-key auth via pc.0g.ai | Direct SDK path unless request IDs require it |
| ESP32 crypto | `rweather/arduinolibs` | Ed25519 class (unconfirmed) | Fallback: HMAC-SHA256 per-device secret |
| ESP32 transport | `links2004/arduinoWebSockets`, ArduinoJson | Outbound WS client, JSON | — |

Paybot facts that shape the work: it is bun + turbo + Vite + EVM, and its "robot" is a UGV over HTTP. There is **no ESP32, receipt, policy, World ID, or 0G code in it**. Those are all new.

## 4. System architecture

```
Agent service ──x402 pay──► Gateway (Hono) ◄──SSE/REST── Dashboard (Next.js)
 (@x402/fetch,               ├ x402 verify/settle ──► Hedera facilitator ──► Hedera testnet
  Hedera signer)             ├ policy engine (caps, allowlist, threshold)
                             ├ World OIDC step-up ──► auth.world.org
                             ├ Decider ──► 0G Compute Router   (timeout 4s → SAFE_STOP)
                             ├ receipt signer (Ed25519)
                             ├ loggers ──► 0G Storage + Hedera HCS
                             └ device hub (WS, device connects outbound)
                                         │
                                  ESP32 + relay
                                  verify sig / deviceId / expiry / nonce
                                  relay ON, local timer, signed ack, heartbeat 5s
```

### Session state machine
`PENDING → STEP_UP? → DECIDING → ISSUED → ACTIVE → SETTLED`
Exits: `CANCELLED` (step-up denied/expired, no ack in 8s, policy deny, settle failed 3× after ack so the device is switched off, gateway restart), `SAFE_STOP` (0G error/timeout). Payment is **never settled** on any exit except `SETTLED`.

### Request lifecycle (hero flow)
1. Agent `POST /devices/:id/session` → 402 (price/min, network, payTo).
2. Agent signs Hedera payment, retries with payment header.
3. Gateway `/verify` only. Reject reused payment-payload hash.
4. Policy: allowlist, per-agent daily cap, per-device rate. Amount over `STEP_UP_THRESHOLD_HBAR` → `step_up_required` with `sessionId`.
5. Human completes World OIDC (state bound to `sessionId`); backend validates; session resumes. Denied/expired → `CANCELLED`.
6. `Decider.decide()` → `ALLOW|DENY` + 0G request ID. Any error/timeout → `SAFE_STOP`.
7. Sign receipt `{deviceId, sessionId, nonce(128-bit), notBefore, expiresAt, amount, payer}`.
8. Push to device over WS; device verifies, relay ON, sends signed ack.
9. Ack within 8s → `/settle` → Hedera tx ID. No ack → `CANCELLED`, no settle.
10. Write episode to 0G Storage (root hash) and one HCS message per state change.
11. Device turns relay off by local timer at `expiresAt`, even if offline.

## 5. Module scope

| Path | Contents | Depends on |
|---|---|---|
| `packages/shared` | zod schemas, canonical receipt encoding, Ed25519 sign/verify (Node), test-vector JSON, shared types | — |
| `packages/db` | Prisma schema (Device, Agent, Session, StepUp, UsedNonce), SQLite client | — |
| `services/gateway` | Hono app. Modules: `x402`, `policy`, `stepup`, `decider` (interface + `ZeroGDecider`), `receipts`, `devices` (WS hub), `loggers` (0G Storage, HCS), `sse` | shared, db |
| `services/agent` | CLI + small HTTP trigger; Hedera signer; `@x402/fetch` autopay; surfaces `step_up_required` | shared |
| `apps/web` | Next.js + Tailwind + shadcn. Pages: devices, live session + countdown, agent spend vs cap, audit list (HashScan/0G links), World step-up page + callback | gateway API |
| `firmware/esp32` | PlatformIO: Wi-Fi, NTP, WS client, Ed25519 verify (or HMAC fallback), nonce ring buffer, relay, local timer, ack, heartbeat | test vector |
| `docs/` | `DECISIONS.md`, `WORLD_DEBRIEF.md`, `RESOURCES.md`, architecture diagram, "what breaks if 0G is removed" | — |

## 6. Build order and exit criteria

| # | Step | Done when |
|---|---|---|
| 1 | Scaffold pnpm monorepo, Prisma, `.env.example`, DECISIONS.md | `pnpm install && pnpm -r typecheck` passes |
| 2 | First x402 payment (agent → dummy Hono endpoint, Hedera testnet) | Tx ID on HashScan. **Stop and confirm with user** |
| 3 | Receipts in `packages/shared` + test vector | Round-trip unit test passes |
| 4 | Firmware | Script-signed receipt flips relay; replay rejected; timer turns off; ack sent |
| 5 | Gateway E2E | Paid unlock with no UI, no-ack means no settle |
| 6 | Policy + World step-up | Over-cap blocked until World ID; cancel path leaves device off |
| 7 | 0G Decider + Storage + SAFE_STOP | Request ID + root hash in DB; blocked 0G yields SAFE_STOP |
| 8 | HCS logger | One message per state change |
| 9 | Dashboard | Live session visible with countdown |
| 10 | Docs, video, submit | Checklist in PRD §12 |

## 7. Tests (minimum)
- Unit: receipt round-trip (Node vs firmware vector), policy caps/threshold, replay rejection, 0G timeout → SAFE_STOP.
- Integration script: happy path, replay, over-cap denied, over-cap approved, 0G down, device offline.
- Manual pre-recording: fresh testnet balances, phone hotspot, NTP sync, World redirect URIs, HashScan links.

## 8. Corrections to the PRD / CLAUDE.md
1. **Settle-on-ack is feasible.** Hedera exact spec has separate `/verify` and `/settle`; promote it from P1 to the primary design. Refund-on-no-ack is the fallback only.
2. **0G base URL**: `https://router-api.0g.ai/v1` (key from pc.0g.ai); the PRD's `ZG_COMPUTE_BASE_URL` was blank.
3. **0G request IDs are undocumented** on the compute overview page. Verify against a live call on day 1; if the Router doesn't return one, use the Direct SDK path.
4. **zerobot** doesn't document a decision loop or episode logging. Our own `Decider` + episode schema is the design, not a copy.
5. **No Solidity** is cheap to honor and unlocks a second Hedera prize. Don't port `Escrow.sol`.
6. **`rweather/arduinolibs` Ed25519** is unconfirmed. Check `libraries/` early; fall back to HMAC-SHA256 and log it in DECISIONS.md.
7. **Deadline** is not on the prizes page; verify on Discord.

## 9. Inputs needed from the owner
- Hedera testnet: payer (agent) account ID + DER key, payTo account ID, operator account for HCS.
- Testnet HBAR; USDC via Circle faucet for the P1 token path.
- 0G: pc.0g.ai API key + credits (booth); 0G faucet key for Storage.
- World: auth.world.org portal app (client ID/secret, redirect URI `http://localhost:3000/api/world/callback`).
- Hardware: ESP32, relay module, hotspot-capable phone.

## 10. Risks
| Risk | Mitigation |
|---|---|
| `@x402/hedera` packaging | Add from monorepo source as workspace/git dep; budget 1h |
| Venue Wi-Fi isolation | Device connects outbound; phone hotspot |
| ESP32 Ed25519 library fights | HMAC fallback, documented |
| 0G request ID missing | Direct SDK path; confirm early |
| Device clock | NTP on boot, ±30s skew |
| Scope creep | No P1 before end-to-end paid unlock works |

## 11. Out of scope
Mainnet, custody UI, mobile app, multi-tenant auth, running our own facilitator, ERC-8004 identity, marketplace (roadmap slides only).
