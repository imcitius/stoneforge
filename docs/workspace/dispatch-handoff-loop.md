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
  reported to the Director and is not changed here.
- A merge steward that keeps REVIEW for an external blocker may be re-spawned by
  steward orphan recovery up to the existing cap of 3, after which `mergeStatus`
  becomes `failed`. That logic is unchanged.
