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
- pending merge, unassigned, merge stewards registered but **all disabled**
  (deliberate merge freeze via `sf agent disable`) → `steward-parked` (el-ilbdj7);
- the only free eligible executors are provider-limited, or an orphaned task's
  (non-parked) executor is limited → `provider-limit` with the soonest reset time.

Still actionable (wake): no eligible executor exists at all (for reviews: no merge
steward registered, even if other stewards are), a free unlimited
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
- `steward-parked` reviews are quiet, but the Director gets **one** notice per
  change of that set ("Every registered merge steward is disabled (parked) ...";
  same idle/human-input/2-min gating), so a forgotten freeze is still noticed.
  The parked set is part of the wake signature; while unchanged, polls only log the
  quiet state, and other wakes list those reviews under "No action needed"
  (`(all merge stewards disabled)`). Re-enabling a free merge steward makes them
  actionable again (normal behaviour).

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

## Foreground steward gates interrupted on 2026-11-01/02 — el-1dqbmw

Two causes produced the same misleading orphan-resume prompt. The prompt in the
installed build said "interrupted by a server restart" for *any* lost session;
it is not evidence that the server restarted.

### 30-minute steward age limit (confirmed for el-2y9mhb, el-16h7v4 and el-4f4k40)

- Persisted agent session history for m-steward-4 records `session-mvzri7p2-000c-arx0`
  started at **2026-11-02 21:19:40.611Z** and ended at **21:49:42.883Z** with
  `Steward session exceeded max duration (1805s, limit: 1800s)`. Its Claude
  transcript records a foreground `pnpm check:merge` begun at 21:48:01Z; the
  Bash tool returned exit **137** at **21:49:44.899Z**. Gate output completed
  check 89 and only opened check 90 (`piped-output.bun.test.ts`). The 600-second
  Bash timeout had not elapsed. The task was resumed at 21:51:50Z.
- m-steward-4 on el-16h7v4 ended at 2026-11-01 21:07:04Z with the same age-limit
  reason (1804s); m-steward-2 on el-4f4k40 ended at 20:47:58Z with that reason
  (1805s). A later m-steward-2 session also ended at 2026-11-02 21:39:07Z
  with the same reason (1803s). These are independent repeats of the code path,
  though the retained records alone do not prove each had a gate in flight.
- `DispatchDaemon.reapStaleSessions()` used the session's creation time and a
  default `maxStewardSessionDurationMs` of 1,800,000. It called
  `SessionManager.stopSession(id, { graceful: false })` regardless of recent
  activity. That reached `SpawnerService.terminate()` and the Claude SDK
  headless session's `close()`, cancelling the provider and its running tool.
  The daemon initiated this stop; the available records do not identify the
  individual OS syscall that delivered SIGKILL to Bash. Check 90's source has
  no process-group kill, and the gate has no mechanism to kill its parent.

### Actual project backend shutdown (confirmed for el-3ypnie and el-2wx7k3)

At **2026-11-01 21:33:02–21:33:05Z**, seven persisted agent sessions have the
termination reason `Server shutdown`, including the stewards reviewing
el-3ypnie and el-2wx7k3. The Desktop project log has seven corresponding exit
events, then language-server/broadcaster shutdown and a fresh server startup.
`startSmithyServer().close()` stops every running session; the Desktop-managed
backend calls it on a project stop, parent IPC disconnect or SIGTERM. The retained
log does not identify which of these initiated that shutdown. It was a project
backend lifecycle event affecting all its sessions, not evidence of a test killing
a process group. The 30-minute age-limit incidents stopped individual sessions
while the backend continued; the session-stop code uses a session handle rather
than a negative process-group PID. The live process tree also shows different
process groups for active tool chains. No unrelated-session kill from the age
limit was found.

### Source correction and scope

The default hard steward age limit is now **0 (disabled)**. An explicit
`maxStewardSessionDurationMs` still works. The existing
`sessionIdleTimeoutMs` default of 30 minutes stops assigned worker/steward
sessions with no provider output, while an active review can run longer than
30 minutes. The regression covers a review past the former cap, explicit hard
cap enforcement, and the idle stop path. It does not alter Desktop project
Stop/Restart semantics, and the installed daemon retains its old default until
an independently approved update. The installed API does not expose
`maxStewardSessionDurationMs` as a runtime override. This investigation did not
modify the live daemon or stop any sessions.

Verification on the source branch: the focused liveness suite passed **21/21**,
Smithy typecheck passed, and one foreground `pnpm check:merge` under pinned
Node **22.23.3** passed **204/204** in **465.19s**. No raw logs or local machine
paths are committed.

## Concurrent merge steward sessions and worktree cleanup — el-2mlwrb

The installed d58bd815 daemon spawned two el-218u sessions for review el-3klk89.
The first merged the task; cleanup removed its worktree while the second session
was running a merge gate. That gate's failures were invalid because its worktree
disappeared during the run. The installed daemon is older than the source
session-record compare-and-swap guard (el-52oa7i); this source change does not
update the installed daemon.

