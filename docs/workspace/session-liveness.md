# Session liveness, resume prompt and quiet Director watchdog — el-4dcv06

Split from el-5jwe6q (see `dispatch-handoff-loop.md`, whose contracts are reused).
This is a source change. The installed Desktop application and the running
daemon change only after a separately approved install.

## Incidents (read-only evidence reported by the Director)

- **Hung after orphan resume.** e-worker-1/2 were resumed by orphan recovery
  (2026-10-31 23:39Z / 00:30Z) and stayed `running` without output for about 10 h
  until the Director stopped them. Nothing in the daemon looked at session
  activity: `reapStaleSessions` only applies `maxSessionDurationMs` (worker
  default 0 = off) and the 30-min steward cap, and orphan recovery only acts when
  no session is active.
- **Finished sessions linger.** e-worker-2 (el-4f7pc9 completed 10:05Z), e-worker-4
  (el-xjw36 completed 10:14Z) and r-steward-1 (recovery handoff 10:08Z) ended their
  final turn but stayed `running` with no assigned task and occupied slots.
- **Misleading resume prompt.** Every orphan resume (worker and merge steward) said
  "Your previous session was interrupted by a server restart", including after a
  crash, a provider error or a daemon stop.
- **Noisy watchdog.** The Director watchdog woke an idle Director every 2 minutes
  while any ready task existed, even when the only obstacle was that all workers
  were busy or provider-limited, and it repeated the same task list indefinitely.
- **Rapid resumes burn the recovery budget (el-55qcdj, 2026-11-01 10:42Z).**
  Steward m-steward-2 started `pnpm check:merge` as a background shell and ended
  its turn. Each turn end left the steward without an active session, so steward
  orphan recovery resumed it on the next poll: 3 resumes in about 25 s (10:42:41,
  10:42:45, 10:43:04), each killing the background gate, then
  `mergeStatus=failed` "Steward recovery limit reached after 3 attempts" with no
  code verdict. The worker `resumeCount` path had the same gap: no minimum interval
  between resumes. (Workspace mitigation: the steward prompt override requires a
  foreground gate.)
- **Minor (m-steward-2 review of el-5jwe6q).** `recordedBranchAvailable()` accepted a
  candidate whenever the recorded worktree existed, even on another branch, while
  `resolveTaskWorkspace()` then fell through and could throw
  `TaskBranchUnavailableError` after selection. The poll errored on every cycle and
  lower-priority ready tasks were never reached.

## Fix

### 1. Liveness (`DispatchDaemon.reapIdleSessions`, every poll cycle)

Runs after `reapStaleSessions`, and also while dispatch is paused by limits.
Only ephemeral workers and stewards are considered; directors and persistent
workers are human-facing and never stopped. Activity is `SessionRecord.lastActivityAt`,
which the SessionManager updates on each provider event and PTY output.

| Session state | Threshold (config, `0` disables) | Action |
|---|---|---|
| Agent has an OPEN/IN_PROGRESS/REVIEW task | `sessionIdleTimeoutMs`, default 30 min | **Hung**: stop the session; record `metadata.orchestrator.lastHungSession` (session, provider session, agent, last activity, stop time, idle ms); orphan recovery resumes it next cycle (counts `resumeCount`) |
| No assigned task | `idleSessionWithoutTaskMs`, default 10 min | **Lingering**: stop the session |

- Only the agent's current running session is stopped (checked via `getActiveSession`).
- The 30-min default is longer than the pinned gate (~7 min) and must stay longer
  than the longest silent command a worker runs.
- Both options are part of `DispatchDaemonConfig`, accepted by `PATCH /api/daemon/config`
  and persisted as daemon config overrides by the smithy server.

**No-progress counting (worker tasks).** A hung worker session is evaluated by
`evaluateHungSession` against the same `noProgress` baseline as handoffs: unchanged
fingerprint (branch head + title/description without handoff notes + dependencies)
increments the count, any change resets it, no baseline gives 0, a leftover
`dispatchHold` restarts it. `evaluatedHandoffAt` is preserved so a later dispatch
never re-counts a handoff. Each stopped session is counted once (`lastHungSession.sessionId`).
At `noProgressHandoffLimit` the existing hold is used: task DEFERRED, **also
unassigned** (so undefer goes through normal branch-preserving dispatch and resets
the counter), `dispatchHold.trigger = 'hung-session'`, exactly one Director message.
With defaults (limit 3, `maxResumeAttemptsBeforeRecovery` 3), three hangs without
progress hold the task at `resumeCount` 2, before a recovery steward is spawned.
Steward hangs are recorded but not counted; the steward recovery cap (3) applies.

