# Pre-merge acceptance checks

Run from the repository root, on **macOS arm64**, with pnpm **8.15.5**,
Bun **1.3.11** and Node **22.23.3** (the Desktop runtime pinned in the lockfile):

```sh
pnpm install --frozen-lockfile
export PATH="$PWD/apps/desktop/node_modules/node/bin:$PATH"
node -v
pnpm check:merge
```

Keep the install exit code as well as the check exit code. For a single shell
invocation, use `pnpm install --frozen-lockfile && pnpm check:merge`.
No new dependencies or lockfile changes are required. Git, local listening sockets,
PTY support and macOS `lsof` are needed by the existing integration fixtures.
Run one gate per worktree at a time. Installation needs registry access or a warm
pnpm store; Git/worktree tests may also invoke Corepack/package-manager setup.

Before discovering or running any steps, the runner prints its Node version,
native ABI (`process.versions.modules`), executable path, pnpm/Bun versions and
the Node resolved through PATH. The validated major comes from
`apps/desktop/package.json` → `devDependencies.node` (currently 22.23.3).
A different major or runner/PATH ABI mismatch exits 1 immediately. Under a
matching runtime, child processes resolve `better-sqlite3` from storage and
`node-pty` from Smithy. SQLite opens and closes `:memory:` to force its deferred
native load; PTY loads its addon without starting a terminal. Missing tools,
an invalid pin or an unloadable addon also fail before any gate step. Each probe
has a five-second timeout.

Preflight errors retain the underlying diagnostic and print the worktree's pinned
runtime path and a shell-quoted `export PATH=...` command. Select that runtime
and rerun; the gate never switches runtimes or rebuilds native modules itself.
If native loading still fails under pinned Node, inspect the addon error and the
Desktop README's development setup. Preflight output stays on the console;
per-step logs and `results.json` are created only after preflight succeeds.

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
| `node --test scripts/check-merge.test.mjs` | Runtime/native preflight fixtures and failure-before-steps checks; failure propagation, including first/middle/last failure, missing executable, signal and worker environment isolation. |
| `pnpm typecheck --force` | All workspace packages that declare `typecheck`, including shared routes/UI, web/server apps and Desktop; Turbo also builds their dependencies. |
| `pnpm --filter @stoneforge/desktop build` | Fresh Desktop JavaScript and shell resources; backend SDK builds were prerequisites of Desktop typecheck. |
| `bun test ./<file>` for every `*.bun.test.ts` under `packages/{core,storage,quarry,smithy}/src` | Core types/config/errors, real Bun SQLite/schema, Quarry API/CLI/dependencies/sync and Smithy orchestration/runtime/providers/Git/repository routing. Each file runs in its own process so Bun module mocks cannot leak into other files. |
| `pnpm --filter @stoneforge/smithy test:node` | Existing Vitest config: Node routes, permissions, stewardship/merge/worker lifecycle and a real PTY fixture using a fake provider executable. |
| `pnpm --filter @stoneforge/desktop test` | All Desktop Node tests: four backend tests covering workspace initialization, external-server adoption, multi-project HTTP/WS identity/isolation/restart and real CLI multi-repository registration/binding/merge after restart, plus two Logs bounds/escaping tests, two sidebar preference/view-bounds tests, five director-attention notification tests, a UTF-8 locale test and the pinned-Electron socket-workaround tests. Uses real temporary Git repositories and Node SQLite. |

The pricing test uses `bun:test`, so it is named `model-pricing.bun.test.ts`.
The Quarry `piped-output.bun.test.ts` regression also rebuilds Quarry and Smithy
and spawns their real Node CLI entrypoints with subprocess stdout/stderr pipes.
It checks complete large Unicode JSON/plain output and error exit codes; see
[CLI piped output](cli-piped-output.md) for the reproduction and exact coverage.
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
  Linux is exercised separately by GitHub CI through `pnpm check:ci`; see
  "CI vs gate" below. A green CI run is not macOS acceptance.

## CI vs gate