The source session manager already serializes starts in progress for one agent,
and the task session-record guard stops a spawned session that loses a concurrent
claim. A remaining gap allowed a second start after the first start returned but
while its status was still `starting`: the manager's existing-session check only
rejected `running`. Both start and resume now reject `starting` as well. The merge
steward spawn path also checks the live session immediately before sync/spawn,
after the daemon's earlier availability check.

Merge cleanup now queries live `starting`, `running`, and `terminating` sessions
and retains the task worktree if another session uses its path. The latest
recorded task session is allowed to complete its own merge cleanup. The service
receives the live session manager in the server's normal service wiring, including
repository-scoped instances. A deferred cleanup returns `false`; the merged task
remains merged and an operator can retry cleanup after the other session exits.

Regression coverage: a `starting` headless session rejects another start and
resume for the same agent; a second stale merge-steward dispatch makes no task
or session change; cleanup retains a shared worktree while a second session is
live and removes it after that session ends. Focused Bun **135/135**, Smithy Node
**402/402**, and Smithy typecheck passed on the first worker commit; its
`pnpm check:merge` passed **212/212**.

### CLI merge cleanup (steward review follow-up)

Steward review found the guard above covered only `MergeStewardService`
(scheduler `processAllPending` and PR-merged polling). Agent merge stewards in this
workspace merge with the CLI, `sf task merge <id> --local`, which then ran an
unconditional `git worktree remove --force` on the task worktree; `sf merge
--cleanup` did the same for its source worktree. That CLI path is how session
83b6d1be removed the worktree under 433aed6e. The CLI runs in its own process
without a SessionManager.

Guarded merge cleanup paths now:

| Path | Liveness source | Caller excluded |
|------|-----------------|-----------------|
| `MergeStewardService.cleanupAfterMerge` (server) | in-process SessionManager | latest task `sessionHistory` entry |
| `sf task merge` (CLI) | workspace server `GET /api/sessions` | `STONEFORGE_SESSION_ID` |
| `sf merge --cleanup` (CLI) | workspace server `GET /api/sessions` | `STONEFORGE_SESSION_ID` |

All three share one rule (`runtime/worktree-session-use.ts`): a `starting`,
`running` or `terminating` session uses a worktree when its recorded worktree or
working directory is that worktree or a directory inside it (paths canonicalized,
relative paths resolved against the project root). The CLI reaches the server the
same way as other CLI server calls (Desktop connection descriptor with identity
check, or the discovered external server; otherwise the configured URL), with a
5 s timeout.

- **Another live session uses the worktree:** the merge, delivery verification and
  task close are unchanged and succeed. The worktree and the local source branch
  are kept (`sf merge` also keeps the remote branch). Text output adds `Worktree
  retained: live session <id> (agent <id>) still uses it` with the manual
  `git worktree remove` command; JSON output adds `worktreeCleanup` (`removed:
  false`, `retainedReason: in-use`, `sessionId`) or, for `sf merge`,
  `cleanupRetained`.
- **Liveness cannot be determined** (no server owns the workspace, request error,
  malformed response): fail-safe, same as above with `retainedReason: unknown`.
  This includes running the CLI with no server at all; such worktrees must be
  removed by hand or by a later cleanup.
- **No other live session** (only the caller, or sessions elsewhere/ended): the
  worktree and branch are removed as before.

Also: when a failed orphan steward resume finds the steward already live
(started by another path meanwhile), recovery now keeps the task's `sessionId`
and does not spawn, instead of clearing it first.

Limits: a session the server does not track (a process that outlived a server
restart, a manually started agent) is invisible to every guard. The caller is
identified only by `STONEFORGE_SESSION_ID`; an operator running the CLI without
it is treated as a non-session caller, so any live session in the worktree keeps
it. The installed d58bd815 Desktop/CLI is unchanged until an explicit update.

Regression coverage (`cli/worktree-cleanup-guard.bun.test.ts`, real Git, SQLite,
CLI subprocess and a Desktop-style session server fixture): `sf task merge` keeps
worktree and branch while another live session uses it, removes both when only
the caller is live, keeps them when no server is reachable; `sf merge --cleanup`
keeps/removes likewise; decision unit cases (subdirectory, caller, ended,
suspended, relative path, unknown). Negative control: with the previous CLI code
the four retention/query assertions fail. Existing CLI tests that assert cleanup
(`local-delivery`, `merge-arguments`, `target-delivery`) now run against the fixture
server (a child process, so `spawnSync` CLI calls still work), which reports no
other session. Daemon recovery regression in
`dispatch-daemon.bun.test.ts` (fails without the fix).

Verification of the follow-up (code commit `20f3345a`, synced with local master
`afd736b5`): pinned Node **22.23.3**, foreground `pnpm check:merge` **213/213**,
exit 0, 381.22s. An earlier run on the first follow-up commit failed 2 checks
(`merge-arguments`, `target-delivery`: they asserted removal with no server, now
the fail-safe retain case) and led to the fixture change in `20f3345a`.
Focused: new guard suite 10/10, local-delivery 24/24, merge-arguments 15/15,
target-delivery 26/26, dispatch-daemon, spawn-session-record and session-manager
Bun suites, merge-steward-service Vitest 76/76, Smithy typecheck. Independent
steward review pending; installed Desktop unchanged.
