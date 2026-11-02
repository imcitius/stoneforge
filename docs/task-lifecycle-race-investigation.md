# Assignment/start/complete/unassign race investigation — el-191a6

Research on local `core/master` **5cf51a19f609ea87dda09104f812dd87f861217b**,
2026-09-26, after delivered handoff fix el-1f5tm. Worker el-38k9.
Only tests and this report change; production lifecycle/storage policy is unchanged.
The passing `DEFECT evidence` tests characterize unsafe behavior, not an approved
contract. Convert them to reject/preserve regressions in separately approved fixes.

## Contracts and reachable callers

All paths below are in `packages/smithy/src/` unless qualified otherwise.

- `services/task-assignment-service.ts:371` explicitly permits reassignment. Its
  comment delegates the decision to dispatch. An explicit, sequential A→B
  assignment is supported and produces matching assignee/assignedAgent/session.
  Merely assigning an already assigned task is **not** a reproduced defect.
- `services/dispatch-service.ts:212` reads whether the task is assigned, calls
  assignToAgent, then sends assignment/reassignment notification. It has no
  expected-version/claim argument. `services/dispatch-daemon.ts:2716` selects
  `ready({includeEphemeral:true}).filter(t => !t.assignee)`, does asynchronous
  worktree/session work, then dispatches at line 2844 with markAsStarted=true.
  Selection is a claim on an unassigned candidate, not an intentional override
  of a later Human decision. `services/worker-task-service.ts:285` also dispatches
  with markAsStarted=true; its explicit start-worker action is a distinct caller.
- `services/task-assignment-service.ts:471` startTask documents starting work
  “by the assigned agent”, but accepts only task ID and optional new session ID.
  Repository call-site search found no production caller of this specific SDK
  method. Actual daemon/start-worker flows use assignment markAsStarted instead.
  Its SDK race is reproduced; no user-facing startTask incident is claimed.
- `services/task-assignment-service.ts:495` completeTask documents completion by
  the assigned agent into REVIEW. It rejects only CLOSED/REVIEW at the initial
  read. CompleteTaskOptions has no caller/session identity. CLI
  `cli/commands/task.ts:305` supplies summary/commit/MR options, ignoring
  SF_ENTITY_ID/STONEFORGE_SESSION_ID for this operation. HTTP
  `apps/smithy-server/src/routes/tasks.ts:507` accepts performedBy, but
  `services/worker-task-service.ts:392` does not forward it to assignment service.
  Thus neither route supplies an ownership guard. Only CLI was executed here;
  HTTP reachability was inspected in source, not exercised against a server.
- `services/task-assignment-service.ts:444` unassignTask documents clearing owner
  and agent metadata while retaining branch context. Its production caller at
  `services/dispatch-daemon.ts:2858` is defensive cleanup after dispatch error
  containing “Agent channel not found”. It has no expected assignment token.
  Stale cleanup must not clear a successor's assignment. Direct operator unassign
  policy for terminal tasks is not specified or changed by this research.
- `packages/quarry/src/api/quarry-api.ts:1286` already supplies expectedUpdatedAt;
  SQL predicate/rollback at lines 1373–1381 works at both investigated boundaries.
  These four lifecycle methods do not opt in. No storage rewrite is needed.

## Deterministic fixture and boundaries

`packages/smithy/src/services/task-lifecycle-race-evidence.bun.test.ts` uses two
real QuarryAPI connections to one new temporary SQLite file per test. All writes
are through QuarryAPI. No sleeps, stress loop, provider, daemon/session controls,
live backend, live tasks, app update or maintenance el-1clm are used. SQL queries
are read-only event snapshots. Complete uses no MR provider and no remote fixture.
CLI subprocesses clear inherited project/routing/identity environment, then set
only the temporary root and stale test identity.

Starting snapshot: IN_PROGRESS, assignee/assignedAgent=A, session=provider-old,
history internal-old→provider-old owned by A. A competitor on connection B commits
one of: CLOSED (with closedAt/reason), DEFERRED, Human assignee H, or consistent
assignment B/session provider-new/history internal-new. Closed/deferred also set
future scheduledFor/deadline. These are simulated decisions, not live mutations.

- **R1:** after the service's task read, before returning that snapshot.
- **R2:** after Quarry.update's internal task read, before returning the snapshot
  to serialization/transaction. For two-write methods this is the first write.
- **W1:** after the first assignment/unassign update commits, before second write;
  either complete competitor reassignment or injected second-write failure.
- **D:** after dispatch reads its unassigned candidate, before assignment service.

These are executable await boundaries: the competing transaction completes before
continuation. No simultaneous SQL writers or probabilistic timing are required.
Expected safety for R1/R2/W1: reject stale operation and preserve the winning
snapshot, or atomically commit a valid transition; no hybrid ownership. For D,
automatic claim must fail after eligibility/owner changes. This does not revoke
explicit, freshly authorized reassignment. Status rules for admin operations need
an explicit API contract in any follow-up.

## Expected versus observed matrix

Notation: A=original worker, B=successor, H=Human, ∅=unset; metadata owner is M,
metadata session is S. Each R row was run against all four competitor changes
(CLOSED, DEFERRED, B, H), **32 cases**. “Winning status/owner” means connection B's
committed value, not the stale service input.

| Path | Expected on stale operation | Actual status | Actual assignee / M / S |
|---|---|---|---|
| assign(markAsStarted), R1/R2 | conflict; preserve winner | IN_PROGRESS | A / A / stale-session |
| start, R1 | conflict; preserve winner | IN_PROGRESS | winning owner / A / stale-session |
| start, R2 | conflict; preserve winner | IN_PROGRESS | A / A / stale-session |
| complete, R1/R2 | conflict; preserve winner | REVIEW | ∅ / A / provider-old |
| unassign, R1 | conditional cleanup conflict | winning status | ∅ / ∅ / ∅ |
| unassign, R2 | conditional cleanup conflict | IN_PROGRESS | ∅ / ∅ / ∅ |
| assign, W1 competing B | conflict or one coherent assignment | IN_PROGRESS | B / A / stale-session |
| unassign, W1 competing B | preserve B | IN_PROGRESS | B / ∅ / ∅ |
| assign, second write fails | no partial assignment | IN_PROGRESS | B / A / provider-old (persists after error) |
| unassign, second write fails | no partial release | IN_PROGRESS | ∅ / A / provider-old (persists after error) |
| dispatch D after close/defer/B/H | automatic claim conflict; no notification | IN_PROGRESS | A / A / late-dispatch; real notification stored |
| stale CLI complete after defer/H/B | reject old session; preserve winner | REVIEW | ∅ / winning M / winning S |

R1 preserves winner's scheduledFor/deadline and closedAt, even though assign/start/
complete change status. R2 loses those fields completely: Quarry serializes the
whole object from its old read without expectedUpdatedAt, so fields absent from
`updates` can also be reverted. Start R1 retains B/H assignee but restores A's
metadata; R2 restores A assignee too. Reassignment history internal-new is lost
by R1/R2 start/complete/unassign (assign rebuilds its metadata without history).

Dispatch test calls the real dispatch service on an actual ready/unassigned
candidate; it checks successful result and persisted notification for all four
competitors. It does **not** launch a full daemon/provider or prove how often this
interleaving happens. Source above connects that service boundary to automatic
selection. The split unassign failure is additionally proven to enter the actual
`ready().filter(!assignee)` pool while old assignment metadata survives. By the
same filter, R2 unassign can make previously terminal work eligible again; the
matrix proves its status/owner fields, not a separate full daemon run per row.
Complete moves work to the review pipeline, not the worker-ready pool.

## Positive controls and session-history observation

- Explicit sequential reassignment A→B succeeds coherently (supported contract).
- Complete called after CLOSED or REVIEW rejects without any task/event change.
  The CLOSED race still succeeds because the initial check saw IN_PROGRESS.
- Current completion with metadata sessionId=internal-old enters REVIEW, unassigns,
  ends the matching history entry, and is absent from ready.
- Delivered CAS rejects and preserves complete task/event snapshots for both R1
  and R2, including absence from the unassigned ready pool. Existing handoff suite
  remains the positive regression coverage for owner/session guards.
- With metadata sessionId=provider-old and history sessionId=internal-old,
  providerSessionId=provider-old, normal completion leaves endedAt unset. This is
  a separate reproduced ID-mapping defect, not necessarily a concurrency race.
  `types/task-meta.ts:405` compares only entry.sessionId;
  `services/task-assignment-service.ts:560` passes metadata sessionId. Daemon writes
  providerSessionId??internal ID at line 2840 and the internal/provider pair at
  lines 2875–2883, so this fixture models a supported shape. Real stale CLI completion
  after B also leaves B's provider-shaped history entry open; it does not end A's
  old session or validate that A is permitted to complete B's work.

## Narrow follow-ups proposed to Director (not implemented)

Director should check duplicates and choose contracts before creating tasks.

1. **Atomic assignment:** combine assignee/status/metadata into one update with
   expectedUpdatedAt from the assignment snapshot. Preserve explicit sequential
   reassignment. Cover W1 and failure rollback; no retry on a newer owner.
2. **Automatic dispatch claim:** carry the candidate's version/eligibility into
   assignment; distinguish automatic claim from explicit reassignment. Guard the
   transition before notification; handle already-started session cleanup at its
   caller. Atomic assignment alone does not fix D, where service reads the newer
   Human/closed snapshot and intentionally overwrites it.
3. **Worker completion:** carry caller and unique internal session identity from
   CLI/HTTP through service, define allowed worker statuses, validate owner/session,
   and CAS final transition. Preserve an explicit admin pathway if required. Git
   push/MR creation currently precedes final write (lines 514–611); define safe
   side-effect ordering/idempotency before implementation. External MR effects
   were not reproduced in this investigation.
4. **Conditional unassign cleanup:** single guarded owner+metadata update tied to
   the failed dispatch's assignment identity. Do not clear another session after
   an async failure. Keep deliberate admin unassignment a distinct contract.
5. **SDK startTask:** define allowed states/caller identity and use existing CAS.
   Lower reachability than daemon markAsStarted; no production caller found.
6. **Completion history ID mapping:** resolve the current unique internal history
   entry (not every matching resumed provider ID) before ending it. Pair with
   ownership validation; retain existing history. Test distinct and reused IDs.

No claim is made about other updateSessionId/daemon metadata writes, duplicate
completion side effects, cross-process dispatch locks, cancellation or storage
backends beyond the exercised Bun SQLite path. These need separately scoped work,
not a general lifecycle refactor. This is source evidence, not installation evidence.

## Validation and review

- `pnpm install --frozen-lockfile`: exit 0, 3.1 s; unchanged lockfile. Initial bin
  link warnings refer to not-yet-built dist files.
- `bun test packages/smithy/src/services/task-lifecycle-race-evidence.bun.test.ts`:
  **50 pass / 0 fail, 344 assertions**, 760 ms. Deterministic defects and positive
  controls are intentionally labelled separately.
- Initial investigation run: 35 pass / 12 fail. Those assertions assumed that R2
  retained unrelated fields and that provider ID closed internal history. Actual
  behavior disproved both assumptions; the matrix/assertions were corrected from
  observed source behavior. No production edit or retry-until-green. Original
  log retained at `/tmp/el-191a6-initial-observations.log`.
- One full required `pnpm check:merge`: **184/184, exit 0, 198.24 s**.
  Uncached workspace typecheck 17/17, Desktop build, Bun **8,661 pass / 0 fail /
  29 existing skips**, Smithy Node/Vitest 325, Desktop Node 6 and gate regression
  tests 5 passed. New evidence suite: 50/50, 344 assertions; existing assignment
  37/37 and handoff ownership/CLI 26/26 passed. No gate retries or omitted steps.
  Exact commands/exits/durations and per-step logs:
  `$TMPDIR/stoneforge-merge-check-zePClv/results.json`.
- Node 22.23.3, pnpm 8.15.5, Bun 1.3.11, macOS arm64. `git diff --check`
  and local master ancestry pass; HEAD and master were both 5cf51a1 before the
  research commit. No production files differ. Only documentation changed after
  the gate; test content is the tested version.
- Shared reference **el-4aqnn** is added to the Documentation library/Directory;
  existing handoff evidence **el-2pglm** now links this adjacent investigation.
  Director received the proposed split in message el-56slw. Independent steward
  acceptance and approved CLI local delivery are pending, not performed by worker.

Logs: `/tmp/el-191a6-{install,focused,gate}.log`. Independent steward must read the
report and characterization assertions, validate the proposed split and re-run
relevant tests/required gate on the final revision before approved local delivery.
Worker does not self-approve or merge. Separate root build/lint/test, browser,
packaged GUI, live providers, Quarry Node and cross-platform checks are not run.

## Atomic assignment follow-up — el-3oeut, 2026-09-26

The research matrix and review above are historical evidence from el-191a6, not a
claim that every row remains unfixed. This follow-up changes only the assignment
R1/R2/W1/failure group. Base is delivered local master
`072b5305b2b67c90d951318f1942457810c68068`, read after approved el-ptim CLI sync
(299 artifact hashes verified). Storage and other lifecycle implementations are
unchanged.

`assignToAgent` now passes assignee, optional IN_PROGRESS status and orchestrator
metadata in one Quarry update with `expectedUpdatedAt` from the initial service
snapshot. Conflicts propagate unchanged; there is no retry with a newer version
or owner. Explicit sequential A→B reassignment remains supported. This is not an
eligibility check for an earlier automatic-dispatch candidate: dispatch D still
has its own labelled DEFECT evidence and requires its separate contract/fix.

The same evidence file converts assignment's eight R1/R2 rows into regressions:
CLOSED/DEFERRED/Human/B winners are preserved by full task equality (including
schedule, closure and both histories), unchanged event snapshots, and absence
from the unassigned ready pool. Each rejected call attempts exactly one update.
W1 now reads the first committed assignment from the other connection, verifies
coherent owner/session metadata, commits B, and verifies B and its events survive;
a tripwire rejects any attempted second assignment write. The failure regression
throws after the real metadata transaction callback's SQL work but before commit,
then verifies rollback of the full OPEN/A snapshot and all events. It would leave
B/A partial ownership with the old split implementation. No direct SQL fixture
mutations were introduced.

All original controls remain. Start/complete/unassign, automatic dispatch, stale
CLI completion and provider/internal history mapping remain labelled DEFECT
cases pending their own fixes. Successful assignment retains its previous metadata
construction policy; this change does not broaden history-retention semantics.
The competitor fixture now accepts absent sessionHistory because a completed
assignment already rebuilt metadata without that history before this fix.

Validation:

- `pnpm install --frozen-lockfile`: exit 0, unchanged lockfile.
- `bun test packages/smithy/src/services/task-lifecycle-race-evidence.bun.test.ts packages/smithy/src/services/task-assignment-service.bun.test.ts packages/smithy/src/services/task-handoff-ownership.bun.test.ts`:
  **113 pass / 0 fail, 597 assertions**, 1.74 s.
- Negative control: temporarily restore only the old assignment-service production
  file from master, run the ten converted `REGRESSION:` cases, restore the fixed
  file in `finally`: **10 fail / 0 pass**, exit 1 as expected. No branch switch.
- Initial fixture run: 49 pass / 1 fail because W1's competitor tried to spread
  missing sessionHistory after the newly atomic metadata commit. Fixture corrected
  to handle the existing optional field; production history policy was not changed.
  Original log retained at `/tmp/el-3oeut-initial-fixture.log`.

