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
in `completionHistory`. Both operation records and full session history survive
assignment/reassignment, reopen and reset; pending claims cannot be erased by
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
