# Workflow: Parallel Lanes and Stacked PRs

How several Claude sessions (or people) build AgentMeter at the same time without stepping on each other.

## 1. Lanes

| Lane | Folder it owns | Brief for the agent | Branch prefix |
|---|---|---|---|
| core (lead) | `packages/shared`, `docs`, root config | `docs/lanes/CORE.md` | `core/` |
| A. web | `apps/web` | `apps/web/CLAUDE.md` | `web/` |
| B. backend | `services/gateway`, `services/agent`, `packages/db` | `services/gateway/CLAUDE.md` | `be/` |
| C. web3 | `packages/chain` | `packages/chain/CLAUDE.md` | `w3/` |
| D. firmware | `firmware/esp32` | `firmware/esp32/CLAUDE.md` | `fw/` |

Rules:
1. **Edit only inside your lane's folder.** Need something elsewhere? Open an issue labeled `contract` or ask the lead (§5).
2. Read, in order: `CLAUDE.md` (root), your lane brief, `docs/ARCHITECTURE.md`, `docs/API.md`, `TRD.md`.
3. Build against **ports and fakes** from `packages/shared`. Never block on another lane.
4. Every lane brief lists its tasks, definition of done, and the keys it needs.

## 2. Starting a parallel session (git worktrees)

One worktree per lane so sessions never share a working directory. From the repo root, after the stack in §3 lands (or from the PR3 branch before it merges):

```bash
git fetch origin
git worktree add .worktrees/web      -b web/dashboard-shell   origin/main
git worktree add .worktrees/be       -b be/gateway-skeleton   origin/main
git worktree add .worktrees/w3       -b w3/hedera-x402        origin/main
git worktree add .worktrees/fw       -b fw/receipt-verify     origin/main
```

Then open a Claude Code session in each folder (`cd .worktrees/web && claude`) and paste the starter prompt from the lane brief. `.worktrees/` is git-ignored. Run `pnpm install` once per worktree (pnpm store is shared, so it is fast).

Starter prompt shape: *"You are the <lane> lane for AgentMeter. Read CLAUDE.md, <lane brief>, docs/ARCHITECTURE.md, docs/API.md, TRD.md. Do task <N> only. Stay inside <folder>. Open a stacked PR."*

## 3. Stacked PRs

Each PR is based on the previous branch, not on `main`, so reviewers see small diffs and lanes can build on unmerged work.

Initial stack (created in this setup):

| # | Branch | Base | Contents |
|---|---|---|---|
| 1 | `feat/docs-foundation` | `main` | README, TRD, ARCHITECTURE, API, WORKFLOW, DECISIONS, RESOURCES, SCOPE |
| 2 | `feat/monorepo-scaffold` | PR1 branch | pnpm workspace, lane folders and briefs, `.env.example`, tsconfig, CI |
| 3 | `feat/shared-contracts` | PR2 branch | schemas, ports, fakes, errors, receipt crypto, test vector |

Create a stacked PR:
```bash
git checkout -b feat/next-thing            # from the branch you are stacking on
# ...work, commit...
git push -u origin feat/next-thing
gh pr create --base <previous-branch> --title "..." --body "..."
```

Merging bottom-up: merge PR1 into `main`, then retarget PR2 to `main` (`gh pr edit <n> --base main`), merge, repeat. If a lower PR changes after review, rebase the ones above:
```bash
git checkout feat/monorepo-scaffold && git rebase feat/docs-foundation
git checkout feat/shared-contracts  && git rebase feat/monorepo-scaffold
git push --force-with-lease origin feat/monorepo-scaffold feat/shared-contracts
```
`--force-with-lease` only on your own stack branches, never on `main`.

Lane PRs after the initial stack are normally **based on `main`** (lanes are independent); stack within a lane when tasks depend on each other.

## 4. Commits and PRs
- Small commits, imperative subject, conventional prefix: `feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`. Sponsors check for steady history, so no end-of-hackathon dumps.
- PR body: what, why, how tested, which TRD/API items it covers, any new ADR.
- Never commit `.env`, keys, `secrets.h`, `*.db`.
- Before opening: `pnpm -r typecheck && pnpm -r test`.

## 5. Contract-change protocol (`packages/shared`, `docs/API.md`)

Contracts are the one shared surface. To change one:
1. Open an issue (label `contract`) naming the schema/port, the change, and which lanes are affected.
2. The lead edits `packages/shared` + `docs/API.md` + the test vector (if the receipt) in **one** PR based on `main`, appends an ADR, and announces it.
3. Lanes rebase onto it. Additive changes (new optional field) are safe; renames/removals need all affected lanes to acknowledge.
4. Never edit `packages/shared` from a lane PR.

## 6. Integration milestones

| Gate | Lanes | Proof |
|---|---|---|
| G0 | core | Stack PR1–3 merged; fakes run |
| G1 | w3 + agent | First settled Hedera x402 payment, tx ID on HashScan (**stop and confirm with owner**) |
| G2 | fw + core | Firmware verifies test vector, flips relay, rejects replay |
| G3 | be + fw | Gateway pushes a receipt to the real device, gets ack, settles (no UI) |
| G4 | be + w3 + web | Step-up approve and deny paths work end to end |
| G5 | w3 + be | 0G decision, request ID, Storage root hash, HCS seq; 0G blocked → SAFE_STOP |
| G6 | web | Dashboard shows a live session with countdown and audit links |
| G7 | all | Demo scenarios pass; docs, video, submission |

No P1 work (USDC, camera, Agent Kit) before G3 is green.

## 7. Daily rhythm
1. Lead merges the lowest ready PR; lanes rebase.
2. Each lane updates its task checklist in its brief (tick boxes in the PR).
3. Decisions go to `docs/DECISIONS.md` the moment they are made.
4. End of session: push, open or update PR, note blockers in the PR description.

## 8. Asking the owner
Agents stop and ask the owner for: Hedera account IDs/keys, 0G API key and credits, World portal client, hardware details, deadline, any spend, and any change to a prize-critical requirement. Never invent keys or fake an integration result.