Required gate result is recorded below. Logs: `/tmp/el-3oeut-{install,focused,negative,gate}.log`.
Independent steward review of the exact final commit and explicit checks remain
required before approved CLI local delivery; the worker does not self-approve or
merge. Installed Desktop5f53cef, live daemon/sessions/tasks and completed maintenance
el-1clm are not test fixtures and were untouched. No paid provider or remote fixture.
Separate root build/lint/test, Quarry Node, browser/packaged GUI, live providers and
cross-platform checks were not run.

One full required `pnpm check:merge`: **184/184, exit 0, 215.69 s**.
Uncached typecheck 17/17; fresh Desktop build; Bun 8,661 pass / 0 fail /
29 existing skips; Smithy Node/Vitest 325; Desktop Node 6; gate regressions 5.
The converted evidence suite remains 50 tests (331 assertions); assignment 37,
handoff ownership/CLI 26 and Quarry CAS 2 also pass in the gate. No gate retries,
skipped steps, threshold changes or configuration edits. `git diff --check` passed.
Exact commands/exits/durations and per-step logs:
`$TMPDIR/stoneforge-merge-check-yaJkik/results.json`.
Only evidence documentation changed after the gate; production/tests are the tested
versions. Independent approval/local delivery remain pending task lifecycle review.

## Git completion argv correction — el-50c9s, 2026-09-26

The separate source risk reported above is addressed in
`services/task-assignment-service.ts`. On synced local master `072b530`, source
inspection confirmed branch metadata interpolation into shell `git rev-list` and
`git push`; no injection payload was executed against that original path.
Fetch, revision lookup/count and push now use execFile argv. Git check-ref-format
validates both full head ref and branch syntax, rejecting option-like names and
revision shorthand. Full refs resolve with rev-parse --verify --end-of-options to
commit OIDs before comparison; push uses -- and an explicit heads-to-heads refspec.
Valid shell-special characters stay literal, including dollar/backtick forms.
Configured testCommand shell execution is untouched.

`services/task-completion-git.bun.test.ts` uses new temporary SQLite/Git fixtures
and local bare remotes only. Its 19 tests cover literal special-character refs,
missing/invalid/option-like revisions, absence of harmless marker files, new and
ahead branch push, no-push with an unreachable push URL, rejected push, nonfatal
fetch with cached refs, unreachable origin failure, and no-origin completion.
Successful completion still enters REVIEW, clears assignee and closes internal-ID
session history; failures preserve the entire task snapshot. No external remote,
live daemon/provider/session/task or installed Desktop was a test fixture.

Safe negative control: restoring only the original production file temporarily
and selecting the ordinary `main` branch plus same-named tag test yields **1 fail**:
completion returns REVIEW while remote main remains behind, because the ambiguous
revision resolves to the tag. The fixed path passes that test. All payload-bearing
tests were filtered out during the original-code control; the fix was restored in
finally. Log: `/tmp/el-50c9s-negative.log`.

Focused Git suite: **19 pass, 100 assertions**. Existing assignment/lifecycle
suites: **87 pass, 440 assertions**. These include the original **50 DEFECT/control**
cases unchanged: status/owner/dispatch/start/unassign races and provider-history
mapping remain open defects requiring their separate fixes. There was no Git
injection characterization test to convert; its original source-risk report above
is preserved, and new assertions enforce rejection/preservation and literal refs.

Frozen pnpm install passed (3.1s; initial missing-dist bin warnings). Required gate
and final commit/review status are recorded below. Logs:
`/tmp/el-50c9s-{install,focused,existing,negative,gate}.log`.
Separate root build/lint/test, browser/packaged GUI, live providers and cross-platform
checks are omitted. Source changes do not update Desktop5f53cef or reopen completed
maintenance el-1clm. Independent steward review of the exact final commit and explicit
checks remain required before approved CLI `task merge --local`; worker does not merge.

Worker required gate on production/test commit `d714841`: **pnpm check:merge exit 0,
185/185 steps, 224.54s**, one run. Includes uncached workspace typecheck, Desktop
source build, Smithy Node/Vitest, Desktop Node integration and the new Git suite
19/19. Exact commands/exits/durations and per-step logs:
`$TMPDIR/stoneforge-merge-check-VRcL9Z/results.json`.
`git diff --check` passed. Only this evidence note changes after the gate; production
and tests remain the tested versions. Independent steward acceptance is pending.

## Conditional cleanup correction — el-j14no, 2026-09-26

The historical unassign DEFECT rows above describe the pre-fix revision. Their
R1/R2, W1 and split-write failure tests are now preservation regressions; start,
complete, automatic claim selection and history-ID defects remain explicitly
labelled pending separate fixes. Atomic assignment regressions/controls remain.

`unassignTask` now requires an explicit discriminated options contract:

- `{ mode: 'failed-dispatch', expectedAssignment: { agentId, sessionId, updatedAt } }`
  carries the exact committed assignment receipt, including an explicitly absent
  session ID if that assignment had none. The task must still be OPEN/IN_PROGRESS,
  with matching assignee, metadata owner, session and version. No identity is
  inferred from a later read and no conflict is retried.
- `{ mode: 'admin' }` deliberately releases the current owner, including a Human
  or terminal task, while preserving its status and closure/schedule fields. It
  does not reopen work. This is an explicit SDK operation, not an authentication
  boundary or an implicit fallback for legacy calls with missing options.

Both modes clear assignee/assignedAgent/session/worktree/startedAt in one Quarry
CAS update. Branch, target/repository context, histories and unrelated metadata
remain. Admin also guards its read version, so a concurrent decision wins.

Dispatch wraps post-assignment notification failures in `DispatchAssignmentError`
with the assignment's returned version/identity. The daemon's existing missing-
channel handler uses this receipt for cleanup. Pre-assignment failure has no
receipt and performs no release. A later successor/Human/close/defer is preserved
when notification fails asynchronously. Notification error selection and automatic
claim policy are unchanged; this does not fix the separate stale candidate defect.

Tests use deterministic boundaries over isolated SQLite/Quarry connections.
Failures before the first write and after transactional SQL mutations preserve
all task fields/events and keep assigned work out of the ready/unassigned pool.
The old second-write tripwire is retained: a coherent release commits once, then
a competitor commits, with no second write to damage its snapshot/events. Positive
controls cover own cleanup, admin current-owner/terminal release, and admin CAS.
Real dispatch tests capture receipts at notification failure; the existing daemon
fixture also exercises actual assignment/dispatch/cleanup with synthetic provider
and worktree boundaries, without starting providers or touching live sessions.

Verification results and independent-review status are recorded with the final
worker result below. No installed app update, maintenance, gate change, live task
fixture or worker merge is part of this correction.

### Worker verification for el-j14no

Approved standalone CLI sync succeeded against local master `a4f73af2fee9cd62d7c820ede3dfdcdac58f3d99`.
`pnpm install --frozen-lockfile` and Smithy typecheck exited 0; lockfile unchanged.
Focused assignment/lifecycle run: **107 pass, 0 fail, 508 assertions**. Daemon
suite: **146 pass, 0 fail, 2 existing skips, 435 assertions**. No failing trial
runs or gate retries occurred.

One full `pnpm check:merge`: **185/185, exit 0, 215.54s**. Uncached workspace
typecheck 17/17, Desktop build, Bun **8,706 pass / 0 fail / 29 existing skips**,
Smithy Node/Vitest 325, Desktop Node 6 and gate tests 5 pass. Lifecycle matrix is
70/70 (412 assertions); assignment 37/37; daemon 146 pass/2 skips. `git diff
--check` passes. After this run only verification documentation changed.

Exact commands, exits and step logs:
`$TMPDIR/stoneforge-merge-check-hpL0d0/results.json`.
Worker logs: `/tmp/el-j14no-{install,typecheck,focused,daemon,gate}.log`.
Separate root build/lint/test, Quarry Node, browser/packaged GUI, real providers
and cross-platform tests were not run. Existing skips do not count as coverage.
Independent steward review of the final commit and approved CLI local delivery
remain pending; the implementation worker neither approves nor merges this work.
Installed Desktop5f53cef, live daemon/sessions and completed el-1clm are unchanged.

## Automatic dispatch claim — el-1q2vv, partial implementation / contract handoff

**NOT ready for merge or task completion.** Worker el-4eqh is handing off for
Director contract clarification under the task's explicit instruction to propose
a concrete design before expanding the contract. Installed Desktop5f53cef,
live daemons/sessions and closed maintenance el-1clm were not touched.

Base is local master `f30b41ad841d1cea6ca5d274403baba950a85a0d`.
Approved el-ptim artifact: all 299 hashes verified, `sf task sync el-1q2vv`
exit 0; worktree/branch unchanged. Frozen pnpm install exit 0 (8.7s), lockfile
unchanged; initial unbuilt-dist bin warnings retained in the log.

Partial source implementation:

- Daemon passes the original ready/unassigned candidate's updatedAt through
  DispatchOptions.claim to assignment. Assignment checks unchanged version,
  unassigned owner, OPEN/IN_PROGRESS and due scheduledFor, then commits via CAS.
  Omitted claim continues to mean explicit reassignment; start-worker keeps it.
- New automatic preparation uses a UUID in its Git agent-name namespace, so a
  second attempt cannot invoke destructive createWorktree on the first path.
  Existing/handoff worktrees are reused. Failed attempts retain worktrees:
  deleting one after an async ownership check cannot safely exclude adoption by
  a successor. No new automatic deletion is introduced.
- Dispatch failure stops its exact internal session ID and conditionally releases
  only the notification-error assignment receipt. This exposes the separate
  SessionManager persistence problem below: **this cleanup is not fully safe yet**.
- Post-dispatch session-history write uses the returned assignment snapshot and
  CAS, rather than rereading and overwriting a successor.
- Only the four D DEFECT cases were converted to rejection/preservation tests;
  other labelled DEFECT evidence and positive controls remain intact.

Actual verification of the partial implementation:

- `bun test packages/smithy/src/services/task-lifecycle-race-evidence.bun.test.ts
  packages/smithy/src/services/dispatch-daemon.bun.test.ts`: **216 pass, 2 existing
  skips, 0 fail, 847 assertions**, 5.06s. Log `/tmp/el-1q2vv-initial.log`.
- `pnpm --filter @stoneforge/smithy typecheck`: exit 0.
- `git diff --check`: exit 0.
- Required `pnpm check:merge` deliberately **not run yet**: acceptance is incomplete,
  including new real Git/daemon simultaneous-claimant and explicit start-worker
  controls. No independent approval, merge or application update is claimed.

### Confirmed contract gaps and proposed narrow design

Two deterministic reject/preserve probes (`SCOPE:` tests appended to the
lifecycle evidence file in an isolated worktree, run with
`bun test <file> -t SCOPE:`) asserted the desired safe behavior, **not unsafe
behavior as a passing norm**. The probe patch was removed from the repository
before publication (el-ju3fwi); the parent-DRAFT case is now a permanent
regression in `packages/smithy/src/services/dispatch-claim.bun.test.ts`. The
probes appended to the existing real temporary two-connection SQLite fixture. Session startup/termination use only an isolated spawner mock,
with the real SessionManager and registry; there is no real provider invocation.

1. **Parent-plan eligibility is not protected by the task timestamp.** Associate
   a task with an ACTIVE parent, capture ready/unassigned candidate, then change
   parent to DRAFT on the other connection. The task is absent from ready, its
   updatedAt is unchanged, but the partial claim succeeds and notifies. Proposed
   API: a task-only conditional update option (or dedicated Quarry claim method)
   that checks original updatedAt plus ready/unassigned predicates in the *same
   SQLite transaction* as the update. Include task status, owner, schedule,
   blocked_cache, parent DRAFT and parent blocked state, matching
   ready({includeEphemeral:true}). An extra asynchronous ready() check is not an
   atomic fix. Keep manual assignment outside this predicate. Director must
   confirm whether full ready eligibility is intended here or explicitly limit
   this task to the four task-version D competitors.
2. **Stopping by internal session ID alone does not preserve successor metadata.**
   During spawner.terminate(old), start successor for the same agent. Its active
   in-memory ID remains correct, but old stopSession calls updateAgentSession and
   persistSession, restoring old provider ID and idle over successor running.
   Proposed contract: persist a unique internal current-session identity at start;
   stop/exit cleanup may update current agent fields only with that identity and
   an atomic entity CAS. Historical session append must preserve successor fields
   and history. No retry may substitute a new owner. Define legacy sessions without
   internal identity explicitly. This is a SessionManager/registry contract change,
   not something dispatch can fix by rereading current session or using provider ID.
   Keep attempt-specific process termination; never terminate the current agent
   session by lookup. Scope/legacy policy needs Director confirmation before edits.

Refined probes: **0 pass / 2 fail as expected**, 6 assertions, 384ms;
`/tmp/el-1q2vv-contract-probes-refined.log`. Original exploratory run is retained
at `/tmp/el-1q2vv-contract-probes.log`: its first assertion incorrectly assumed a
new blocks dependency leaves updatedAt unchanged (it actually changes it), and
its spawner mock lacked getSession. Those harness/assumption failures were corrected
before the above two findings were claimed. The final probe source is also at
`/tmp/el-1q2vv-contract-probes.ts`. No retries of a merge gate occurred.

After Director decision: finish the scoped atomic eligibility/session ownership
contract, add real temporary Git daemon-boundary regressions for all four D
competitors and both simultaneous claimants, verify unique notification and
successor resource preservation, cover isolated startup/notification errors and
positive automatic/explicit start-worker paths, then run `pnpm check:merge`.
Commit/push final implementation, complete the task, obtain independent steward
review of the exact final commit and use approved CLI local delivery after checks.
This partial worker handoff is not an approval to merge.

## Automatic dispatch claim — Director-approved continuation el-1q2vv

The earlier partial handoff and its two failing probes above are historical
baseline evidence. Director's decision in the task handoff history (18:54:10Z)
approved both narrow extensions and the conservative legacy ownership policy.
The probe patch is retained as historical source; do not apply it to this revision:
the two desired-safety probes now live as passing REGRESSION tests in the lifecycle
suite. Current-field equality excludes the intentionally appended old-session
history; neighboring history must be preserved. Other DEFECT groups, controls and
historical failures are retained for their separate fixes.

Approved standalone el-ptim sync verified all 299 artifact hashes and synced
against local master f30b41ad841d1cea6ca5d274403baba950a85a0d without conflicts.
No pending worker branch was copied. Frozen pnpm install succeeded (3.2s), with
unbuilt-dist bin-link warnings and no lockfile changes.

### Final contracts

- `UpdateOptions.requireReadyUnassigned` is a task-only conditional option requiring
  an original `expectedUpdatedAt`. SQLite transaction reads current task type,
  status, assignee, deletion, schedule and parent-plan availability before the CAS
  write. Rejection rolls back task writes/events and occurs before notification.
  `ready()` and claim share the draft/blocked-parent SQL and task status/due rules.
  Ephemeral workflow children remain allowed for automatic dispatch.
- Dependency/status writers publish blocked_cache after their primary transaction.
  The claim also calls the existing blocking computation with fresh recursive
  parent reads in its transaction, including blocks/awaits/parent-child semantics.
  This closes the unpublished-cache interval without moving all writers into a
  new transaction framework. Cyclic ancestry conservatively rejects. Existing
  blocked-cache exclusions remain conservative; no eager cache mutation is done
  by claim. Eligibility is guaranteed at commit, not indefinitely after it.
