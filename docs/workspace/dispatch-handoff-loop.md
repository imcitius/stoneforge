# Handoff/redispatch loops and branch loss — el-5jwe6q

Incident window 2026-11-01 00:00–09:00Z (installed runtime, not this source).
This report records what happened, the root causes, the fix and its evidence. It does
not change the installed Desktop application. Runtime behavior changes only after a
separately approved install.

## Incident evidence (read-only, live project data)

- **el-2zeuz**: 523 `handoffHistory` entries between 00:22Z and 04:52Z, each one a
  read-only preflight followed by a handoff and a Director message
  (`IOConsoleLocked=Yes`; GUI acceptance needs an unlocked screen). Recorded
  branch/worktree changed at handoff indices 390, 447, 465, 466 and 502 from the
  reviewed `agent/e-worker-2/el-2zeuz-desktop-getting-started` (26a1c073) to new
  `agent/c-worker-1-<uuid>/el-2zeuz-desktop-getting-started` branches at master.
  Before the first change, 389 redispatches reused the reviewed worktree correctly.
  The Director later reconciled the metadata by hand.
- **el-56khe** (21 handoffs) and **el-apzlc** (36) looped as well but kept their branch.
- The Desktop log is a 128 KB ring buffer and no longer covers the window. The
  element event history (`sf history el-2zeuz --after 2026-11-01T03:39:30Z`) does:

| Event | Actor | Orchestrator change |
|------|-------|---------------------|
| 9171 | c-worker-1 | handoff: `handoffBranch/handoffWorktree` = reviewed branch/worktree, status → open |
| 9177 | daemon | dispatch: `assignToAgent` rebuilds metadata, **drops `handoffBranch/handoffWorktree`**, keeps `branch/worktree` |
| 9180 | daemon | 12 ms later, failed-dispatch cleanup (`unassignTask`, notification failed after the assignment committed) **clears `worktree`** and the assignee; status stays in_progress |
| 9183 | daemon | next dispatch: `branch` set, `worktree` and `handoffBranch` absent → **new branch from master**, metadata overwritten |

## Root causes

1. **Branch loss (a).** `assignTaskToWorker` reused a branch only if either
   (`handoffBranch` and `handoffWorktree`) or (`branch` and `worktree`) were both present
   and the worktree was still registered. Otherwise it called
   `createWorktreeForTask`, which generates a fresh attempt branch from the target.
   The failed-dispatch cleanup legitimately clears `worktree`. The preceding
   assignment had already consumed the handoff fields, so the recorded branch was
   ignored. `recoverOrphanedTask` had the same fallback for a missing worktree.
   The notification failure itself was not reproduced. Dispatch notifications create
   their document and message without a collision-checking ID config, the same
   mechanism as the known gate ID-collision flake (el-45m5h/el-4htfn). This is a
   plausible trigger but is not proven for this incident.
2. **No throttle (b).** Handoff resets status to OPEN (and `resumeCount` to 0), and
   the task is immediately ready again. Nothing counted handoffs. `resumeCount` and
   the recovery steward only cover sessions that exit **without** complete/handoff.
3. **Evidence erasure.** `sf task reject --message` replaced the whole
   `handoffHistory` with one `cli` entry (index 0 of el-2zeuz at 00:22Z).

## Fix

### (a) Recorded branch is always preserved

`DispatchDaemon.resolveTaskWorkspace` is used by both automatic dispatch and orphan
recovery:

1. Reuse the recorded worktree if it is registered and on the recorded branch.
2. Otherwise reuse any registered worktree that has the recorded branch checked out.
   This is the incident case: the reviewed worktree still existed.
3. Otherwise attach a new attempt-specific worktree path to the **same** branch
   (`customBranch`). A local branch is checked out as-is. A branch that exists only on
   origin is created from `origin/<branch>`.
4. Only a task without any recorded branch gets a new branch from the target.

If the recorded branch exists neither locally nor on origin, the candidate is
skipped. The daemon emits a deduplicated "Task branch missing" warning and an
operation-log entry, and leaves the metadata unchanged. It never silently restarts
from the target. An existing directory at the old path is never deleted for reuse:
a new path is used.

