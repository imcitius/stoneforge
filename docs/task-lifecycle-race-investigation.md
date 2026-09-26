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
