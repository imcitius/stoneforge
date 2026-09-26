# Desktop candidate and coordinated update — el-1zar

## Decision boundary

Prepared on 2026-09-26 by worker el-4eqh. **Acceptance is incomplete:** the fixed
GUI sample failed 3/3 at native Logs focus, and the subsequent OS snapshot shows
the graphical console is locked. Onboarding was not reached. This candidate must
not be described as independently approved or ready to install. The task prepares
a candidate and an installation runbook for Human. It does **not** authorize stopping
agents/daemons, replacing the installed app, migrating live projects or restarting
sessions. No installation task or automatic update action was created.

Independent steward review of the **exact relocated app below** and the final
task commit is required before Human decides. Worker results are not independent
approval. A separately rebuilt app is a different candidate, even at the same
source commit; record and review its identity/manifest separately if needed.

While this candidate was being checked, local master advanced to
`5b58361429b403e9a87edc590b70f81ba5c9353e` (el-1onu, delivered at 15:59:37Z).
The frozen d121628 app is therefore evidence, **not the latest-master final
candidate**. On resumption, sync via the approved CLI and build a new clean-source
candidate including el-1onu, retaining this app and its failed GUI sample. Run the
gate and all required packaged checks for that new identity; do not relabel this
manifest or count earlier results as checks of a different app.

## Candidate identity and source

- Artifact directory: `/Users/citius/Desktop/Work/Stoneforge-artifacts/el-1zar-d121628`.
- App: `Stoneforge Desktop.app` inside that directory; relocated before runtime tests.
  This directory is outside all managed worktrees and survives task cleanup.
- Clean build source/local master: `d121628cae2b615f020ef3a08a2f0b0bb0910ebf`.
- Bundled version `0.1.0`, branch `agent/e-worker-1/el-1zar-desktop`, `dirty=false`,
  builtAt `2026-09-26T15:50:36.888Z`. macOS arm64, Electron 44.4.5, Node 22.23.3.
- `IDENTITY.json` duplicates `Contents/Resources/app/build-info.json`.
- `BUNDLE_MANIFEST.json` records 10,543 file/directory/symlink entries, permissions,
  file lengths/SHA-256 and link targets. SHA-256:
  `be78ee5cf176e0f81ac813306cb75213ad3f09848e28a467d6717d8c6908cd18`.
- Build used pnpm 8.15.5 and frozen lockfile, Bun 1.3.11, host Node 22.23.3.
  Source was clean through packaging. Subsequent task changes add verification
  scripts and documentation; they do not alter this immutable app or its identity.

The approved `/tmp/stoneforge-el-ptim-151b314/sf task sync el-1zar` with shared
`STONEFORGE_ROOT=/Users/citius/Desktop/Work/Stoneforge` fast-forwarded only the
assigned branch to local master. All 299 approved CLI hashes and its manifest hash
were reverified. `evidence/source-preflight.json` records ancestry of el-2kc,
el-ptim, el-3514, Logs el-31ag, harness el-4d52, gate/docs el-1r6, workload el-4p9h,
piped CLI output el-3num, and metrics el-5psa/el-33hc/el-10qu. No target publication,
branch switch, force, merge-status workaround or installed-CLI delivery was used.

## Verification evidence

Shared workspace runbook: `sf document show el-1l2t` (category `runbook`, in the
Documentation library and Directory). Related references el-36q and el-1uyc link
this blocked candidate without removing their historical accepted artifacts.

Every command's output/exit is retained under the artifact directory. Source gate
logs are copied there, rather than depending on the temporary runner directory.
Runtime fixtures use only temporary repositories/projects and separate app-data.
Test children clear inherited `STONEFORGE_*`, `SF_*`, `ORCHESTRATOR_URL` and
`ELECTRON_RUN_AS_NODE`; shared `sf` operations retain the real project root.

