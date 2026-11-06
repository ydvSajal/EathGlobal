# AgentMeter API and Wire Contracts

Contract-first: lanes build against this file and the zod schemas in `packages/shared/src/schemas`. If they disagree, the zod schema wins and this file gets fixed in the same PR. Versioned: `v1`. Breaking changes follow `docs/WORKFLOW.md` §5.

Money: integer base units as **strings** (tinybar for HBAR, token base units otherwise) plus `asset` (`"HBAR"` or HTS token id). Time: unix seconds (integer). IDs: opaque strings.

## 1. REST (gateway, JSON)

### Errors
`{ "error": { "code": "POLICY_DENIED", "message": "...", "sessionId": "s_..." } }`. Codes in TRD §6.

### `POST /devices/:id/session`  (x402-protected)
Request body: `{ "minutes": 10, "agentId": "a_1" }`.

| Case | Status | Body |
|---|---|---|
| No payment header | 402 | x402 requirements: `{ x402Version, accepts:[{ scheme:"exact", network:"hedera:testnet", asset, amount, payTo, maxTimeoutSeconds, extra:{ feePayer, assetTransferMethod:"cryptoTransfer" } }] }` (exact shape comes from `@x402/core`) |
| Valid payment, policy ALLOW | 202 | `{ sessionId, state:"DECIDING" }` |
| Valid payment, over threshold | 202 | `{ sessionId, state:"STEP_UP", stepUpUrl }` |
| Policy deny | 403 | `POLICY_DENIED` |
| Replay | 409 | `PAYMENT_REPLAY` |
| Device offline | 409 | `DEVICE_OFFLINE` |
| Rate limited | 429 | `RATE_LIMITED` |

The agent then polls `GET /sessions/:id` or listens on `/events` until a terminal state.

### `GET /sessions/:id`
```json
{
  "id": "s_1", "deviceId": "d1", "agentId": "a_1",
  "state": "ACTIVE",
  "amount": "100000000", "asset": "HBAR", "minutes": 10,
  "expiresAt": 1789000000,
  "hederaTxId": "0.0.123@1789000000.000000000",
  "zgRequestId": "...", "zgRootHash": "0x...", "hcsSeq": 12,
  "events": [ { "state": "PENDING", "at": 1789000000, "detail": null } ]
}
```
States: `PENDING | STEP_UP | DECIDING | ISSUED | ACTIVE | SETTLED | CANCELLED | SAFE_STOP`. Terminal: `SETTLED | CANCELLED | SAFE_STOP`.

### Step-up
- `POST /stepup/:sessionId/start` → `{ authorizeUrl }`. Gateway stores `state`, `nonce`, PKCE verifier, and the exact action (deviceId, minutes, amount, expiry).
- `GET /stepup/callback?code&state` (called by the web callback server-side) → `{ sessionId, result:"APPROVED"|"DENIED"|"EXPIRED" }`.
- OIDC params: `scope=openid`, `max_age=0`, `prompt=login`, S256 PKCE, `state`, `nonce`.

### Reads for the dashboard
- `GET /devices` → `[{ id, name, status:"ONLINE"|"OFFLINE", lastHeartbeat, pricePerMinute, asset, relay }]`
- `GET /agents` → `[{ id, name, hederaAccountId, dailyCap, spentToday, asset }]`
- `GET /audit?limit&cursor` → sessions with `hederaTxId`, `hashscanUrl`, `hcsSeq`, `zgRequestId`, `zgRootHash`
- `GET /events` (SSE) → `event: session` data: `{ sessionId, state, at, detail }`; `event: device` data: `{ deviceId, status, relay }`
- `GET /health` → `{ ok, db, deps:{ facilitator, zerog, hedera, world } }` (last-success times)

## 2. Device WebSocket  `ws://<gateway>/devices/:id?token=<deviceToken>`

All frames are JSON text. Unknown `type` is ignored and logged.

Device → server:
| type | fields |
|---|---|
| `hello` | `deviceId, fw, ts` |
| `heartbeat` | `deviceId, relay:boolean, ts` (every 5s) |
| `ack` | `sessionId, nonce, relay:true, ts, mac`. `mac` = lowercase hex HMAC-SHA256 with the per-device secret over the string sessionId, nonce, ts joined by the pipe character (ts in unix seconds). Server ignores acks with a bad MAC, a ts more than 30s from now, or no matching pending receipt. |
| `nack` | `sessionId, nonce, reason: "signature"|"device"|"expired"|"not_yet_valid"|"replay"|"clock"` |

Server → device:
| type | fields |
|---|---|
| `receipt` | `receipt:{ deviceId, sessionId, nonce, notBefore, expiresAt, amount, payer }, sig` |
| `cancel` | `sessionId` (device turns relay off if on) |

Server rules: no `ack` within 8s of `receipt` → `CANCELLED`, no settle. No heartbeat for 15s → device `OFFLINE`.

## 3. Receipt (the Node ↔ firmware contract)

Canonical string (UTF-8, fixed order, `|` separated, no spaces):

```
AMv1|<deviceId>|<sessionId>|<nonceHex32>|<notBefore>|<expiresAt>|<amount>|<payer>
```

- `nonceHex32`: 16 random bytes, lowercase hex (32 chars).
- `notBefore`, `expiresAt`: unix seconds, decimal, no leading zeros.
- `amount`: decimal string of base units. `payer`: Hedera account id `0.0.n`.
- Field values must not contain `|`; the encoder rejects them.
- `sig` = Ed25519 signature over the UTF-8 bytes of the canonical string, base64 (standard, padded) in JSON.
- Device accepts when: signature valid for the pinned public key **and** `deviceId` equals its own **and** `notBefore-30 ≤ now ≤ expiresAt+30` **and** nonce not in its ring buffer (N≥32) **and** clock is NTP-synced.
- Test vector: `packages/shared/test-vectors/receipt.json` holds `{ seedBase64, publicKeyBase64, receipt, canonical, sigBase64 }` plus negative cases (tampered field, wrong device, expired, replay). Both Node tests and firmware run it.

## 4. Decider contract

Input (`DecisionInput`): `{ deviceId, deviceStatus, relay, lastHeartbeatAgeSec, recentSessions:[...], requestedMinutes, amount, agentId }`.
Output (`Decision`): `{ verdict:"ALLOW"|"DENY", reason:string, requestId:string }`.
Model prompt demands strict JSON `{"verdict":"ALLOW|DENY","reason":"..."}`; parse with zod; anything else is a failure.

## 5. Episode and audit schemas

`Episode` (0G Storage): `{ v:1, sessionId, deviceId, agentId, input:DecisionInput, decision:Decision|null, outcome:"ALLOW"|"DENY"|"SAFE_STOP", receiptHash?:string, at }`.
`AuditEntry` (HCS message): `{ v:1, sessionId, state, at, hederaTxId?, zgRequestId?, zgRootHash? }`, UTF-8 JSON, one per state change.
