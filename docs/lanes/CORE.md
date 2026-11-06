# Core lane (lead): `packages/shared`, `docs`, root config

Owns contracts, docs, CI, and the PR stack. Only this lane edits `packages/shared` and `docs/API.md`.

## Tasks
- [x] **K1** Docs foundation (PR #1).
- [ ] **K2** Monorepo scaffold, lane briefs, `.env.example`, CI, state file and compaction hook (PR #2).
- [ ] **K3** Shared contracts (PR #3): zod schemas, ports, errors, fakes, canonical receipt encode/sign/verify, test vector with negative cases, key-generation script.
- [ ] **K4** Merge stack bottom-up; announce lanes may branch (Gate G0).
- [ ] **K5** Handle `contract` issues from lanes (`docs/WORKFLOW.md` §5).
- [ ] **K6** `docs/WORLD_DEBRIEF.md` (from web3 lane notes), final README with tx IDs and request IDs, architecture image, Credits, submission checklist (PRD §12).

## Rules
- Keep `docs/STATE.md` current (see root `CLAUDE.md`).
- Append every decision to `docs/DECISIONS.md`.
- Gate G1 (first Hedera payment) needs explicit owner confirmation before moving on.