| Command | Result | Evidence |
|---|---|---|
| `pnpm install --frozen-lockfile` | exit 0, 12.00s, unchanged lockfile | `evidence/install.{log,json}` |
| `pnpm check:merge` | exit 0, 180/180 steps, 388.07s wall | `evidence/gate.{log,json}`, `evidence/gate-steps/` |
| `pnpm --filter @stoneforge/desktop package:mac` | exit 0, 44.97s; fresh web assets, bundled SQLite ABI, real PTY spawn/output/exit | `evidence/package.{log,json}` |
| Bundled Node + `apps/desktop/scripts/check-safeguards.mjs` | exit 0, 15 checks | `evidence/safeguards.{log,json}` |
| `SF_TEST_CLI=<app>/Contents/Resources/runtime/sf bun test` with task-merge-status, task-merge-status-arguments, merge-arguments and target-delivery Bun files | exit 0, 69 tests / 404 assertions, 56.64s runner | `evidence/cli-matrix.{log,json}` |
| `DESKTOP_APP=<exact relocated app> node apps/desktop/scripts/check-app.mjs`, fixed runs 1/2/3 | **each exit 1**, 24.51s / 25.26s / 24.94s; native Logs focus timeout | `SMOKE_RESULTS.json`, `evidence/smoke-{1,2,3}.log` |
| Same `DESKTOP_APP`, `node apps/desktop/scripts/check-launch-services.mjs` | exit 0, 3.81s; Unicode path, packaged runtime, parent-loss cleanup | `evidence/launch-services.log` |
| `node apps/desktop/scripts/bundle-manifest.mjs verify <app> <manifest>` after all runtime checks | exit 0; all 10,543 entries unchanged | `evidence/manifest-after.json` |

The source gate includes uncached typecheck (17/17), fresh Desktop build, Bun
8,536 passed / 29 existing skips, Smithy Vitest 325, Desktop Node 6 and gate runner
regressions 5. It ran once; no failed check was excluded or retried. Packaging
warnings about Browserslist age, bundle size and deprecated prebuild-install are
retained. Frozen install warned about not-yet-built workspace CLI links.
This is an unsigned local macOS arm64 preview. Signing/notarization, Intel/other
platforms, full browser/root test suites and live provider calls were not checked.
The source gate's 29 existing skips are retained, not counted as passing coverage.

`check-safeguards.mjs` requires the selected app's actual Node executable and
imports production JS only from its backend. It exercises real temporary Git
repositories and SQLite: local-descendant creation/triage and CLI sync; remote
publication refusal; failed local delivery retaining REVIEW/source/target;
squash/no-ff literal messages and marker absence; merge-status literal refs/hash
and refusal of local-only delivery even with force; divergent-target rejection;
five canonical/default/conflicting workload capacity cases; unavailable versus
measured-zero usage; Codex deduplication/cache categories, unknown pricing and
resumed-thread suppression. These are packaged behavior checks, not source-only
tests or string searches. They do not spawn provider sessions.

All 296 deployed workspace JS files (Smithy 125, Quarry 117, storage 9, core 30,
shared routes 15) and 186 built web files match the clean-source build byte for byte;
see `evidence/source-bundle-byte-match.json`. This proves which UI build was packaged,
not successful GUI coverage of the Metrics screen.

The 69-test matrix's CLI subprocesses use this app's bundled Node/CLI; direct
helper/service calls in those Bun files still execute source. Do not describe all
69 as direct packaged-module tests. The separate 15-check Node script above imports
only packaged production modules. All Git remotes in both fixtures are local temp
repositories; no live project, provider session or external publication is involved.

Recheck the exact artifact from any source checkout containing these scripts:

```sh
DESKTOP_APP='/Users/citius/Desktop/Work/Stoneforge-artifacts/el-1zar-d121628/Stoneforge Desktop.app'
node apps/desktop/scripts/bundle-manifest.mjs verify "$DESKTOP_APP" \
  /Users/citius/Desktop/Work/Stoneforge-artifacts/el-1zar-d121628/BUNDLE_MANIFEST.json
DESKTOP_APP="$DESKTOP_APP" "$DESKTOP_APP/Contents/Resources/runtime/node" \
  apps/desktop/scripts/check-safeguards.mjs
```

Standalone copies of the manifest and bundled-safeguards scripts are also retained
in `evidence/tools/` beside the artifact and can be run from there after worktree
cleanup. The GUI harness copies are audit evidence; running them still requires
the repository's installed Playwright dependencies and directory structure.

The GUI stability sample was fixed at three full `check-app.mjs` invocations on
this same app, followed by one `check-launch-services.mjs`. `SMOKE_RESULTS.json`
records every outcome. Each smoke passed real PTY, footer identity, three-project
rendering/isolation, HTTP/WS/SSE authentication and project switching, then failed
at `check-logs.mjs:39` / first open at line 108: `Native focus did not settle`.
No Logs visual/scroll/focus acceptance or onboarding acceptance is claimed. Empty
`logs-observations.json` files are retained; failure preceded screenshots/onboarding
artifacts. Fixtures: `stoneforge-electron-aq5yyM`, `stoneforge-electron-Gm7kqN`,
`stoneforge-electron-I75xH3`. Launch fixture: `stoneforge-launch-FNmIAK`.

