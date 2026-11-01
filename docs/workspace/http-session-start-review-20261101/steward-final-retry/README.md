## Independent steward final re-review el-56khe — 2026-11-01

Reviewed commit: `cce7fd0c2f766923462f45ed87b17f73c3ea9166`; local target:
`1b43de2bf9c5c9716750e5a56c619530196732c4`. Steward el-3jso.
Approved operational CLI build d58bd815, dirty=false, and all four Director-pinned
hashes matched. Safe sync imported only delivered el-4bwuz Spawner changes and
reports. Both additive lifecycle-report conflicts were concatenated without loss.
No reviewer production or substantive conflict-resolution changes. Worker HTTP
source hashes, lockfile and gate script match the reviewed worker evidence.

Acceptance criteria checked individually:
1. Both actual HTTP factories capture the returned atomic assignment receipt
   (agent, session identity and updatedAt) and use failed-dispatch conditional
   release only for their failed attempt. Assignment rejection has no receipt.
   No current-owner/session lookup is adopted during cleanup. Existing unassign
   guards and transactional expectedUpdatedAt preserve Human, terminal, deferred,
   successor and completion decisions, status, branch, histories and claims.
2. Real two-connection temporary SQLite, local Git/worktrees, API/HTTP and
   SessionManager tests cover successful201, failed spawn/publication/listener/
   persistence, notification/prompt save, release failure/transaction rollback,
   R1/R2 races and whole task/event/resource preservation. Preparation failure
   returns an error rather than a false successful start.
3. Accepted sessions survive optional operation-log failure. Only that optional
   post-publication write is non-fatal, with an exact-session stderr diagnostic.
   Publication/persistence/listener errors still fail startup; failed or unknown
   rollback carries SessionStartupCleanupError with internal identity and both
   errors, retaining assignment. Pending rollback is awaited before release.
   Notification failure after acceptance retains the session and returns500.
4. New shared per-SessionManager/per-agent synchronous admission begins before
   the first await/precheck and ends in finally after notification and awaited
   cleanup. Same/mixed route factories reject contenders409 without acquiring
   assignment or resources. Pending spawn, accepted overlap, pending rollback/
   release, early exit, later retry and unrelated-agent progress are covered.
   The preserved old overlap probe was independently reloaded into a scratch
   test importing this exact source: only the expected contender response changes
   to409 and A is explicitly unblocked because B no longer reaches assignment.
   Original accepted-session/identity/handle/assignment/resource assertions remain.
   Both overlap cases plus original publication/pending controls pass6/6,
   88 assertions, exit0; earlier controls remain4/4. No worktree test/source edits.
5. Worktrees remain registered/on disk, including reused and successor-accessible
   resources. Diagnostics honestly report retained/not-returned; no deletion lease
   is inferred, and no universal orphan removal or provider termination is promised.
6. Existing el-4aqnn, Directory and docs/task-lifecycle-race-investigation.md
   document the chosen invariant, behavior and limits. All26 historical-review
   and27 worker-correction evidence SHA256 entries verified. Previous publication
   and overlap CHANGES REQUIRED results, negative controls and ambient-Node failed
   gate are preserved, not replaced by current passing evidence. No new shared
   document/library registration is needed.
7. Scope stays within HTTP admission, assignment release and narrow accepted-start
   outcome; however the sequential retry after incomplete rollback is still unsafe
   (blocking finding below). CLI/daemon/resume and cross-process starts are not serialized by this
   in-process HTTP guard. Existing natural terminated/persisted SessionManager
   shortcut and provider cleanup limits remain outside this change, already
   recorded in preceding lifecycle reviews; no new unrelated defect discovered.

Independent commands/results:
- Pinned PATH="$PWD/apps/desktop/node_modules/node/bin:$PATH"; node -v v22.23.3.
  Runtime log: /tmp/el-56khe-final-steward-runtime.log.
- pnpm8.15.5 install --frozen-lockfile: exit0; lock unchanged.
  Log: /tmp/el-56khe-final-steward-install.log.
- Scratch original-probe adaptation: bun test <scratch>/probe.bun.test.ts using
  checkEnvironment() from scripts/check-merge.mjs and pinned PATH.6/6,exit0.
  Path recorded in /tmp/el-56khe-final-independent-path.txt; log:
  /tmp/el-56khe-final-independent-probe.log. Only imports and contender-response/
  unblock scheduling adapted; production source unchanged.
