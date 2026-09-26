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
