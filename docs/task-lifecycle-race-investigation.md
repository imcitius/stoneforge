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
  `/var/folders/b6/ltn3hn4j3nq1n86rbg2j9zk40000gn/T/stoneforge-merge-check-zePClv/results.json`.
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
`/var/folders/b6/ltn3hn4j3nq1n86rbg2j9zk40000gn/T/stoneforge-merge-check-yaJkik/results.json`.
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
`/var/folders/b6/ltn3hn4j3nq1n86rbg2j9zk40000gn/T/stoneforge-merge-check-VRcL9Z/results.json`.
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
`/var/folders/b6/ltn3hn4j3nq1n86rbg2j9zk40000gn/T/stoneforge-merge-check-hpL0d0/results.json`.
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

Two deterministic reject/preserve probes are preserved as
`docs/workspace/dispatch-claim-contract-probes.patch`. They assert the desired
safe behavior, **not unsafe behavior as a passing norm**. Apply this patch in an
isolated worktree, run the lifecycle evidence file with `bun test <file> -t SCOPE:`,
then reverse the patch. It appends to the existing real temporary two-connection
SQLite fixture. Session startup/termination use only an isolated spawner mock,
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
contract, as are unresolved stale start/dispatch writers listed above and the legacy SDK
OrchestratorAPI.assignTaskToAgent metadata snapshot write. These can still replace
metadata outside this protocol; they require separate fixes, reported to Director.

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
`/var/folders/b6/ltn3hn4j3nq1n86rbg2j9zk40000gn/T/stoneforge-merge-check-btk0at/results.json`.
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
`/var/folders/b6/ltn3hn4j3nq1n86rbg2j9zk40000gn/T/stoneforge-merge-check-sGhU4A/results.json`.
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
`/var/folders/b6/ltn3hn4j3nq1n86rbg2j9zk40000gn/T/stoneforge-merge-check-5wSjK1/results.json`.
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
`/var/folders/b6/ltn3hn4j3nq1n86rbg2j9zk40000gn/T/stoneforge-merge-check-06UZVT/results.json`.
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
`/var/folders/b6/ltn3hn4j3nq1n86rbg2j9zk40000gn/T/stoneforge-merge-check-HEkiPi/results.json`.
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
`/var/folders/b6/ltn3hn4j3nq1n86rbg2j9zk40000gn/T/stoneforge-merge-check-YYVnWC/results.json`.
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
`/var/folders/b6/ltn3hn4j3nq1n86rbg2j9zk40000gn/T/stoneforge-merge-check-g8qBfX/results.json`.
Only unchanged Quarry list scaling failed: ratio3.559304857848077 against `<3`.
The test/implementation were not edited by this task; the previously documented
failure class remains unresolved, without a causal attribution to host load.
All dispatch, lifecycle, typecheck, Node and Desktop source checks passed.
Director notified. This failed gate is retained, not described as green acceptance.
During the run local master advanced to delivered handoff fix `beac945`; the
approved CLI's manifest and all299 hashes were verified before integrating it.