### (b) No-progress handoff guard

- `metadata.orchestrator.noProgress = { count, fingerprint, evaluatedHandoffAt }`.
  The fingerprint is the task branch head commit plus a SHA-256 of title,
  description and the task's dependencies. The description excludes
  `[AGENT HANDOFF NOTE]` text: exact notes from `handoffHistory` first, then
  single-line leftovers.
- At each dispatch the daemon records the fingerprint (after the workspace is
  resolved, so a first dispatch records its new branch head). For a ready
  candidate with a **new** `handoffAt`, an unchanged fingerprint increments the
  count and any change resets it to 0. Missing baselines (legacy, first dispatch)
  start at 0. Each handoff is counted once.
- At `noProgressHandoffLimit` (default 3, `0` disables) the daemon CAS-updates the
  task to **DEFERRED** with `metadata.orchestrator.dispatchHold`
  (reason, count, limit, fingerprint, handoffAt, directorId). Only the poller whose
  CAS succeeds sends **one** direct message to the owning Director, from the last
  worker session. The message includes the task ID, worker, reason, branch/commit,
  last handoff note and resume commands. `notifiedAt`/`notificationMessageId` (or
  `notificationError`) are recorded on that hold. There are no retries, so the
  Director is notified at most once per hold.
- Reset/release by Director or Human action:
  - **undefer** or another status change: a ready task with a leftover hold resets to 0.
  - **description/title or dependency change, or a new branch commit while deferred**:
    `releaseNoProgressHolds()`, which runs at the start of each worker-availability
    poll, sets the task OPEN, clears the hold and resets the count.
  - **explicit assignment**: `assignToAgent` without an automatic claim drops
    `noProgress`. Any assignment drops `dispatchHold`.

### (c) Rate-limit and crash paths

The counter changes only when a new handoff is evaluated at dispatch selection, or
on hold and release. All-limited dispatch skips, rapid-exit rate-limit detection
(`resumeCount` rollback), crash/orphan resume and recovery-steward logic do not read
or write it. Automatic claims preserve it through `assignToAgent`. Failed-dispatch
cleanup and orphan recovery merge metadata and preserve it. `resumeCount` semantics
are unchanged: handoff still resets it to 0.

### Prompts and CLI

- Worker prompt: external precondition guidance. For a task dependency, run
  `sf dependency add --type=blocks` and hand off once. For a Human/GUI blocker,
  message the Director once and hand off once. If the same blocker is already
  reported with no change, do not message again.
- Merge steward prompt (built-in and the reviewed override copy
  `docs/workspace/steward-merge.md`): use `sf task reject` with detailed findings for
  code defects. `sf task handoff` is rejected for REVIEW tasks. For GUI-only,
  external or environment blockers, keep REVIEW and send one Director message;
  never reject them to OPEN.
- Director prompt: how to resume a held task.
- `sf task reject --message` now appends to `handoffHistory` instead of replacing it.

## Evidence

New suite `packages/smithy/src/services/dispatch-no-progress.bun.test.ts`. It uses a
temporary SQLite database, a temporary Git repository with a bare origin, a real
`WorktreeManager`, `SessionManager`, `TaskAssignmentService` and `DispatchService`,
and an inert provider double. The daemon is not started; its poll actions are
invoked directly. The suite has 16 tests:

- (a) incident sequence (a real notification failure after a handoff redispatch,
  followed by the real failed-dispatch cleanup), worktree removed from disk,
  branch only on origin, branch missing everywhere.
- (b) stop after 3 with exactly one Director message and inbox item over repeated
  polls; commit progress resets; limit 0 disables; reset by undefer (a second
  hold sends a second message), by description append, by dependency change and
  by explicit assignment.
- (c) all executables rate-limited: no dispatch, counter/status unchanged, no
  message. Crash plus orphan resume: counter unchanged, `resumeCount` 1. Rapid exit
  with an explicit limit message: `resumeCount` rolled back to 0, rate limit
  recorded, counter unchanged.
- Helper contracts: note stripping, and counting each handoff once.

