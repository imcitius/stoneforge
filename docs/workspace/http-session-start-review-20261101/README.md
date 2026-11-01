# el-56khe independent re-review, 2026-11-01

Reviewed implementation/integration: `a51bbb21800d64d237e4ced9d780673341b81223`.
Local target: `bdd07d45252ad3f9a052902b4255c5089f0253fa`.
Steward: el-3jso. Verdict: **CHANGES REQUIRED**.

Approved operational CLI build-info and all four supplied hashes matched. Safe
sync required only concatenating the two independent lifecycle-report sections;
no production conflict edits. No pending worker changes were imported.

## Blocking finding

The criterion "уже принятая/новая сессия не жертва cleanup" is still unmet:

1. Request A assigns task T to agent X and waits for provider spawn.
2. Request B for the same T/X passes the HTTP active-session precheck, because A
   has not returned its spawn handle yet. B commits its own assignment receipt.
3. A finishes normal spawn, publishes/persists its exact session and returns201.
4. B invokes the real SessionManager. It rejects with "already has an active
   session" before creating any B session.
5. B treats that rejection as permission to release its assignment receipt. Its
   version still matches (A's publication updates the agent, not the task).
6. A is still running/persisted with a live mock provider handle, but task T has
   no assignee. B reports500 and `cleanup.assignment=released`.

The scheduling hooks only await/defer real operations. No synthetic startSession
exception, private state mutation, current-owner adoption or live provider is used.
Two temporary SQLite connections, local Git worktrees and both actual HTTP route
factories exercise real API assignment CAS and SessionManager start/stop behavior.
The provider boundary is mocked; this is not evidence of live SDK termination.

`concurrent-start-probe.log`: **0pass/2fail,exit1**,24 assertions. Both fail only
at preserved assignee after proving A returned201, exact running persisted identity,
live handle and retained registered Git worktree. `concurrent-start-control.log`:
**2pass/0fail,exit0**,24 assertions, with only HTTP assignment release replaced by
an inert return. This control attributes loss to the new release behavior; it is
not a full master checkout. An earlier scheduling variant also failed both routes
when B rejected while A was still starting; the saved final probe establishes the
stronger already-accepted-session case.

Required correction: distinguish rejection due to another starting/accepted attempt
from a positively cleaned own failed attempt. Prevent overlapping start requests
from acquiring/releasing a task receipt that belongs to an accepted invocation,
using an attempt-bound contract or a narrow ownership/reservation boundary. Do not
fix this by rereading/adopting the current session or matching an error string.
Preserve successful own-start rollback release, incomplete-cleanup retention,
original errors, assignment CAS, Human/terminal/successor decisions and retained
worktrees. Add both overlapping schedules as permanent regressions on both routes.
Keep this evidence and update el-4aqnn and the lifecycle report after correction.

## Previously blocking paths

Optional accepted-start logging is now correctly non-fatal with explicit stderr
including internal session ID; publication/persistence and startup errors are not
blanket-suppressed. `SessionStartupCleanupError` preserves both errors and exact
attempt identity if rollback rejects. The caller retains assignment on incomplete
rollback and after accepted notification failures. Returned receipts and release
CAS remain fenced against status/version/owner/session changes.

Recreated independent `published-and-pending-probe.log`: **4pass/0fail,exit0**,
66 assertions. Both routes preserve exact assignment/task events after optional
log failure and retain assignment while rollback termination is pending, releasing
only after it settles. Worker permanent probe16 additionally covers repeated log
failure, listener/publication failure, rollback failure/unknown persistence, and
real successor starts. Original September /tmp probe files were absent; their
historical failed0/2/control2/2 records remain in el-4aqnn and the lifecycle report.
These November artifacts preserve fresh evidence without claiming the old files
still exist.

## Reproduction

The `.bun.test.ts.txt` files use imports relative to `packages/smithy/src/api/`.
Copy one there under a temporary `.bun.test.ts` name, run it with Bun, then remove
only that temporary file. Run subprocesses using `checkEnvironment()` exported by
`scripts/check-merge.mjs`, which strips live project/actor/server routing and sets
`RUN_INTEGRATION_TESTS=false`. For the concurrent probe use
`--test-name-pattern 'overlapping HTTP'`; for its control additionally set
`EL56_CONTROL_NO_RELEASE=1` in that sanitized subprocess environment. The copied
probe includes the four passing controls; they are filtered out in concurrent logs.
Do not run fixtures against live workspace storage or providers.

Required gate result and environment limitations are appended below.

## Environment failure and authorized pinned run

The initial full `pnpm check:merge` used ambient Node v26.8.2 and finished
**193/195,exit1,294.95s**. The only failed checks were Quarry `metrics-output`
(step075) and `piped-output` (step089). `ambient-gate-results.json`,
`ambient-gate.log`, `ambient-075.log` and `ambient-089.log` preserve the failures.
An isolated in-memory native load reproduced `ERR_DLOPEN_FAILED`: better-sqlite3
is ABI127 (Node22), while Node26 requires ABI147 (`native-abi.log`). Quarry,
storage, lockfile and gate script have no diff against the local target.
Director notified in el-3u2wx; follow-up is already tracked as el-127xg, no duplicate.

Director confirmed the overlap defect belongs in el-56khe and explicitly authorized
one fresh gate with repository-pinned Node22 first on PATH (el-241/el-1bx and task
scope updated). The command, from the worktree root, is:

```sh
export PATH="$PWD/apps/desktop/node_modules/node/bin:$PATH"
node -v  # v22.23.3, saved in pinned-runtime.log
pnpm check:merge
```

No native rebuild, package/lockfile edit, global Node change or gate weakening.
The new runtime does not fix the HTTP defect: pinned `bun test` of the complete
independent probe still has **4pass/2fail,exit1**,90 assertions; the filtered
no-release-only control still passes **2/2,exit0**,24 assertions. These are saved
as `pinned-probes.log` and `pinned-control.log`.

The first gate's seven relevant suites passed **345/345,1956 assertions**:
HTTP48 + permanent publication probe16 + explicit API30 + SessionManager92 +
dispatch53 + assignment37 + completion69. Smithy Node/Vitest352/352 and Desktop
Node17/17 passed. Existing skips elsewhere are not passing coverage. The original
frozen install passed with pnpm8.15.5; the lockfile is unchanged. No standalone
root build/lint/test, docs build, browser/packaged GUI, cross-platform, live-provider
or maintenance checks were run. These omissions do not imply acceptance.

Final pinned-gate outcome follows.

Final pinned gate: **195 checks, 0 failed, duration=361.53s; exit0**.
All195 checks passed with Node22.23.3; relevant345/345,1956 assertions,
Smithy Node/Vitest352/352 and Desktop Node17/17. Full command/exits in
`pinned-gate-results.json`, gate log and nine relevant per-step logs retained.
The HTTP overlap probe remains0/2 (control2/2); the verdict is still CHANGES REQUIRED.

Only documentation/evidence changed after the reviewed source a51bbb2.
No source, manifest, lockfile or gate changes were made by the reviewer.
Director scope decision authorizes a narrow single-flight guard or attempt-bound
outcome without successor lookup; the next worker must implement it and rerun
relevant tests and the pinned gate, then obtain another exact-final independent review.
