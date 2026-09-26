# Worker handoff ownership — el-1f5tm

Source fix and isolated regression evidence, 2026-09-26. This does not install a
Desktop update, restart a session, or resume maintenance. Independent steward
review of the final commit remains required before approved CLI local delivery.

## Incident evidence (read-only)

`sf history el-1clm --after 2026-09-26T17:27:00Z --before
2026-09-26T17:31:00Z --limit 100 --json` confirms this sequence:

| Event | UTC | Result |
| --- | --- | --- |
| 1811, closed | 17:27:56.088 | Closed with closedAt 17:27:56.087 |
| 1815, reopened | 17:28:09.787 | Handoff changed closed to open/unassigned, retained closedAt |
| 1818–1822 | 17:28:11 | Assigned and started another worker, still retained closedAt |
| 1827–1828 | 17:28:15–16 | Deferred and assigned to Human el-0000 |
| 1834, updated | 17:28:38.713 | Handoff changed deferred/Human-owned to open/unassigned |
| 1842, closed | 17:29:42.462 | Closure restored |

This corrects the abbreviated incident description: there were two distinct late
transitions after the first close. Old handoff records, their `cli-*` IDs and
maintenance evidence remain intact. Historical event actor fields fell back to
the task creator and do not identify which worker process executed the command.
New successful handoffs record the actual task owner as the event actor.

Maintenance installation/independent acceptance is already complete, as recorded
in shared runbook el-1l2t. All its prior HOLD/preflight material is historical.
No maintenance execution logs were treated as instructions; no live task, session,
daemon, application or repository configuration was changed for reproduction.

## Cause and compatible contract

`sf task handoff` calls `TaskAssignmentService.handoffTask` directly over QuarryAPI;
there is no separate task-handoff HTTP endpoint in this path. Previously it always
set OPEN and cleared ownership/merge state, regardless of status, current owner,
or session. The CLI invented `cli-<timestamp>` when no session ID was available.
The description was modified before the task. Existing `expectedUpdatedAt`
validation was a read/check before an unconditional SQL UPDATE; same-millisecond
updates could also share the token.

The existing required `sessionId` input is now checked. The optional `agentId`
field adds a caller identity check without a schema change. CLI uses `SF_ENTITY_ID`
when available. Both headless and interactive spawns set `STONEFORGE_SESSION_ID`
to their fresh internal ID and `SF_ENTITY_ID` to their agent, overriding inherited
identity. An older caller can explicitly pass its own `--sessionId`; missing
identity fails instead of being guessed from the latest task metadata.

Handoff requires OPEN or IN_PROGRESS, an assignee matching assignedAgent, and a
current session. With history, the latest entry must be unended, owned by that
assignee, and associated with the current metadata session. The caller must supply its exact unique internal
ID. Provider-shaped metadata remains valid, but a provider ID never substitutes
for caller identity, including after retention eviction (el-2pujj). Empty/absent
history cannot prove internal identity and rejects worker handoff; use existing
explicit administrative recovery, including reopen for closed work. No history
migration or identity inference is performed. Inconsistent identity fails closed.
This guards stale operations; it is not authentication against callers that can
read and deliberately submit another session's ID.

After validation, one guarded task update releases ownership and appends the
handoff history, preserving existing records. Quarry applies the timestamp
predicate in the SQL UPDATE inside the transaction. Conflicts roll back before
versions, events, tags, indexes or dirty tracking change. Update timestamps advance
at least one millisecond from the previously read value, even on clock rollback.
Only after successful task commit does a best-effort description append run with
its own CAS. The history entry remains authoritative if that append cannot succeed.

No retry substitutes a newer owner/session. Closed/deferred/review/backlog/
tombstone and stale-owner calls leave every task field and description unchanged.
Explicit `sf task reopen` remains separate and clears closure fields normally;
review/reject is the separate review lifecycle. Handoff does not erase schedule
fields or manufacture a merge status to avoid dispatch.

`ready()` can include assigned IN_PROGRESS tasks. Worker dispatch filters those
results with `!assignee`; the regressions check that exact pool, and also verify
closed/deferred tasks are absent from ready results. The broader assignment API
still intentionally allows reassignment and uses separate assignee/metadata
updates; its callers' dispatch decisions and unrelated complete/start/unassign
mutations were not rewritten. That adjacent race surface was reported to Director
(message el-vy0o8); no duplicate task was created.