GitHub CI (`.github/workflows/ci.yml`, `ubuntu-latest`, push/PR to `master`) runs
`pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm build` and then
**`pnpm check:ci`** (`scripts/check-ci.mjs`). `check:ci` calls the gate's own
`runMergeGate()`: the same Node/native preflight, the same `mergeChecks()` step
list in the same order and the same per-file Bun isolation as `pnpm check:merge`.
No step is filtered and it accepts no arguments. The only difference is the host:
`check:merge` refuses non-macOS hosts, `check:ci` runs on macOS or Linux.
CI pins pnpm 8.15.5, Node 22.23.3, Bun 1.3.11 and Python 3.11.

Before el-2wx7k3, CI ran `bun test src` in each package. In Smithy that also
loads the Vitest `*.test.ts` files under Bun and shares one Bun process across
files (locally exit 1: 2118 pass, 21 skip, 56 fail, 1 error) while the gate
passed. It was replaced, not fixed: `bun test src` in Smithy is still not a
supported check.

What differs on Linux (all visible in the logs, none hidden):

| Item | Linux behaviour | Why |
| --- | --- | --- |
| Desktop `external.test.mjs` adoption test | Skipped with reason | `findExternalServer` (`packages/quarry/src/cli/server-discovery.ts`) returns `undefined` off macOS and discovers servers with `/usr/sbin/lsof` and `/bin/ps`. Adoption is macOS-only product behaviour. |
| Desktop `socket-workaround.test.mjs` Electron EINVAL test | Skipped (existing) | Injects a macOS-only socket error. |
| Other 15 Desktop Node tests, Desktop build | Run | Plain Node/TypeScript, temporary Git repos and SQLite. |
| `node-pty` | Compiled during install | 1.1.0 ships prebuilds only for darwin/win32. pnpm 8.15.5's bundled node-gyp 9.4.1 imports `distutils`, removed in Python 3.12 (the ubuntu-24.04 default), so CI pins Python 3.11 via `actions/setup-python`. |
| `better-sqlite3` | Prebuilt Linux binary | Loaded by the preflight like on macOS. |
| PTY fixtures (Smithy Vitest, Bun runtime tests) | Run | Linux PTY via node-pty; passed in the Ubuntu container run. |

Known Linux result (pre-existing, not changed by el-2wx7k3): Quarry
`query-performance.bun.test.ts` → *should maintain list performance as dataset
grows* asserts a `minimumPerQuery` ratio `< 3` for 150 vs 50 tasks. Each list
query returns all `size` tasks, so the work is linear. On macOS arm64 it measured
2.864 (load ~22). In an Ubuntu 24.04 arm64 container (4 CPUs, container load ~2)
it measured 3.0025, 3.0564 in two full runs and 3.029–3.048 in four of five
isolated runs. The per-query minimums were stable (about 0.137 / 0.276 / 0.417 ms),
so this looks like a platform difference, not load noise. GitHub's x64 runners
were not measured. The threshold says "never raise this", so CI keeps the test
and a red CI run on this test alone should be read with that in mind. Tracked as
**el-1caqsx** (contract decision needed; see also workspace reference el-241).

### Pinned third-party actions (el-3fg1vs)

Every `uses:` in `.github/workflows/*.yml` references a full 40-character commit
SHA followed by the release it came from, e.g.
`actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0`. The repo is
public and `desktop-release.yml` holds `contents: write`, so a retargeted major
tag (`@v4`) must not be able to change what runs. Workflows also keep minimal
token permissions: `ci.yml`, `deploy-docs.yml` and `deploy-website.yml` are
`contents: read`; only `desktop-release.yml` has `contents: write`.

Pins as of 2026-11-02 (the commit each major tag pointed to then, so pinning
changed nothing at runtime): `actions/checkout` v4.4.0, `actions/setup-node`
v4.4.0, `actions/setup-python` v5.6.0, `actions/upload-artifact` v4.6.2,
`pnpm/action-setup` v4.3.0, `oven-sh/setup-bun` v2.2.0.

Updating a pin (deliberate, reviewed change; never a bare tag):

1. Pick the release tag, then resolve it read-only. Annotated tags (`type: tag`)
   must be dereferenced to the commit:
   ```sh
   gh api repos/OWNER/ACTION/git/ref/tags/vX.Y.Z --jq '.object.type + " " + .object.sha'
   gh api repos/OWNER/ACTION/git/tags/<tag-object-sha> --jq .object.sha   # only if type is "tag"
   ```
2. Replace the SHA and the `# vX.Y.Z` comment in every workflow using that action,
   and read the action's release notes/diff between the old and new commit.