- One required pnpm check:merge: **197/197, exit0,255.99s**, pinned Node22.23.3.
  Eight focused suites **365/365,2302 assertions**; Smithy Node/Vitest365/365,
  Desktop Node17/17, uncached typecheck17/17 and Desktop source build pass.
  Full log /tmp/el-56khe-final-steward-gate.log; per-command results
  /var/folders/b6/ltn3hn4j3nq1n86rbg2j9zk40000gn/T/stoneforge-merge-check-Nm4A9d/results.json.

Separate root build/lint/test, public-docs build, browser/packaged GUI,
cross-platform and live-provider tests omitted; existing skips are not passing
coverage. Tests use temporary SQLite/Git and inert provider/SDK mocks. Installed
application, live sessions, daemon and maintenance were not changed or used as
fixtures. No native rebuild, global Node/config change, gate weakening or retry.


### Blocking finding: sequential retry after incomplete startup rollback

Verdict: **CHANGES REQUIRED**, despite the passing standard gate.
Unmet criterion: "уже принятая/новая сессия не жертва cleanup" and the explicit
Director requirement "If startup rollback itself fails or its completion is
unknown, do not release as though no owned session remains."

Both real HTTP factories reproduce through normal public lifecycle:
1. A assigns the task, spawns its handle and publishes its internal identity to
   SQLite. The subsequent persistSession fault triggers startup rollback.
2. Provider termination throws. A returns500 with retained-session-cleanup-incomplete,
   and its task remains assigned. The exact A handle is still live; the persisted
   agent remains currentSessionId=A, sessionStatus=running. SessionManager's stop
   path has already marked local state terminated and removed its active mapping.
3. The HTTP finally releases admission. A sequential retry B for the same agent
   and task passes the precheck, commits another assignment receipt and attempts
   spawn. The provider rejects B's spawn before returning any new handle.
4. B's catch sees an ordinary startup error and releases its matching receipt.
   Result: task.assignee is undefined while A's exact handle remains live and
   its published registry identity/status remain A/running. The worktree survives.

The scratch probe uses two temporary SQLite connections, real API/HTTP/Git/
SessionManager, public persistence fault injection and inert provider handles.
It does not mutate private session state, synthesize startSession exceptions,
look up/adopt a successor, or access live workspace/provider data. Both routes
fail **0/2,exit1,28 assertions**, only on final assignee preservation after proving
A's live/published state and retained resources. The no-release-only control,
installed after A's first response, passes **2/2,exit0,28 assertions**. It attributes
the loss to B's cleanup, not a whole baseline checkout or a proposed fix.

Relevant paths at reviewed source: both routes' cleanup and finally
(SDK sessions.ts489-504; app sessions.ts456-471), and SessionManager
finishSessionStop termination-before-await ordering (session-manager.ts860-880).
The initial incomplete-start detection works; its protection does not survive
another HTTP attempt. This is distinct from the fixed overlapping-request race.

Required next step: preserve attempt-bound incomplete-cleanup knowledge across
HTTP retries, or safely reject new admission until the exact unresolved attempt
is resolved, without rediscovering/adopting a current agent session. Keep the
positive completed-rollback retry, no-task-mutation rejection, overlap guard,
original errors, successor/CAS/history and retained-resource guarantees. Obtain
Director guidance on the narrow contract if needed; no broad runtime redesign.
Add this both-route regression, then relevant checks, pinned final gate and a new
independent exact-commit review. No merge approval or local delivery performed.

Director notified in el-4miqg. Existing publication/overlap blockers are corrected
and their historical failures remain preserved. The new blocker is introduced by
HTTP conditional release across the unresolved prior attempt, not an unrelated
pre-existing test failure. Gate checks all pass; the additional probe blocks merge.

Reproduce: copy retry-probe.bun.test.ts.txt into packages/smithy/src/api/ with a
.bun.test.ts filename; run bun test <path> --test-name-pattern 'retry after incomplete'
in a subprocess using checkEnvironment() and pinned Node PATH. For the attribution
control additionally set EL56_CONTROL_NO_RELEASE=1 in that isolated environment.
The source also contains the six previously blocking controls; those are filtered
out by this command. Remove only the copied temporary file after execution.
