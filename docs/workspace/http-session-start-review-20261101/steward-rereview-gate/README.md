

## Independent final steward re-review el-56khe — 2026-11-01

Reviewed commit **3e6d534cf4983f4fc366dae15a4e747f4758bdb7**, local target
**1b43de2bf9c5c9716750e5a56c619530196732c4**. Approved installed operational CLI
build d58bd815/dirty=false and all four prescribed SHA256 hashes matched. Exact
command-scoped Human author/committer identity was used for `task sync el-56khe`;
exit0, refs/heads/master already included, HEAD unchanged. Reviewed task description,
caller report el-2hrsm, full production/test diff and affected existing code.
No steward production, test, conflict-resolution or repository edits.

Acceptance evidence:
1. Both HTTP factories capture only the committed assignment return (task ID,
   agent, internal identity and updatedAt). Failed assignment has no cleanup
   authority. Existing failed-dispatch CAS rejects changed versions/owners and
   Human/terminal/deferred decisions; no reread/adoption or admin fallback.
2. Real two-connection temporary SQLite/local Git/HTTP/API/SessionManager tests
   cover stranded-assignment baseline, success, preparation/spawn/publication/
   persistence/listener/notification errors, transaction rollback and cleanup
   diagnostics. R1/R2 preserve complete winning task/event snapshots, completion
   claims/history and status/branch. Reusable and successor Git data are retained.
3. Accepted/publication logging is a narrow non-fatal optional write with visible
   diagnostic. Post-return prompt/notification errors remain HTTP500 and retain
   accepted sessions and assignment. Unsuccessful/unknown rollback returns the
   exact attempt-bound SessionStartupCleanupError; pending rollback is awaited.
4. Shared manager/agent admission precedes every await/precheck and covers all
   effects and cleanup. Concurrent same/mixed factories reject409 without effects.
   Incomplete rollback retains admission and its own internal session ID across
   sequential retries/factory recreation; it never looks up/adopts a successor.
   Completed rollback still permits successful retry; unrelated agents progress.
5. Prior independent retry failure is corrected: portable steward probe rerun
   against current production passes **8/8,118 assertions,exit0** (both routes:
   publication, pending rollback, overlap and sequential incomplete retry).
   Adaptations only relocate imports and expect new409 incomplete-cleanup response
   instead of baseline500. No no-release stub or production modification in this
   passing run. First scratch invocation failed before tests because its node_modules
   link pointed at root (storage package unavailable); preserved setup log, then
   corrected link to Smithy dependencies. This was not a source failure/gate retry.
6. Historical original failures, attribution controls and failed ambient gate
   remain intact. All **94** committed review-evidence hashes verified across four
   manifests. Existing el-4aqnn, Directory and repository lifecycle report describe
   the final invariant and intentional retention. No new shared document/library
   entry is required. No pending branches, dependency or gate changes introduced.

Independent verification on Node **v22.23.3**, pnpm8.15.5:
- `pnpm install --frozen-lockfile`: exit0, lock unchanged.
- `pnpm check:merge`: **196/197, exit1,253.95s**. Uncached typecheck17/17,
  Desktop build, HTTP94/94, Smithy Node365/365, Desktop Node17/17 pass.
  Eight relevant suites: **374pass/1fail,2546 assertions**, not375 passes.
- Only failure: task-completion-protocol.bun.test.ts:38 beforeEach inserting
  savedDoc via api.create: UNIQUE elements.id / ALREADY_EXISTS, case
  `identity rejection preserves everything: missing-history` (68pass/1fail).
  Failure occurs before the completion/HTTP behavior. Fixture, core, Quarry,
  storage and completion source are byte-identical to target master.
- One bounded isolated `bun test packages/smithy/src/services/task-completion-protocol.bun.test.ts`
  with gate checkEnvironment() and pinned PATH: **69/69,374 assertions,exit0**.
  This is non-reproduction, not replacement of the failed gate. No full retry.
  No exact colliding IDs/root cause/frequency was captured.
- Scratch `bun test <scratch>/probe.bun.test.ts` via checkEnvironment():8/8.
  Source diff whitespace, unchanged source since worker gate, clean starting
  worktree and master ancestry checks pass. No source change during checks.

Original gate results: /var/folders/b6/ltn3hn4j3nq1n86rbg2j9zk40000gn/T/stoneforge-merge-check-thsMOB/results.json.
Durable complete197-step logs archive, results, failure, one isolated diagnostic,
probe source/log/setup failure and install/runtime logs are in
`docs/workspace/http-session-start-review-20261101/steward-rereview-gate/`.
To replay portable probe, copy independent-probe.bun.test.ts.txt into Smithy src/api
and run Bun in a fresh sanitized checkEnvironment() with pinned Node PATH;
remove the scratch copy afterward. No live routing/provider fixtures allowed.

Limitations: retained admission lasts the SessionManager lifetime even after an
explicit exact-session stop succeeds; no reset/recovery protocol was added.
Manager replacement/restart is not proof of provider cleanup. In-process HTTP
admission does not fence CLI/daemon/resume, other managers/processes or crash
recovery. Worktree retention deliberately does not promise removal of orphans.
Provider handles are inert test fixtures, not actual provider transports.
Separate root build/lint/test, public-docs build, browser/packaged GUI,
cross-platform and live-provider checks omitted; existing skips are not passes.
Installed application, live sessions/daemon and maintenance were not changed.

Adjacent source-only observation sent to Director via message el-4wqyv (command
addressed assigned Director el-9qzi): unchanged Spawner.spawnHeadless waitForInit
rejection after obtaining a handle marks terminated without invoking provider
termination; interactive post-handle catch is analogous. Potential unpublished
resource retention, medium severity; not a fresh runtime reproduction or a new
published-session failure. Requested triage/reuse or creation of a scoped follow-up,
without expanding this HTTP task. Existing lower-runtime limitations remain.

Verdict: HTTP criteria satisfied; **DELIVERY HELD — mandatory gate failed**.
No new HTTP source defect asserted, no merge approval and no --force/status bypass.
Director notified of the unrelated fixture failure in el-4tcd9; existing el-1w48v
tracks similar fixture generation collisions, and should be extended/reused if
appropriate (not assumed identical root cause). Next: obtain delivered fixture
correction or Director-scoped investigation, sync local master with approved CLI,
run pinned required gate and independent exact-final review. Do not copy pending
branches or repeatedly rerun until green. Normal review rejection preserves the
branch/evidence; task handoff is unavailable for review-status tasks by its current
ownership contract. No production edits or installed/live operations by steward.