3. Check: `git grep -nE 'uses: [^ ]+@v?[0-9]+(\.[0-9]+)*$' .github/workflows` must
   print nothing, and `actionlint` (with shellcheck) on `.github/workflows/*.yml`
   must exit 0. The Desktop test `apps/desktop/tests/ci-release.test.mjs`
   (*every workflow action is pinned to a full commit SHA*, part of the gate)
   fails on any `uses:` without a SHA and `# vX.Y.Z` comment.

Dependabot is **not** configured: version updates open branches and pull requests
in the repository. If wanted later, a `.github/dependabot.yml` with
`package-ecosystem: github-actions` understands SHA pins with version comments;
enabling it is a separate decision.

### Validation — el-2wx7k3, 2026-11-01

Implementation commit `948dc27` (base local master `2927d82`). Commands were run
from the worktree root, Node 22.23.3 first on PATH.

| Where | Command | Result |
| --- | --- | --- |
| macOS arm64 | `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm build` | Exit 0 each (typecheck 17/17, build 14/14). |
| macOS arm64 | `pnpm check:ci` | **200/200, exit 0**, 488.17 s; Desktop 17/17, Smithy Vitest 376/376, gate regressions 13/13. |
| macOS arm64 | `pnpm check:merge` | **200/200, exit 0**, 409.48 s. |
| macOS arm64 | Executed command lists (`results.json`) | `check:ci` and `check:merge` ran identical 200 commands. |
| Ubuntu 24.04 arm64 container, non-root, no global Git identity, Python 3.11, 4 CPUs | The four CI commands above | Install/typecheck/build exit 0; `check:ci` 199/200, only the Quarry list-scaling test above failed (3.0564); Desktop 15 pass / 2 skip; same 200 commands as macOS. |
| Ubuntu container, Python 3.12 (no setup-python) | `pnpm install --frozen-lockfile` | Exit 1: `ModuleNotFoundError: No module named 'distutils'` while building node-pty. |
| — | `actionlint` 1.7.12 with shellcheck 0.11.0 on `.github/workflows/*.yml` | 0 errors; a negative control (`run: ls $FOO`) reported SC2086, so shellcheck was active. |

Not run: the workflow on GitHub (the Director pushes), x64 Linux, Playwright,
`pnpm lint`/`pnpm test`. The container emulates the runner (Ubuntu 24.04,
non-root `runner`, pinned toolchain); it is not the GitHub image.

## Steward review and activation

The merge steward must inspect the change, acceptance criteria and actual results,
then independently run the gate on the proposed merge result in a clean worktree.
Retain the exact commit, tool versions, command, exit code, duration and full log.
Review warnings/skips and run additional checks needed for the changed area.
A known failure still blocks acceptance; do not bypass the gate or replace tests
with compilation. Track unrelated defects separately rather than weakening checks.

This document and command do **not** themselves activate a repository merge policy.
The separate el-1r6 activation set core's shared `testCommand` to
`pnpm check:merge`; inspect `sf repo list` for the current value. Activation and
independent review evidence are recorded in
`docs/workspace/merge-acceptance-2026-09-26.md` and workspace document el-241.
The standalone local merge command does not run the gate; execute it explicitly.

## Evidence hygiene

The repository is published. Verification evidence stays outside Git; the repo
holds only the conclusions.

- Do **not** commit raw gate logs (`*.log`), runner `results.json`/gate JSON,
  console captures, evidence archives (`*.tar.gz`), ad-hoc probe scripts or
  patches, or evidence directories under `docs/`.
- Do **not** commit machine-local paths: home directories (`/Users/<name>/…`,
  `/home/<name>/…`), `$TMPDIR` expansions (`/var/folders/…`, `/private/tmp/…`),
  or personal artifact/backup directories. Use repo-relative paths or
  placeholders such as `<workspace>`, `<repo>`, `$TMPDIR/stoneforge-merge-check-…`
  or `~/Applications/…`.
- Keep raw evidence in `/tmp` (or another local directory) or attach it to the
  workspace through `sf` documents/messages. In the repo, write a concise summary:
  what was measured, the exact commit, commands, key numbers (for example
  `194/194, exit 0, 254.58s`), a few quoted lines when needed, and the conclusion.