### 2. Accurate resume prompt

`buildInterruptedResumePrompt` (worker and merge steward orphan resume) states:

- that the previous session ended before `sf task complete`/`sf task handoff` (or
  a recorded merge outcome) and that the daemon only knows it is no longer running;
  or, when `lastHungSession` matches the resumed session, that the daemon stopped
  it after N min without output;
- the previous session's recorded start/end and termination reason (SessionManager
  history by provider session ID, else task session history), or that no end
  record exists;
- task status, merge status (stewards), branch and head commit, last handoff note,
  and the resume attempt number against its cap.

### 3. Director watchdog

Each candidate is classified. A task does **not** need the Director when its only
obstacle is:

- ready and unassigned, and no eligible ephemeral worker is free (busy session,
  assigned task, unread inbox, pool full) → `worker-capacity`;
- pending merge, unassigned, every merge steward busy → `steward-capacity`;
- the only free eligible executors are provider-limited, or an orphaned task's
  (non-parked) executor is limited → `provider-limit` with the soonest reset time.

Still actionable (wake): no eligible executor exists at all, a free unlimited
executor exists but the task stayed ready, parked/disabled executors, orphaned work
of an unlimited executor, and conflict/test_failed/failed merges.

- Only waiting tasks: no wake; one info log/operation-log entry per changed waiting
  set (reasons and reset times).
- A wake lists actionable tasks and adds "No action needed" with each waiting task
  and its reset time.
- A wake is delivered once per Director session per signature (actionable task IDs
  + current provider limits/manual sleep). An unchanged signature is not re-sent;
  a changed task set or limit wakes again (existing idle/human-input/2-min spacing
  still applies). An empty actionable set clears the signature.

### 4. Orphan resume back-off (el-55qcdj; added after the steward el-5qra review)

Worker (`resumeCount`) and merge-steward (`stewardRecoveryCount`) orphan recovery
wait before resuming the same task again:

```
delay(n) = min(orphanResumeBackoffMs * 2^n, 30 min)     n = earlier resumes (counter value)
resume only when now >= start of that agent's previous session on the task + delay(n)
```

- Default `orphanResumeBackoffMs` = 60 000 → 1, 2, 4 min. With the steward cap of 3,
  quick turn ends now reach `failed` after at least 7 min instead of ~25 s; the cap
  itself is unchanged, so an endless loop is still impossible.
- Measured from the previous session's **start** (task `sessionHistory`, entry of
  the same agent): a session that already ran longer than the delay (stopped as
  hung after 30 min, a long run before a crash, a server restart) is resumed at
  once. Only resumes in quick succession are spaced out.
- While deferred nothing is counted and nothing is started. One info and
  operation-log entry (`recovery`) per task and attempt states the wait.
- A manual daemon wake after that session start lifts the delay, matching the
  existing `resumeCount` reset on wake.
- Rate-limit skips, the recovery-steward escalation at `maxResumeAttemptsBeforeRecovery`
  and the steward cap check run as before (the cap check runs before the delay).
- `0` disables (previous behavior). Part of `DispatchDaemonConfig`, accepted by
  `PATCH /api/daemon/config` (non-negative milliseconds) and persisted as a daemon
  config override.
- Behavior change: a session that crashes right after it started is resumed after
  1 min instead of on the next poll.

### 5. Workspace check consistency

`recordedBranchAvailable()` now accepts an existing recorded worktree only when it
is on the recorded branch (or its branch cannot be read), the same rule as step 1
of `resolveTaskWorkspace()`. Otherwise it falls through to the local/origin branch
checks, which match resolution's remaining steps (a worktree holding the branch
implies a local branch). A missing branch is skipped with the existing warning, so
lower-priority ready tasks are dispatched instead of the poll erroring on every
cycle. The change is confined to the candidate check. After the el-2q3e2y merge the
check uses the shared `task-workspace.ts` helpers (`recordedTaskWorkspace`,
`sameBranchName`, branch lookups); a missing recorded branch without work
evidence is created, not skipped (el-2q3e2y rule), so the regression fixture
records prior work.

