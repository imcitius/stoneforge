# el-56khe HTTP session start review — evidence summary (2026-11-01)

Condensed record of the November review rounds for el-56khe (conditional release
of the HTTP task assignment after a failed session start). The full narrative of
each round is in `docs/task-lifecycle-race-investigation.md` (sections
"el-56khe independent re-review" onward). Raw gate logs, results JSON, archives
and probe copies were removed before publication; this file keeps what was
measured, the key numbers, the commits and the conclusions.

Delivered to `master` as `02511ed` (after the unrelated fixture collision was
fixed by el-1w48v in `5b3b5ae`). Permanent regression coverage lives in
`packages/smithy/src/api/http-session-start{,.concurrent,.steward-probe}.bun.test.ts`.

All runs used temporary SQLite (two connections), local Git worktrees, the real
API/HTTP route factories and SessionManager, with inert provider handles; no live
workspace, provider, daemon or installed application was used. Subprocesses used
`checkEnvironment()` from `scripts/check-merge.mjs`. Runtime for the accepted
gates: repository-pinned Node v22.23.3
(`export PATH="$PWD/apps/desktop/node_modules/node/bin:$PATH"`), pnpm 8.15.5,
`pnpm install --frozen-lockfile` with an unchanged lockfile.

## Rounds

| Round | Commit | What was measured | Key result | Verdict |
|---|---|---|---|---|
| Steward re-review (el-3jso) | `a51bbb2` | Publication/pending-rollback probe, both routes | 4/4, 66 assertions | Fixed |
| | | Overlapping start probe (A accepted, B rejected by SessionManager then released A's assignment) | **0/2** (24 assertions); no-release control 2/2 | **Changes required** |
| | | `pnpm check:merge`, ambient Node 26.8.2 | 193/195 — Quarry `metrics-output`/`piped-output`: better-sqlite3 ABI 127 vs Node 26 ABI 147 (`ERR_DLOPEN_FAILED`), tracked as el-127xg | Environment |
| | | `pnpm check:merge`, pinned Node 22 | 195/195, 361.53 s | Pass |
| Worker overlap fix | `ec28964` | Per-SessionManager/per-agent HTTP admission; contender gets 409 `SESSION_START_IN_PROGRESS` before any assignment | Baseline 0/2, control 2/2; eight focused suites 365/365 (2302 assertions); gate 197/197, 247.31 s | Pass |
| Steward final re-review (el-3jso) | `cce7fd0` | Overlap fix; adapted original probe | 6/6, 88 assertions; gate 197/197, 255.99 s | Fixed |
| | | Sequential retry after incomplete startup rollback (A's termination throws, B retries, B's spawn fails and releases A's assignment) | **0/2** (28 assertions); no-release control 2/2 | **Changes required** |
| Worker retry fix | `ecb6ce9` | Admission retained on `SessionStartupCleanupError`; later requests get 409 `SESSION_START_CLEANUP_INCOMPLETE` with the exact internal session ID | Concurrent suite 30 cases; eight focused suites 375/375 (2550 assertions); gate 197/197, 245.49 s | Pass |
| Steward re-review | `3e6d534` | All acceptance criteria; portable steward probe | 8/8, 118 assertions | Criteria met |
| | | `pnpm check:merge`, pinned Node 22 | 196/197, 253.95 s — only failure `task-completion-protocol.bun.test.ts` fixture `UNIQUE elements.id` before the behaviour under test; isolated rerun 69/69 | Delivery held → el-1w48v |

The focused suites were (relative to `packages/smithy/src/`):
`api/http-session-start.bun.test.ts`, `api/http-session-start.concurrent.bun.test.ts`,
`api/http-session-start.steward-probe.bun.test.ts`,
`api/orchestrator-assignment.bun.test.ts`, `runtime/session-manager.bun.test.ts`,
`services/dispatch-claim.bun.test.ts`, `services/task-assignment-service.bun.test.ts`,
`services/task-completion-protocol.bun.test.ts`.

## Conclusion

- Both HTTP factories release an assignment only through the attempt-bound
  receipt of their own failed attempt, with conditional (CAS) release; no
  current-owner lookup or adoption, no error-string matching.
- One HTTP start attempt per SessionManager/agent is admitted from before the
  first await until after awaited cleanup. Overlapping contenders receive 409
  without side effects.
- If startup rollback fails or its result is unknown, admission stays held for
  that attempt and later requests receive 409 `SESSION_START_CLEANUP_INCOMPLETE`.

## Limitations

- Retained admission lasts for the SessionManager instance lifetime, even after
  a later exact-session stop; there is no reset or recovery endpoint.
- The guard is in-process HTTP only; CLI/daemon/resume, other managers/processes
  and crash recovery are not fenced.
- Worktrees are intentionally retained; orphan removal is not promised.
- Provider handles are inert fixtures; live SDK termination was not tested.
- Root build/lint/test, public docs build, browser/packaged GUI, cross-platform and
  live-provider checks were not run in these rounds.