At `2026-09-26T15:57:58.355669Z`, read-only `ioreg -n Root -d1` reported
`IOConsoleLocked=Yes` and `CGSSessionScreenIsLocked=Yes`; the sanitized snapshot is
`evidence/gui-environment.json`. This is a confirmed environmental obstacle to
native focus, not proof that no production issue can remain. It was captured after
the matrix, not continuously during each run. No unlock, focus assertion bypass,
GUI harness change, extra sleep or retry-until-green was attempted. After Human
provides an unlocked graphical session, verify that precondition and declare a new
bounded sample before running it. Keep these three failures permanently visible.
Independent steward verification of the same exact app remains outstanding.

## Metrics included and remaining limits

This app includes el-5psa attribution/usage coverage, el-33hc availability UI/CLI,
and el-10qu summary/model/total cache denominator. The latter uses
`read / (uncached + read + creation)`, weighted by token counts; unknown legacy
coverage and measured-empty denominators are N/A. See workspace reference el-1fqa
and `provider-metrics-el-5psa.md` for evidence and historical failures.

Schema 13 adds nullable usage availability. It does not backfill old attribution
or provider counters. Resumed Codex lifetime totals are deliberately suppressed;
interactive paths without the collector and unsupported provider usage can remain
unavailable. Unknown/multiple-model pricing is unavailable, not free usage. No live
provider calls or billing verification were performed. The active-agent card's
separate cache ratio defect was already reported to Director (el-1t45); it is outside
the included summary/model/total fix and is not fixed in this artifact. Its later
el-1onu source fix is now on local master 5b58361 and must enter the next candidate.

## Proposed update runbook — do not execute without separate Human approval

### 1. Review and inventory, before approval

Director obtains steward's independent verdict specifying final task commit,
the exact artifact path/identity and the manifest hash above. Steward must rerun
the required gate, verify this manifest before/after runtime checks, inspect the
packaged safeguards, run the fixed GUI sample and LaunchServices against this app,
and preserve all outcomes. Source approval alone does not approve the app.

Inventory the installed `~/Applications/Stoneforge Desktop Preview.app` identity,
executable path/PID and actual Electron userData directory. At preparation time
the installed identity was `0.1.0` / `497e0995c285020c17a23bbe0513e4126ca5f92c`,
built `2026-09-26T12:07:38.953Z`; it was not replaced. The observed userData registry
is `~/Library/Application Support/Stoneforge Desktop/projects.json`, listing
Stoneforge and photo-cleanup. Re-read it at execution time: **Quit affects every
open project**, including adopted external servers. Do not assume the other
project has no sessions or that closing a window stops the app.

For each registered/open project, use its exact `STONEFORGE_ROOT` with approved
`sf agent list`, `sf daemon status`, `sf repo list`, and the authenticated API
`GET /api/sessions?status=starting,running,suspended,terminating`. Use the CLI's
`getOrchestratorUrl`/`orchestratorFetch` (or the project's UI); do not guess port
3457 or print connection secrets. Record agent/session IDs, task/worktree/branch,
uncommitted/unpushed work, resumability/provider IDs, daemon/dispatch state, owning
server PID/start time/database and any external/adopted process. Match owners using
the lock/descriptor and OS database/socket ownership. Resolve discrepancies first.

The preparation snapshot (`evidence/agents.txt`, `daemon.txt`) has daemon running,
dispatch active, both workers running and the Director running. It is not an
execution-time inventory or permission to interrupt them. Capture a human-readable
resume list; do not copy raw transcripts or credentials into the review record.

Human approval must identify: exact app + manifest, maintenance window, **all**
affected projects/sessions and any allowed interruption, operator, backup location,
whether/when dispatch may resume, and rollback policy. If any affected project is
not approved or work is not safely saved, postpone the app replacement. Do not
create an automatically dispatched install/stop task to obtain this approval.

### 2. Quiesce only after that approval

Execute from an operator terminal outside the app that will be stopped. Stop
dispatch via the approved CLI's `sf daemon stop` scoped separately to approved
project roots. Ask workers to complete or hand off and commit/push their branches;
preserve uncommitted work instead of resetting/stashing it automatically. Wait for
steward/worker work to settle and stop the Director last. Do not assume stopping
the daemon also stops existing sessions.

Use supported agent/session stop controls for explicitly approved sessions, then
Desktop Stop for their project servers. Quit the old app only when every remaining
affected project is approved. The manager handles graceful shutdown and may escalate
its own child shutdown; do not add broad `pkill`, manual SIGKILL or stale-lock
deletion. Verify no old app/backend/agent owns each database/socket and locks are
released. If shutdown is incomplete or ownership is uncertain, stop the procedure
and report it; do not replace binaries or copy live database files as a cold backup.

### 3. Back up application and data before the first new launch

Choose a dated backup directory outside worktrees with enough space, access limited
to the user, and record its path. Use macOS `ditto` to copy the **entire old .app**,
the actual Electron userData directory (including projects.json, preferences and
partitions), and each approved project's **entire `.stoneforge` directory** after
writers have stopped. Preserve uploads, sessions, prompts, config, repository
registry, exports and SQLite sidecars if present; record worktree/branch state too.
Do not delete or reconstruct the database from JSONL: exports can lag live data
and do not represent all metrics/session tables.

Use SQLite's standard online-backup interface (`sqlite3 SOURCE '.backup DEST'`,
with correctly quoted chosen paths) to produce a standalone database backup, and
run `PRAGMA integrity_check` **on that backup**, requiring `ok`. Keep the full cold
directory copy as well. Generate SHA-256 manifests for the old app/data copies
and compare file counts/bytes. Check the backup can be opened read-only; do not
rehearse restore on a live project. Keep backups private: they may contain secrets.