- Dispatch carries the original candidate token across worktree and session
  preparation. Explicit manual dispatch/start-worker still omit claim and retain
  deliberate reassignment. Failed notification cleanup uses the delivered
  `failed-dispatch` identity/version contract, without acquiring a newer owner.
- Automatic new worktrees use a unique attempt namespace. Borrowed/handoff and
  failed-preparation worktrees are retained, including after startup failure:
  deleting after a separate ownership read could destroy an adopted worktree.
  This trades possible unused directories for successor safety; no automatic
  reclamation policy is claimed.
- New SessionManager start/resume publishes additive `metadata.agent.currentSessionId`
  (the unique internal spawn ID) together with provider ID/status via entity CAS
  from the pre-spawn token. Concurrent local starts are reserved; competing
  managers cannot both publish from one token. A publication or later startup
  persistence failure terminates only its exact known process handle.
- Stop, suspend, exit, provider-ID discovery and dead-session persistence only
  change current registry fields for that internal ID, with entity CAS. A conflict
  revokes permission to update current fields; bounded retry only merges that
  session's historical entry into freshly read history. No new identity is adopted,
  provider IDs may be reused on resume, and unrelated history is preserved within
  the existing 20-entry bound. Double stop is idempotent.
- Legacy absent/ambiguous internal identity never authorizes current-field cleanup.
  Exactly known processes can stop; available history is merged with diagnostics
  indicating incomplete current-field cleanup. No live history/session migration.
  Public start/stop/resume signatures and provider `sessionId` meaning are unchanged.
  Other callers of unconditional registry APIs and startup-wide reconciliation
  retain their existing contracts: this is not a universal registry-writer fix.

### Deterministic verification and limits

`dispatch-claim.bun.test.ts` uses two real temporary SQLite connections and a new
local Git repository/worktrees per test. Actual daemon assignment action,
assignment/dispatch, SessionManager and registry execute; only process/provider
handles are inert mocks. No daemon loop or live/paid provider starts. Boundaries
are awaited callbacks/barriers, not sleeps or probabilistic stress.

Coverage includes CLOSED/DEFERRED/Human/worker B, ACTIVE→DRAFT, blocked parent and
future schedule after candidate read; parent DRAFT after Quarry's update snapshot;
unpublished blocked-cache writer boundary; two simultaneous daemon claimants with
exactly one assignment notification and surviving winning worktree/session; due
unassigned success; explicit start-worker reassignment with real Git worktree;
startup/provider and notification failures; old stop/exit during successor start;
resumed provider-ID reuse; absent/ambiguous legacy identity; preserved neighboring
history; same-session cleanup; two managers' publication CAS; double stop; startup
persistence failure after publication.

The initial new Git fixture runs failed because `system` is a reserved entity name,
then because WorktreeManager.initWorkspace was omitted. Both harness failures are
retained in `/tmp/el-1q2vv-claim{,-2}.log`. Corrected run: 13/13; expanded run: 21/21.
A further desired-safety test exposed a process leak after startup persistence
failure: baseline `/tmp/el-1q2vv-startup-negative.log` fails, then exact-handle
cleanup fixes it. Subsequent focused SessionManager/lifecycle/claim run: 179 pass,
0 fail, 663 assertions. Final expanded claim run: **24 pass / 0 fail, 93 assertions**, 4.22s. Final gate results follow below.

The first full gate started before that last startup cleanup correction and final
regressions; it completed **186/186, exit 0, 235.38s** and is retained as intermediate, not final-revision acceptance.
No gate script, threshold or merge configuration changed. Final acceptance uses a
separate complete gate after all source/test edits.

Logs: `/tmp/el-1q2vv-{install-continued,continued-focused,session-daemon,claim-3,
claim-4,startup-negative,final-focused,final-claim,gate,gate-final}.log`.
Separate root build/lint/test, Playwright, packaged GUI, cross-platform and live
providers are not run. Required gate includes its declared package/runtime checks.
Installed Desktop5f53cef, live project processes and closed maintenance el-1clm
are not test fixtures and were not changed. Remaining SDK assignment/start and
completion groups remain separately scoped (el-2hrsm/el-2htch/el-20qt0).

Independent steward review of the exact final commit and approved CLI local merge
remain required after worker commit/push/completion; worker does not self-approve.
## Retention clarification — el-2y8n3

See [task-session-retention.md](workspace/task-session-retention.md): append keeps
only the last 50 entries, including unfinished/claim-referenced eviction. Preserving
existing entries is not unlimited history. Audit availability and recovery authority
are separate; provider-ID ambiguity can disappear after eviction. That handoff
limitation is characterized and proposed to Director, not fixed here. Pending
completion candidate probes remain explicitly separate from accepted master.
## Worker completion and history follow-up — el-20qt0, 2026-09-26

This section supersedes **only completion/history** observations above. Historical
measurements remain evidence of the original defect, not desired behavior. The
start/automatic-dispatch DEFECT groups remain explicitly unfixed here. Unassign is
covered by the independently delivered el-j14no correction above.
The separate literal-argv correction is retained.

Director's accepted contract permits durable operation audit **after** acquisition
of a narrow metadata CAS claim. Preflight rejection and losing claim CAS leave the
entire task, description, history and events unchanged. A post-claim failure may
retain only that operation's claim/phase/error/receipt/reconciliation records. It
must not close history or move the task to REVIEW. This supersedes the older Git
error controls' blanket unchanged-task assertion; they now verify the phase and
preserved lifecycle/history. No separate journal/schema or general lifecycle-writer
refactor was introduced.

### Caller and history contract

`TaskAssignmentService.completeTask(id, options)` defaults to worker mode. It
requires `agentId` and the **internal** `sessionId`, an OPEN/IN_PROGRESS task,
matching assignee/assignedAgent/current history owner, and the latest unfinished
history entry with a unique internal ID. Metadata may identify that entry by its
internal or provider ID. Caller provider IDs, duplicate internal IDs, missing or
ended history, and stale resumed callers reject. A current internal caller works
when a provider ID was reused on resume: only that internal entry is closed;
earlier entries are retained exactly, including earlier unfinished entries.

CLI carries `--agentId` / `--sessionId`, defaulting in worker mode to SF_ENTITY_ID /
STONEFORGE_SESSION_ID. These environment values are **untrusted assertions checked
against current task state**, never inferred from the last owner. Admin is a
separate explicit `--admin --agentId <operator>` mode with no environment fallback.
SDK/HTTP use `mode: 'admin'`; HTTP actor is `performedBy`, worker session is
`sessionId`. Both routes return 409 for guard/CAS conflict. Admin may complete an
active task without a worker history; if history exists it must still identify a
unique current unfinished entry with coherent ownership. Admin does not bypass
claims, version checks or unknown outcomes. Dashboard's operator Complete action
sends this explicit mode and the selected human's ID; missing selection fails.
These identity fields are **not an authentication/authorization boundary**.

### Claim, effects and limits

`completionOperation` stores a random operationId, initial taskVersion, actor,
mode/internal entry, original owner, repository/branch/worktree, resolved commitOid,
request contents and phase. After a finalized operation is explicitly reopened
and assigned a fresh internal session, the next claim archives the old operation
in `completionHistory`. Both operation records and existing session entries survive
assignment/reassignment, reopen and reset (append still retains only the last 50); pending claims cannot be erased by
these normal paths. Direct arbitrary metadata replacement is outside this narrow
contract, as are the remaining stale start and arbitrary legacy metadata writers.
The automatic dispatch claim was subsequently fixed by el-1q2vv; the separate
OrchestratorAPI.assignTaskToAgent snapshot write is corrected by el-2hrsm below.
These narrow fixes do not make all lifecycle metadata writers CAS-safe.

Each phase/final write has SQL CAS on the exact preceding task version. Each
continuation checks current version, ownership, claim and session before an effect.
No winner is overwritten from the old task metadata snapshot. Phases are:

- `claimed` → `push_started` → `pushed` (or `push_failed`).
- With configured MR creation: `mr_started` → `receipt` (or `unknown`).
- Final CAS atomically records `finalized`, REVIEW, clears assignee and ends only
  the selected internal history entry.

Git source is the preflight-resolved OID and destination is a validated literal
`refs/heads/<branch>`; push uses execFile argv and never force. Local branch movement
cannot change that source. With an origin, push is attempted even if a cached
tracking ref matches; a stale cache/failing fetch is not proof of remote delivery.
No-origin completion remains supported. A branchless offline operation
has no Git effect/OID; a recorded branch requires an existing Git worktree even with --no-mr; remote MR creation requires a resolved local commit.

A losing claim cannot push/create an MR. Concurrent completions have one claim
winner. Later calls reject pending operations rather than automatically retrying.
A finalized operation can be replayed explicitly with `operationId` and its caller
without effects or new events. Reopen is not a retry of an unresolved operation.

**No network atomicity is promised.** There is an unavoidable interval between the
last state check and sending an effect, and a sent Git/provider request may finish
after a concurrent close/reassignment. Its external result cannot be rolled back
by SQLite CAS. Subsequent effects and finalization are fenced; durable mr_started
means the outcome is unknown even if its response/receipt was lost. Remote branch
movement by another actor can also change an MR after push; provider creation is
branch-based, not an atomic compare-and-create against head OID. Claims do not add
provider-level idempotency or serialize other actors' Git operations.

### Explicit recovery (SDK operator API)

Use `TaskAssignmentService.reconcileCompletion(taskId, { operationId, operatorId,
reason, mergeRequestId? })` against the same registered project/repository, after
an operator investigates the operation. This is deliberately a narrow SDK method,
not an automatic daemon action or a new global recovery subsystem. Its inputs
must be explicit; the recorded reason/actor/time/previous phase are committed by
CAS before continuation. Concurrent normal/recovery continuations are fenced by
that CAS. No TTL takeover or reopen reset exists.

- Before MR started, an operator can resume the **same** claim and pinned push.
  Retrying a previously started push uses the same OID and never force. It may
  fail if the remote moved; this does not authorize replacing its target.
- A durable receipt is reused for the same operation and finalization only; no
  second create is issued. A successful finalized recovery is a read-only replay.
- `mr_started`/`unknown` require a concrete MR number and provider evidence. The
  GitHub provider uses literal `gh pr view <number> --json ...` to verify open state,
  source/base branch, head OID, provider/number/URL and the operation-specific body
  marker. Unsupported lookup, missing/mismatched evidence, unavailable provider,
  or an absent operator rationale leave the state unchanged and unknown. Failure
  to find an MR is **not** evidence that create never happened.
- Unknown with no matching existing MR cannot be resumed by this API. There is no
  “assume absent”, abandon, clear-claim or retry-create escape hatch. A transferred
  owner/session cannot adopt a previous operation either. These remain deliberate
  fail-closed cases requiring separate operator investigation/design; do not edit
  metadata to bypass them. Closed work must be explicitly reopened, but reopening
  does not restore the original owner/history or authorize recovery automatically.

Recovery code example (illustrative; never execute against live fixtures):

```ts
await assignment.reconcileCompletion(taskId, {
  operationId: reviewedClaim.operationId,
  operatorId,
  reason: 'Verified the existing open MR belongs to this operation',
  mergeRequestId: reviewedMrNumber,
});
```

### Isolated validation

`task-completion-protocol.bun.test.ts` uses two real temporary SQLite connections,
real CLI subprocesses, both production HTTP route factories through ephemeral
localhost servers, real worker/assignment services and deterministic provider
mocks. `task-completion-git.bun.test.ts` uses new temporary local/bare Git repos.
No live tasks/sessions/daemon/provider calls, external remotes, installed Desktop,
or maintenance el-1clm are used as fixtures.

Coverage includes preflight stale close/defer/Human/B; R1/R2 task/description/event
preservation; current and resumed internal identity; ambiguous history; real CLI
reopen; both HTTP routes/current/admin; double claim; boundaries before effects
and after MR; response/process loss and restart; insufficient evidence; receipt
reuse after final-write failure; pinned OID despite local movement; failed push
and explicit recovery; owner change after successful push; and unknown surviving
real reopen + assignment. Only matching completion/history DEFECT assertions were
converted to reject/preserve regressions. Historical controls remain in the file.

Worker results and exact final independent steward verdict follow below. Early
focused runs: 106/106 across lifecycle/assignment/Git; protocol 65/65; expanded
protocol+Git 89/89; assignment/history-preservation set 154/154. Smithy Node command
`pnpm --filter @stoneforge/smithy test:node -- src/services/worker-task-service.test.ts`
actually ran all 13 Vitest files: 325/325 (the wrapper did not filter). Frozen install
and Smithy typecheck passed. The first typecheck found only narrowing errors in
the new helper and was corrected; that failed attempt is retained in task logs.


### Worker integration evidence (before final integrated gate)

Source `921f3ec0c09ad8de147fdcd8de2c936764866474` received independent advisory
code review, **179/179 tests, 901 assertions**, with no remaining blocking finding.
The review's earlier missing-worktree finding was fixed with two reject/preserve
regressions before this commit. This is not the registered SF steward's final
approval. The isolated orchestration mock also passed (mode=mock,
skipDaemonStart=true, fresh SQLite/Git fixture), now using a real internal history
identity and expecting REVIEW rather than the obsolete CLOSED assertion.

Pre-integration `pnpm check:merge` passed **186/186**, exit 0, **381.84s**;
logs `/tmp/el-20qt0-final-gate.log`,
`$TMPDIR/stoneforge-merge-check-btk0at/results.json`.
An earlier in-progress-source gate also passed 186/186 (277.27s), but is not final
acceptance. Both results are retained. Local master advanced during verification
to `f30b41ad841d1cea6ca5d274403baba950a85a0d` (conditional unassign); approved
CLI sync reported conflicts only in this report and the evidence matrix. Both
sets of corrections and historical records are retained, with assign/complete/
unassign now using the shared rejection branch of the R1/R2 matrix. Production
files auto-merged. The next gate validates this integrated revision.

### Final worker verification for el-20qt0

Integrated source is `e0887b164e2e887ffe0ad8261ebc49400f31ffd8`, against local
master `f30b41ad841d1cea6ca5d274403baba950a85a0d`. A second independent advisory
review compared the merge against both parents and found no blocking integration
concerns; historical evidence and both corrections were retained. The only later
test change, `41381df`, explicitly adds closed-task CLI rejection and description
preservation; it was committed before the final gate executed that matrix.

Final **`pnpm check:merge`: 186/186, exit 0, 224.77s**. Includes uncached
workspace typecheck 17/17, Desktop build, Bun **8,780 pass / 0 fail / 29 existing
skips**, Smithy Node/Vitest 325, Desktop Node 6 and gate regressions 5 pass.
Completion protocol 69, local Git 23, lifecycle matrix 71 and assignment 37 all
passed in that gate (**200 focused tests**). `git diff --check` passed; worktree
was clean before this documentation-only verification addition.

Exact commands, exit codes and per-step logs:
`$TMPDIR/stoneforge-merge-check-sGhU4A/results.json`.
Worker summary log: `/tmp/el-20qt0-integrated-gate.log`. Earlier results above are
retained, not substituted for final integrated validation. Separate root build/
lint/test, Quarry Node, browser/packaged GUI, real provider and cross-platform
checks were omitted; skips are not coverage. No gate/threshold changes, installed
Desktop updates, maintenance actions or live session/task fixtures occurred.
Only the assigned source branch was pushed; no external MR was created.

Existing workspace reference el-4aqnn and Documentation Directory are updated.
Registered SF steward review of the **exact final commit**, followed by explicit
checks and approved CLI local merge, remains required. Advisory sub-agent review
is not a claim that this orchestration review or delivery has occurred.

