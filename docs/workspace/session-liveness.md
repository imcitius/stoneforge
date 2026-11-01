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
