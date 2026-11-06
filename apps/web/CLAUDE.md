# Lane A: web (`apps/web`)

You own **only** `apps/web/**`. Layer L3. Import from `@agentmeter/shared` (types, zod, api-client); never import gateway code; no secrets in the browser.

Read first: root `CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/API.md` §1, `TRD.md` F13, `docs/STATE.md`.

## Starter prompt
> You are the **web** lane for AgentMeter. Read CLAUDE.md, apps/web/CLAUDE.md, docs/ARCHITECTURE.md, docs/API.md, TRD.md, docs/STATE.md. Do task <Wn> only, inside apps/web. Open a PR.

## Stack
Next.js App Router, TypeScript strict, Tailwind, shadcn/ui. Browser talks only to the gateway at `NEXT_PUBLIC_GATEWAY_URL`.

## Tasks
- [ ] **W1** Scaffold Next.js + Tailwind + shadcn in this folder (keep package name `@agentmeter/web`; add `typecheck` script). Layout, nav, dark theme.
- [ ] **W2** Gateway client wrapper + `useSSE` hook over `/events`. Fixture mode (`NEXT_PUBLIC_FIXTURES=1`) serves canned data from `@agentmeter/shared` fakes so you never block on the backend.
- [ ] **W3** `/` devices list: status, last heartbeat, relay, price per minute.
- [ ] **W4** `/sessions/[id]` live session: state timeline, countdown to `expiresAt` (idea from Paybot `CountdownTimer`), locked/unlocked gate (idea from `BotAccessGate`), HashScan link.
- [ ] **W5** `/agents` spend vs cap bars.
- [ ] **W6** `/audit` table: session, state, HashScan tx link, HCS seq, 0G request ID and root hash.
- [ ] **W7** `/step-up/[sessionId]` shows the exact action (device, minutes, amount), then redirects to the authorize URL from `POST /stepup/:id/start`. `/api/world/callback` forwards `code,state` to the gateway server-side and renders APPROVED / DENIED / EXPIRED. Deny and expiry paths are prize-critical.
- [ ] **W8** Polish for the demo video: big countdown, clear SAFE_STOP and CANCELLED banners.

## Definition of done
`pnpm --filter @agentmeter/web typecheck` passes; pages render against fixtures and against a real gateway; no key material in the bundle; mobile-friendly enough for a demo phone.

## Keys needed
None for fixtures. World client ID is held by the **gateway**, not the web app. Needs: running gateway URL.

## Reference
Paybot `apps/web/src/components/gate/BotAccessGate.tsx`, `components/ui/CountdownTimer.tsx`, `hooks/usePayment.ts` (ideas only; Vite/wagmi code does not carry over).