## Spawner termination retry — el-1c5so, 2026-09-26

Production fix `1b8de58`, integrated with delivered local master `a6120dc` in
`c4a8eb2`. This is the lower-level Spawner contract, separate from pending
el-1q2vv SessionManager persistence/CAS work; no pending branch was copied.

A real `SpawnerServiceImpl`, spawned through inert typed providers, confirms
that throwing interactive kill/headless close after the transition leaves
`terminating`, and a concurrent duplicate previously returned success. The
initial four-test desired-safety baseline on `75b818a` produced **3 failures,
1 pass** (exit1): both provider-error cases and early concurrent success fail.
The original successor-only control passed because it did not yet assert own
completion; the final regression also requires own terminated state and two
calls on the original handle. Baseline log: `/tmp/el-1c5so-baseline.log`.
No desired-safety failure was converted into acceptable defect behavior.

The implementation stores attempt/step progress on the captured internal session.
Concurrent callers await the same attempt, including its exact thrown error even
if the provider reports exit synchronously before throwing. Retrying a failed
attempt never resolves the agent's current session/provider ID, so a same-agent,
same-provider-ID successor is untouched. Completed stops remain idempotent.
Provider requestExit/write/interrupt/close/kill errors propagate unchanged.
Successful interrupt, graceful request/grace period, close and force request are
not replayed; a throwing step may be retried on that same handle. As with any
provider API, a throw after an unreported external side effect is ambiguous:
this is not a guarantee of exactly-once external delivery.

A concurrent force call joins the active graceful attempt; it does not escalate
that attempt. After failure, force retry skips unfinished graceful steps.
Interactive/legacy graceful shutdown waits up to 5s for exit, then sends force
and waits up to another 5s. Headless graceful shutdown interrupts, closes and
waits up to 5s for stream completion; force skips interrupt. Provider interrupt
itself retains its Promise contract (no new cancellation deadline).
A sent signal, process.killed flag, successful close or expired timer alone is
not completion: unconfirmed exit rejects and remains `terminating` with no
synthetic endedAt. Later attempts can await the outstanding accepted request,
without re-sending it. A provider exit callback/stream completion can finish the
session independently. These provider observations do not prove that every
external descendant/server has stopped. SessionManager's separate in-memory
status/persistence behavior is not changed or claimed fixed here.

The temporary exit observer and timer are installed before the request and
removed on success, timeout and throw. No polling interval remains. Ordinary
5s retention timers created by actual provider exit remain intact.
`spawner-terminate.test.ts` uses Vitest fake timers, no arbitrary sleeps, no OS
processes or live providers. Its **15/15** passing cases cover direct close/kill
failure and concurrent error, delayed/synchronous exit, original handle versus
successor, completed positive controls, requestExit/write failures, fallback
kill throw, accepted-close/kill timeout then retry, headless interrupt/close
progress, force/graceful retries, and original errors despite synchronous exit.
The legacy process branch has no current public spawn path; its explicit
private-state fixture uses only EventEmitter plus mock kill, and asserts
SIGKILL despite killed=true, failure retry and listener disposal. This proves
branch behavior, not current production reachability of a legacy spawn path.

Validation before full gate: frozen pnpm install exit0; Smithy typecheck exit0;
focused Vitest15/15 exit0; SessionManager Bun85/85,157 assertions exit0.
Logs: `/tmp/el-1c5so-{install,typecheck,focused,session-manager}.log`.
Required full gate result is recorded below when finished. No standalone root
build/lint/test, browser/packaged GUI, cross-platform or real-provider coverage
is claimed. Installed Desktop, agent processes, daemon and closed maintenance were not
used as fixtures or modified. Shared task/docs updates use sf. Exact-final-commit
independent steward review and approved CLI local merge remain required.

### el-1q2vv safe sync after delivered completion fix

Checkpoint 5f03117 passed its complete gate: **186/186, exit 0, 214.59s**
(`/tmp/el-1q2vv-gate-final.log`, results directory `stoneforge-merge-check-KUSXtg`).
Local master then advanced to 3420c56198517a39d1219a2c1acfd0099d526429
(el-20qt0 completion). Approved CLI sync merged all source/tests automatically;
only this append-only report conflicted, resolved by preserving both full sections.
Completion's delivered contracts and converted regression assertions are retained.
Thus the earlier statement that completion is pending describes the pre-sync state.
Final integrated checks and independent exact-commit review are recorded below.

### el-1q2vv final integrated worker acceptance

Source at integrated commit `5a42f08` (implementation `5f03117`, prior partial
`12dd742`) includes delivered local master `3420c56`. Focused claim/lifecycle/
completion protocol/Git suite: **189 pass, 0 fail, 992 assertions**, 24.32s.
Complete **pnpm check:merge: 187/187, exit 0, 236.11s**, after all source/test edits
and approved sync. Includes uncached workspace typecheck, Desktop build, all gate
Bun files, Smithy Node/Vitest, Desktop Node and gate regression checks. Claim suite
is **24/24**; existing skip cases remain, no gate/threshold changes.

Logs: `/tmp/el-1q2vv-integrated-focused.log`, `/tmp/el-1q2vv-gate-integrated.log`.
Every command/exit/duration and log is recorded in
`$TMPDIR/stoneforge-merge-check-5wSjK1/results.json`.
`git diff --check` passes and local master is an ancestor. Only documentation is
changed after this gate. Previous gate runs (186/186 at 235.38s and 214.59s),
original safety failures and fixture failures are preserved above, not erased.

Worker acceptance is complete; independent steward review of the final documentation
commit plus exact implementation, and approved CLI local delivery after explicit
checks, remain required. No manual PR/merge, installed app replacement or live
provider/daemon/session testing was performed. Director's coordination of this
worker's live task assignment is not a test fixture or application maintenance.

### el-1q2vv steward rejection and cleanup retry correction

Steward rejected `db20c9883cca7016f9764760c522ab21ccc75cb8` after a passing
188/188 gate: `stopSession` treated in-memory `terminated` as completed cleanup.
A transient persistence error left the registry running with no ended history;
a second stop silently returned. The original independent evidence remains in
shared reference el-4aqnn and `/tmp/el-1q2vv-review/stop-retry-regression.patch`.
This worker reapplied that desired-safety probe and reproduced **0 pass / 1 fail**
on db20c98 before the fix. It is now a permanent reject/preserve regression in
`dispatch-claim.bun.test.ts`, not a characterization of acceptable behavior.

SessionManager now records stop progress per captured internal session ID.
Concurrent callers await the same operation and receive its failure. A later
call retries incomplete cleanup; successful process termination is not repeated
when only persistence failed. Completed stops are idempotent. Failed termination
remains retryable through the same exact SpawnerService session ID. The original
end timestamp/reason are retained. Stop progress is removed with the session's
normal memory cleanup; an incomplete explicit stop cannot be evicted by that timer.
Current registry fields still require the existing internal identity/entity CAS;
retry never looks up or adopts a successor's session. History remains deduplicated.
No API/format/schema, legacy ownership, gate or threshold changes were made.

Four additional real temporary SQLite/Git + actual SessionManager/registry tests
cover persistence failure/retry, concurrent successful stops, and concurrent
persistence/termination failures followed by same-provider-ID successor startup.
They assert both callers fail, own cleanup retries, unique ended history, and
successor process/current fields/active mapping preservation. Spawner handles are
inert mocks; there are no live agents, providers or task/daemon fixtures.

Frozen install: exit0. Focused command:
`bun test packages/smithy/src/services/dispatch-claim.bun.test.ts packages/smithy/src/services/task-lifecycle-race-evidence.bun.test.ts packages/smithy/src/runtime/session-manager.bun.test.ts packages/smithy/src/services/task-session-retention.bun.test.ts`
passed **198/198, 715 assertions**, exit0, 17.61s; claim suite now28/28.
Log: `/tmp/el-1q2vv-retry-focused-final.log`.
An initial implementation incorrectly required persisted=true for all timer
cleanup, failing an existing non-stop eviction control (197 pass/1 fail).
The correction restricts the timer guard to explicit stop progress; the existing
control is unchanged. A prematurely started full gate was interrupted (exit130)
during typecheck, before this correction; it is not claimed as validation.

Adjacent lower-level limitation: existing SpawnerImpl.terminate returns for
`terminating` even after a provider close/kill throw. This exists on local master
and is reported to Director in el-25s0e; it is not fixed or hidden by these
SpawnerService-boundary tests. This change does not claim universal provider
termination reliability. Other historical DEFECT groups, controls and completed
handoff/completion/retention fixes remain intact.

The assigned branch already includes the steward's approved local sync with
master75b818a; ancestry/diff checks pass. Independent exact-final-commit review
and explicit approved CLI local merge remain the steward's next steps. No manual
PR/merge, installed Desktop update or maintenance/live session operation occurred.
Separate root build/lint/test, browser/packaged GUI, standalone server suite,
browser sql.js, cross-platform and real-provider tests are omitted.

Final retry-correction gate: **pnpm check:merge188/188, exit0,239.48s**.
Log `/tmp/el-1q2vv-retry-gate-final.log`; exact commands/exits and per-step logs:
`$TMPDIR/stoneforge-merge-check-06UZVT/results.json`.
All final production/test edits were present; only this result documentation was
added afterward. This supersedes neither the historical rejection nor omitted
live-provider coverage. Independent exact-commit review remains required.

## Handoff internal identity after eviction — el-2pujj

The retention investigation's provider fallback is now removed: worker handoff
requires the exact unique current unfinished internal entry plus existing
owner/status/version checks. Provider-shaped metadata remains valid data, but
provider caller IDs and unprovable empty/absent history reject. This aligns with
the delivered worker completion and dispatch internal-identity contracts, without
changing their admin paths, cap50 or audit/history storage. See
`docs/workspace/worker-handoff-ownership.md` for isolated failing baseline,
CLI/spawner audit, regression matrix and verification. Earlier DEFECT evidence
and independent acceptance records retain their original scope and revisions.

### el-1c5so delivered-contract compatibility and final verification

The first full `pnpm check:merge` on integrated `c4a8eb2` passed **188/188,
exit0,238.23s**; results at
`$TMPDIR/stoneforge-merge-check-HEkiPi/results.json`.
During verification el-1q2vv was independently accepted and delivered as local
master `90b3ad8`. Approved CLI sync produced `5ee8034`; only the additive report
conflict needed resolution, retaining both reports. Statements above referring
to pending SessionManager changes are historical; the final branch includes the
delivered contract, with no worker changes to SessionManager/dispatch/Quarry.

Source compatibility review: stopSession shares its own pending operation;
a Spawner rejection leaves terminationComplete=false and does not enter
persistence. Retry calls terminate with the same internal session ID. After
successful Spawner exit, a persistence-only retry skips process termination.
Existing SessionManager in-memory status-before-exit semantics remain outside
this lower-level change. Integrated `bun test
packages/smithy/src/services/dispatch-claim.bun.test.ts
packages/smithy/src/runtime/session-manager.bun.test.ts`: **113/113,279 assertions,
exit0,10.50s**, log `/tmp/el-1c5so-integrated-runtime.log`.

Final integrated `pnpm check:merge`: **189/189,exit0,265.29s** on source `5ee8034`,
including Spawner Vitest15/15 and all declared runtime/Node checks. Full log
`/tmp/el-1c5so-gate-integrated.log`; exact commands/results:
`$TMPDIR/stoneforge-merge-check-YYVnWC/results.json`.
Local master ancestry and diff checks pass. Only report text changed after this
gate. Original failures and pre-sync result are retained. Independent steward
review of the final commit and approved CLI local merge remain required; this
worker record is not a merge verdict or installed application update.

## Non-merge steward automatic claim — el-hkutb, 2026-09-26

Baseline local master `3c22b53bf6b85175dc8f4b69372096bc9b12fa9b` already contains
el-1q2vv's independently delivered automatic claim/cleanup contract and the
Spawner retry fix. Assigned worktree started at that exact target; no sync or
branch switch was necessary. Earlier evidence and neighboring fixes are retained.

`pollWorkflowTasks` now passes the selected non-merge steward candidate's original
`updatedAt` through DispatchService's automatic claim option. Assignment keeps its
transactional ready/unassigned predicates, source parent/dependency eligibility and
schedule checks. A lost claim does not increment processed or emit task:dispatched.
Focus tags (`docs`, `steward-docs`, generic `workflow`), priority ordering, disabled
and busy exclusions remain unchanged. Manual dispatch still permits intentional
reassignment. The merge-steward REVIEW branch and reconciliation are unchanged.

On notification failure, this caller conditionally releases only the assignment
receipt carried by DispatchAssignmentError. It never refreshes ownership or uses
administrative unassign. Pre-assignment preparation failure has no receipt and
cannot release a successor. This path does not prepare a process or worktree;
it must not call session stop or directory cleanup on existing resources.

The 25 added Bun regressions extend `dispatch-claim.bun.test.ts` using the actual
daemon poll, DispatchService, TaskAssignmentService and two Quarry connections to
one temporary on-disk SQLite database. Deterministic hooks run after selection and
immediately before the real transactional update. Close, defer, Human/successor,
parent DRAFT/blocked and future schedule reject while preserving complete task and
task-event snapshots, messages, existing agent/session state and a successor
directory. Two polls selecting the same snapshot for different stewards produce
one assignment notification and one success. Controls cover all three tags,
priority, due/in-progress tasks, focus mismatch, disabled/busy agents, manual
Human reassignment, notification failure with/without successor, and channel
preparation failure. No sleeps, live daemon, provider or live task reproduction.
SQLite writes use QuarryAPI; direct SQL only reads event/message evidence.

Validation:
- `pnpm install --frozen-lockfile`: exit0, unchanged lock; `/tmp/el-hkutb-install.log`.
- Before the production edit, new desired-safety tests: **16 pass / 9 fail**,
  133 assertions (`/tmp/el-hkutb-baseline.log`). Seven candidate races, parent DRAFT
  at the transaction boundary and notification cleanup without a successor fail.
  Other transaction races and the original same-steward two-poll control already
  pass via existing assignment CAS; they are not newly attributed defects.
  The final two-poll control uses distinct steward identities.
- Initial corrected full claim suite: **53/53**, 320 assertions, 8.94s
  (`/tmp/el-hkutb-focused.log`).
- `bun test packages/smithy/src/services/dispatch-claim.bun.test.ts packages/smithy/src/services/dispatch-service.bun.test.ts packages/smithy/src/services/dispatch-daemon.bun.test.ts packages/smithy/src/services/task-assignment-service.bun.test.ts`:
  **246 pass / 2 existing skips / 0 fail**, 893 assertions, 24.22s
  (`/tmp/el-hkutb-focused-final.log`). Final distinct-steward control included.

Required gate results follow below. Separate root build/lint/test, Quarry Node,
browser/packaged GUI, cross-platform and live-provider checks are not claimed.
The required gate includes its declared typecheck/build/runtime checks. Installed
Desktop, live agents/sessions/daemon and completed maintenance remain unchanged.
Independent steward review of the exact final commit and approved CLI local
merge remain required; this worker report is not merge approval.

First required gate on source `e3511ad`: **188/189, exit1, 450.35s**;
`/tmp/el-hkutb-gate.log`, exact results
`$TMPDIR/stoneforge-merge-check-g8qBfX/results.json`.
Only unchanged Quarry list scaling failed: ratio3.559304857848077 against `<3`.
The test/implementation were not edited by this task; the previously documented
failure class remains unresolved, without a causal attribution to host load.
All dispatch, lifecycle, typecheck, Node and Desktop source checks passed.
Director notified. This failed gate is retained, not described as green acceptance.
During the run local master advanced to delivered handoff fix `beac945`; the
approved CLI's manifest and all299 hashes were verified before integrating it.