- Before committing documentation, check the tree:
  `git grep -nE "/Users/|/private/tmp/|/var/folders/"` must not report new hits,
  and `git ls-files docs | grep -E '\.(log|tar|gz|tgz|zip)$'` must be empty. Known
  remaining hits, all inherited from upstream and intentionally left:
  - `/Users/you/my-project` in `apps/docs` — generic documentation example.
  - `/Users/home/...` in `.stoneforge/sync/elements.jsonl` — upstream sync export
    (upstream author's own workspace data, last touched upstream 2026-04-23).
    It is generated data; editing it by hand would bypass QuarryAPI.
- Stewards reject changes that add raw evidence files or machine-local paths and
  ask for a summary instead.

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
  durations): `$TMPDIR/stoneforge-merge-check-L6eAuQ/`.

Observed duration fits the current steward default of five minutes on this host;
this is not a guarantee for slower machines. The steward must rerun the final
proposed merge after the separately tracked defects are resolved, inspect the
results independently and never bypass failures. Repository activation remains
task **el-1r6**; `repositories.json` was not edited.


## Validation after local target integration — 2026-09-26

The resumed worker used the independently approved
`/tmp/stoneforge-el-ptim-151b314/sf task sync el-5xd` with
`STONEFORGE_ROOT=<workspace>`. No installed app or session
was changed. The first sync included local master `e32f709` (el-2kc and el-ptim),
producing `6a01bc56f43562392a948a48c025761a889f1c10`. A second sync included the
newly merged el-52s fixture fix, local master `0f0a7ad4c767d9ac85ce0fb3408f031ee2f9bf91`,
producing final tested code **`67d3dd5a9862e90a1c880bda705e47300588505d`**.
Both sync commands exited 0. The task delta remains the same six gate/documentation
files; no implementation changes or test exclusions were added during resumption.
`git merge-base --is-ancestor master HEAD`, `git diff --check` and clean tracked
worktree checks succeeded. Tool versions remain Node 22.23.3, pnpm 8.15.5,
Bun 1.3.11 on macOS arm64. Each run began with empty `git status --porcelain`.

| Command / revision | Exit | Duration | Result |
| --- | --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | 3.23 s wall | Existing lockfile unchanged. |
| `pnpm check:merge` on `6a01bc5` | 0 | 145.94 s runner / 146.55 s wall | 175/175 steps; 8,479 Bun pass, 29 skips; 325 Vitest, 4 Desktop, 5 gate regressions pass. |
| **`pnpm check:merge` on `67d3dd5`** | **1** | **176.64 s runner / 177.30 s wall** | **174/175 steps pass; final acceptance blocked by el-2z6.** |

The final run executed all checks, even after the failure:

| Check group | Exit | Seconds | Result |
| --- | --- | --- | --- |
| `node --test scripts/check-merge.test.mjs` | 0 | 0.38 | 5 pass, including synthetic subprocess failures. |
| `pnpm typecheck --force` | 0 | 39.68 | 17 successful tasks, 0 cached. |
| `pnpm --filter @stoneforge/desktop build` | 0 | 1.95 | Fresh source build. |
| Core Bun, 24 files | All 0 | 3.28 | 2,737 pass, 22 skip. |
| Storage Bun, 3 files | All 0 | 0.69 | 137 pass. |
| Quarry Bun, 96 files | One 1 | 36.02 | 4,260 pass, 1 fail, 1 skip. |
| Smithy Bun, 47 files | All 0 | 87.23 | 1,344 pass, 6 skip; includes new target-delivery and merge-arguments files. |
| `pnpm --filter @stoneforge/smithy test:node` | 0 | 2.23 | 325 pass in 13 files. |
| `pnpm --filter @stoneforge/desktop test` | 0 | 5.08 | 4 backend integration tests pass. |

The sole final failure is `bun test ./packages/quarry/src/api/query-performance.bun.test.ts`
(exit 1, 1.02 s; 32 pass / 1 fail). `should maintain list performance as dataset grows`
received **3.9796987826047063**, expected **< 3**, at line 633. This is the existing
list measurement issue tracked in **el-2z6**; that task's changes are not in this
revision. The earlier successful run does not supersede this failure. No retry,
assertion change or unrelated production fix was performed. The el-52s fixture fix
is included and its five tests passed; historical failures above are retained.

Evidence:

