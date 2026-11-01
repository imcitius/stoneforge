## el-56khe worker correction — incomplete startup protection across retries (2026-11-01)

Continues independent CHANGES REQUIRED on `2dcba6861d3fdf4b6940710b0964def0dae38dc3`.
The previous gate197/197, publication/overlap passes and new retry0/2/control2/2
remain historical evidence, not approval. Current branch already contains delivered
master `1b43de2`; no pending branch is copied and no target checkout is edited.

The exact steward retry probe was copied into the API test directory (only its
relative API import repaired) before production edits. Under pinned Node22.23.3
PATH and the gate's sanitized checkEnvironment(), baseline again failed0/2,
28assertions; no-release-only control passed2/2,28assertions. Logs and portable
source are preserved in `docs/workspace/http-session-start-review-20261101/worker-retry-correction/`.

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


### Reproduction commands and retained evidence

From the assigned worktree root, first select the pinned runtime:

```sh
export PATH="$PWD/apps/desktop/node_modules/node/bin:$PATH"
node -v # v22.23.3
pnpm install --frozen-lockfile
```

The eight fresh-process focused commands are recorded in `reproduce.mjs.txt`;
copy it to `/tmp/el56-reproduce.mjs`, then run `node /tmp/el56-reproduce.mjs`
from this worktree. It uses `checkEnvironment()` to remove all live Stoneforge
routing/actor variables and disable real provider integration. Permanent tests
use real temporary SQLite/Git/HTTP/SessionManager plus inert provider handles.

The exact pre-fix probe is `baseline-probe.bun.test.ts.txt`; original source is
also retained in `../steward-final-retry/`. Before source edits it was copied to
`packages/smithy/src/api/http-session-start.retry-baseline.bun.test.ts` and run as
`bun test <that path> --test-name-pattern 'retry after incomplete'`, using the
same sanitized environment. `baseline.log` is exit1 (0pass/2fail,28assertions);
`no-release-control.log` is exit0 (2pass/0fail,28assertions) with only the fixture
variable EL56_CONTROL_NO_RELEASE=1. The transient baseline file was removed after
capture; its old expectation of a second500 is intentionally no longer correct.
The permanent concurrent suite adapts that response to409 and strengthens full
state/effect assertions; it does not disable cleanup.

Required final command: `pnpm check:merge` (no filters/skips), pinned Node22.23.3.
The original source and eight focused-suite logs are retained here. Full gate log,
results, relevant per-step logs and final outcome follow. All75 historical review
SHA256 entries verified unchanged before this gate completed. Raw diagnostic logs
are preserved verbatim, including source snippets and original whitespace.


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

Evidence directory `docs/workspace/http-session-start-review-20261101/worker-retry-correction/`
contains baseline0/2 and no-release-control2/2 logs/source, all eight focused logs,
reproduction runner, runtime/install logs, full gate log/results and `gate-logs.tar.gz`
with all197 per-command logs. `source-sha256.txt` binds tested code/gate/lock;
`SHA256SUMS` binds captured evidence. Original gate location:
`/var/folders/b6/ltn3hn4j3nq1n86rbg2j9zk40000gn/T/stoneforge-merge-check-P8Z98W`.
All75 historical evidence hashes verified unchanged. No prior failure/control or
completion/history record is overwritten. Source diff whitespace check passes;
raw captured log whitespace remains intentionally verbatim.

This is worker verification, **not independent merge approval**. Complete through
the normal task lifecycle for a new exact-final steward review and approved CLI
local delivery. The explicit manager-lifetime admission retention limitation above
remains; no automatic recovery, universal orphan deletion or cross-process fencing
is claimed. No installed application, live provider/session/daemon or maintenance
changes. Omitted checks remain as listed above.