Baseline: the same suite against unmodified `1b43de2` sources gives **5 pass / 11
fail**. The incident test receives `agent/c-worker-1-<uuid>/…` instead of the
recorded branch. The rate-limit and helper tests pass on both, which confirms that
behavior is unchanged. With the fix: **16/16**. Commands, existing suites and the
required gate are recorded in the task handoff and shared runbook el-of6.

## Limitations

- A description edit by the handing-off agent outside the handoff note counts as
  progress, as does a sync merge commit. Both are conservative: the loop continues
  as before rather than being held wrongly.
- Status changes other than undefer while the task is not held, such as
  backlog → open, are not part of the fingerprint.
- A held task with no owning Director, or no worker session to send from, records
  `notificationError` plus a UI warning instead of a message.
- The explicit `startWorkerOnTask` path (WorkerTaskService) still creates its
  worktree from options and does not consult the recorded branch. This was
  reported to the Director and is not changed here. *(Resolved by el-2q3e2y,
  see below.)*
- A merge steward that keeps REVIEW for an external blocker may be re-spawned by
  steward orphan recovery up to the existing cap of 3, after which `mergeStatus`
  becomes `failed`. That logic is unchanged.

## Follow-up el-2q3e2y: explicit start and assignment metadata

Source only; the installed Desktop application is unchanged until a separately
approved install.

### Defects (reproduced at 67d0f7a, the el-5jwe6q delivery)

1. **Explicit start lost the branch.** `WorkerTaskService.startWorkerOnTask`
   called `createWorktree` with the request options only. A handed-off task with
   commits got a fresh `agent/<worker>/<task>` branch from `main`; the recorded
   branch was ignored (the el-2zeuz branch-loss class).
2. **`assignToAgent` rebuilt the orchestrator metadata.** It kept only a fixed
   list (repository, branch/worktree, handoff/completion/session histories,
   targetBranch, noProgress for claims) and dropped every other field:
   `resumeCount`, `reportedIssues`, `lastCommitHash`, completion and merge-request
   data, recovery counters, test/sync results, `owningDirector`, `handoffAt`
   and others. It also ignored a recorded `branch` without a pending handoff and
   generated a new name. The recovery-steward escalation comment "keep
   resumeCount high so a fresh worker doesn't get auto-dispatched into a
   known-failing loop" was defeated by the next assignment.
3. **Found while reproducing (introduced by el-5jwe6q).** A manual dispatch
   without a worktree (`POST /api/tasks/:id/dispatch`, `DispatchService.dispatch`)
   records a generated branch *name* through `assignToAgent`, without creating it.
   Orphan recovery then treated that name as a lost branch and threw
   `TaskBranchUnavailableError` on every poll (`processed: 0`); before el-5jwe6q
   it created the worktree. The candidate check would also skip such a task.

### Fix

- The el-5jwe6q resolver moved unchanged from a private `DispatchDaemon` method to
  `packages/smithy/src/services/task-workspace.ts` (`resolveTaskWorkspace`,
  `recordedTaskWorkspace`, `TaskBranchUnavailableError`, Git ref helpers). The
  daemon (dispatch, orphan recovery, candidate check) and `startWorkerOnTask` use
  the same module.
- `startWorkerOnTask` with a recorded branch (handoff first, then assignment):
  reuse the recorded worktree, else a worktree holding the branch, else a new
  worktree path attached to the **same** branch (local, or from `origin/<branch>`).
  A requested `worktreePath` is used only if free; otherwise an attempt-specific
  path, never replacing an existing directory. A recorded branch with prior work
  that is missing everywhere is refused **before** assignment
  (`TaskBranchUnavailableError`, HTTP 409 `TASK_BRANCH_UNAVAILABLE`). An explicit
  `branch` option that differs from the recorded branch is an override (logged).
  No recorded branch: previous behavior.
- Missing recorded branch **without work evidence** (`taskHasWorkEvidence`: no
  session or handoff history, `handoffBranch`, `sessionId`, `lastCommitHash`,
  completion operation/history or merge request ID) is a name that was never
  materialized. It is created under that name from the target, in all paths.
  A deleted branch with any of that evidence is still refused/skipped as before.