### 6. Provider rate limits do not burn the budgets; release to free capacity (el-5x4x9v)

Incident (2026-11-01): review el-4htfn was assigned to Codex merge steward
m-steward-1 at 15:01Z. The Codex quota reset hourly and was hit again; each reset
resumed the steward (16:02, 17:02, 18:02Z) and counted toward
`stewardRecoveryCount`, then `mergeStatus=failed` "Steward recovery limit reached
after 3 attempts" without a review. el-30sfi4 waited for hours on a rate-limited
Codex worker. The existing guards only skipped recovery *while* the provider was
limited, and the back-off above only spaces quick session ends; an hourly
limit-and-reset cycle passes both and burned one attempt per hour.

- **Record.** The SessionManager rate-limit handler (the same `rate_limited` events
  that feed the tracker behind `sf daemon status` "Rate-limited executables") and
  the rapid-exit detector (explicit limit message) record the session on every
  OPEN/IN_PROGRESS/REVIEW task its worker/steward agent holds:
  `metadata.orchestrator.lastRateLimitedSession` (session, provider session,
  agent, role, provider, detection time, clamped reset time) and, on the matching
  `sessionHistory` entry, `endReason: 'rate-limited'`, `rateLimitedAt`,
  `rateLimitResetsAt`. Writes are tracked; orphan recovery waits for pending
  writes before deciding.
- **Not counted.** When the agent's latest session on the task is that limited
  session (`findRateLimitedPreviousSession`), the next orphan resume does not
  increment `resumeCount` (worker) or `stewardRecoveryCount` (merge steward); an
  info/operation-log entry says so. Sessions that end for any other reason are
  counted as before, so the caps (recovery steward, steward `failed`) still apply.
  The rapid-exit detector no longer rolls `resumeCount` back (it records the
  session instead), so a limit is never credited twice. A limited session that is
  later stopped as hung is not counted toward the no-progress guard. The resume
  prompt names the provider rate limit as the end reason.
- **Release.** In orphan recovery, when an ephemeral worker or merge steward is
  rate-limited (`all_limited`), has **no live session**, and another enabled
  executor of the same kind whose provider is not limited is free (same rules as
  dispatch: no session; workers also no unread inbox item, no assigned task, pool
  capacity), the task is released: assignee/`assignedAgent`/`sessionId`/
  `startedAt` cleared, `branch` and `worktree` kept, counters kept, the limited
  session closed in history, `lastRateLimitRelease` recorded (from agent, role,
  provider, session, release time, soonest reset). Worker tasks return to OPEN;
  review tasks keep REVIEW with `mergeStatus: 'pending'` (only `pending`/`testing`
  are released). The write is a CAS on the observed task version; the live
  session is re-checked immediately before it. Normal dispatch then assigns the
  task (worktree reused). Without free unlimited capacity the task stays and is
  resumed after the reset, uncounted. `releaseRateLimitedTasks: false` disables
  release (`PATCH /api/daemon/config`, persisted override).
- **No new work for limited executors.** Verified: worker dispatch, orphan resume
  (outer guard and pre-check), merge-steward spawn, recovery-steward spawn, triage
  and director forwarding check the provider limit. Fixed: `pollWorkflowTasks`
  counted a limited merge steward as available, so it took the review off the
  queue without starting a session and a free steward missed it for that cycle;
  limited stewards are now excluded (also for non-merge steward dispatch).
  Limited workers are skipped before task selection.

## Evidence

- New `packages/smithy/src/services/dispatch-liveness.bun.test.ts` (14 tests in the first
  delivery, 20 with the back-off below; real
  SQLite, Git with bare origin, SessionManager, WorktreeManager, TaskAssignmentService,
  DispatchService; inert provider double; mocked daemon clock): hung stop/record/count
  and accurate resume; thresholds, activity reset, disable/configure; three hangs →
  hold with one message, commit reset, undefer → same-branch redispatch; defaults
  hold before the resume cap; hung merge steward resume prompt; lingering
  worker/steward stopped, director/persistent kept; crash resume prompt; workspace
  consistency (skip vs reattach); helper contracts.
