# CLAUDE.md — Handover for Claude Code

You are building **AgentMeter** at ETHGlobal Mumbai 2026 (hackathon, ~48h, deadline reported Sun 8 Nov 09:00 IST, verify). Read `PRD.md` first: it holds scope, prize requirements, architecture, data model, security checklist and milestones. This file tells you **how to work** and **where to pull code from**.

## Mission in one line
Agents pay per minute over x402 on Hedera to switch on a physical device (ESP32 + relay); the device verifies a signed expiring receipt; spends above a threshold need World ID step-up; every decision goes through 0G with safe-stop on failure.

## Working rules
- **Ship the P0 list in PRD §5 before anything else.** No P1 work until the end-to-end paid unlock works.
- Stack: TypeScript everywhere, **pnpm** workspaces, Next.js App Router + Tailwind + shadcn/ui for the dashboard, **Hono** for the gateway (matches Paybot), Prisma + SQLite, Arduino/PlatformIO C++ for the ESP32.
- One gateway service with modules, not microservices.
- Commit small and often with clear messages (sponsors check for steady history).
- Never put private keys in client code or commit `.env`. Provide `.env.example`.
- Every external call (facilitator, 0G, World) gets a timeout and typed error. A 0G failure must produce `SAFE_STOP`, **never a default ALLOW**.
- Keep a `docs/DECISIONS.md` log: one line per architectural decision.
- When an SDK's behavior is unclear, read the linked repo/docs below before guessing. These SDKs move fast.

## Monorepo layout (create this)
```
agentmeter/
├─ apps/
│  └─ web/                 # Next.js dashboard (devices, sessions, spend, audit, World step-up page)
├─ services/
│  ├─ gateway/             # Hono: x402 Hedera, policy, step-up, 0G decide, receipts, device hub (WS), loggers
│  └─ agent/               # autonomous payer: @x402/fetch + Hedera signer (CLI + small HTTP trigger)
├─ packages/
│  ├─ shared/              # zod schemas, receipt encoding, types
│  └─ db/                  # Prisma schema + client (SQLite)
├─ firmware/
│  └─ esp32/               # PlatformIO project: WS client, Ed25519 verify, relay, local timer, ack
├─ docs/                   # DECISIONS.md, WORLD_DEBRIEF.md, architecture.png
├─ PRD.md
└─ CLAUDE.md
```

## Reference repos and what to take from each

### 1. Paybot (the project we build on) — https://github.com/superposition/paybot
ETHGlobal Buenos Aires 2025 finalist, showcase: https://ethglobal.com/showcase/paybot-q7grd
Clone it into `/reference/paybot` (gitignored) and extract:
- **Resource server (Hono, TS)**: the x402 gateway pattern that validates the payment header before proxying to the robot. Reuse the structure for `services/gateway`, but swap the EVM/QUSD logic for Hedera x402.
- **Facilitator /settle flow**: how base64 payloads are decoded and verified. Useful to understand x402 internals; we use an external Hedera facilitator instead of running theirs.
- **Escrow.sol** (time-locked escrow with claim after expiry): reference for the refund/settle-on-ack logic. Hedera is EVM-compatible, so it can be adapted if we go the escrow route (P1).
- **Frontend**: `BotAccessGate` (locked/unlocked states), `CountdownTimer`, `usePayment` orchestration. Port the UX ideas into `apps/web`.
- **Docker/infra**: the contract-export volume trick, if useful.
- Their base64 dual-mode helper (`globalThis.btoa` vs `Buffer`).
- Do **not** keep: QUSD token, Base network config, the human-signs-in-wallet flow (our payer is an agent).

### 2. x402 protocol + Hedera mechanism — https://github.com/x402-foundation/x402
- Hedera exact scheme package: `typescript/packages/mechanisms/hedera` → https://github.com/x402-foundation/x402/tree/main/typescript/packages/mechanisms/hedera
- Scheme spec: https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_hedera.md
- Note: `@x402/hedera` may not be published on npm; if not, add it from the monorepo source as a workspace/git dependency.
- Take: server middleware for 402 responses + verify/settle, client `@x402/fetch` wrapper.

### 3. Working Hedera x402 example — https://github.com/OkeyAmy/hbar402
Copy the client setup pattern (`wrapFetchWithPaymentFromConfig` + `ExactHederaScheme` + `createClientHederaSigner(accountId, PrivateKey.fromStringDer(...))`) and its `buy()` helper that decodes the receipt. Fastest path to a first settled payment.

### 4. Hedera x402 + World ID approvals — https://github.com/Lyons800/remit
A project that combines agent x402 payments on Hedera with World-verified human approvals. Read for the approval pattern and how they avoid storing agent→human mappings. Take ideas, not the domain logic.

### 5. Facilitators (pick one, make it configurable)
- Official: `https://x402.org/facilitator` (testnet, no API key; check `curl https://x402.org/facilitator/supported` lists `hedera:testnet`)
- Blocky402: `https://api.testnet.blocky402.com` (testnet), `https://api.blocky402.com` (mainnet)
- Docs: https://docs.hedera.com/solutions/ai/x402 and https://docs.hedera.com/solutions/ai/x402/facilitators

