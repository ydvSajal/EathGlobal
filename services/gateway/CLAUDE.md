# Lane B: backend (`services/gateway`, `services/agent`, `packages/db`)

You own **only** those three folders. Layers L1 (db) / L2 (core) / L3 (http, ws, agent). Build against ports and fakes from `@agentmeter/shared`; the composition root (`src/main.ts`) injects fakes or real adapters by env.

Read first: root `CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/API.md`, `TRD.md` (§2 F1–F11, §3 timeouts and fail-safe rules), `docs/STATE.md`.

## Starter prompt
> You are the **backend** lane for AgentMeter. Read CLAUDE.md, services/gateway/CLAUDE.md, docs/ARCHITECTURE.md, docs/API.md, TRD.md, docs/STATE.md. Do task <Bn> only, inside services/gateway, services/agent, packages/db. Open a PR.

## Stack
Hono + `@hono/node-server` + `ws`, Prisma + SQLite, zod, pino, Vitest.

## Tasks
- [x] **B1** Gateway skeleton: `config.ts` (zod env, fail fast), `main.ts` composition root (`ADAPTERS=fake|real`), `/health`, pino logging.
- [x] **B2** `packages/db`: Prisma schema per TRD §4 (`Device, Agent, Session, SessionEvent, StepUp, UsedNonce`), repositories, seed with one device and one agent.
- [x] **B3** `core/session-machine.ts` (allowed transitions only) and `core/policy.ts` (allowlist, daily cap, device rate, threshold). Table-driven unit tests.
- [ ] **B4** `core/orchestrator.ts`: verify → policy → step-up → decide → receipt → push → ack(8s) → settle → log. Tests with fakes: happy, replay, over-cap denied, 0G down → SAFE_STOP, no ack → no settle.
- [ ] **B5** HTTP routes: `POST /devices/:id/session` (402 flow via the `PaymentFacilitator` port), `GET /sessions/:id`, step-up start/callback, reads, `GET /events` SSE.
- [ ] **B6** Device hub `ws/devices.ts`: hello, heartbeat, ack/nack, 15s offline detection, `receipt`/`cancel` push. Include a simulated-device script (`pnpm sim:device`) so you can test without hardware.
- [ ] **B7** `services/agent`: `pay.ts` using `@x402/fetch` + Hedera signer (pattern from hbar402), `cli.ts` (`rent`, `status`), handles `step_up_required` by printing the URL and polling. Needs web3 lane for the real signer; use the fake facilitator until then.
- [ ] **B8** Scenario runner `pnpm demo:scenarios` covering all six demo cases.

## Rules
- The order of operations lives only in `orchestrator.ts`.
- Any 0G failure is `SAFE_STOP`. Payment settles only after a valid ack. Logging failures never change a decision.
- Every external call goes through a port, with the TRD §3.1 timeout and a typed error.
- Never log keys. Never import from `apps/web`.

## Definition of done
`pnpm --filter "@agentmeter/{gateway,db,agent}" typecheck test` pass; scenario runner green with fakes; `ADAPTERS=real` boots when keys are present.

## Keys needed
Owner provides (ask): `RECEIPT_SIGNING_KEY_ED25519` (generate with the shared script once it exists), later the real Hedera/0G/World values via the web3 lane's adapters.

## Reference
Paybot `apps/x402-facilitator/src/example-resource-server.ts` (Hono layout, middleware shape) and `facilitator.ts` (`/verify` then `/settle`).