- `/tmp/el-5xd-resume-install.log` (install).
- `/tmp/el-5xd-resume-gate.log` (first post-sync pass).
- `$TMPDIR/stoneforge-merge-check-LHUCOB/results.json` (all first-run commands, exits, durations and per-step log paths).
- `/tmp/el-5xd-final-gate.log` (final failed gate).
- `$TMPDIR/stoneforge-merge-check-m98nM3/results.json` (all final commands, exits, durations and per-step log paths); `046.log` is the complete failure.

The command correctly propagated a real failed check through the final process
exit despite subsequent successful checks. Implementation approval of the gate
remains separate from acceptance of this revision. Preserve this task branch and
worktree until el-2z6 is integrated, then sync using an independently approved CLI,
run the final gate and obtain independent steward review before local delivery.
Do not use installed remote-first merge or merge-status as a workaround. Activation
remains el-1r6; repositories.json and AGENTS.md were not edited by this task.

## Integrated gate after reviewed fixes — 2026-09-26

After independently approved el-2z6 was delivered, the approved standalone
`/tmp/stoneforge-el-ptim-151b314/sf task sync el-5xd` with
`STONEFORGE_ROOT=<workspace>` returned **0** and included
local master **`00847ad3dca80b601aa7f9009708319df5f119bf`**. The tested revision is
**`0ed8c8e80e0cae0d0918b0bb01df15d99a152c65`**. All 299 artifact manifest entries
matched their hashes. The target now includes el-52s, el-2z6, Desktop Logs and
merge-status argv fixes. The task still changes only the original six gate/docs
files relative to master. No gate implementation, thresholds or exclusions changed
in this resumption. Only this documentation was updated after the test run.

The assigned worktree had empty `git status --porcelain` before and after the run;
`git merge-base --is-ancestor master HEAD` and `git diff --check` returned 0.
Tool versions remain macOS arm64, Node 22.23.3, pnpm 8.15.5, Bun 1.3.11 and
lockfile Vitest 4.0.18. Frozen install left the lockfile unchanged. Typecheck rebuilt
dependencies without cache and Desktop output was freshly built by the gate.

| Command / group | Exit | Seconds | Result |
| --- | --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | 3.66 wall | Existing lockfile and dependencies. |
| `node --test scripts/check-merge.test.mjs` | 0 | 0.43 | 5 pass; first/middle/last failure, missing executable, signal and log preservation covered. |
| `pnpm typecheck --force` | 0 | 23.54 | 17 successful tasks, 0 cached. |
| `pnpm --filter @stoneforge/desktop build` | 0 | 1.49 | Fresh source build, including Logs. |
| Core Bun, 24 files | All 0 | 1.92 | 2,737 pass, 22 skip. |
| Storage Bun, 3 files | All 0 | 0.31 | 137 pass. |
| Quarry Bun, 96 files | All 0 | 35.73 | 4,263 pass, 1 skip; performance 35/35. |
| Smithy Bun, 48 files | All 0 | 87.37 | 1,355 pass, 6 skip; includes new merge-status argv coverage. |
| `pnpm --filter @stoneforge/smithy test:node` | 0 | 3.79 | 325 pass in 13 files. |
| `pnpm --filter @stoneforge/desktop test` | 0 | 5.90 | 6 pass: 4 backend integrations and 2 Logs tests. |
| **`pnpm check:merge`** | **0** | **160.48 runner / 161.13 wall** | **176/176 steps pass; 8,492 Bun pass, 29 existing skips.** |

One complete gate was run after this sync, with no retry-until-green. The previous
failed runs above remain evidence that a real failure produces a nonzero final
exit despite later passing checks. The el-2z6 change stabilizes measurement;
it does not establish the cause of historical create ratio 7.216375 or prove
cross-platform performance. Its method and limits remain in
`docs/query-performance-investigation.md` and workspace reference el-47e2.

Evidence: `/tmp/el-5xd-integrated-install.log` and `.json`,
`/tmp/el-5xd-integrated-gate.log` and `.json`; all 176 exact commands, exit codes,
durations and full per-step logs are in
`$TMPDIR/stoneforge-merge-check-pqv08E/results.json`.
The current target remained 00847ad at completion. This is worker validation;
the steward must independently review and run the gate on the final proposed
merge revision before approved local delivery. Activation remains separate el-1r6.
AGENTS.md, repositories.json, installed Desktop and running sessions were unchanged.