Approved CLI sync with delivered handoff `beac945` succeeded without conflicts as
`8fa6a5b`. Integrated required **pnpm check:merge189/189, exit0, 256.13s**:
`/tmp/el-hkutb-integrated-gate.log`, exact results
`$TMPDIR/stoneforge-merge-check-bYbZs8/results.json`.
Quarry scaling35/35 passed unchanged; this does not establish the original cause.
## Claude SDK cleanup retry — el-1mo5c, 2026-09-26

Baseline is delivered local master `3c22b53`, including Spawner el-1c5so and
SessionManager el-1q2vv. No pending branch was copied. Implementation `c9f32d3`
changes only ClaudeHeadlessSession close bookkeeping: `closed` retains the existing
iteration guard and input is closed before SDK cleanup; `cleanupComplete` is set only after the captured
SDK query's synchronous close returns. Throws remain visible to the caller and
leave cleanup retryable on that exact query. Successful cleanup is idempotent.
Input is never reopened; pre-close queued messages retain their existing drain
order, new messages after close begins are dropped. Interrupt remains separate
and does not set either close latch. No new provider-wide state or handle lookup.

The locked SDK is @anthropic-ai/claude-agent-sdk 0.3.282. Its local Query declaration
has close(): void and documents process/MCP/pending-request cleanup. Tests invoke
the actual exported ClaudeHeadlessProvider.spawn and session wrapper, mocking only
SDK query creation with inert queues/methods. No live SDK query, OS child or provider
is invoked; the fixture does not estimate real SDK exception frequency or promise
that retrying SDK internals reverses a partial external side effect.

New Vitest suite `packages/smithy/src/providers/claude/headless-close.test.ts`:
first throw/success/completed no-op; distinct repeated throws then success; waiting
input closed before throwing cleanup (including reentrant send); old queue ordering;
post-failure output suppression plus cleanup after iterator end; natural end cleanup;
interrupt error/success/input preservation; AbortError completion; composed real
Spawner/Claude adapter retry with shared caller error, skipped successful interrupt,
original query and untouched same-agent/same-provider-ID successor.

Baseline with all 9 final regressions and original production file: **4 fail/5 pass,
exit1**, `/tmp/el-1mo5c-baseline-final.log`. Prior raw baseline and refined diagnostic
are retained in `/tmp/el-1mo5c-baseline.log` and `-baseline-refined.log`: first composed
case hit Vitest timeout; fake-time refinement exposed `Session termination unconfirmed`.
An intermediate post-fix run had 23/24 passing: advancing 5 seconds removed the already
terminated session via the existing retention timer. The final fixture advances zero
fake milliseconds and checks SDK call count before awaiting retry, giving deterministic
baseline failure and retaining the termination-state assertion. No production timer or
threshold was changed. Intermediate log `/tmp/el-1mo5c-focused.log` is retained.

Verification:
- `pnpm install --frozen-lockfile`: exit0, lockfile unchanged; install log
  `/tmp/el-1mo5c-install.log`.
- `pnpm --filter @stoneforge/smithy typecheck`: exit0,
  `/tmp/el-1mo5c-typecheck.log`.
- `pnpm --filter @stoneforge/smithy test:node src/providers/claude/headless-close.test.ts src/runtime/spawner-terminate.test.ts`:
  **24/24 pass**, `/tmp/el-1mo5c-focused-final.log`.
- `bun test packages/smithy/src/providers/claude/headless.bun.test.ts`:
  **17/17 pass,48 assertions**, `/tmp/el-1mo5c-adapter.log` (isolated process).
- `bun test packages/smithy/src/runtime/spawner.bun.test.ts packages/smithy/src/runtime/session-manager.bun.test.ts packages/smithy/src/services/dispatch-claim.bun.test.ts`:
  **187/187 pass,478 assertions**, `/tmp/el-1mo5c-runtime.log`.

Iterator end is NOT proof of resource cleanup. The adapter's retry latch remains
incomplete across iterator end, proven directly. Existing Spawner treats ended
provider output as terminated, so a subsequent Spawner terminate can return before
reaching this adapter if output already ended independently. This separate runtime
boundary is unchanged and reported to Director; composed coverage here tests retry
while output is still pending after the SDK throw, then ends on successful cleanup.
No universal process-tree/resource-release guarantee is claimed.

Required gate result follows below. Separate root build/lint/test, browser/packaged
GUI, cross-platform and live-provider checks are omitted; the gate runs its declared
checks. Installed application, live sessions/daemon and maintenance were untouched.
Independent steward review of the exact final commit and approved CLI local merge
are required after worker completion; worker does not claim either.

First required `pnpm check:merge`: **189/189, exit0,315.77s**, including Smithy
Vitest349/349. Log `/tmp/el-1mo5c-gate.log`; exact per-step results:
`$TMPDIR/stoneforge-merge-check-LVCg2k/results.json`.
Local master advanced to delivered handoff fix beac945 during verification; approved
CLI sync and integration verification follow, preserving the first gate evidence.

Approved CLI manifest and all299 hashes verified; `task sync el-1mo5c` integrated
delivered local master beac945 without conflicts as fd7cb1e. Source/tests unchanged.
Integrated gate **188/189, exit1,324.95s**: unchanged Quarry list scaling failed,
medians0.233444/0.452705/0.740195ms, ratio3.170760 against `<3`. This is a failed
gate, not green acceptance. All other steps passed. Log
`/tmp/el-1mo5c-gate-integrated.log`; exact results
`$TMPDIR/stoneforge-merge-check-GPBE9u/results.json`.
Quarry API and performance test match first passing baseline3c22b53. Earlier
progress updates sampled the current log tail and missed this earlier failure;
the completed result corrects those updates. No causal attribution to host load.

One isolated diagnostic via Node spawnSync with gate `checkEnvironment()` and
`bun test packages/quarry/src/api/query-performance.bun.test.ts` passed
**35/35,891 assertions,exit0,8.06s**, `/tmp/el-1mo5c-quarry-probe.log`.
This does not erase the failure or establish its cause. Director notified, no
duplicate task/threshold/code change. One final full gate retry follows to verify
the integrated tree; repeated failure requires handoff rather than a green claim.

Director instruction received after the repeat started supersedes the planned
retry-as-acceptance/handoff wording above: do not stop the running check, retain
its entire result as **additional diagnostic only**, and run no further gates
on this unchanged source. The failed integrated acceptance **188/189** remains
explicit regardless of the diagnostic outcome. Related investigation is tracked
in **el-39znb**; no duplicate task or self-approval. Send the final report/commit
to independent review with the unsuccessful acceptance disclosed. Completion of
the worker implementation does not authorize merge or claim the gate issue resolved.

Additional full diagnostic on unchanged fd7cb1e: **189/189,exit0,238.73s**,
`/tmp/el-1mo5c-gate-final.log`; exact results
`$TMPDIR/stoneforge-merge-check-P1jcfh/results.json`.
Per Director instruction this is diagnostic only; it does not replace the failed
integrated acceptance188/189, prove a root cause, or authorize merge. No more
worker gates were run. During this diagnostic local master advanced separately
to8c8cca9 (el-2hrsm atomic assignment); it is not included in this worker tree.
Independent steward must sync/review the exact final commit against the then-current
target, retain the el-39znb failure context and establish acceptance before merge.
Only verification documentation changed after the tested source. Installed app,
live providers/sessions/daemon and maintenance remain unchanged.


## Explicit OrchestratorAPI assignment — el-2hrsm, 2026-09-26

Base local master `a98c67e` includes delivered completion el-20qt0 and automatic
claim el-1q2vv. This fixes the separate `OrchestratorAPI.assignTaskToAgent` path;
it does not redirect explicit assignment through automatic ready/unassigned
eligibility or through the differently configured TaskAssignmentService.

Previously assignee/status committed first; a second metadata write reused the
original snapshot. A concurrent close/defer/Human/worker owner or completion claim
could be overwritten; failure of the metadata transaction left partial assignment.
Now one Quarry update combines assignee, optional IN_PROGRESS and merged metadata,
with expectedUpdatedAt from the original task read. Existing transactional SQL CAS
rejects both R1 (after API snapshot read) and R2 (after Quarry update read) without
retry. No second write remains. W1 observers see coherent ownership, status and
metadata, and a later winner survives. Rollback after real SQL mutations preserves
the original task and event rows.

Compatibility is deliberate: an existing owner and future schedule do not prevent
explicit reassignment. Custom/default branch and worktree, omitted/provided
sessionId, optional markAsStarted, and unconditional startedAt retain this API's
previous semantics. No new eligibility/status policy or session-history append is
introduced. Outer metadata, orchestrator extensions, completionOperation,
completionHistory, sessionHistory and handoff history are retained. A competing
claim causes conflict instead of stale overwrite; an already present unknown claim
survives assignment. Real lost-MR-response -> CLI reopen -> API assignment coverage
supplies a valid new session and confirms completion still requires reconciliation;
the transferred owner cannot recover the previous operation. No claim reset, TTL
or recovery escape hatch was added.

### Caller boundaries (verified, not expanded into lifecycle cleanup)

- Real source CLI `agent start --taskId` spawns before assignment. Its subprocess
  test uses the actual parser/handler/API/SQLite and an inert Spawner factory.
  CAS rejection returns failure and preserves the competitor task/events, but the
  already spawned process is not terminated. The fixture records one spawn and
  zero termination calls. This existing resource lifecycle remains out of scope.
- Both SDK and app HTTP session-start routes call the real API. Rejection keeps
  task/events and avoids session start, prompt save and notification; their current
  error mapping is HTTP 500, not a newly introduced 409 mapping. Persistent-worker
  worktree preparation precedes assignment: an inert manager proves one preparation
  call remains on rejection. No deletion/compensating cleanup is claimed.
- Successful HTTP assignment precedes startSession. A simulated start failure
  leaves the coherent assignment committed and returns 500; there is no caller-wide
  transaction. Earlier route prompt reads and preparation are outside the API's
  original-snapshot CAS. A change after assignment may precede spawn; the assignment
  result is a receipt of that commit, not a lock on future lifecycle decisions.
- SessionManager/Spawner/provider/Git process behavior is not tested by these mocks.
  Existing completion/dispatch suites are run for compatibility. Generic metadata
  replacement and unrelated start writers are not fixed here.

### Evidence and checks

All new data lives in temporary on-disk SQLite with independent connections;
fixture Git repositories have only local empty commits and no remote. No running
server/listening port, live task/agent/session, provider or installed app is used.
CLI module mocks are restricted to a child process preload under tests/fixtures,
so they cannot contaminate other Bun suites or ship in the production src build.

Initial desired-safety baseline on original production code: **15 fail / 9 pass**
(`/tmp/el-2hrsm-baseline-corrected.log`). Failures are ten R1/R2 competitors,
W1 coherence, transactional rollback, real CLI conflict and both HTTP conflicts.
The first baseline invocation used a wrong CLI flag; that fixture error was fixed
before recording this baseline. Positive existing reassignment/unknown controls
passed even before the fix; they are compatibility evidence, not newly fixed bugs.
The corrected API passed those 24 tests. Final coverage adds all five W1 winners,
nonempty completion audit history and persistent-worktree caller boundaries.

Frozen pnpm install passed (missing dist CLI-bin warnings before build; lockfile
unchanged). Initial package build caught a generic type mismatch in the new preload
fixture; it was typed correctly and moved out of production src. Final
`pnpm --filter @stoneforge/smithy... build` passed. Focused API/integration/assignment/
completion/lifecycle run passed234/234 before two added persistent-worktree cases.
Final required gate, logs and exact source commit are recorded below.
Separate full root build/lint/test, browser/GUI/packaged app, cross-platform,
browser SQLite, live provider and universal Node caller coverage are not claimed.
Independent exact-final-commit steward review and approved CLI local delivery
remain required. No installed application or maintenance changes are authorized.


### el-2hrsm pre-sync gate and delivered Spawner integration

Source `2cf14d611bb8d134bb813342f73c4d1fc5b7f4d2` passed the first full
`pnpm check:merge`: **190/190, exit0,430.99s**; logs `/tmp/el-2hrsm-gate.log`,
exact step results `$TMPDIR/stoneforge-merge-check-SPA3m4/results.json`.
The gate includes the final30/30 assignment tests (189 assertions) and compatibility
suites. Local master advanced to delivered Spawner fix `3c22b53` during that run.
Approved safe sync preserves both implementations; only an additive report conflict
needed resolution, retaining both reports. The integrated revision is checked again
below; the earlier result remains evidence for its original source.

### el-2hrsm final integrated worker verification

Integrated source `d95fcae` includes delivered local master `3c22b53`. Final
`pnpm check:merge`: **190/190, exit0,258.81s**, log
`/tmp/el-2hrsm-gate-integrated.log`; exact commands and step results:
`$TMPDIR/stoneforge-merge-check-X6o7Pl/results.json`.
The gate includes uncached workspace typecheck, all declared isolated Bun suites,
Smithy Node/Vitest340/340 (including the delivered Spawner tests), Desktop build
and Node integration. The five focused suites inside the final gate total
**236/236,1155 assertions**: explicit API30, API integration27, assignment37,
completion69, lifecycle73. Existing skips in other suites are not passing coverage.
Earlier focused234/234 and first gate190/190 remain historical results above.

Local master ancestry, diff check and clean source status passed. Only this result
record changed after the integrated gate; production/test files remain the tested
versions. Exact-final-commit independent steward review and approved CLI local merge
are still required. Caller process/worktree effects and recovery limits above remain;
no installed app, live session/daemon, provider or maintenance changes were made.

## Retained headless cleanup after output end — el-4bwuz, 2026-09-26

Implementation `c9dd48d73c2484909be6460d2ffe5c0467af48ff` starts at delivered local
master `2bb427b7a314643fd8b0e8adcc94cb054888cc41`, including Spawner el-1c5so,
Claude adapter el-1mo5c and SessionManager el-1q2vv. Approved CLI artifact manifest
and all299 hashes verified; `task sync el-4bwuz` confirmed that exact local target.
Only Spawner production code changes; providers, SessionManager, CAS and gate
configuration are unchanged.

### Contract and resource limits

Spawner now distinguishes output termination from a successful synchronous
`HeadlessSession.close()` return on its captured internal handle. Explicit terminate
on an already terminated headless session retries incomplete close without sending
another interrupt, changing the ended status/timestamp or resolving an agent's
current provider/session. It also closes when output ends during awaited interrupt.
A thrown close leaves its completion latch unset; each explicit attempt exposes
its actual error, and concurrent terminate calls join the same attempt. Successful
close is recorded through one helper for explicit termination, automatic result/error
handling and suspension, preventing repeat calls after successful automatic cleanup.
Interactive/legacy exited-process early returns remain; no exited PID is signalled.

The existing five-second retention bound is unchanged. Retry is available only
while the old internal handle remains in Spawner; after eviction, its ID rejects
with `Session not found` rather than resolving a successor. No background cleanup
retry or unbounded retention was added. Existing termination observer/timer cleanup,
five-second confirmation waits, graceful/force behavior and successful-step
idempotence remain covered. A successful synchronous adapter call is the observable
cleanup-request contract, **not proof of every external process/resource stopping**.
Providers may perform asynchronous cleanup internally (e.g. Codex/OpenCode); this
change neither redesigns their APIs nor proves rollback of partial SDK side effects.

