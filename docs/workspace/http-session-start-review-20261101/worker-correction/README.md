# el-56khe worker overlap correction, 2026-11-01

Source: `ec28964836689f656595b4039965d5b203f2b6f4`, based on approved safe-sync
`a476aac` of the reviewed branch with delivered local master `f1d707a`.
The preceding independent CHANGES REQUIRED verdict and all sibling evidence files
are preserved. This directory records worker verification, not merge approval.

## Invariant and scope

Each SessionManager admits one HTTP start attempt per agent from before the first
await through all prechecks, preparation, assignment, start, notifications and
conditional cleanup. Both routes share the same WeakMap reservation, including
fresh/mixed route factories. A contender gets409 `SESSION_START_IN_PROGRESS`
without assigning, preparing worktrees or invoking SessionManager. Finally releases
admission after awaited cleanup; an already accepted session remains protected by
the normal409 `SESSION_EXISTS` precheck. Different agents/managers are independent.
This is in-process HTTP admission; CLI/daemon/resume and cross-process coordination
are not redesigned. No owner reread/adoption or string-matched cleanup occurs.
Existing assignment CAS, exact internal-session rollback receipts, accepted-start
logging, claims/history and retained-worktree diagnostics are unchanged. Retention
is intentional: exclusive worktree deletion ownership is not proven. No universal
orphan cleanup or live SDK termination is claimed.

## Commands and evidence

All runtime checks select the repository-pinned Node first, from this worktree:

```sh
export PATH="$PWD/apps/desktop/node_modules/node/bin:$PATH"
node -v  # v22.23.3
pnpm install --frozen-lockfile
```

`install.log`: pnpm8.15.5 exit0; lockfile unchanged. Approved installed operational
CLI build-info and all four Director hashes matched before `task sync el-56khe`.
The installed app was only read for this authorized CLI operation; it was not
modified/rebuilt, and no sessions/daemon/providers were used as test fixtures.

Before production edits, copy the parent's `concurrent-start-probe.bun.test.ts.txt`
into `packages/smithy/src/api/http-session-start.concurrent.bun.test.ts` and invoke:

```sh
bun test ./packages/smithy/src/api/http-session-start.concurrent.bun.test.ts \
  --test-name-pattern 'overlapping HTTP'
```

Run subprocesses with `checkEnvironment()` from `scripts/check-merge.mjs`, stripping
live project/actor/server routing and setting `RUN_INTEGRATION_TESTS=false`.
`baseline.log`:0pass/2fail,exit1,24 assertions on unmodified a476aac.
`no-release-control.log`:2/2,exit0,24 assertions; only set
`EL56_CONTROL_NO_RELEASE=1` in that sanitized subprocess environment. This is an
attribution control, not a whole baseline checkout. No production deletion/release
bypass remains in the final source/tests.

The permanent adapted suite keeps4 independent published/pending controls, adds8
starting/accepted schedules across both same/mixed factories,4 pending provider
rollback/assignment-release and retry cases,2 early preparation/notification exits,
and2 unrelated-agent progress cases. Whole task/events/resource snapshots assert
no contender effects. The old accepted-overlap timing hook remains, unreachable
now because admission rejects B before assignment. Accepted A still returns201,
keeps its exact live handle/persisted identity and assignment; later B gets409.

Final focused invocation used one fresh sanitized subprocess per file:

- `api/http-session-start.concurrent.bun.test.ts`:20/20,346 assertions.
- `api/http-session-start.bun.test.ts`:48/48,576 assertions (R1/R2/successor included).
- `api/http-session-start.steward-probe.bun.test.ts`:16/16,218 assertions.
- `api/orchestrator-assignment.bun.test.ts`:30/30,189 assertions.
- `runtime/session-manager.bun.test.ts`:92/92,183 assertions.
- `services/dispatch-claim.bun.test.ts`:53/53,320 assertions.
- `services/task-assignment-service.bun.test.ts`:37/37,96 assertions.
- `services/task-completion-protocol.bun.test.ts`:69/69,374 assertions.

Paths above are relative to `packages/smithy/src/`; commands were
`bun test ./packages/smithy/src/<path>` using spawnSync with checkEnvironment().
All exit0:365/365,2302 assertions; full logs are retained here by suite name.
Full required gate outcome follows once settled. Separate root build/lint/test,
public docs build, browser/packaged GUI, cross-platform and live-provider tests
were not run; existing skips are not passing coverage. Independent exact-final
steward review and approved local delivery remain required.

Final worker acceptance on source **ec28964836689f656595b4039965d5b203f2b6f4**:
- One required `pnpm check:merge` with pinned **Node v22.23.3**: **197/197,
  exit0,247.31s**, no retries. Full gate log/results and relevant per-step logs in
  `docs/workspace/http-session-start-review-20261101/worker-correction/`;
  original full log directory is
  `/var/folders/b6/ltn3hn4j3nq1n86rbg2j9zk40000gn/T/stoneforge-merge-check-wVdRoI`.
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
