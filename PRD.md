# AgentMeter — PRD

> Working name. ETHGlobal Mumbai 2026 build. Builds on top of **Paybot** (ETHGlobal Buenos Aires 2025 finalist, https://github.com/superposition/paybot). Credits in README.

## 1. One-liner

AI agents rent real machines (charger, locker, printer, rover) by paying per minute over **x402 on Hedera**. The device only switches on after it verifies a **signed, expiring receipt itself**. Above a spend limit, a **human approves with fresh World ID**. Every decision runs and is logged on **0G**, and if 0G is unreachable the device **fails safe and stays off**.

## 2. Why this wins (judge's view)

Paybot proved the demo works: pay → physical thing moves. What it didn't answer, and what this build answers:

| Gap in Paybot | AgentMeter answer |
|---|---|
| Device trusts the server blindly | Device verifies an Ed25519-signed receipt (deviceId, nonce, expiry, amount) on-chip |
| Replay possible | Nonce + expiry; device keeps a ring buffer of used nonces |
| Human pays from a wallet UI | **An agent** pays on its own (x402), human only steps in above a threshold |
| No spend control | Per-agent and per-device caps, device allowlist |
| Pay even if device fails | **Settle-on-ack**: payment is verified first, settled only after the device confirms it switched on |
| No audit trail | Each decision → 0G Storage (request ID) + Hedera HCS topic |
| Base/EVM + custom token | Hedera testnet, HBAR or USDC (HTS), facilitator pays fees |

## 3. Target prizes (max 3 partner programs)

1. **Hedera: "AI Agents That Pay: x402 on Hedera"** ($6,500: 3k/2k/1.5k)
   - Must: ≥1 x402-protected endpoint settling on Hedera testnet via a listed facilitator (x402.org, Blocky402) or our own; an agent completes ≥1 paid request end to end **with no human approving**; README with setup, architecture, payment flow, and ≥1 Hedera transaction ID; demo video ≤5 min with a HashScan link.
   - Extra points we hit: spending controls (budgets, allowlist, human approval above threshold), HCS audit log, USDC as HTS token, Hedera Agent Kit, ERC-8004 identity (stretch).
2. **0G: "Physical AI: Agents with a Body"** ($5,000: 2.5k/1.5k/1k, and the $1k slot is reserved for **best build on real hardware**)
   - Must: a 0G call inside the decision loop; an episode log on 0G Storage with a request ID per decision; a replayable sim or live hardware demo at the 0G booth; a **safe-stop fallback if 0G is unreachable** (a faked decision disqualifies).
   - Not wanted: a chatbot with a robot avatar, pre-recorded motion, or 0G used only for logs.
3. **World: "World ID Agent Pass"** ($5,000: 2.5k/1.5k/1k)
   - Must: the full journey (verification request → user completes → validated result → protected action); **a denied/expired/cancelled path where the action does not happen**; validation in a secure backend, never trusting the client; an integration debrief (time to first success, friction, missing docs, top improvement).

Plus **ETHGlobal Finalist**: for a 3–5 person team, 1,000 USDC per person + 500 USDC travel.

## 4. Users and core scenario

- **Owner**: a person who owns a physical device and wants to rent it out per minute.
- **Agent**: an AI agent acting for a human (e.g. "charge my scooter for 10 min", "unlock locker 3 for the courier").
- **Human principal**: the person behind the agent, who approves expensive actions with World ID.

**Hero flow (demo):**
1. The agent requests `POST /devices/:id/session` → gets **402 Payment Required** with price per minute, network, and payTo.
2. The agent signs a Hedera x402 payment, then retries with the payment header.
3. The gateway **verifies** the payment (not yet settled) and runs a **policy check**: allowlist, per-agent cap, per-device cap.
4. If amount ≤ threshold, continue. If above, return `step_up_required`; the human completes **World ID fresh authentication**; the backend validates the OIDC result, then continues.
5. **0G decision step**: the gateway calls 0G Private Computer with device state (+ camera frame, P1). The model returns `ALLOW` or `DENY` + reason; we record the request ID.
6. The gateway signs a receipt `{deviceId, sessionId, nonce, notBefore, expiresAt, amount, payer}` with an Ed25519 key.
7. The ESP32 (outbound WebSocket/poll) receives the receipt, verifies signature + expiry + unused nonce → **relay ON** → sends a signed ack.
8. On ack, the gateway **settles** via the facilitator and gets the Hedera tx ID. With no ack within N seconds, the session is cancelled and the payment is never settled.
9. Episode written to 0G Storage (root hash) + HCS topic message (sequence number).
10. When the session expires, the device turns the relay off by itself (local timer, no server needed).

**Failure demos (must show on stage):**
- Replay the same receipt → device rejects.
- Over budget → World ID prompt → human cancels → nothing happens.
- Kill 0G connectivity → gateway returns `SAFE_STOP`, device stays off.
- Device unplugged → no ack → no settlement.

## 5. Scope

### P0 (must ship, judged)
- [ ] x402 Hedera **exact** scheme endpoint (`@x402/hedera`, from the x402 monorepo source) behind a Hono gateway
- [ ] Agent client that auto-pays with `@x402/fetch` + `ExactHederaScheme` client (no human)
- [ ] Policy engine: allowlist, per-agent daily cap, per-device rate, threshold for step-up
- [ ] World ID step-up via OIDC (auth.world.org), backend-validated, with approve + deny/expired paths
- [ ] 0G Private Computer decision call in the loop, with request IDs stored
- [ ] 0G Storage episode log per decision
- [ ] Safe stop: any 0G error/timeout → DENY + device stays off (no faked decision)
- [ ] Ed25519 receipt signing (gateway) + verification on ESP32 (nonce, expiry, deviceId)
- [ ] ESP32 firmware: outbound connection, relay control, local session timer, signed ack, heartbeat
- [ ] HCS topic audit log of every session
- [ ] Minimal dashboard: devices, live session, agent spend vs cap, audit trail with HashScan + 0G links
- [ ] Sponsor docs: README (architecture, payment flow, tx IDs), World debrief, "what breaks if 0G is removed"

### P1 (if time)
- [ ] Settle-on-ack (verify → device ack → settle). Fallback if the facilitator flow makes this hard: settle immediately, refund on no-ack.
- [ ] ESP32-CAM frame → 0G vision model as part of the decision ("is the bay clear?")
- [ ] Settle in USDC (HTS) instead of HBAR
- [ ] Hedera Agent Kit as the agent framework

### P2 (stretch, mention as roadmap)
- ERC-8004 / HCS-14 agent identity + reputation
- Multi-device marketplace, agent compares prices across devices
- Scheduled Transactions for recurring rentals
- Run our own facilitator with replay protection

### Out of scope
- Mainnet, a real money custody UI, mobile app, multi-tenant auth beyond the demo

## 6. Architecture

```
┌───────────────┐   x402 (402 → signed payment)   ┌──────────────────────────────┐
│ Agent service │ ───────────────────────────────► │ Gateway (Hono, TS)           │
│ @x402/fetch + │ ◄─── step_up_required ────────── │  ├─ x402 verify/settle (Hedera)│
│ Hedera signer │                                  │  ├─ policy engine (caps)      │
└───────────────┘                                  │  ├─ World ID OIDC step-up     │
        ▲                                          │  ├─ 0G decide (+request id)   │
        │ human approves                           │  ├─ receipt signer (Ed25519)  │
┌───────────────┐                                  │  ├─ 0G Storage + HCS logger   │
│ Web dashboard │ ◄──── SSE / REST ─────────────── │  └─ device hub (WebSocket)    │
│ Next.js       │                                  └──────────────┬───────────────┘
└───────────────┘                                                 │ outbound WS from device
                                                       ┌──────────▼──────────┐
                                                       │ ESP32 + relay (+cam)│
                                                       │ verify sig/nonce/exp│
                                                       │ local timer, ack    │
                                                       └─────────────────────┘
External: Hedera testnet (facilitator: x402.org or Blocky402), 0G Private Computer, 0G Storage, World IdP (OIDC)
```

**Key decisions:**
- **Device connects outbound** (WebSocket/long-poll to the gateway). Venue Wi-Fi often isolates clients, so never rely on inbound connections to the ESP32. Bring a phone hotspot.
- **The device is the final authority** on actuation. The server can be compromised; the device only trusts receipts signed by the pinned public key.
- **Local session timer** on the device: power off even if the network dies.
- **One gateway service** for the hackathon (not microservices). Modules inside it.
- **Provider-agnostic AI interface**: a `Decider` interface with a `ZeroGDecider` implementation (OpenAI-compatible API), so models can be swapped.

## 7. Data model (Prisma + SQLite)

- `Device { id, name, pubKeyFingerprint, pricePerMinute, payTo, status, lastHeartbeat }`
- `Agent { id, name, hederaAccountId, dailyCap, spentToday, humanSubject? }`
- `Session { id, deviceId, agentId, amount, minutes, status (PENDING|STEP_UP|DECIDING|ISSUED|ACTIVE|SETTLED|CANCELLED|SAFE_STOP), nonce, expiresAt, paymentPayloadHash, hederaTxId?, zgRequestId?, zgRootHash?, hcsSeq?, createdAt }`
- `StepUp { id, sessionId, state, nonce, status (PENDING|APPROVED|DENIED|EXPIRED), worldSub?, authTime? }`
- `UsedNonce { nonce, createdAt }` (server-side replay guard too)

## 8. Security checklist (also a demo talking point)

- [ ] Receipt: Ed25519 over a canonical encoding; fields deviceId, sessionId, nonce (128-bit random), notBefore, expiresAt, amount
- [ ] Device: reject wrong deviceId, expired, not-yet-valid, used nonce; NTP time sync with a tolerance window
- [ ] Server: payment payload hash single-use; idempotent settle
- [ ] World ID: OIDC authorization code + PKCE, validate `iss`/`aud`/`exp`/`nonce`/`auth_time` server-side; bind step-up to the sessionId via `state`
- [ ] Secrets only in env; never ship the receipt private key or Hedera key to the browser
- [ ] Rate limit the session endpoint per agent
- [ ] 0G timeout (e.g. 4s) → SAFE_STOP, never a default ALLOW
- [ ] Device-pinned public key compiled into firmware (or provisioned once over serial)

## 9. Environment variables

```
# Hedera
HEDERA_NETWORK=testnet
HEDERA_OPERATOR_ID=0.0.x
HEDERA_OPERATOR_KEY=302e...            # DER
HEDERA_PAYTO_ACCOUNT_ID=0.0.x          # device owner revenue account
HEDERA_HCS_TOPIC_ID=0.0.x
HEDERA_USDC_TOKEN_ID=0.0.429274         # testnet USDC (verify)
X402_FACILITATOR_URL=https://x402.org/facilitator   # or https://api.testnet.blocky402.com

# Agent (separate account, the payer)
AGENT_HEDERA_ACCOUNT_ID=0.0.x
AGENT_HEDERA_PRIVATE_KEY=302e...

# 0G
ZG_COMPUTE_BASE_URL=                     # 0G Private Computer, OpenAI-compatible
ZG_COMPUTE_API_KEY=
ZG_MODEL=0gm-1.0
ZG_STORAGE_RPC=
ZG_STORAGE_INDEXER=
ZG_PRIVATE_KEY=

# World ID (OIDC)
WORLD_OIDC_ISSUER=                       # from auth.world.org discovery
WORLD_CLIENT_ID=
WORLD_CLIENT_SECRET=                     # or private_key_jwt
WORLD_REDIRECT_URI=http://localhost:3000/api/world/callback

# Receipts
RECEIPT_SIGNING_KEY_ED25519=             # base64 seed, server only
STEP_UP_THRESHOLD_HBAR=2
DATABASE_URL=file:./dev.db
```

## 10. Milestones (deadline: verify on Discord, reported Sun 8 Nov 09:00 IST)

| When | Milestone | Done = |
|---|---|---|
| Fri AM | Repo scaffold, Hedera testnet accounts, faucet, x402 hello-world | Agent pays a dummy endpoint, Hedera tx ID visible on HashScan |
| Fri PM | ESP32 receipt verify + relay | Signed receipt from a script flips the relay; a replay is rejected |
| Fri night | Gateway glue: 402 → verify → sign receipt → device → settle | End-to-end paid unlock, no UI |
| Sat AM | Policy + World ID step-up (approve + deny) | Over-cap request blocked until World ID, cancel path works |
| Sat PM | 0G decider + Storage log + safe stop + HCS | Request IDs + root hashes in DB; unplug 0G → SAFE_STOP |
| Sat night | Dashboard + feature freeze | Judge can watch a session live |
| Sun AM | Video, README, sponsor docs, submit | Submitted before the deadline |

## 11. Demo script (≤3 min for finalist, ≤5 min Hedera video)

1. "Agents can reason but can't safely pay for the physical world." (10s)
2. The agent rents the device → 402 → pays → **relay clicks**; show the HashScan tx + 0G request ID. (40s)
3. Replay the receipt → rejected on the device. (15s)
4. The agent tries an expensive 30-min session → World ID prompt → **human cancels** → nothing happens; then approve → works. (40s)
5. Kill 0G → **device stays off** (safe stop). (20s)
6. Audit trail: HCS topic + 0G Storage episode. (20s)
7. Roadmap: marketplace of rentable machines for agents. (15s)

## 12. Submission checklist

- [ ] Public GitHub repo, MIT license, steady commit history (no single final-day dump)
- [ ] README: architecture diagram, payment flow, Hedera tx ID(s) + HashScan links, HCS topic ID, 0G request IDs + Storage root hashes, safe-stop explanation, the sentence "what breaks if 0G is removed", **Credits** section for Paybot and reused libraries, how AI was used
- [ ] `docs/WORLD_DEBRIEF.md`: time to first success, friction, missing capability/docs, top improvement
- [ ] Demo videos: ≤3 min (finalist/0G), ≤5 min (Hedera); no sped-up footage, no phone recording, no AI voiceover (ETHGlobal video rules)
- [ ] Live demo link + hardware at the 0G booth if possible
- [ ] Select partner prizes: Hedera, 0G, World
