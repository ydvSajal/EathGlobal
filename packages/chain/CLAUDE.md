# Lane C: web3 (`packages/chain`)

You own **only** `packages/chain/**`. Layer L1: real adapters for the ports in `@agentmeter/shared/src/ports.ts`. Throw typed errors from `shared/errors`; honor TRD §3.1 timeouts; never return a made-up success.

Read first: root `CLAUDE.md`, `docs/ARCHITECTURE.md` §2, `docs/API.md` §4–5, `TRD.md` §3, `docs/RESOURCES.md`, `docs/STATE.md`.

## Starter prompt
> You are the **web3** lane for AgentMeter. Read CLAUDE.md, packages/chain/CLAUDE.md, docs/ARCHITECTURE.md, docs/API.md, TRD.md, docs/RESOURCES.md, docs/STATE.md. Do task <Cn> only, inside packages/chain. Open a PR. Ask the owner for any key you need.

## Tasks
- [ ] **C1** *(Gate G1, stop and confirm with owner)* First settled x402 payment on Hedera testnet: a tiny script in `packages/chain/scripts/first-payment.ts` runs a dummy Hono endpoint and an agent that pays it with `@x402/fetch` + `ExactHederaScheme` + `createClientHederaSigner` (pattern from `OkeyAmy/hbar402`). Log the Hedera tx ID and HashScan link. Resolve: is `@x402/hedera` on npm, or add it from `typescript/packages/mechanisms/hedera` of the x402 monorepo? Record in `docs/DECISIONS.md`.
- [ ] **C2** `facilitator.ts`: implement `PaymentFacilitator` (`requirements`, `verify`, `settle`) against `X402_FACILITATOR_URL`. Confirm verify can run without settle (spec says yes). Check `curl $X402_FACILITATOR_URL/supported` lists `hedera:testnet`. If not splittable, implement the fallback (settle then refund) behind the same port and ADR it.
- [ ] **C3** `hcs.ts`: implement `AuditLog` (`TopicMessageSubmitTransaction`), plus `scripts/create-topic.ts`. Decide SDK package (`@hashgraph/sdk` vs `@hiero-ledger/sdk`); ADR it.
- [ ] **C4** `zerog-decider.ts`: implement `Decider` via the Router (`https://router-api.0g.ai/v1`, OpenAI-compatible). 4s `AbortController`; strict JSON prompt parsed with zod; any failure throws so the orchestrator emits `SAFE_STOP`. **Find where the request ID comes from** (response header/body field?); if the Router gives none, use the Direct SDK path. ADR it. Record a live example request ID in `docs/STATE.md`.
- [ ] **C5** `zerog-storage.ts`: implement `EpisodeStore` (`put` → `rootHash`). Confirm package name and call shape from the 0G Storage SDK docs.
- [ ] **C6** `world.ts`: implement `StepUpProvider` using OIDC discovery, PKCE S256, `max_age=0`, `prompt=login`, token validation (`iss`, `aud`, `exp`, `nonce`, `acr`, `auth_time` belongs to this attempt), single code redemption. Denied/expired/cancelled return a result, never throw success. Keep notes for `docs/WORLD_DEBRIEF.md` (time to first success, friction, missing docs, top improvement).
- [ ] **C7** (P1) USDC via HTS: add token asset to requirements; handle association.
- [ ] **C8** (P1) Hedera Agent Kit option for the agent.

## Rules
- Each adapter has a contract test run against the **fake of the same port** (same assertions) plus an opt-in live test (`LIVE=1`) that needs keys.
- No keys in code. Read config passed in by the composition root, not `process.env` inside adapters.
- Do not edit `packages/shared`; request contract changes via `docs/WORKFLOW.md` §5.

## Definition of done
`pnpm --filter @agentmeter/chain typecheck test` pass; live test proven once per adapter and the evidence (tx ID, request ID, root hash, HCS seq) pasted in the PR.

## Keys needed (ask the owner)
Hedera operator/payTo/agent accounts and keys · 0G Compute API key + model name · 0G Storage RPC/indexer/private key · World client id/secret + redirect URI. Sources in README §4.
