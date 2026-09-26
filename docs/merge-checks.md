# Pre-merge acceptance checks

Run from the repository root, on **macOS arm64**, with pnpm **8.15.5**,
Bun **1.3.11** and Node **22.23.3** (the Desktop runtime pinned in the lockfile):

```sh
pnpm install --frozen-lockfile
pnpm check:merge
```

Keep the install exit code as well as the check exit code. For a single shell
invocation, use `pnpm install --frozen-lockfile && pnpm check:merge`.
No new dependencies or lockfile changes are required. Git, local listening sockets,
PTY support and macOS `lsof` are needed by the existing integration fixtures.
Run one gate per worktree at a time. Installation needs registry access or a warm
pnpm store; Git/worktree tests may also invoke Corepack/package-manager setup.

`check:merge` prints every command, exit code and elapsed seconds. It runs all
checks sequentially, reports every failed step and exits **1 if any step fails**
(including a missing executable or signal). It does not allow skip/filter flags.
Full stdout/stderr per step and a machine-readable `results.json` stay in the
printed temporary log directory. The console shows a short tail for failed steps;
inspect the full logs for details and skips. This keeps the steward's command
output buffer from overflowing. Preserve that directory with the review evidence.
Tests run directly, outside Turbo's test cache. `pnpm typecheck --force` reruns
typechecks and their dependency builds rather than replaying cached success.
An interrupted run is incomplete and must never count as acceptance.

## Coverage

| Step | What it actually checks |
| --- | --- |
| `node --test scripts/check-merge.test.mjs` | Failure propagation, including first/middle/last failure, missing executable, signal and worker environment isolation. |
| `pnpm typecheck --force` | All workspace packages that declare `typecheck`, including shared routes/UI, web/server apps and Desktop; Turbo also builds their dependencies. |
| `pnpm --filter @stoneforge/desktop build` | Fresh Desktop JavaScript and shell resources; backend SDK builds were prerequisites of Desktop typecheck. |
| `bun test ./<file>` for every `*.bun.test.ts` under `packages/{core,storage,quarry,smithy}/src` | Core types/config/errors, real Bun SQLite/schema, Quarry API/CLI/dependencies/sync and Smithy orchestration/runtime/providers/Git/repository routing. Each file runs in its own process so Bun module mocks cannot leak into other files. |
| `pnpm --filter @stoneforge/smithy test:node` | Existing Vitest config: Node routes, permissions, stewardship/merge/worker lifecycle and a real PTY fixture using a fake provider executable. |
| `pnpm --filter @stoneforge/desktop test` | All four existing Node backend tests: workspace initialization, external-server adoption, multi-project HTTP/WS identity/isolation/restart and real CLI multi-repository registration/binding/merge after restart. Uses real temporary Git repositories and Node SQLite. |

The pricing test uses `bun:test`, so it is named `model-pricing.bun.test.ts`.
Core, storage and quarry currently have **no Vitest tests**; their `test:node`
scripts would report no tests. Smithy uses both runners. `bun test` at the root,
`bun test src` in Smithy and `pnpm test` are not substitutes for this gate: they
mix incompatible test imports and/or pull in separate browser suites.

The runner removes inherited `STONEFORGE_*`, `SF_*` and `ORCHESTRATOR_URL` only
from child environments so fixtures do not inherit a worker's shared project,
actor or server. The invoking shell and installed application are unchanged.
`RUN_INTEGRATION_TESTS=false` keeps live provider tests opt-in.

## Explicit exclusions

- Existing `test.skip` / conditional skips remain visible in runner output.
  In particular, the four live Claude spawner tests are skipped. A skipped test
  is not evidence that its behavior works. There is no allowlist of failed tests.
- No packaged Electron GUI, native-dialog/renderer interaction, bundle relocation,
  signing/notarization, LaunchServices launch or installed-app upgrade check.
  For those changes, follow `apps/desktop/README.md`: build/package a separate
  artifact and run `check-app.mjs` and `check-launch-services.mjs`. Never replace
  the installed app or restart user sessions as part of this gate.
- No paid/live Codex, Claude, OpenCode or external-service authentication/API
  validation. Provider unit tests use mocks/fixtures. Live checks remain explicit.
- No Playwright frontend suites, standalone `apps/smithy-server` Vitest suite,
  docs/website builds, browser `sql.js` backend or cross-platform coverage.
  `smithy-next`, docs and website do not declare `typecheck`; the root command
  does not invent coverage for them. Add relevant checks when reviewing changes
  in these areas. Intel macOS, Linux and Windows are not verified by this gate;
  the command fails on non-macOS instead of silently skipping Desktop.

## Steward review and activation