Delivered SessionManager stop retries compose with this change: Spawner rejection
keeps terminationComplete false, and a retry invokes the same internal ID. After
success, persistence-only retries skip termination. Its pre-existing natural-exit
shortcut (`terminated && persisted`, with no stop progress) still returns before
Spawner; this is not a universal SessionManager natural-exit cleanup fix. Direct
Spawner terminate can now clean the retained handle in that case. This boundary
was reported once to Director in el-ig5h1; no broader contract was inferred.

### Evidence and verification

Vitest uses actual Spawner, actual delivered ClaudeHeadlessProvider with only
SDK Query mocked, inert queues/interactive/process handles and isolated in-memory
SQLite for real QuarryAPI/AgentRegistry/SessionManager composition. No live SDK,
provider, OS process, agent PID, installed app/session, daemon or maintenance was
used as a fixture. Fake timers and explicit exit/interrupt barriers avoid sleeps.

- New real-Spawner baseline on unchanged production: **6fail/18pass, exit1**,
  `/tmp/el-4bwuz-baseline.log`.
- Final37-test baseline against the unchanged delivered Spawner, retaining the
  delivered Claude adapter: **9fail/28pass, exit1**,
  `/tmp/el-4bwuz-baseline-final.log`. Failures assert missing close/retry and missing
  repeated errors, including SDK/SessionManager composition; controls remain green.
- Corrected final focused command:
  `pnpm --filter @stoneforge/smithy test:node src/runtime/spawner-terminate.test.ts src/providers/claude/headless-close.test.ts`:
  **37/37 pass, exit0**, `/tmp/el-4bwuz-focused-final.log` (Spawner25, Claude12).
  Coverage includes iterator end before first close, end during throwing close,
  repeated distinct errors then success, concurrent success/failure, successful
  cleanup exactly once, interrupt/output-driven-close interleaving, automatic
  result/error success and throw, retention eviction, exited OS mock no-resignal,
  same-agent/reused-provider-ID successor and real SessionManager persistence/CAS.
- An intermediate composition fixture expected the entire successor agent record
  to stay byte-equal: **35pass/1fail**, `/tmp/el-4bwuz-composition.log`. This was an
  incorrect fixture expectation: successful old-session persistence legitimately
  appends history. The final test instead asserts preserved active identity/status,
  untouched successor handle and exactly one old history entry. No production CAS
  or persistence change was made to satisfy that assertion.
- `pnpm install --frozen-lockfile`: exit0, `/tmp/el-4bwuz-install.log`; existing
  missing-unbuilt-workspace-bin warnings, lockfile unchanged.
- `pnpm --filter @stoneforge/smithy typecheck`: exit0,
  `/tmp/el-4bwuz-typecheck.log`.
- Separate isolated Bun processes for
  `packages/smithy/src/providers/claude/headless.bun.test.ts`,
  `packages/smithy/src/runtime/spawner.bun.test.ts`,
  `packages/smithy/src/runtime/session-manager.bun.test.ts`,
  `packages/smithy/src/services/dispatch-claim.bun.test.ts`:
  **17+74+85+28=204pass,526 assertions, all exit0**,
  `/tmp/el-4bwuz-runtime.log`. Project/actor/server routing environment variables
  were removed only for test subprocesses, preserving worker STONEFORGE_ROOT.

Required `pnpm check:merge` result follows below. Separate root build/lint/test,
browser/packaged GUI, cross-platform and live-provider coverage is not claimed.
Independent exact-final steward acceptance and approved CLI local delivery remain
required; worker completion is not merge approval.

### el-4bwuz initial full acceptance before adjacent delivered dispatch delta

`pnpm check:merge` on source `c9dd48d` passed **190/190,exit0,304.94s**.
Log `/tmp/el-4bwuz-gate.log`; exact per-step results
`$TMPDIR/stoneforge-merge-check-p3oWjX/results.json`.
During this run local master advanced to delivered non-merge-steward claim
`4c29bb0`; subsequent approved sync and integrated acceptance are recorded below.
### el-hkutb final integrated worker verification

Approved CLI sync with explicit API assignment master `8c8cca9` produced `c1ba041`.
Only the appended lifecycle report conflicted; both reports were preserved. Code
merged without conflict, and the non-merge steward implementation is unchanged.
Final **pnpm check:merge190/190, exit0, 289.34s**:
`/tmp/el-hkutb-final-gate.log`; exact per-step commands/results:
`$TMPDIR/stoneforge-merge-check-Yvaz3t/results.json`.
The gate includes the new explicit API assignment coverage, delivered handoff,
completion/claim/cleanup/Spawner regressions, uncached workspace typecheck,
Desktop source build, Smithy Node/Vitest and Desktop Node tests. Earlier failed
scaling evidence and the subsequent189/189 result remain above; no test threshold
or unrelated implementation was changed. Target ancestry/diff checks pass.
Only verification documentation changes after this gate. Independent review must
name the exact final worker commit (or its subsequently synchronized replacement)
before approved CLI local merge. No worker merge or installed/live changes.

## HTTP session start conditional release — el-56khe, 2026-09-26

Baseline `8c8cca9` includes the delivered explicit API CAS (el-2hrsm), automatic
claim/internal-session cleanup and completion/history fixes. The former caller
report's stranded HTTP assignment is historical baseline evidence, now addressed
here; CLI caller ordering and the rest of session runtime are not rewritten.
Approved local sync through the el-ptim CLI included delivered master `2bb427b`
(Claude cleanup retry), without conflicts. CLI source manifest and all299 hashes
matched; no pending worker branch was copied. Implementation commit: `1fe94ea`.

Both actual `sessions.ts` HTTP start routes capture task ID, owner, session identity
and version exclusively from the committed assignment return. A rejected assignment
has no receipt and cannot release anything. A startup rejection releases through
TaskAssignmentService's existing failed-dispatch CAS; no administrative fallback,
retry or reread/adoption of a newer owner is allowed. The release preserves task
status, generated branch, outer/extension metadata, completion claims/history and
session/handoff history. Human, terminal, deferred and successor/version changes
win at both the first read and the actual update transaction.

Worktree preparation is distinct from an accepted SessionManager return. The route
never stops sessions by agent ID or tries to recover a handle it did not receive.
SessionManager retains its existing exact-internal-session startup cleanup contract.
After start returns, event-saver/prompt persistence/client-notification errors still
return HTTP500, but do not unassign or stop the accepted session (or a newer one).
The response identifies the accepted internal session when known. Persistent
worktree preparation errors now fail explicitly in both routes; the app route no
longer silently continues in a different directory after preparation failure.

No destructive worktree cleanup is attempted: there is no exclusive deletion lease,
and a precheck cannot prove that a reusable path has not been acquired by a successor.
Errors report `cleanup.assignment` (`not-assigned`, `released`, `retained-conflict`,
`retained-error`, `retained-session-started`) and `cleanup.worktree` with retained
path/reason when returned, or `not-returned` when no path was delivered. The latter
is **not** proof that preparation created no resources. Cleanup errors accompany,
never replace, the original HTTP error. Logs include the same diagnostics. These
outcomes do not promise removal of all orphan resources or successful provider
termination: a failed internal stop remains logged by SessionManager and resources
can remain for later explicit recovery. No resource GC or entire runtime redesign.

Evidence uses both real HTTP route factories, two connections to temporary on-disk
SQLite, local Git worktrees, real OrchestratorAPI/TaskAssignmentService/SessionManager,
and inert SpawnerService-boundary provider handles. No live process/provider, agent,
session, daemon, installed app or maintenance operation was used as a test object.
The tests do not claim an actual SDK/provider transport termination was exercised.

- New initial desired-safety baseline: **4pass/34fail**,210 assertions,
  `/tmp/el-56khe-baseline.log`. Six direct spawn/persistence/termination-error cases
  demonstrate retained assignment. Other failures also include missing diagnostics
  and cleanup-race hooks that the old route never reached; not34 distinct defects.
- First correction:38/38,454 assertions, `/tmp/el-56khe-focused.log`.
- Expanded test intermediate:70pass/2fail across new+API suites,
  `/tmp/el-56khe-focused-2.log`. The two publication-race expectations incorrectly
  forbade the existing runtime's own ended-history append. Assertions now preserve
  successor current fields and require the legitimate terminated own history entry;
  production runtime was unchanged. Subsequent46/46,540 assertions in
  `/tmp/el-56khe-focused-3.log` retains that evidence.
- Final focused command: `bun test packages/smithy/src/api/http-session-start.bun.test.ts packages/smithy/src/api/orchestrator-assignment.bun.test.ts packages/smithy/src/services/task-assignment-service.bun.test.ts packages/smithy/src/services/dispatch-claim.bun.test.ts packages/smithy/src/services/task-completion-protocol.bun.test.ts`:
  **212/212,1359 assertions,exit0,36.79s**, `/tmp/el-56khe-focused-final.log`.
  New route suite48 tests covers spawn, preparation, publication, persistence,
  termination and notification errors; rollback after real release SQL; R1/R2
  closed/deferred/Human/successor/completion-claim races; assignment CAS rejection;
  successful start; returned reusable Git paths; accepted plus newer sessions;
  full task/event preservation and retained files/registered Git worktrees.
- `pnpm install --frozen-lockfile`:exit0,lock unchanged,
  `/tmp/el-56khe-install.log`; package typecheck exit0 before final integration.
- Required integrated `pnpm check:merge`: result appended below.

Separate root build/lint/test, browser/packaged GUI, cross-platform and live-provider
checks are not claimed. The required gate runs its declared uncached source/runtime
checks. Independent steward review must name the exact final commit and establish
acceptance before approved CLI local delivery; worker verification is not approval.
Installed Desktop and completed maintenance are unchanged.

First required gate on `1fe94ea`: **191/191,exit0,317.12s**;
`/tmp/el-56khe-gate.log`, exact commands/results:
`$TMPDIR/stoneforge-merge-check-dLG3kY/results.json`.
During this run master advanced to delivered non-merge steward claim `4c29bb0`.
Approved sync and final integrated verification follow; this first result is retained.

### el-56khe final integrated worker verification

Approved CLI sync with delivered steward claim `4c29bb0` produced `8cb6db3`.
Only additive lifecycle-report text conflicted; both sections were preserved.
HTTP implementation/tests were unchanged. Required integrated **pnpm check:merge:
191/191,exit0,317.67s**, `/tmp/el-56khe-gate-integrated.log`; exact per-step results:
`$TMPDIR/stoneforge-merge-check-DEYYoI/results.json`.
Five focused suites inside this gate: **237/237,1557 assertions** (HTTP48/API30/
claim53/assignment37/completion69). Includes uncached workspace typecheck, Desktop
source build, Smithy Node/Vitest and Desktop Node integration. First gate191/191
and original baseline/intermediate fixture failures remain above.

After this gate, approved CLI sync included delivered documentation-only master
`24df339` (el-39znb). `git diff --exit-code 8cb6db3 HEAD -- packages apps scripts
package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json` passed: tested code,
tests, manifests and gate configuration are identical. No additional runtime gate
was run for that documentation-only addition; ancestry and diff checks passed.
Only this verification report changes afterward. Independent steward must review
this exact final source/documentation commit before approved CLI local delivery.
No worker merge approval, installed-app update or live-session maintenance is claimed.

### el-56khe independent rejection and corrected publication boundary

The preceding worker result is historical, not acceptance. Independent steward
review of `6937489e99cae471ab61678dfa3bf32989ca0d72` requested changes despite
191/191 gate (316.92s) and focused237/237. Its real SQLite/Git/HTTP/SessionManager
probe configured public `setOperationLog()` to throw after publication/persistence:
both routes returned500 and released assignment while their own provider handle
remained live. Original probe **0pass/2fail**, `/tmp/el-56khe-steward-probe.log`;
control disabling only release **2pass/0fail**,
`/tmp/el-56khe-steward-probe-control.log`. Original source/review are retained at
`/tmp/el-56khe-steward-probe.bun.test.ts` and `/tmp/el-56khe-steward-review.md`.
Worker reproduced **0pass/2fail** before this correction in
`/tmp/el-56khe-revision-baseline.log`. Default server constructors do not configure
this optional log; no live incidence claim is made. Director explicitly included
this narrow runtime/HTTP boundary in el-56khe.

Current start contract supersedes the earlier assumption that every rejected start
proves successful cleanup. Once publication and persistence finish, optional
`operationLog.write` failure emits an explicit stderr diagnostic including the
accepted internal session ID and the error, and returns the normal accepted receipt.
HTTP201 is accurate: the session was accepted and remains running. Only this
optional post-acceptance log is non-fatal; publication, persistence and notification
failures retain their existing rejection behavior. After this log, public receipt
construction only copies internal fields; there are no other awaited operations.
Listener installation now lies inside the exact-session startup rollback boundary.

If startup rollback rejects (provider termination or persistence/observability),
`SessionStartupCleanupError` carries the original error, rollback error and this
attempt's internal session ID. Both HTTP routes return500 with
`cleanup.assignment=retained-session-cleanup-incomplete`, exact `cleanup.sessionId`
and cleanup error. They do not release or rediscover a session by agent identity.
Even if the handle has exited, an unknown cleanup/persistence result conservatively
retains assignment. A still-pending rollback does not reach HTTP assignment release;
no new timeout/cancellation or automatic retry is introduced. Successful exact
rollback still permits receipt-bound conditional assignment release. All prior
CAS/version, Human/terminal/successor, completion/history and worktree protections
remain. Worktrees intentionally remain retained without exclusive deletion proof;
this change promises neither removal of all orphans nor live SDK termination.
Resume, other runtime callers, provider transport and general logger design are
outside this narrow correction.

Permanent adaptation of the steward probe lives in
`packages/smithy/src/api/http-session-start.steward-probe.bun.test.ts`:
16 tests across both real routes with temporary SQLite/local Git and real
SessionManager, mocked provider handles. They verify repeated accepted starts with
failing optional logging and persisted current identity, listener and publication
failure cleanup, persistence rollback success, termination failure, unknown rollback
persistence, repeated exact cleanup rejection, and actual successor SessionManager
starts during successful/failed rollback. Successor task/event snapshots and Git
resources survive. Existing HTTP48 suite now requires retention on failed termination
instead of incorrectly treating rejection as proof of completed rollback.

Verification so far: frozen install exit0 (lock unchanged); package typecheck exit0;
intermediate HTTP62/62 (772 assertions); final new probe16 plus SessionManager85
**101/101,375 assertions,exit0**, `/tmp/el-56khe-revision-runtime.log`.
Required final gate outcome and exact-final independent review follow separately.
No installed app, live agent/session/daemon/provider or maintenance operation.

### el-56khe corrected-boundary final worker gate

Source `9a689169101ec97d8aa7d96328edc7fc8bc4fbfd`, base/master24df339:
**pnpm check:merge192/192,exit0,304.48s**, single required run after correction.
Log `/tmp/el-56khe-revision-gate.log`; exact commands/results/per-step logs:
`$TMPDIR/stoneforge-merge-check-rKGCc3/results.json`.
Seven relevant suites in that gate: HTTP48 + new steward probe16 + explicit API30
+ SessionManager85 + dispatch53 + assignment37 + completion69 = **338/338,1930
assertions**. Smithy Node349/349 and Desktop Node6/6 passed, as did uncached workspace
typecheck and Desktop source build. Frozen install/package typecheck/diff/target
ancestry also passed. No gate or threshold modification; earlier failed probe/control
and previous gate results are retained. Only this verification text changes after
the passing source. Separate root build/lint/test, public docs build, browser/packaged
GUI, cross-platform and live-provider tests were not run. No installed/live changes.
Exact-final independent steward approval and approved CLI local delivery remain
required; this worker result is not a merge verdict.

