# Task session history: retention, audit and recovery — el-2y8n3

Current integration: accepted local master `3420c56` now includes el-20qt0.
The historical baseline and pending-candidate results below are preserved; see
the final integration section for checks on the delivered completion protocol.

Worker investigation, 2026-09-26. Accepted baseline: local core/master
`f30b41ad841d1cea6ca5d274403baba950a85a0d`. Approved el-ptim CLI's 299
manifest hashes matched; `task sync el-2y8n3` succeeded without conflicts.
No retention, production behavior, schema, installed app, daemon or maintenance
changes. The only production-source edit corrects an inaccurate type comment.
Pending el-20qt0 source `41381df` is inspected/probed separately, not delivered
or approved by this investigation. Other lifecycle work el-1q2vv/el-2htch/el-2hrsm
is outside scope; historical lifecycle evidence remains valid at its named revision.

## Exact bounded metadata contract

`packages/smithy/src/types/task-meta.ts:373–421` defines a private cap of 50.
`appendTaskSessionHistory` copies the existing array plus the new entry, then
`slice(-50)`: insertion order, not chronological sorting, no deduplication,
no active-entry or claim-reference exemption. Oversized input is truncated on
append; raw metadata writes and close alone do not enforce the cap. Other metadata
is preserved. `closeTaskSessionHistory` updates every matching unended internal
`sessionId`; missing/evicted IDs are a silent no-op on the array, not rehydrated
from events. `endedAt` absence is not proof a process is still alive.

At 50 entries the oldest remains; append 51 removes it even if unfinished or
referenced by a completion claim. The appended/current entry remains. Retaining
existing entries across reassignment (el-20qt0) does not mean retaining unlimited
history. Metadata is a recent window, not the complete task session ledger.

## Actual readers and writers at baseline

Paths below are in `packages/smithy/src/` unless qualified.

| Path / symbol | Behavior and retention consequence |
| --- | --- |
| `services/dispatch-daemon.ts`, append calls at 2347, 2413, 2682, 2885, 3372, 3593 | Orphan worker resume/fresh start, orphan steward resume, normal worker dispatch, merge/recovery steward spawn append internal/provider identities via Quarry update. Append is a separate metadata write; no claim pinning. Existing lifecycle races are tracked separately. |
| `services/task-assignment-service.ts`, assign/start/unassign/complete/handoff | Metadata replacement/update paths; baseline assign can discard history (separate el-20qt0). Complete closes using metadata session ID at 594 (known provider/internal mismatch). Handoff at 686 uses latest entry plus ambiguity count and closes its internal ID at 714. |
| `services/dispatch-daemon.ts:1453` | Recovery escalation counts steward entries in the retained window, not a lifetime count; interleaved evictions can reduce it. No live escalation incident reproduced here. |
| Same file:2574,2618,3717 | Rate-limit detector uses last few entries, manual-wake comparison uses latest start, recovery prompt lists retained history only. |
| `apps/smithy-web/src/components/task/TaskDetailPanel.tsx:434,2227` | Sessions count/list comes directly from metadata (display sorted); no audit backfill. |
| `runtime/session-manager.ts:1189,1656` | Separate **agent** history (persisted slice of 20), not the task's 50-entry ledger. It cannot be assumed to restore evicted task history. |

No reader above queries events to recover an evicted identity. Provider transcripts,
agent metadata, task sessions and operation logs are different evidence sources;
none is an automatic complete substitute for the others.

## Isolated characterization and limitation

`packages/smithy/src/services/task-session-retention.bun.test.ts` uses fresh
in-memory SQLite and real QuarryAPI/service calls, with no live task/session,
provider, server or direct SQL writes. Six tests cover:

- Exact 50/51 order, unfinished eviction, immutable input, preserved opaque claim
  reference and no-op close of an evicted ID.
- Audit API old/new snapshots retain eviction while current metadata does not;
  a limited event query is only a subset. API JSONL export lacks the evicted entry.
- Current internal handoff succeeds at 50 and 51; stale internal caller rejects
  with the complete task unchanged, and success ends the current entry.
- **CHARACTERIZATION, not a fix:** provider ID `reused` appears in entries 1 and
  50: handoff rejects ambiguity. With entries 1 and 51 sharing it, append has
  evicted entry 1: the same provider caller succeeds. Both old/current processes
  know that ID. Retained-window uniqueness does not establish lifetime uniqueness.

This is a demonstrated boundary weakness in the legacy provider-ID handoff
fallback, not evidence that completion is broken by the cap. The fixture requires
a provider ID reused after enough intervening entries to evict its prior occurrence;
it does not prove the normal daemon generates that sequence or its frequency.
Repeated consecutive resumes of the same provider retain duplicates within the
window and still reject the provider fallback. No live stale-call incident is claimed. Proposal sent to
Director (message el-9355r): require the internal ID whenever history exists;
consider no-history legacy policy separately. Alternatively a durable ambiguity
marker needs an explicit design/migration. Do not remove the cap or infer safety
from a passing characterization. No production fix is included or duplicate task
created. Arbitrary forged caller IDs/authentication are outside this ownership
check's contract.

## Completion candidate and recovery are distinct

Pending `41381df:packages/smithy/src/services/task-completion.ts`:
`identity` (lines 31–51) requires latest unfinished unique internal identity;
`validate` (77–84) also matches claim owner, session, branch/worktree/repository;
`reconcile` (205 onward) validates before effects/evidence lookup. It does not
restore history from audit or adopt an older owner's claim. Claims survive append
as separate metadata, but survival of a claim is not authority to resume it.

