# AgentMeter — Technical Requirements Document (TRD)

Companion to [`PRD.md`](PRD.md) (what and why). This file states **how it must behave technically**. Layering and module boundaries: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Wire contracts: [`docs/API.md`](docs/API.md).

Items tagged **(verify)** are unconfirmed facts to check before depending on them.

## 1. Technology stack

| Concern | Choice | Notes |
|---|---|---|
| Language | TypeScript 5.x, ESM, `strict` | Firmware is C++ (Arduino/PlatformIO) |
| Runtime | Node 22+ (local is 26.x) | `engines.node >=22` |
| Package manager | pnpm 11 workspaces | |
| Gateway | Hono + `@hono/node-server` + `ws` | One process, modules not microservices |
| Validation | zod | Single source of truth for wire types, in `packages/shared` |
| DB | Prisma + SQLite | Single writer. File `DATABASE_URL=file:./dev.db` |
| Dashboard | Next.js (App Router) + Tailwind + shadcn/ui | Talks only to the gateway |
| Payments | `@x402/hedera`, `@x402/core`, `@x402/fetch` | May need monorepo-source dependency (verify npm publish) |
| Hedera SDK | `@hashgraph/sdk` or `@hiero-ledger/sdk` | (verify) hbar402 uses the latter |
| AI | 0G Compute Router, OpenAI-compatible (`https://router-api.0g.ai/v1`) | Direct SDK `@0gfoundation/0g-compute-ts-sdk` if Router returns no request ID (verify) |
| Storage log | 0G Storage SDK | Package and API (verify) |
| Identity | World OIDC (`auth.world.org`), authorization code + PKCE S256 | |
| Crypto | Node `crypto` Ed25519 (server); `rweather/arduinolibs` Ed25519 (device, verify) | HMAC-SHA256 fallback |
| Tests | Vitest (TS), PlatformIO native tests or serial script (firmware) | |
| Lint/format | Prettier + `tsc --noEmit`; ESLint optional | Keep CI fast |

## 2. Functional requirements (technical form)

| ID | Requirement | Acceptance |
|---|---|---|
| F1 | `POST /devices/:id/session` returns 402 with Hedera requirements when no valid payment header is present | Integration test |
| F2 | With a valid payment header the gateway calls facilitator `/verify` and does **not** call `/settle` until device ack | Test with fake facilitator asserts call order |
| F3 | Reused payment payload hash is rejected | Unit test |
| F4 | Policy returns `ALLOW`, `STEP_UP`, or `DENY(reason)` from allowlist, daily cap, device rate, threshold | Unit tests, table-driven |
| F5 | `STEP_UP` blocks until World OIDC completes; denied/expired/cancelled sets `CANCELLED` and never issues a receipt | Integration test |
| F6 | Decider returns `ALLOW`/`DENY` + `requestId`; any error, timeout (>4s), or malformed output yields `SAFE_STOP` | Unit test with throwing/slow fake |
| F7 | Receipt is Ed25519 over the canonical string; device verifies signature, deviceId, window, unused nonce | Shared test vector, Node and firmware |
| F8 | No ack within 8s → `CANCELLED`, `/settle` never called | Integration test |
| F9 | Settle after ack stores `hederaTxId`; settle is idempotent | Unit test |
| F10 | Every state change appends one HCS message and stores `hcsSeq` | Integration with fake log |
| F11 | Every decision (incl. DENY, SAFE_STOP) writes one 0G Storage episode and stores `zgRootHash` | Integration with fake store |
| F12 | Device turns relay off at `expiresAt` via local timer with no network | Firmware manual test |
| F13 | Dashboard shows devices, live session countdown, spend vs cap, audit with HashScan and 0G links | Manual + smoke |

## 3. Non-functional requirements

### 3.1 Timeouts (every external call, typed error)

| Call | Timeout | On failure |
|---|---|---|
| Facilitator `/verify` | 5s | `PAYMENT_UNVERIFIED`, session not created |
| 0G Compute decide | **4s** | `SAFE_STOP` |
| Device ack | **8s** | `CANCELLED`, no settle |
| Facilitator `/settle` | 10s | session stays `ACTIVE`, retry idempotently, flag in audit |
| 0G Storage put | 10s | retry in background; never changes the decision |
| HCS submit | 10s | retry in background; never changes the decision |
| World token exchange | 5s | step-up fails closed (`CANCELLED`) |
| Device heartbeat | every 5s; offline after 15s | device `status=OFFLINE`, new sessions refused |

### 3.2 Fail-safe rules (hard)
1. Anything uncertain about whether the device should switch on means it does not switch on.
2. There is no code path that returns `ALLOW` without a validated model response.
3. Payment settles only after a valid device ack.
4. Logging failures never change a decision.

