# Daemon stop/status CLI regression — el-prlpi

## Contract and scope

Implementation commit: `f731dca8be61352513095b1feba524a63f71019c`.
The old stop precheck only read `running`/`status`, while the current daemon API
returns `isRunning`. A running canonical response therefore produced a successful
"Daemon is not running" without POST. Quiet status also preferred a conflicting
legacy `status` over the canonical boolean.

Stop and status now share state resolution: boolean `isRunning`, otherwise boolean
`running`, otherwise recognized legacy `status` (`running`, `stopped`,
`not_running`). Only absent fields permit fallback; an explicit false wins over
contradictory legacy fields, and malformed or missing state fails with exit 1.
HTTP errors preserve nested `error.message` instead of printing `[object Object]`.

Stop still checks GET status, prompts unless forced, and POSTs only when running.
A stop response reporting running, invalid state/acknowledgement, `success:false`,
or an error fails without a success message. Legacy stopped status/boolean and
message-only acknowledgements remain supported (as does `success:true` alone).
There is no new automatic poll: `sf daemon status` is the explicit readback.
A successful acknowledgement is not a guarantee against a subsequent restart.

JSON retains the raw server payload in the normal CLI success envelope. Plain
stop retains server messages/default wording; quiet stop prints `stopped`.
Already-stopped output remains plain "Daemon is not running", JSON `not_running`,
and empty quiet output. Quiet status consistently prints `running`/`stopped`;
raw JSON still preserves contradictory legacy fields for inspection.

No live daemon, session, installed app or maintenance el-1clm was used as a test
object. Only the assigned worktree and temporary HTTP/workspace fixtures changed.
Source integration does not update the installed Desktop/CLI.

## Regression evidence

`packages/smithy/src/cli/commands/daemon.bun.test.ts` builds the workspace Smithy
CLI/dependencies, then launches actual Node CLI subprocesses against a temporary
loopback server on an allocated port. Each test has a private Desktop-style
connection descriptor and verifies identity/auth headers. Inherited STONEFORGE_*,
SF_*, ORCHESTRATOR_URL and ELECTRON_RUN_AS_NODE are removed from test children;
shared sf commands retain the real project root. Fixture state changes on POST,
and a separate real `status` invocation reads it back.

Coverage includes canonical true/false and contradictory legacy fields, legacy
running/status responses, no-op behavior, all three output modes, confirmation
and cancellation, HTTP failures, malformed JSON, invalid state objects, and stop
responses that reject or still report running. The gate discovers this Bun file
automatically; its subprocess behavior runs under Node, not Bun.

- `pnpm install --frozen-lockfile`: exit 0, 3.4s; pnpm 8.15.5, Node 22.23.3,
  Bun 1.3.11. Initial missing dist/bin link warnings are retained in install log;
  subsequent test build succeeds. Manifests/lockfile unchanged.
- Before implementation, the initial test suite gave 6 pass / 35 fail and
  reproduced canonical true returning `not_running` instead of STOP. This was
  the initial 41-case suite, not the final suite run on an unchanged baseline.
- First implementation run: 33 pass / 8 fail. All eight failures were a test
  harness error (`--force` incorrectly passed to `status`); corrected the fixture
  invocation, then added four output/HTTP cases and running-status assertions.
- Final targeted command:
  `bun test packages/smithy/src/cli/commands/daemon.bun.test.ts`:
  **exit 0, 45 pass / 0 fail, 222 assertions, 24.13s**.

Logs retained: `/tmp/el-prlpi-install.log`, `/tmp/el-prlpi-baseline.log`,
`/tmp/el-prlpi-regression.log`, `/tmp/el-prlpi-regression-final.log`.

## Required gate and delivery boundary

On implementation commit `f731dca8be61352513095b1feba524a63f71019c`, the single
`pnpm check:merge` invocation returned **exit 0, 181/181 checks, 203.24s**.
Uncached typecheck 17/17; fresh Desktop source build; Bun 8,581 pass / 0 fail /
29 existing skips (including this CLI suite's 45/45); Smithy Node/Vitest 325/325;
Desktop Node backend integration 6/6; gate regressions 5/5. Skips are not passing
coverage. No gate configuration changes, filtering or reruns were used.

Full gate log: `/tmp/el-prlpi-gate.log`. Exact per-step commands/exits/durations
and logs:
`/var/folders/b6/ltn3hn4j3nq1n86rbg2j9zk40000gn/T/stoneforge-merge-check-MaBK84/results.json`.
`git diff --check` passed; local master `70b37ba` remained an ancestor of HEAD.
The subsequent report commit changes only this evidence document.

Separate root build/lint/test, full Playwright/browser suites, packaged GUI,
live-provider and cross-platform checks were not run. No application installation,
restart or maintenance continuation is authorized by this source fix.

Worker acceptance is complete; independent steward review of the final commit
and explicit checks remain required before approved CLI `task merge --local`.
Shared references `el-241` and `el-1l2t` distinguish this source correction from
the unchanged installed application and the completed historical maintenance.