## Активация и итоговая worker-приёмка el-1r6 — 2026-09-26

После закрытия/доставки всех семи блокеров approved el-ptim CLI (299 hashes match)
синхронизировал assigned worktree с local master
`3722db9626db16f401eb464dab1239f8d0f1224f`. Frozen install exit 0;
один полный **`pnpm check:merge` exit 0, 176/176 steps**, 162.91 s runner /
163.249 s wall. Uncached typecheck 17/17 (0 cached), 8,492 Bun pass / 29 existing
skips, 325 Vitest, 6 Desktop, 5 gate regressions; fresh Desktop build exit 0.
Node 22.23.3, pnpm 8.15.5, Bun 1.3.11, macOS arm64. Реализация gate не менялась;
исторические failures и исключения выше сохранены, live/packaged GUI не проверялись.

После этого изменено только `core.testCommand` на точное `pnpm check:merge` в
shared repositories.json с exclusive lock и atomic rename; update API отсутствует.
Id/path/targetBranch/gitCommonDir сохранены. Аутентифицированный текущий backend
GET /api/repositories и installed sf repo list сразу показывают новое значение;
endpoint/project/instance identity прежние, restart не нужен. Это настройка и её
видимость в текущем сервере; standalone task merge --local сам gate не запускает.

Полный отчёт находится в core `docs/workspace/merge-acceptance-2026-09-26.md`
(санитизированные snapshots и patch-файлы удалены из репозитория перед
публикацией, el-ju3fwi; суть изменений приведена в отчёте).
Логи: `/tmp/el-1r6-evidence/{install.log,gate.log,gate.json}`; все команды/exits/
длительности — `$TMPDIR/stoneforge-merge-check-Z9wDEd/results.json`.
Это worker acceptance/activation; независимое ревью steward текущего commit и
общих изменений обязательно до закрытия el-1r6 и local delivery. Приложение и
сессии не заменялись/не перезапускались; installed dispatch ещё требует ancestry check.


## Runtime preflight validation — 2026-11-01, el-127xg


Worker validation on implementation `8f1b5ceb7428bfe5bd158c858e3fca6df13c7dac`
(base `bdd07d45252ad3f9a052902b4255c5089f0253fa`), macOS arm64:

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` with pinned Node PATH | Exit 0; existing missing-dist CLI bin warnings before builds; lockfile unchanged. |
| `node --test scripts/check-merge.test.mjs` with pinned Node PATH | Exit 0, 12/12; 2.577s final focused run. |
| One ambient `pnpm check:merge` | Expected exit 1 in **1.101s**, Node v26.8.2 / ABI147, `/opt/homebrew/Cellar/node/26.8.2/bin/node`; no gate steps ran. |
| One full `pnpm check:merge` with pinned Node PATH | **193/193, exit 0**, 306.75s runner / 307.902s wall; Node **v22.23.3 / ABI127**, pnpm8.15.5, Bun1.3.11; both native probes pass. |

The full gate includes uncached typecheck17/17 (0 cached), fresh Desktop build,
12 gate regressions, all discovered per-file Bun suites, Smithy Node352/352 and
Desktop Node17/17. Existing skips/exclusions remain; separate root build/lint/test,
Playwright, packaged GUI, live-provider and cross-platform checks were not run.
Step discovery and execution functions are byte-identical to the baseline.

Evidence: `/tmp/el-127xg-install.log`, `/tmp/el-127xg-tests.log`,
`/tmp/el-127xg-ambient.json`, `/tmp/el-127xg-gate.{log,json}`. The gate log starts
with the separately recorded `node -v` and all preflight tool/runtime details.
All exact step commands/exits/timings and full logs are retained at
`$TMPDIR/stoneforge-merge-check-oMTYAE/results.json`.

Only documentation changed after the tested implementation. Author and committer
use the approved command-scoped Ilya Rubinchik identity. Independent exact-final
steward review and approved local delivery remain required; this is worker
acceptance, not merge approval. Installed Desktop/live sessions/global Node were
not changed. The approved installed d58bd815 operational CLI build-info and all
four hashes from el-of6 were verified; the exact documented aggregate-hash command
matched (an initial alternate Python ordering was not equivalent).