### el-4bwuz integrated gate failure and handoff

Approved CLI sync with delivered `4c29bb0` produced `cdc223c`; only additive
lifecycle-report conflict resolution was needed, preserving both reports.
**Required integrated `pnpm check:merge`:189/190,exit1,313.94s — FAILED**.
Log `/tmp/el-4bwuz-gate-integrated.log`; exact results:
`$TMPDIR/stoneforge-merge-check-uVtHnx/results.json`.
Failing step131 is `packages/smithy/src/api/orchestrator-api.integration.bun.test.ts`:
`getDirector returns the director` fails during beforeEach registerWorker ->
createAgentChannel -> QuarryAPI.create with `UNIQUE constraint failed: elements.id`
(ALREADY_EXISTS), **26pass/1fail**. Its raw log is `131.log` in that directory.
This API/test/Quarry path is unchanged from delivered2bb427b; no evidence establishes
its collision cause or a Spawner regression. Dedicated follow-up **el-2zj6n** tracks
investigation. No production/threshold/retry change was made outside task scope.

Exactly one isolated diagnostic rerun of that suite with clean test environment
passed **27/27,92 assertions,exit0**, `/tmp/el-4bwuz-api-diagnostic.log`.
This is non-reproduction evidence, **not acceptance**, and does not supersede the
failed integrated gate. No third full gate was run to obtain a green result.
The earlier pre-integration190/190 pass remains historical evidence only.
Integrated focused Spawner/Claude37/37 and all Smithy Node/Vitest362/362 passed;
all other189 gate steps, including runtime/dispatch and Desktop, passed.

During the second gate master delivered documentation-only research24df339.
Approved CLI sync staged that conflict-free merge but reported a generic merge
failure; command-scoped Git author/committer configuration completed the existing
merge as `8377ed6`. Diff from tested cdc223c is exclusively under docs/, and current
master ancestry passes. This documentation merge does not cure the gate failure;
no untested production delta or unrelated fix was introduced.

Implementation and reports are committed/pushed; task is handed off rather than
completed because required acceptance is not green. Director must determine the
next acceptance/investigation step. Independent exact-final steward review and
approved CLI local merge are still required. No installed/live changes.

## CLI assignment failure cleanup — el-420pr

Baseline is delivered local master `24df339`; it includes the reviewed el-2hrsm
atomic explicit API, Spawner exact internal-ID termination and Claude cleanup
retry. No pending branch is copied. The historical el-2hrsm caller report above
remains baseline evidence; its CLI leak is addressed by this narrow follow-up.

The preparation order is unchanged: spawn first, then explicit assignment. A
successful spawn receipt gives this call its own internal session ID, so no
preparation-order change is needed. Only assignment rejection enters cleanup.
The CLI calls its own Spawner's `terminate(receipt.session.id, false)` once; it
never resolves an agent's current session, uses a provider ID, retries assignment,
or releases/rewrites task state. A throw after an assignment commit is ambiguous:
keep that assignment and all metadata/events, and stop only this call's process.
A successor with the same agent/provider ID remains untouched. Existing explicit
reassignment policy, history retention and completion claims are unchanged.

Force termination avoids waiting for provider interrupt before close. The existing
Spawner confirms exit or rejects; an additional 10-second CLI deadline bounds a
nonsettling cleanup promise. Timeout is not cancellation or proof of exit: cleanup
may still settle later against its captured internal ID. Cleanup failure reports
both the original assignment error first and a separate session-specific cleanup
error, always exit1. Successful cleanup rethrows the original failure through the
existing CLI formatter. No success output or stream begins after rejected assignment.
Spawn failure before a receipt remains the Spawner's responsibility; CLI has no
proven target to clean and neither assigns nor discovers another session.

New subprocess regressions run the real source CLI/parser/output/API against
isolated temporary SQLite, with child-only inert Spawner and API failure hooks.
They cover CAS competitor, Human, closed/deferred, same-agent successor with reused
provider ID, validation rejection, post-commit unknown outcome, cleanup throw,
unconfirmed exit, permanently pending cleanup, spawn failure, no-task start,
default/JSON/quiet success and failure, plus headless/interactive streaming.
All rejection cases compare complete winning task and event snapshots. These mocks
prove the caller boundary, not live provider termination; existing real Spawner
mock-provider regressions separately verify the delivered termination contract.
The older el-2hrsm CLI expectation now requires one own termination on rejection;
its successful-assignment control still requires zero terminations.

Evidence before production edits: **7 pass / 14 fail**, 105 assertions, real CLI
suite21 tests, `/tmp/el-420pr-baseline.log`. Every cleanup case leaked; all7 normal
start/stream/spawn-failure controls passed. Initial corrected CLI plus explicit API
suites: **51/51,323 assertions**, `/tmp/el-420pr-focused.log`. Frozen install exit0,
lock unchanged, `/tmp/el-420pr-install.log`. Required gate/final results follow.

No live provider, session, daemon, installed application or maintenance operation
is used. Independent exact-final steward review and approved CLI local delivery
remain required; worker verification is not merge approval.

Final worker verification on source `43d0115`, local target `24df339`:
- Final typed-validation CLI fixture: **21/21,134 assertions**, exit0,
  `/tmp/el-420pr-final-cli.log`.
- Required **pnpm check:merge191/191,exit0,318.46s**, one run,
  `/tmp/el-420pr-gate.log`; exact commands/results and per-step logs:
  `$TMPDIR/stoneforge-merge-check-8ab1Ct/results.json`.
- Relevant suites inside that gate: CLI21 + explicit API30 + SessionManager85 +
  dispatch-claim53 + completion69 = **258/258,1174 assertions**; Smithy Node/Vitest
  **349/349**, Desktop Node **6/6**. Workspace uncached typecheck and Desktop source
  build passed. Existing skips elsewhere are not passing coverage.
- Local target ancestry and `git diff --check` pass; only verification text changed
  after the gate. Separate root build/lint/test, public docs build, browser/packaged
  GUI, cross-platform and live-provider tests were not run. Gate is source
  acceptance, not an installed-app update or independent merge approval.

Initial commit attempt lacked Git identity; retried with command-scoped worker
identity, without global Git config changes. No implementation/test failures after
correction. Final documentation commit must receive exact-final independent review
before approved standalone CLI local delivery.

## el-56khe independent re-review — 2026-11-01, changes required

Safe sync of worker correction5cd4805 with local masterbdd07d4 produced
`a51bbb21800d64d237e4ced9d780673341b81223`. The approved operational CLI's build-info
and four supplied hashes matched. Only independent appended documentation sections
conflicted; both were preserved, with no reviewer production changes.

The former accepted-start operation-log defect is corrected. Recreated independent
real SQLite/Git/HTTP/SessionManager probes pass4/4 (66 assertions), checking both
routes, retained exact task/events after optional logging failure and no assignment
release while rollback is still pending. Original September /tmp evidence files
were absent; historical0/2 failure/control2/2 records above and in el-4aqnn remain.
Raw probe logs were not kept in the repository; key numbers are summarized in
`docs/workspace/http-session-start-review-20261101/README.md`.

**CHANGES REQUIRED:** the criterion "уже принятая/новая сессия не жертва cleanup"
still fails for overlapping starts. A assigns and awaits spawn; B passes the early
active-session precheck and commits its assignment; A publishes/persists and returns
HTTP201 before B calls the real SessionManager; B rejects with "already has an
active session" and its HTTP catch releases the matching task receipt. A's exact
session/handle remains running, but task.assignee is undefined. Publication changes
the agent rather than the task, so receipt-version CAS alone cannot fence this.
Normal-lifecycle probe **0pass/2fail,exit1**; no-release-only control **2pass/0fail,
exit0**. Both have24 assertions and use only isolated temporary SQLite/local Git
and inert provider handles. The scheduling hook adds no synthetic startup failure.

Required correction: make overlapping-start rejection distinct from positively
cleaned own-start failure, using an attempt-bound outcome/reservation boundary.
Do not adopt a current session/owner or parse error strings to decide cleanup.
Preserve positive release, incomplete rollback retention, error diagnostics,
Human/terminal/successor CAS, histories and intentional worktree retention. Add
both already-starting and already-accepted overlap schedules for both routes.
Full reproduction and gate/environment evidence are in the accompanying README.
No merge approval, installed-app update, live-session/provider or daemon changes.

Final re-review gate: **195 checks, 0 failed, duration=361.53s; exit0**,
repository-pinned Node22.23.3. Relevant345/345,1956 assertions; Smithy Node352/352;
Desktop Node17/17. Original ambient Node26 gate193/195,exit1,294.95s retained
(native ABI127/147 mismatch, tracked el-127xg; one fresh pinned run authorized).
Independent pinned probes4pass/2fail and no-release control2/2 still block approval.
No source/lock/gate changes; exact results and logs in the review evidence directory.

## el-56khe overlapping HTTP start correction — 2026-11-01

The independent CHANGES REQUIRED verdict above remains historical evidence. After
approved CLI hash verification, safe sync with delivered master `f1d707a` produced
`a476aac`; no pending branch was copied. The steward's portable overlap probe was
copied into `packages/smithy/src/api/http-session-start.concurrent.bun.test.ts`.
On that unmodified source, the accepted-session schedule again failed **0/2**
(24 assertions); the no-release-only attribution control passed **2/2**. Raw
logs were not kept in the repository; see the summary in
`docs/workspace/http-session-start-review-20261101/README.md`.
This control does not constitute a complete baseline checkout.

Chosen invariant: within one SessionManager, at most one HTTP start attempt for
an agent can enter the initial precheck, worktree preparation, assignment, spawn,
publication, notification and failure cleanup interval. A shared WeakMap keyed by
manager and agent acquires synchronously before the first await. Both route
factories use it, including multiple factories sharing the same manager. A
contender receives **409 SESSION_START_IN_PROGRESS** before acquiring any receipt
or resource. The owning request releases admission in finally, after any awaited
rollback/conditional assignment release. A later request then observes the normal
active-session check (**409 SESSION_EXISTS**) or can retry a failed start. Other
agents and independent managers are not serialized. This is an in-process HTTP
admission rule, not a cross-process lock or a redesign of CLI/daemon/resume runtime.
No successor lookup, owner adoption or exception-text matching is used for cleanup.

The earlier assignment receipt/CAS, optional accepted-start logging diagnostics,
exact-session incomplete-rollback retention, Human/terminal/successor preservation,
completion claims/history and intentional worktree retention are unchanged.
Worktrees are still retained because exclusive deletion ownership is unproven;
there is no claim that all orphan resources or live provider handles are removed.

The permanent adaptation keeps the independent published/pending rollback controls
(4 tests) and adds both starting/accepted schedules for SDK/app and mixed factory
pairs (8), pending provider rollback and conditional-release admission/retry (4),
early preparation/accepted notification failures (2), and unrelated-agent progress
(2). Real temporary SQLite, local Git, API/HTTP/SessionManager and inert provider
handles are used; no live workspace sessions, daemon or provider calls. The
accepted schedule retains the original timing hook, which is now unreachable for
the rejected contender. Whole task/event snapshots and registered worktree contents
remain unchanged by rejected attempts. Initial corrected result **20/20**,346
assertions; the final relevant and required-gate results follow below.

Final worker acceptance on source **ec28964836689f656595b4039965d5b203f2b6f4**:
- One required `pnpm check:merge` with pinned **Node v22.23.3**: **197/197,
  exit0,247.31s**, no retries. Raw gate log/results were not committed
  (original temporary directory `$TMPDIR/stoneforge-merge-check-wVdRoI`);
  summary in `docs/workspace/http-session-start-review-20261101/README.md`.
- Eight focused suites separately and again inside gate: **365/365,2302 assertions**
  (HTTP48+overlap20+publication16+API30+SessionManager92+dispatch53+assignment37+
  completion69). Prior independent publication/pending controls remain4/4.
- Gate uncached typecheck, Desktop source build, Smithy Node/Vitest **352/352** and
  Desktop Node **17/17** pass. Frozen install with pnpm8.15.5 exit0, lock unchanged.
- Original steward evidence26 SHA256 entries verified unchanged. Baseline0/2 and
  no-release control2/2 remain historical failures/controls, not erased by this run.
- `git diff --check`, delivered masterf1d707a ancestry and no post-gate source/config
  diff pass. Only verification documentation/evidence is added after ec28964.
  Both author and committer use command-local Ilya Rubinchik <ilya@r-4k.com>.

Separate root build/lint/test, public docs build, browser/packaged GUI, cross-platform
and live-provider checks were not run. Existing skips are not passing coverage.
No installed app change, live-session/provider/daemon test or maintenance operation.
Independent exact-final steward approval and approved CLI local delivery remain
required; worker verification/completion is not merge approval.


## el-4bwuz continuation after blocker delivery — 2026-11-01

The blocker el-2zj6n was independently approved at
5993051c3ce94789217c8ee348d0e2b7b7afd65b and delivered to local master
f1d707a3150578d8ec0c66372a5b485a3506e75c. The approved installed operational
CLI's build-info and all four Director-pinned hashes matched before use.
Command-local Human-approved author/committer identity was used, without Git
configuration changes. `sf task sync el-4bwuz` merged the delivered target;
the sole conflict was additive lifecycle-report content. Both reports were
preserved in integration ae335530db54f96912de0e26df77880a82160fe8.

The original cleanup implementation and its two regression suites are retained.
Relative to delivered master, production changes remain confined to Spawner;
Claude adapter and SessionManager have no task-specific changes. Review of their
current stop/close paths confirms the same captured-handle retry and persistence
contract. Existing five-second retention, natural persisted SessionManager
shortcut, and lack of universal external-process cleanup confirmation still apply.
The baseline9fail/28pass and old integrated189/190 failure remain historical
evidence; delivered collision correction does not prove the old exact incident's
cause.

Validation uses repository-pinned Node **v22.23.3** first on PATH:
`export PATH="$PWD/apps/desktop/node_modules/node/bin:$PATH"; node -v`.
No native rebuild, global Node change, installed-app modification or live
provider/session/daemon fixture was used. Frozen install succeeded, lockfile
unchanged (`/tmp/el-4bwuz-20261101-install.log`).
Focused command, using the gate's isolated environment:
`pnpm --filter @stoneforge/smithy test:node src/runtime/spawner-terminate.test.ts src/providers/claude/headless-close.test.ts`
passed **37/37**, including actual Spawner/Claude/SessionManager with isolated
SDKQuery and SQLite; log `/tmp/el-4bwuz-20261101-focused.log`.

One authorized integrated `pnpm check:merge` on ae335530: **194/194, exit0,
250.22s**, with Node v22.23.3 recorded in
`/tmp/el-4bwuz-20261101-runtime.log`. Full log:
`/tmp/el-4bwuz-20261101-gate.log`; exact commands, timings and per-step logs:
`$TMPDIR/stoneforge-merge-check-j11T99/results.json`.
Includes uncached typecheck17/17, collision7/7, original API27/27,
Claude17/17, Spawner77/77, SessionManager92/92, dispatch-claim53/53,
Smithy Node365/365 (including focused37), Desktop build and Node17/17.
The four relevant Bun suites total239 passes. No retry-until-green,
gate/threshold change or additional implementation was performed.
Local target remains f1d707a; ancestry and focused diff checks pass.