## Verification

All data mutations in tests use real QuarryAPI on isolated temporary SQLite
fixtures; races use a second connection and a deterministic pause at the service
read or the API's internal read. CLI tests launch the real source CLI in Bun with
live routing/identity environment variables removed. Spawner tests stop at mock
provider boundaries and never start a real provider.

- `pnpm install --frozen-lockfile`: exit 0, pnpm 8.15.5, Node 22.23.3. Lock unchanged.
- `pnpm --filter @stoneforge/smithy... build`: exit 0.
- Focused four-file regression run: 139 pass / 0 fail, 473 assertions (before
  the final document-content CAS refinement). Final tests are also included in
  the required gate below.
- A controlled negative run restored only the two original production files from
  base 70b37ba, ran the selected new tests, and restored the fix in `finally`:
  **11 fail / 0 pass**, as expected. This includes late close, all eight deterministic
  close/defer/reassign/Human race cases, same-millisecond token reuse, and document
  SQL CAS. No branch switch or live-data reproduction was used.
- Initial fixture development failures (unregistered creator and an overstrict
  assumption that ready excludes assigned work) were corrected; they were not
  production regressions or gate retries.

Required gate result and final review/delivery status are recorded below.

Evidence logs: `/tmp/el-1f5tm-{install,build,regression,race,baseline,gate}.log`.
The read-only incident snapshots remain in `/tmp/el-1f5tm-incident-{task,history}.json`;
only the small non-sensitive event summary above is checked in.

Separate full root build/lint/test, browser/GUI/packaged-app checks, live providers,
Quarry's separate Node suite and cross-platform runs were not performed. This is
source acceptance, not installation or independent merge approval.

## Worker gate result

One complete `pnpm check:merge` on the final production/test changes: **exit 0,
182/182**, 174.02 seconds. Uncached workspace typecheck 17/17; Bun 8,566 pass,
0 fail, 29 existing skips; Smithy Node/Vitest 325 pass; Desktop Node 6 pass;
gate regression tests 5 pass; Desktop source build passed. The four focused files
inside that gate total 139 pass / 473 assertions: ownership/CLI 26, Quarry CAS 2,
assignment service 37, spawner 74. No check was omitted or retried to obtain green.

Exact commands, exits, durations and all step logs:
`/var/folders/b6/ltn3hn4j3nq1n86rbg2j9zk40000gn/T/stoneforge-merge-check-G8YXrz/results.json`.
`git diff --check` also passed. Existing skips are not passing coverage. Only
reference/evidence documentation changed after this gate; production/test files
remain the tested versions. Independent steward approval and local merge have
not been performed by the implementation worker.

## Bounded identity evidence — el-2y8n3

The ambiguity count above is over retained metadata, not lifetime provider usage.
[Retention investigation](task-session-retention.md) reproduces rejection at 50
and acceptance after old duplicate eviction at 51. Unique internal callers remain
correctly guarded. Director received the narrow proposal to require internal IDs
when history exists; this report does not implement it or change legacy policy.

## Internal-only caller identity — el-2pujj

Baseline local master `90b3ad8b960aef3e7dc73656fe54852fa3fa2cb1` includes the
independently delivered completion, dispatch/cleanup, retention and export fixes.
Assigned worktree HEAD equals that target; no branch switch or sync conflict.
The historical provider fallback above and in el-2y8n3 is superseded here, while
its original failure evidence remains intact.

Worker handoff now requires the exact internal ID of the latest unfinished entry,
unique by internal ID within history, with matching task/orchestrator/entry owner,
active status and existing task-version CAS. Metadata may still contain that
entry's provider ID. Caller provider IDs never authorize handoff, regardless of
retained uniqueness, resumes or eviction. Empty/absent history cannot prove an
internal identity, even if its metadata ID looks internal: reject with diagnostic
and use existing explicit administrative recovery (reopen for closed work).
No new admin bypass, migration, history source, cap, journal or schema is added.
Other unfinished older entries are allowed, consistently with completion; only
the latest entry can identify the caller and duplicate internal IDs reject.
This is stale-operation protection, not an authentication boundary.