- `assignToAgent` merges into the existing metadata. Only
  `ASSIGNMENT_RESET_FIELDS` change:

| Field | Assignment sets | Why |
|------|-----------------|-----|
| `assignedAgent` | new agent | the new owner |
| `branch` / `worktree` | option > pending handoff > recorded > generated | continue the task branch; worktree paired with its branch |
| `sessionId` | option (else cleared) | previous owner's session must not pass current-session guards (el-1f5tm); history keeps it |
| `mergeStatus` | `pending` | new work cycle; the old outcome no longer describes the branch (`mergeFailureReason` is kept for the next worker) |
| `startedAt` | now if `markAsStarted`, else cleared | previous owner's start; unassign clears it for the same reason |
| `handoffBranch` / `handoffWorktree` | cleared | one-shot pointer consumed into branch/worktree; a leftover would override the assigned worktree on redispatch |
| `noProgress` | kept for automatic claims, cleared otherwise | el-5jwe6q contract: explicit assignment is a Director/Human decision |
| `dispatchHold` | cleared | any assignment ends a hold (el-5jwe6q) |

Everything else is kept, including `handoffAt`, `handoffFrom`, `lastSessionId`
(facts about the last handoff), `resumeCount` and recovery counters, and
`completedAt`/merge-request fields (a completion overwrites them).

### Evidence

`packages/smithy/src/services/dispatch-no-progress.bun.test.ts` reuses the el-5jwe6q
fixture (temporary SQLite, Git repository with bare origin, real
`WorktreeManager`/`SessionManager`/`TaskAssignmentService`/`DispatchService`,
inert provider double) and adds 11 tests:

- (d) explicit start after a handoff reuses the worktree and commit; worktree
  removed and cleared by admin unassign attaches the same branch; origin-only
  branch from the origin tip; missing branch with prior work refused with
  task version unchanged and no branch created; explicit different `branch`
  override; generated-only name created by explicit start; manual dispatch
  followed by orphan recovery.
- (e) explicit assignment keeps 21 unrelated fields and changes only the
  documented fields; automatic claim keeps them; a recorded branch without a
  handoff is kept; the exported reset list matches the documented one.

Baseline (fix sources reverted, same test file): **18 pass / 9 fail**. For
example, explicit start received `agent/c-worker-1/<task>-…` instead of the
recorded `agent/c-worker-1-<uuid>/…` branch, orphan recovery processed 0
instead of 1, and `resumeCount` became `undefined` instead of 2. The two
override/generated-name tests pass on both (compatibility controls). With the
fix: **27/27**. An HTTP route test covers the 409 mapping.

### Limitations

- Work evidence is metadata-based. A task worked only through explicit starts
  (they record `sessionId` but no `sessionHistory`) and then reassigned keeps no
  trace. If its branch is then deleted locally and on origin, it is recreated
  from the target under the same name.
- `startWorkerOnTask` still records no `sessionHistory` entry (unchanged).

## Follow-up el-4dcv06 (2026-11-01)

The scope split from this task is delivered in `session-liveness.md`: hung and
lingering worker/steward sessions are stopped by the daemon (a worker hang counts
toward the no-progress counter above and can create a `trigger: 'hung-session'`
hold that also unassigns the task), orphan resume prompts state the recorded end
state instead of "server restart", and the Director watchdog no longer wakes for
capacity/limit-only work or repeats an unchanged task set. The m-steward-2 note
about `recordedBranchAvailable()` vs `resolveTaskWorkspace()` is fixed in the
candidate check (an existing recorded worktree counts only on the recorded branch). Section (c) above still holds for rate-limit and crash paths;
only a daemon-detected hang is new input to the counter. The history above is
unchanged.

Steward review (el-5qra) added the el-55qcdj requirement: rapid successive orphan
resumes now back off (`orphanResumeBackoffMs`, see `session-liveness.md` §4) instead
of burning `resumeCount`/`stewardRecoveryCount` within seconds. The caps above are
unchanged.
