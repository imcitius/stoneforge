# Core merge acceptance — el-1r6, 2026-09-26

The existing `core` registration now uses exactly **`pnpm check:merge`**.
Worker el-38k9 ran that command once on local master
`3722db9626db16f401eb464dab1239f8d0f1224f` in the assigned worktree before activation:
**exit 0, 176/176 steps, 163.249 seconds wall time**. Independent steward review
of this activation/evidence remains required before task closure/local delivery.

## Preconditions and verification

All seven blocking tasks were closed and their delivery commits were in master:
el-1ch, el-2kc, el-2z6, el-3514, el-52s, el-5xd and el-ptim. Installed dispatch
had created this worktree at old origin/master `bb5f967`. After checking all
299 manifest hashes of the independently approved el-ptim artifact, the worker ran
`STONEFORGE_ROOT=/Users/citius/Desktop/Work/Stoneforge /tmp/stoneforge-el-ptim-151b314/sf task sync el-1r6`.
It exited 0 and made HEAD exactly equal to local master `3722db9`, without switching
branches. No source/gate implementation, threshold, dependency or exclusion changed.

Environment: macOS arm64, Node 22.23.3, pnpm 8.15.5, Bun 1.3.11, Vitest 4.0.18.
`pnpm install --frozen-lockfile` exited 0 with unchanged lockfile. The worktree was
clean at gate start; only review documentation was added during/after verification.

| Check | Result | Runner seconds |
| --- | --- | --- |
| Gate regression tests | 5 pass | 0.38 |
| `pnpm typecheck --force` | 17 successful tasks, 0 cached | 27.25 |
| Fresh Desktop source build | exit 0 | 1.05 |
| Core Bun, 24 files | 2,737 pass, 22 skip | 1.74 |
| Storage Bun, 3 files | 137 pass | 0.30 |
| Quarry Bun, 96 files | 4,263 pass, 1 skip | 34.01 |
| Smithy Bun, 48 files | 1,355 pass, 6 skip | 88.86 |
| Smithy Node/Vitest | 325 pass, 13 files | 3.08 |
| Desktop Node | 6 pass | 6.14 |

All 8,492 Bun tests passed. The 29 existing skips are 22 core documentation checks,
one Quarry cycle check, two Smithy dispatch/E2E checks and four opt-in live Claude
tests. This run did not retry failures or weaken checks. Historical failures in
`docs/merge-checks.md` / workspace how-to el-1bx remain historical evidence.

Full logs: `/tmp/el-1r6-evidence/gate.log`, `install.log`, `gate.json` and
`/var/folders/b6/ltn3hn4j3nq1n86rbg2j9zk40000gn/T/stoneforge-merge-check-Z9wDEd/results.json`
(all exact commands, exit codes, durations and per-step logs). The adjacent
`merge-acceptance-2026-09-26.json` preserves sanitized snapshots and evidence hashes.

## Activation and shared instructions

The installed CLI and backend support repository list/add/remove, with no update
operation (`cli/commands/repo`, `server/routes/worktrees`, `git/project-repositories`).
The authorized fallback acquired the registry's exclusive `.lock`, reread its
contents, changed only core's `testCommand`, and atomically renamed the result.
It preserved id/path/targetBranch/gitCommonDir, all other data and file permissions.
No repository was removed/re-registered and no SQLite writes were made directly.
`core-merge-gate.patch` records the complete registry diff.

Both authenticated `GET /api/repositories` on the current Desktop backend and
installed `sf repo list` immediately returned `pnpm check:merge`. Connection
endpoint/project/instance identity matched before and after. No restart was needed.
Read-only inspection of installed backend confirms `list()` rereads the JSON and
the scoped merge service takes `repo.testCommand`. This proves live configuration
visibility; the standalone `task merge --local` command still requires an explicit
gate invocation and does not run it automatically.

The permitted root AGENTS correction changes only Dual Storage Model and gotcha 5:
SQLite serves current reads/writes; JSONL export uses `writeFile` and can lag.
No complete recovery from an arbitrary export is promised. This matches repository
AGENTS, `sync/service.ts:123-124,180-181` and spec el-68f. Full before/after files
are in `/tmp/el-1r6-evidence/root-AGENTS.{before,after}.md`; the exact reviewable
change is `root-agents-storage.patch`. Root has no wrapper Git and needs no commit.

Shared `.stoneforge/prompts/steward-merge.md` is byte-identical to
`docs/workspace/steward-merge.md`; neither was changed. Its explicit local-delivery
precedence supersedes built-in origin-based examples. `loadRolePrompt` is consumed
by daemon/scheduler launch paths. No `roleDefinitionRef` consumption was found in
those paths or session routes; its presence alone is not an active policy.

## Live orchestration and remaining issues

- Daemon: running, available, unpaused, workflow-task polling enabled. Exactly the
  existing four agents remain: el-3kyh Director, el-4eqh and el-38k9 ephemeral workers,
  el-3jso merge steward. All explicitly specify codex/gpt-6-astra and task limit 1.
  Both workers had exactly one in-progress task and `hasCapacity=false`.
- Scheduler is running with zero registered stewards/jobs/subscriptions. The merge
  agent exists with empty triggers; `pollWorkflowTasks` separately dispatches REVIEW
  tasks by stewardFocus=merge. Cron registration is not merge-agent registration.
- Workload endpoint reports top-level maxConcurrentTasks=3 because it reads
  `agent.capabilities.maxConcurrentTasks ?? 3`; capacity enforcement correctly reads
  `agent.maxConcurrentTasks ?? 1`. Tracked separately as **el-4p9h** in plan el-3xi6;
  no capacity/config changes were made to hide the reporting defect.
- Seven-day metrics contain **51 sessions**, but group by model reports `unknown`
  and by provider reports `claude-code`, despite current codex agent settings.
  Token/cache-token/cost totals are zero. These are returned values, not proof of
  zero actual use/cost, full model attribution, reliable error rates or throughput.
  Model and provider queries were sequential snapshots (durations can differ).
  Evidence is retained; missing attribution/usage cannot support model optimization.
- Installed Desktop still has the old dispatch/merge implementation. New worktrees
  need ancestry checks, and local integration needs the independently approved
  standalone CLI from el-2384/el-of6. Source delivery does not update the app.
- Gate exclusions remain: packaged GUI/LaunchServices, live providers/authentication,
  browser Playwright, standalone smithy-server Vitest, docs/website builds, browser
  sql.js and other operating systems. No app replacement or session restart occurred.

Steward must independently review this report, both shared-file patches, live
registration, updated workspace documents and the final task diff; rerun required
checks on the current local target before approved CLI local delivery. This worker
report does not substitute for that review.