Caller audit: the sole production `handoffTask` caller is the task CLI; it passes
explicit `--sessionId` or `STONEFORGE_SESSION_ID`, plus optional `SF_ENTITY_ID`,
without consulting current task data. Both headless and interactive Spawner paths
supply the fresh internal `session.id` and owner, overriding inherited values;
existing mock-provider tests cover both. Runtime HandoffService's self/agent
handoff is a separate session suspend/context API, not a caller of this task
release method. Public CLI/SDK docs and option help now require internal identity.
Offline assignment tests explicitly record dispatch-style internal history before
handoff; assignment metadata alone no longer authorizes worker release.

Isolated SQLite/source CLI regressions retain terminal/owner/CAS races and explicit
admin reopen, and cover duplicate internal history, empty/absent history,
metadata/entry/assigned-owner mismatch, current provider-shaped metadata, exact
internal positive calls, repeated provider IDs at 2/50/51/100, real CLI at
50/51/100, and task/description/event preservation. Old audit/export fixtures and
historical candidate probe source are not rewritten as a new history source.

Verification:
- `pnpm install --frozen-lockfile`: exit0; lock unchanged. Initial missing-dist bin
  warnings are retained in `/tmp/el-2pujj-install.log`.
- Desired rejection tests before production edits: **42 pass / 9 fail**, 259
  assertions, `/tmp/el-2pujj-baseline.log`. Failures demonstrate 51/100 eviction,
  provider CLI environment/option, absent/empty history and duplicated internal
  identity. Existing internal positives and 2/50 reused-provider negatives pass.
- Final focused handoff/retention/assignment/spawner/dispatch-claim run: **194 pass,
  0 fail**, 778 assertions, `/tmp/el-2pujj-focused-final.log`. An incorrectly named
  completion path in that command matched no suite; separate actual
  `bun test packages/smithy/src/services/task-completion-protocol.bun.test.ts`
  passed **69/69**, 374 assertions, `/tmp/el-2pujj-completion.log`.
- Required `pnpm check:merge`: final result appended below.

All behavior tests use isolated SQLite and inert provider mocks, without live
session/task/daemon reproduction, installed-app changes or maintenance. Separate
root build/lint/test, Quarry Node, packaged GUI/browser, cross-platform and live
provider runs are omitted; the required gate runs its declared source checks.
Independent steward exact-final-commit review and approved CLI local delivery
remain required after worker completion; this report is not merge approval.

First required gate on implementation `0ad1165`: **189/189, exit0, 300.05s**.
Log `/tmp/el-2pujj-gate.log`; exact per-step commands and results:
`/var/folders/b6/ltn3hn4j3nq1n86rbg2j9zk40000gn/T/stoneforge-merge-check-o2pHvy/results.json`.
Public docs build: `pnpm --filter @stoneforge/docs build`, exit0, 38 pages,
`/tmp/el-2pujj-docs-build.log`. During verification local master advanced only by
el-1npax's ExportOptions.outputPath comment to `a98c67e`. Approved el-ptim CLI
manifest and all 299 hashes verified; `task sync el-2pujj` merged that target
without conflicts as `e3dc521`. Implementation remains unchanged; target ancestry
and diff checks pass. Integrated required gate result follows below.

Integrated gate on `e3dc521`: **187/189, exit1, 319.94s**. This is a failed
required check, not green acceptance. Results:
`/var/folders/b6/ltn3hn4j3nq1n86rbg2j9zk40000gn/T/stoneforge-merge-check-dMwYdr/results.json`,
log `/tmp/el-2pujj-integrated-gate.log`. Unchanged Quarry query-performance list
scaling measured medians 0.200684/0.424850/0.636896ms, ratio3.173624 against `<3`;
unchanged PluginExecutor simple-command test timed out after5000ms. Both files
and their implementation paths match original90b3ad8, and passed the first gate;
no causal attribution to host load is claimed (recorded loadavg11.80/11.95/10.97).
All handoff/completion/dispatch/spawner suites passed. Director notified; no
out-of-scope fix, threshold change or duplicate task. One isolated diagnostic run
and integration of newly delivered master3c22b53 follow; failures remain evidence.