- `dispatch-daemon.bun.test.ts` watchdog: four new tests (worker capacity quiet with
  one log, provider-limited worker until reset, merge-steward capacity vs none,
  limited orphan waits while parked orphan wakes with reset time and limit change
  re-wakes). The existing throttle test now asserts no repeat for an unchanged set.
- Back-off (el-55qcdj), 6 more tests in `dispatch-liveness.bun.test.ts` with the
  system clock mocked (`setSystemTime`): steward turn ends every 4–5 s for 30 s →
  0 resumes, counter 0, not failed; steward schedule 1/2/4 min and the cap still
  reached after the third quick resumed session (`failed`, "…after 3 attempts");
  worker schedule and `0` disables; manual wake lifts the delay; a 10-min session
  resumes at once (control); helper contract. Baseline (fix absent): the incident
  test resumed the steward **3 times within 30 s**; 3 of the 4 daemon tests failed,
  the long-session control passed. Two el-5jwe6q counter tests that crash a session
  right after it starts set `orphanResumeBackoffMs: 0` (counter semantics only);
  the liveness crash-prompt test now advances the clock past the delay.
- Baseline (same tests against `HEAD` 67d0f7a `dispatch-daemon.ts`): liveness
  **5 pass / 9 fail** (passes: pure helpers, prompt builder, reattach case);
  watchdog group **15 pass / 5 fail**. With the fix all pass.
- Commands, the related suites and the required gate are recorded in the task
  completion/handoff and runbook el-of6.

- Rate limits (el-5x4x9v): new `packages/smithy/src/services/dispatch-rate-limit-budget.bun.test.ts`
  (12 tests; same fixture style, limits reported through the real `rate_limited`
  event path, system clock moved): incident replay (Codex steward limited at five
  hourly resets → counter 0, never failed, every ended session marked
  `rate-limited`; a later non-limit end counts 1); worker with cap 2 limited four
  times → `resumeCount` 0, no recovery steward; limited session stopped as hung →
  no no-progress count, free resume; worker release keeps branch/worktree and the
  Claude worker continues on it; review release to the Claude steward; controls
  (live limited session keeps the task, no release when the other worker is busy
  or shares the limited provider, option off); assignment (limited worker/steward
  get nothing, the free steward gets the review in the same cycle); helper
  contracts. Baseline (fix absent): **5 pass / 7 fail** (passes: live-session
  control, option-off control, limited-worker assignment — existing behaviour —
  and the two helper tests). Three existing tests that asserted the rapid-exit
  rollback now assert the recorded session and the uncounted next resume.

## Limitations

- Idle detection relies on provider/PTY activity. A worker running a silent
  command longer than `sessionIdleTimeoutMs` is stopped; raise the option if needed.
- A steward without a task that runs a silent command for more than
  `idleSessionWithoutTaskMs` (e.g. a docs/custom steward) is ended.
- Explicit human-attention requests are honoured (sessions with `attention` are
  skipped), but the SessionManager currently sets attention only for directors.
- Back-off timing uses task `sessionHistory`. A path that starts a session without
  recording history (explicit `startWorkerOnTask`, el-2q3e2y limitation) has no
  start to measure from and is not delayed.
- The delay survives a daemon restart (it is derived from persisted history). A
  deferred resume runs at the first poll after the delay, not exactly at it.
- Watchdog suppression is in memory per Director session; a daemon restart or a
  new Director session sends at most one fresh wake for the same set.
- The watchdog's capacity classification uses the same availability rules as
  dispatch, but does not model per-task repository or branch problems separately:
  such a task is actionable only while a free unlimited worker exists.
- Rate-limit detection relies on provider limit events/messages. A session that
  stops at a limit without any recognisable message is an ordinary end and is
  counted. Only the agent's latest session is checked; the record is kept per task
  (`lastRateLimitedSession`, the most recent one).
- Release honours availability at the moment of the check; a free executor may
  take a higher-priority ready task first. Release ignores the Director's provider
  routing of the task (any free unlimited executor of the same kind may take it);
  set `releaseRateLimitedTasks: false` if routing must be strict. Parked (disabled)
  executors and recovery stewards are not released.
- Explicit starts (`POST /api/sessions/...` start/resume, `startWorkerOnTask`) are
  human/Director actions and are not gated by provider limits here.