### 6. Hedera SDKs and tools
- Hedera Agent Kit (P1 for the agent): https://docs.hedera.com/solutions/ai/agent-kit, repo https://github.com/hashgraph/hedera-agent-kit-js
- HCS (topic create + submit message) via `@hashgraph/sdk`: https://docs.hedera.com/reference/protobuf/consensus/consensus-service
- Mirror Node REST (to show tx status in the dashboard): https://docs.hedera.com/reference/rest-api
- Testnet account: https://portal.hedera.com. USDC: Circle faucet, select Hedera Testnet, use the 0.0.x account ID.
- Explorer for demo links: HashScan (testnet).

### 7. 0G
- 0G Private Computer (OpenAI-compatible, 100+ models, request IDs): https://pc.0g.ai, models https://pc.0g.ai/models
- Compute docs: https://docs.0g.ai/developer-hub/building-on-0g/compute-network/overview
- Storage SDK (episode logs): https://docs.0g.ai/developer-hub/building-on-0g/storage/sdk
- **zerobot** robot control SDK with a mock robot (use if hardware fails, counts as a simulated build): https://github.com/0gfoundation/zerobot
- Faucet: https://faucet.0g.ai, builder hub: https://build.0g.ai
- Take from zerobot: how it structures the decision loop and episode logging; mirror that shape so 0G judges recognize it.

### 8. World ID (Agent Pass / step-up via OIDC)
- Overview: https://auth.world.org/docs
- **Step-up guide (start here)**: https://auth.world.org/docs/guides/step-up (includes the human-checkpoint pattern for agent workflows)
- Client setup: https://auth.world.org/docs/guides/app-registration, portal https://auth.world.org/portal
- OIDC details: https://auth.world.org/docs/guides/oidc, playground https://oauth-playground.toolsforhumanity.dev/
- Proofs are mocked for the hackathon; no sandbox app needed.
- Model: authorization code + PKCE → ID token with pairwise `sub` and `auth_time`. Validate server-side, require fresh `auth_time`, bind to sessionId via `state`.

### 9. ESP32 crypto
- Ed25519 verify on Arduino: rweather Crypto library, https://github.com/rweather/arduinolibs (Ed25519 class). If it fights you on time, fall back to HMAC-SHA256 with a per-device secret and note the trade-off in DECISIONS.md.
- WebSocket client: `links2004/arduinoWebSockets`. JSON: ArduinoJson.

## Build order (follow strictly)
1. **Scaffold** the monorepo, Prisma schema from PRD §7, `.env.example` from PRD §9.
2. **First payment**: `services/agent` pays a dummy x402 endpoint on Hedera testnet. Log the tx ID. Stop and confirm with the user.
3. **Receipts**: `packages/shared` canonical receipt encoding + Ed25519 sign (Node) + a test vector JSON the firmware can verify.
4. **Firmware**: ESP32 connects outbound to `ws://<gateway>/devices/:id`, verifies the test vector, flips the relay, rejects a replay, runs a local timer, sends ack, heartbeats every 5s.
5. **Gateway E2E**: 402 → verify payment → sign receipt → push to device → wait for ack (timeout 8s) → settle → persist.
6. **Policy + World step-up**: caps, allowlist, `step_up_required` response, OIDC flow page in `apps/web`, deny/expired path.
7. **0G**: `Decider` interface + `ZeroGDecider` (timeout 4s → SAFE_STOP), Storage episode write, persist request ID + root hash.
8. **HCS logger**: one message per session state change.
9. **Dashboard**: devices, live session with countdown, agent spend vs cap, audit list linking HashScan / 0G.
10. **Docs**: README, WORLD_DEBRIEF.md, architecture diagram, Credits.

## Testing
- Unit: receipt encode/sign/verify round-trip (Node ↔ firmware test vectors), policy engine (caps, threshold), replay rejection, 0G timeout → SAFE_STOP.
- Integration: scripted agent run covering happy path, replay, over-cap denied, over-cap approved, 0G down, device offline (no ack → no settle).
- Manual checklist before recording: fresh testnet balances, device on hotspot, NTP synced, World portal redirect URIs correct, HashScan links open.

## Known risks (handle early)
- **Venue Wi-Fi client isolation**: the device must connect outbound; use a phone hotspot.
- **`@x402/hedera` packaging**: may need the monorepo source; budget an hour.
- **Settle-on-ack** depends on whether the middleware lets us split verify and settle. If not, settle immediately and refund on no-ack (Hedera transfer back). Decide by Fri night.
- **Device clock** for expiry checks: sync NTP on boot, allow ±30s skew.
- **0G Private Computer credits/API access**: get them at the 0G booth on day 1.

## Credits (keep in README)
Built on top of Paybot by the superposition team (ETHGlobal Buenos Aires 2025). Uses x402 (x402 Foundation), Hedera SDK, 0G zerobot/compute/storage, World ID, rweather/arduinolibs.