This continuation adds only verification documentation after the tested integration.
Separate root build/lint/test, packaged GUI, cross-platform and live-provider
runs were omitted; the required gate ran its declared checks. Historical failed
acceptance and isolated non-reproduction remain preserved. Independent steward
review of the exact final commit and approved CLI local merge are still required;
worker completion is not merge approval or an installed-app update.


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
  $TMPDIR/stoneforge-merge-check-Nm4A9d/results.json.

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


## el-56khe worker correction — incomplete startup protection across retries (2026-11-01)

Continues independent CHANGES REQUIRED on `2dcba6861d3fdf4b6940710b0964def0dae38dc3`.
The previous gate197/197, publication/overlap passes and new retry0/2/control2/2
remain historical evidence, not approval. Current branch already contains delivered
master `1b43de2`; no pending branch is copied and no target checkout is edited.

The exact steward retry probe was copied into the API test directory (only its
relative API import repaired) before production edits. Under pinned Node22.23.3
PATH and the gate's sanitized checkEnvironment(), baseline again failed0/2,
28assertions; no-release-only control passed2/2,28assertions. Raw logs and the
probe source were not kept in the repository; see `docs/workspace/http-session-start-review-20261101/README.md`.

Chosen invariant: a manager/agent HTTP admission may be reopened only when its
attempt exits without an incomplete-cleanup receipt. SessionStartupCleanupError
keeps the reservation, holding only that attempt's exact internal session ID.
Both HTTP factories return409 SESSION_START_CLEANUP_INCOMPLETE with that ID on
later requests, before any agent/session precheck, task assignment, preparation,
spawn, notification or cleanup. No successor identity is looked up/adopted; no
message matching, task-version refresh, local terminated-status check or missing
active mapping substitutes for a cleanup receipt. The original500 and primary/
cleanup diagnostics remain. Successful starts, early returns and completed startup
rollback still release admission and preserve existing successful retry behavior.

Conservative availability limit: retained admission lasts for that SessionManager
instance's lifetime, including after a separately requested exact-session stop.
This HTTP boundary has no cleanup-completion notification and adds no timeout,
reset endpoint, automatic retry or recovery mechanism. Recreating route factories
with the same manager does not unlock it. Process restart/replacement is not a
proof of provider termination and is not recommended here as automatic recovery;
external cleanup/recovery must be established separately. CLI/daemon/resume,
multiple managers/processes and crash recovery remain outside this in-process
HTTP invariant. No broad runtime/provider redesign is included.

Worktrees remain intentionally retained: neither an unassigned task nor a failed
session start proves exclusive deletion ownership. Reusable/successor data stays
on disk and registered in Git; universal orphan deletion is not promised. Existing
conditional assignment CAS, Human/terminal/successor decisions, completion claims,
status/branch/history and accepted-session logging behavior remain unchanged.

The real SQLite(two connections)/local Git/API/HTTP/SessionManager concurrent suite
now has30 cases (previous20 plus10). Added coverage: both factories, repeated same/
mixed-factory retries after failed termination or unknown rollback persistence,
no precheck lookup, full task/events/registry/resources preservation, live successor
protection, unrelated-agent progress, taskless incomplete startup followed by an
assignment request, and explicit conservative retention after a later exact stop.
Only provider handles and timing/fault boundaries are isolated fixtures; no inert
startSession throw mock is used for these regressions. Existing completed-rollback
retry, overlap, publication and R1/R2 coverage is retained.

Verification so far: pnpm install --frozen-lockfile exit0 (lock unchanged);
eight relevant suites375/375,2550assertions, each in a fresh sanitized subprocess:
HTTP48, concurrent30, publication16, API assignment30, SessionManager92, dispatch53,
assignment service37, completion69. One final pinned-runtime pnpm check:merge follows. Independent exact-final steward review remains required;
this worker record is not merge approval. No installed-app/live-session/daemon or
maintenance operations occurred. Separate root build/lint/test, public docs/browser/
packaged GUI, cross-platform and live-provider runs are omitted; gate commands
and results will be recorded, and skips are not passing coverage.


### Final worker verification of retry correction

Source commit **ecb6ce9d4508e66f7691c3c762b5a61ebdd1a640** (author and committer
both command-scoped Ilya Rubinchik <ilya@r-4k.com>), already pushed on the assigned
branch. Local master remains1b43de2 and is an ancestor; no sync/delivery needed
or attempted in this worker session. Final documentation/evidence commit follows;
production/tests/gate/manifests/lock remain byte-identical to tested source.

One required `pnpm check:merge`: **197/197, exit0,245.49s**, explicit pinned
**Node v22.23.3** first on PATH. It includes uncached17/17 workspace typecheck,
Desktop source build, all isolated declared Bun checks, focused375/375,
Smithy Node/Vitest365/365 and Desktop Node17/17. Eight focused suites also passed
separately375/375,2550assertions. No retry, gate change or native rebuild.

Raw evidence (baseline0/2 and no-release-control2/2 logs/source, eight focused
logs, reproduction runner, gate log/results and per-command logs) was not kept in
the repository; key numbers are in `docs/workspace/http-session-start-review-20261101/README.md`. Original gate location:
`$TMPDIR/stoneforge-merge-check-P8Z98W`.
All75 historical evidence hashes verified unchanged. No prior failure/control or
completion/history record is overwritten. Source diff whitespace check passes;
raw captured log whitespace remains intentionally verbatim.

This is worker verification, **not independent merge approval**. Complete through
the normal task lifecycle for a new exact-final steward review and approved CLI
local delivery. The explicit manager-lifetime admission retention limitation above
remains; no automatic recovery, universal orphan deletion or cross-process fencing
is claimed. No installed application, live provider/session/daemon or maintenance
changes. Omitted checks remain as listed above.


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

Original gate results: $TMPDIR/stoneforge-merge-check-thsMOB/results.json.
Raw gate logs, results, the isolated diagnostic and the probe source/logs were
not kept in the repository; key numbers are in `docs/workspace/http-session-start-review-20261101/README.md`. The probe's scenarios are
covered by the permanent `packages/smithy/src/api/http-session-start.concurrent.bun.test.ts`.

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

## Spawn failure after provider handle acquisition — el-4f7pc9, 2026-11-01

Steward observation from el-56khe re-review, reproduced before any fix. Spawner
`spawn()` rejects without returning a session, so its caller (SessionManager, CLI)
cannot terminate the internal session. Before this change two paths orphaned an
already acquired provider handle:

- **Headless**: `waitForInit` rejection after `headlessProvider.spawn()` returned —
  init timeout on a silent stream, resume failure (`error_during_execution` with an
  open stream) or stream end before init — marked the session terminated but never
  called `HeadlessSession.close()`. For Claude, `close()` is what releases the SDK
  query/subprocess (el-1mo5c); the reader loop also stayed blocked on a silent
  stream, so the five-second retention timer was never scheduled.
- **Interactive**: an exception after `interactiveProvider.spawn()` returned
  (`getSessionId`, `onData`/`onExit` registration, transition) never called `kill()`.

Fix (Spawner only): the headless catch calls the shared `closeHeadlessSession()`
latch once (no interrupt), so an earlier automatic close (provider `error` message)
is not repeated; the interactive catch calls `kill()` only if exit was not already
observed. Cleanup errors are logged (`spawner` warn) and never replace the original
spawn error. A thrown headless close leaves the latch unset, so an explicit
`terminate(id)` on the retained terminated session retries close (el-4bwuz).
Retention, termination confirmation, SessionManager, providers and el-56khe HTTP
admission/receipt behavior are unchanged. A successful `close()`/`kill()` is the
cleanup request contract, not proof that every external process stopped.

Evidence: `packages/smithy/src/runtime/spawner-init-cleanup.test.ts` (Vitest, real
Spawner, inert mocked handles). Baseline on unmodified source: 7 fail / 3 pass
(`/tmp/el-4f7pc9-repro-baseline.keep.log`); with fix 10/10, focused
spawner-terminate + Claude headless-close + new file 47/47; Bun spawner77/77,
SessionManager92/92; smithy typecheck exit0. One pinned-Node (v22.23.3) `pnpm
check:merge` on 30789ab: **194/194, exit0, 325.87s** (Smithy Node 375/375), log
`/tmp/el-4f7pc9-gate.log`. Root build/lint, Playwright, packaged GUI and live
providers were not run. Independent steward review and approved local delivery
remain required; installed Desktop unchanged.

## SDK startTask guard — el-2htch, 2026-11-01

Supersedes **only** the el-191a6 `start, R1` / `start, R2` matrix rows and follow-up
proposal 5 above. Those historical measurements remain evidence of the original
defect (IN_PROGRESS with stale A metadata/session over CLOSED, DEFERRED, Human and
successor B; R2 also restored A as assignee and reverted schedule/closure fields).
Base: local master `02511ed` (el-56khe delivered), fast-forward safe sync, no
conflicts. The el-56khe HTTP receipt/release contracts are not touched.

Reachability is unchanged: repository search still finds **no production caller**
of `TaskAssignmentService.startTask`; daemon and start-worker flows use
`assignToAgent(..., { markAsStarted: true })`. No user-facing start incident was
reproduced or is claimed fixed. The Smithy HTTP route `POST /api/tasks/:id/start`
(dashboard "Start Task") does **not** call this method; it is a separate direct
status writer without CAS or assignment checks and is unchanged (reported to
Director, not in scope).

### Contract

`startTask(taskId, options?: StartTaskOptions | string)`:

- Supported statuses: OPEN and IN_PROGRESS. CLOSED, DEFERRED, REVIEW, BACKLOG,
  BLOCKED and TOMBSTONE reject.
- Current assignment: `assignee` must be set, equal `orchestrator.assignedAgent`
  and resolve to a registered agent entity. Unassigned, split (e.g. Human assignee
  over agent metadata) and coherent Human/non-agent ownership reject.
- Caller identity, object form `{ agentId, sessionId? }`: `agentId` is required and
  must equal the current assignee. It is a stale-call guard, not authentication.
- Legacy positional form `startTask(taskId, sessionId?)` is retained for the
  documented assign-then-start call. It makes **no caller assertion**: after a
  committed explicit reassignment it can start successor B's own coherent
  assignment (status/startedAt only), but cannot change B's owner, session or
  history. Same state guards and CAS apply. Actor is recorded only for the object
  form; the legacy form keeps Quarry's default actor.
- Session: a supplied non-empty `sessionId` is recorded only when
  `orchestrator.sessionId` is unset; an equal value is accepted; a different
  recorded session rejects (start never replaces a session). `sessionHistory`,
  `handoffHistory`, branch and worktree are never modified by start.
- Write: status IN_PROGRESS, startedAt and the session in **one** Quarry update
  with `expectedUpdatedAt` from the validated snapshot (existing Quarry CAS, no new
  helper or framework). Conflicts propagate as CONCURRENT_MODIFICATION; no retry
  against a newer snapshot. All guard rejections use the same ConflictError code
  as handoff/completion and perform no write.

Intentional compatibility changes: an **unassigned** task no longer starts (the old
unit test "starts task without session ID" relied on that and now assigns first;
a new test asserts the rejection); a supplied empty/whitespace session now rejects
instead of being ignored; replacing a different recorded session now rejects
(`updateSessionId`, an unchanged legacy writer, remains the explicit replacement
API). The interface accepts both forms, so existing positional call sites compile.

### Evidence

`task-lifecycle-race-evidence.bun.test.ts` (two real QuarryAPI connections to one
temporary SQLite file, Git repo fixture; no timers/providers/daemon/live data):

- The 8 former `DEFECT evidence: start …` rows are converted to `REGRESSION: start
  rejects and preserves {closed,deferred,reassign,human} at read {1,2}` and 8 new
  `start-legacy` rows run the positional form at the same boundaries. Each asserts
  exactly one attempted task write, CONCURRENT_MODIFICATION, full winner equality
  via the other connection (histories, schedule, closure, version), unchanged
  events and absence from the unassigned ready pool. The start input is changed
  from `'stale-session'` to `{ agentId: owner, sessionId: 'provider-old' }`, valid
  against the stale snapshot, so only the version check can reject. The original
  `'stale-session'` input is kept as a separate regression: both forms now reject
  before any write. The defect-only assertion branch is removed because no DEFECT
  rows remain in this matrix; the historical results remain in this report.
- Sequential (fresh-read) stale-owner regressions after committed CLOSED,
  DEFERRED, B, Human, REVIEW, unassigned and coherent non-agent ownership: zero
  writes, winner and events unchanged.
- Positive: current assigned worker starts an OPEN assignment with one write,
  records the session, keeps both histories/branch/worktree; same-session restart
  accepted. Legacy contract test as described above.
- `task-assignment-service.bun.test.ts`: legacy assign-then-start with and without
  session, object-form positive, unassigned rejection, other agent/empty caller/
  replaced session/inactive statuses reject with unchanged task.

Negative control (no branch switch): only the service file was temporarily
replaced with `git show master:` content, `bun test … -t start` ran, and the fixed
file was restored and verified with `cmp`: **0 pass / 26 fail**, exit 1. The 24
REGRESSION rows fail on the old overwrite behavior; POSITIVE and CONTRACT fail
because the old method stores the options object as session / replaces the
recorded session. Log `/tmp/el-2htch-negative.log`.

Not changed: automatic dispatch, assignment, completion, handoff, unassign,
`updateSessionId`, the HTTP start route and other metadata writers. No storage,
gate, threshold or configuration changes; installed Desktop5f53cef, live
daemon/sessions/tasks and closed maintenance el-1clm untouched.

### el-2htch worker verification

- Runtime: `node -v` **v22.23.3** (pinned `apps/desktop/node_modules/node/bin` first
  on PATH), pnpm 8.15.5, Bun 1.3.11, macOS arm64. `pnpm install --frozen-lockfile`
  exit 0, lockfile unchanged.
- Focused: `bun test` evidence + assignment + handoff-ownership suites **170 pass /
  0 fail, 919 assertions** (`/tmp/el-2htch-focused.log`); evidence suite alone 91/91.
  `pnpm --filter @stoneforge/smithy typecheck` exit 0.
- Negative control: 0/26 on old service (above).
- One required `pnpm check:merge` on source commit `8c87adc`: **199/199, exit 0,
  425.67 s**; evidence step 91/91 (492 assertions), Smithy Node/Vitest 365/365,
  Desktop Node 17/17. No retries, skipped steps, threshold or gate changes. Log
  `/tmp/el-2htch-gate.log`. Only this documentation changed after the gate.
- Not run: root build/lint/test separately, Quarry Node, browser/Playwright,
  packaged Desktop, live providers. Commits use the Human-approved command-scoped
  identity; no Git config written. Independent exact-final steward review and
  approved CLI local delivery remain required; worker does not self-approve.
- Review rework after steward el-5qra review of `e82e500`: removed a machine-local
  results path from this section; synced with local master `5d28744` through the
  approved CLI (`sf task sync`), keeping master's el-4f7pc9 section and this one
  (additive doc conflict only; `task-assignment-service.ts` merged cleanly).
  Post-sync focused suites 170/170 (919 assertions), Smithy typecheck exit 0 on Node
  22.23.3. The single post-sync pinned-Node `pnpm check:merge` runs on the commit that
  adds this note; its result is recorded in the task completion and the
  Documentation Directory rather than in a later tracked commit, so the gated commit
  is the final commit.