### 3.3 Security
- Secrets only in env; `.env` and `secrets.h` git-ignored; `.env.example` committed.
- Private keys (Hedera operator, agent, receipt signing seed, 0G key) never in `apps/web` or any browser bundle.
- Receipt nonce: 128-bit CSPRNG. Server and device both keep used nonces.
- World: validate `iss`, `aud`, `exp`, `nonce`, `acr`, `auth_time` (belongs to this attempt), `state` bound to `sessionId`, single code redemption. Never trust client claims.
- Rate limit session endpoint per agent.
- Device pins the gateway public key (compiled in or provisioned over serial). Device ignores any receipt not signed by it.
- Input validation with zod at every boundary (HTTP, WS, env).

### 3.4 Time
- Server UTC unix seconds. Device NTP-syncs on boot and refuses receipts until synced. Skew tolerance ±30s.

### 3.5 Observability
- Structured JSON logs (`pino`) with `sessionId` on every line. No secrets in logs.
- `GET /health` reports gateway, DB, and per-dependency last-success time.
- SSE `/events` is the dashboard's live feed.

### 3.6 Performance targets (demo scale)
- Paid request to relay ON under 12s in the happy path (8s ack budget plus verify and decide).
- Dashboard updates within 1s of a state change.
- Single gateway process, ≤5 devices, ≤10 concurrent sessions.

## 4. Data model (Prisma, SQLite)

Per PRD §7, with these additions:
- `Session.paymentPayloadHash` is `@unique`.
- `Session.state` and a separate append-only `SessionEvent { id, sessionId, state, at, detail, hcsSeq? }` powering the audit view.
- `UsedNonce.nonce` is `@id`.
- All timestamps stored as integer unix seconds.
- Money stored as integer tinybars (or token base units) plus `asset` string; never floats.

## 5. Configuration

All via env, parsed once at boot by a zod schema in `services/gateway/src/config.ts`; boot fails fast on missing/invalid values. Variable list: `.env.example` (authoritative) and README §4.

## 6. Error model

Typed error classes carrying a stable `code`. HTTP errors: `{ error: { code, message, sessionId? } }`.

Codes: `PAYMENT_REQUIRED`, `PAYMENT_UNVERIFIED`, `PAYMENT_REPLAY`, `POLICY_DENIED`, `STEP_UP_REQUIRED`, `STEP_UP_DENIED`, `STEP_UP_EXPIRED`, `DECISION_DENIED`, `SAFE_STOP`, `DEVICE_OFFLINE`, `DEVICE_NO_ACK`, `DEVICE_REJECTED`, `SETTLE_FAILED`, `RATE_LIMITED`, `INTERNAL`.

## 7. Testing strategy

| Level | What | Where |
|---|---|---|
| Unit | receipt encode/sign/verify, policy, state machine, replay guard, Decider timeout | each package, Vitest |
| Contract | Node verifies the firmware test vector; firmware verifies the same vector | `packages/shared/test-vectors/` |
| Integration | scripted agent against gateway with fake facilitator, fake 0G, fake World, simulated device (WS client) | `services/gateway/test/` |
| Demo scenarios | happy, replay, over-cap denied, over-cap approved, 0G down, device offline | `pnpm demo:scenarios` |
| Manual | relay clicks, timer off, unplug, hotspot, NTP | checklist in README §7 |

Fakes (`FakeDecider`, `FakeFacilitator`, `FakeAuditLog`, `FakeEpisodeStore`, `FakeStepUp`) live in `packages/shared` so every lane can run without the others.

## 8. Deployment requirements

| Component | Target | Constraint |
|---|---|---|
| Gateway | Laptop (demo); Render/Fly.io backup | Long-lived WebSocket and writable SQLite: no serverless |
| Dashboard | Laptop or Vercel | Needs public gateway URL if on Vercel |
| Agent | Laptop | Holds payer key; never deployed |
| Device | Phone hotspot | Outbound WS only |
| Tunnel | cloudflared/ngrok | Only for World redirect or remote demo |

## 9. Definition of done (per lane PR)
1. `pnpm -r typecheck` and `pnpm -r test` pass.
2. Behavior in this TRD covered by a test or a documented manual check.
3. No secrets, no `.env`, no `console.log` of keys.
4. New decisions appended to `docs/DECISIONS.md`.
5. Contract changes follow `docs/WORKFLOW.md` §5.

## 10. Open technical questions
See README §8. Owners: web3 lane resolves 0G request ID, 0G Storage API, Hedera SDK package, x402 verify/settle split. Firmware lane resolves Ed25519 on ESP32.