The merge steward must inspect the change, acceptance criteria and actual results,
then independently run the gate on the proposed merge result in a clean worktree.
Retain the exact commit, tool versions, command, exit code, duration and full log.
Review warnings/skips and run additional checks needed for the changed area.
A known failure still blocks acceptance; do not bypass the gate or replace tests
with compilation. Track unrelated defects separately rather than weakening checks.

This document and command do **not** activate a repository merge policy.
The shared `repositories.json` still requires a separate, explicitly reviewed
activation task after this change is merged. Do not infer that the old
`pnpm typecheck` policy executes this gate.

## Recorded validation — 2026-09-26, task el-5xd

Tested code commit: `502a86ed65b733f51c254fb9dd3aa3d8546e0408`, based on local
`master` `b7e5c8b`. The assigned worktree initially pointed to `bb5f967` (without
Desktop); it was fast-forwarded to local master without switching branches.
All implementation and verification stayed in the assigned worktree. macOS arm64,
Node v22.23.3, pnpm 8.15.5, Bun 1.3.11, lockfile Vitest 4.0.18.

Before the recorded clean run, `git status --porcelain` was empty. Generated
package `dist`, Desktop `dist` and workspace/package/app `.turbo` directories
were removed; no tracked files were removed. Dependencies came from a frozen
pnpm install using the existing package store. Typecheck reported **17 tasks,
0 cached**. The worktree remained clean after the run.

| Command / group | Exit code | Seconds | Result |
| --- | --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | 7.38 wall | Lockfile unchanged; warnings about workspace CLI bins before `dist` exists. |
| `node --test scripts/check-merge.test.mjs` | 0 | 0.37 | 5 passed, including synthetic failed subprocesses and >2 MiB log preservation. |
| `pnpm typecheck --force` | 0 | 26.81 | 17 Turbo tasks successful, none cached. |
| `pnpm --filter @stoneforge/desktop build` | 0 | 1.28 | Fresh Desktop output. |
| Per-file Bun: core (24 files) | All 0 | 1.71 | 2,737 passed, 22 skipped. |
| Per-file Bun: storage (3 files) | All 0 | 0.20 | 137 passed. |
| Per-file Bun: quarry (96 files) | All 0 | 38.84 | 4,261 passed, 1 skipped; see earlier failure below. |
| Per-file Bun: smithy (45 files) | One 1; others 0 | 52.83 | 1,302 passed, 1 failed, 6 skipped. |
| `pnpm --filter @stoneforge/smithy test:node` | 0 | 2.69 | 323 passed across 13 files. |
| `pnpm --filter @stoneforge/desktop test` | 0 | 5.59 | All 4 real backend integration tests passed. |
| **`pnpm check:merge`** | **1** | **130.47 runner / 131.11 wall** | **173 steps, 1 failed; not accepted for activation.** |

The failed command was
`bun test ./packages/smithy/src/git/project-repositories.bun.test.ts`
(exit 1, 3.55 s). Test `an assigned task cannot switch repositories or resume a
foreign worktree` raised `CONCURRENT_MODIFICATION` in `QuarryAPI.update`:
expected updatedAt `2026-09-26T12:40:21.714Z`, actual `.715Z`. Tracked as **el-52s**.

The initial full run, before file-backed logging was added, also returned **1**:
173 steps, 163.30 s, two failed files. In addition to the same repository test,
`bun test ./packages/quarry/src/api/query-performance.bun.test.ts` returned 1
in 1.72 s: scaling per-item ratio **7.216375** exceeded `< 4` at line 596.
That unchanged test passed on the clean run; its instability remains tracked as
**el-2z6**, not erased by the later pass. No failing test was excluded or retried
to manufacture a successful gate. The second run validated the logging change
and clean-build prerequisites.

The 29 existing skips are 22 core documentation checks, one Quarry cycle check,
two Smithy dispatch/E2E checks and four opt-in live Claude spawner checks.
The existing suite failure is unrelated to this command's implementation; production
behavior and assertion thresholds were not changed in this task.

Local evidence retained for independent review:

- Clean install: `/tmp/el-5xd-clean-install.log`.
- Initial full run: `/tmp/el-5xd-check-merge-first.log`.
- Clean command output: `/tmp/el-5xd-check-merge-clean.log`.
- Full clean per-step logs and `results.json` (all commands, exit codes and
  durations): `/var/folders/b6/ltn3hn4j3nq1n86rbg2j9zk40000gn/T/stoneforge-merge-check-L6eAuQ/`.

Observed duration fits the current steward default of five minutes on this host;
this is not a guarantee for slower machines. The steward must rerun the final
proposed merge after the separately tracked defects are resolved, inspect the
results independently and never bypass failures. Repository activation remains
task **el-1r6**; `repositories.json` was not edited.