For an additional portable export use the supported
`sf export --full --include-ephemeral --output <backup-export-directory>` against
a **copy** of the backed-up project with its own `STONEFORGE_ROOT`, after removing
inherited desktop instance/DB routing from that operator command. This avoids
changing live dirty tracking. Preserve export counts/exits. JSONL is supplemental,
not a substitute for the complete SQLite/data backup. No invented `sf backup`
command is available in the inspected CLI.

### 4. Install only the exact approved app

With the old app fully stopped and backups verified, validate the candidate
manifest against the independently approved SHA-256 once more. Stage a `ditto`
copy beside `~/Applications/Stoneforge Desktop Preview.app`; verify the full
staged inventory against the same manifest. Rename the old installed app to a
dated backup name, then rename the verified staged app to the final Preview path.
Retain the external candidate and backup. Never copy a new bundle into a running
or partly replaced app. Any changed manifest/identity or copy failure aborts the
update; restore the old path before attempting a launch.

### 5. Launch, identity, health and readback before resuming work

Launch the exact Preview path via LaunchServices. Compare its footer/About and
on-disk build-info with the approved `0.1.0` / full commit / build time. Confirm
each approved project's backend executable comes from the new installed bundle;
adoption of an old external server is not a successful backend update. Require
fresh instance identity, correct project root/database and authenticated health.
Read back repositories/testCommand (`pnpm check:merge`), agents' configured limits
and workload/capacity agreement, task statuses, session history, documents,
uploads and project registry. Check Logs opens/closes; do not manufacture a real
task, provider session or metrics usage to make health appear green.

Schema migration is a real data write at first new-backend launch. Compare essential
counts/IDs with the pre-update readback and keep any errors. The app should not
auto-start directors or dispatch simply because a project opens. Resume only the
specific approved sessions/daemon states, after health/readback succeeds, using
fresh routing/instance credentials. Never reuse an old worker shell's instance ID.
Recheck workload and metrics coverage; legacy/unsupported N/A is expected and does
not justify guessed costs, backfill or a live provider test.

### 6. Rollback

Trigger rollback for identity/hash mismatch, failed migration/startup, wrong project
ownership, missing data, broken required interactions or an explicit Human decision.
Keep dispatch stopped; stop only the new approved project instances with supported
controls. Preserve post-update data/logs separately before any restore. Restore the
old app from the verified backup; reverify its identity/hash. Never run the old
backend against the migrated database assuming downgrade compatibility.

If new data was written, stop and reconcile it with Human before restoring the
pre-update snapshot; do not silently lose it. With approval, restore the matching
complete pre-update project data and userData while all owners are stopped, then
launch the old app and repeat identity/ownership/health/readback. Resume the saved
work list only after this succeeds. Keep both snapshots and candidate for diagnosis.

## Delivery

The worker commits/pushes only verification scripts/docs and **hands off** el-1zar
because GUI acceptance cannot be completed in the locked console. Director was
notified in el-2o97; no duplicate follow-up/install task was created. The resumed
worker must first resolve that precondition, finish the fixed packaged Logs/onboarding
sample and obtain the independent review through the normal task lifecycle. Only
after worker criteria pass use `sf task complete el-1zar` to enter REVIEW. Steward
records the exact app verdict and uses only the approved CLI
`task merge el-1zar --local` with the shared root after explicit required checks.
No manual PR, source publication to master, installed
app replacement, daemon/session stop, live-data backup/migration or rollback was
performed by this task. Human's update decision remains separate.