An isolated probe imported that candidate module with imports redirected to this
baseline's dependencies. **12/12 pass**, including the six baseline cases and six
candidate cases: current completion succeeds at both 50/51; claim for internal-1
recovers with one current entry; adding entry 2 already causes unchanged rejection,
as do 50 and 51. At 50 the referenced entry still exists; at 51 it is gone.
Thus this recovery denial begins with loss of *current identity*, before eviction.
No additional cap-specific completion failure was demonstrated. An older unknown
claim can remain durable but unrecoverable through this API; audit discovery does
not authorize editing metadata, adopting the claim or retrying external creation.
Finalized replay and external MR evidence rules are separate candidate behavior.

Probe source is preserved in `task-session-retention-candidate.test.ts.txt` beside
this report; log `/tmp/el-2y8n3-candidate.log`. To reproduce without checking out
another branch, extract the named `task-completion.ts` with `git show`, place it
as `packages/smithy/.retention-candidate.ts`, redirect its `../` imports to `./src/`
and its sibling service imports to `./src/services/`. Copy the preserved fixture
to `packages/smithy/.retention-probe.test.ts`, run `bun test` on that exact file,
and remove both temporary files. Type-only imports are erased by Bun. This is a
candidate-on-baseline boundary probe, not the full candidate integration gate,
a merge verdict, provider test, or an installed-app behavior claim.

## Audit availability is conditional, not permanent completeness

`packages/quarry/src/api/quarry-api.ts:1471` transactionally inserts full old/new
object snapshots for ordinary updates. `getEvents` at 3076 and `listEvents` return
persisted events with time/type/actor/limit filters; `sf history <task-id> --json`
uses this ordinary audit surface. The fixture observes the evicted entry in the
oldValue of the append update, and the new 50-entry window in newValue. No special
unbounded task metadata is needed to inspect that retained event. Earlier lifecycle
losses can likewise be investigated only insofar as their events were recorded
and retained. Actor attribution follows the mutation path, not proof of process
identity. UI Sessions does not automatically show those old snapshots.

This does **not** guarantee a complete long-term ledger: unrecorded provider events
cannot be recovered; filters/limits hide entries; ephemeral workflow deletion
explicitly deletes events (`quarry-api.ts:4010,4019`); imports/exports and available
backups must be checked. `api.export` at 4678 forwards elements/dependencies to
SyncService and ignores declared `includeEvents`; even `includeEvents:true` in the
fixture does not export audit snapshots. `sync/service.ts:87` rewrites current
`elements.jsonl`/`dependencies.jsonl`, not an append-only event archive. Do not
promise full audit restoration from JSONL, delete SQLite, or restore a task from
an old audit snapshot as a recovery shortcut. No retention policy was altered.

## Verification

- Frozen pnpm install: exit 0, lock unchanged.
- Focused retention + existing handoff ownership: **32 pass, 0 fail, 191 assertions**,
  `/tmp/el-2y8n3-focused.log`.
- Candidate hybrid probe: **12 pass, 0 fail, 32 assertions**, as scoped above.
- Initial fixture run: 5 pass/1 fail because the test inspected a creation-era
  metadata object without history; corrected the event selector. This was a test
  assumption failure, not a production regression; subsequent audit test passes.
- Required `pnpm check:merge`: result recorded below when complete.

Exact final commit still requires independent registered steward review and
approved CLI local delivery after acceptance. Worker does not self-merge.

First baseline gate: **186/186, exit 0, 224.34s** on f30b41a plus the six new
retention cases/comment. `/tmp/el-2y8n3-gate.log`; exact step results:
`/var/folders/b6/ltn3hn4j3nq1n86rbg2j9zk40000gn/T/stoneforge-merge-check-JhTLp4/results.json`.
During this run local master delivered el-20qt0 as `3420c56198517a39d1219a2c1acfd0099d526429`.
The completion module's SHA-256 equals the earlier probe module
`d28c1d13831ec741f593108bce4d2886f6ff66a3587317ff9a7036b1d51a0aa5`.
The pending-language above records the investigation chronology, not the current
delivery status after this point. Integration and a new gate follow below.

## Final integration with delivered completion

Approved sync with `3420c56198517a39d1219a2c1acfd0099d526429` produced one
append conflict in the lifecycle report; both sections were preserved. Production
merged unchanged. Permanent `task-session-retention.bun.test.ts` now has 12 tests,
including actual accepted `TaskCompletionProtocol` completion at 50/51 and
reconciliation at 1/2/50/51. Claim fixtures explicitly disable push/MR creation;
no external effects run. **107/107 focused tests, 576 assertions**, including
existing handoff and completion protocol suites, passed after sync. Historical
hybrid probe results above remain separately labelled, not substituted for these.

`git diff --check` passes. The type comment now says recent sessions rather than
all sessions; the lifecycle report's blanket full-history claim is corrected.
Workspace references el-4aqnn/el-2pglm and Directory were reread and updated
without discarding other entries. No new workspace document or task was needed.
Separate root build/lint/test, Quarry Node, browser/packaged GUI, live provider,
cross-platform and application installation checks were not run; gate includes
its declared typecheck/build/runtime suites. Existing skips are not coverage.
