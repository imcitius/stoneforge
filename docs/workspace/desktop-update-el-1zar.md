# Desktop candidate and coordinated update — el-1zar

## Decision boundary

Updated 2026-09-26 by worker el-38k9 after the earlier el-4eqh handoff.
**Worker acceptance passed for the new 5f53cef candidate. Independent steward
review of this exact relocated app and the final report commit remains required.**
This task prepares a candidate and a reviewable installation runbook for Human;
it does not authorize stopping agents/daemons, replacing the installed app,
migrating live projects or restarting sessions. No installation task was created.
A separately rebuilt app is a different candidate, even at the same source commit.

## Current candidate identity and source

- Artifact directory: `/Users/citius/Desktop/Work/Stoneforge-artifacts/el-1zar-5f53cef`.
- Exact app: `Stoneforge Desktop.app` inside that directory, relocated before all
  runtime checks; outside managed worktrees and preserved after task cleanup.
- Clean build source: `5f53cef6e9ff262d641ba11918dfe44a8f88e3f4`.
- Local master included: `5b58361429b403e9a87edc590b70f81ba5c9353e`, including
  el-1onu active-agent cache indicator. Source differs from master only in the
  earlier verification scripts/README/runbook; production code is the current master.
- Bundled version `0.1.0`, branch `agent/e-worker-1/el-1zar-desktop`, `dirty=false`,
  builtAt `2026-09-26T16:09:38.584Z`; macOS arm64, Electron 44.4.5, Node 22.23.3.
- Adjacent `IDENTITY.json` matches `Contents/Resources/app/build-info.json`.
- `BUNDLE_MANIFEST.json`: 10,543 file/directory/symlink entries with permissions,
  file lengths/SHA-256 and link targets; SHA-256
  `770b5114ff67148d67b42d2a653930cf443b63e7b5aeb04427f10b5d54cc04d8`.
  All entries were reverified after the complete runtime sample.

The approved `/tmp/stoneforge-el-ptim-151b314/sf task sync el-1zar` with shared
`STONEFORGE_ROOT=/Users/citius/Desktop/Work/Stoneforge` merged local master into
only the assigned branch, without conflicts. All 299 approved CLI hashes and
BUILD_INFO SHA-256 were reverified. `evidence/source-preflight.json` records clean
source, target and ancestry of el-2kc/el-ptim/el-3514, Logs el-31ag, harness el-4d52,
gate/docs el-1r6, workload el-4p9h, piped CLI el-3num and metrics
el-5psa/el-33hc/el-10qu/el-1onu. No branch switch, target publication, force,
merge-status workaround or installed-CLI delivery was used.

## Current verification evidence

Shared runbook: `sf document show el-1l2t` (category `runbook`, Documentation
library/Directory); related references el-36q and el-1uyc preserve prior evidence.
All commands, exit codes and durations are in `evidence/*.json` with full logs.
`evidence/gate-steps/` preserves every gate command/output after temp cleanup.
Test children clear inherited `STONEFORGE_*`, `SF_*`, `ORCHESTRATOR_URL` and
`ELECTRON_RUN_AS_NODE`; shared sf retains the real root. Only temporary repositories,
projects and separate app-data were used. No live provider calls or external publish.

| Command | Result | Evidence |
|---|---|---|
| `pnpm install --frozen-lockfile` | exit 0, 5.378s; lock unchanged | `install.{log,json}` |
| **`pnpm check:merge`** | exit 0, **180/180**, 188.570s wall | `gate.{log,json}`, `gate-steps/` |
| `pnpm --filter @stoneforge/desktop package:mac` | exit 0, 29.636s; fresh UI, native SQLite ABI, real PTY spawn/output/exit | `package.{log,json}` |
| Bundled Node + `apps/desktop/scripts/check-safeguards.mjs` | exit 0, **15/15**, 6.143s | `safeguards.{log,json}` |
| `SF_TEST_CLI=<exact app>/Contents/Resources/runtime/sf bun test` on task-merge-status, task-merge-status-arguments, merge-arguments and target-delivery files | exit 0, **69 tests / 404 assertions**, 36.647s | `cli-matrix.{log,json}` |
| `DESKTOP_APP=<exact app> node apps/desktop/scripts/check-app.mjs`, predeclared runs 1/2/3 | **all exit 0**, 19.836 / 18.110 / 17.167s | `smoke-{1,2,3}.{log,json}`, adjacent `SMOKE_RESULTS.json` |
| Same app, `node apps/desktop/scripts/check-launch-services.mjs` | exit 0, 3.546s | `launch-services.{log,json}` |
| `node apps/desktop/scripts/bundle-manifest.mjs verify <app> <manifest>` after all runtime checks | exit 0, **10,543 entries unchanged** | `manifest-after.{log,json}` |

The single gate includes uncached typecheck 17/17, fresh Desktop build, Bun
8,536 pass / 29 existing skips, Smithy Vitest 325, Desktop Node 6 and gate regressions
5. No check was excluded or retried. pnpm 8.15.5, Bun 1.3.11, host Node 22.23.3.
Nonfatal Browserslist/bundle-size/deprecated-package warnings remain in logs.
Unsigned local preview: signing/notarization, Intel/other platforms, full root/browser
suites, live provider operation and billing were not checked. Existing skips are
not counted as passing coverage. A temporary evidence parser initially assumed
an array from ioreg and raised KeyError; corrected to accept macOS's dictionary
shape before collecting lock state. This was not an app/test failure or test retry.

`check-safeguards.mjs` requires this app's actual Node and imports production JS
only from its backend. It exercises real temp Git/SQLite: local-descendant worktree
creation/triage and CLI sync; remote publication refusal; failed local delivery
retaining REVIEW/source/target; squash/no-ff literal argv/messages and marker absence;
merge-status literal refs/hash, force refusal for local-only delivery and divergent
target rejection; five workload/capacity limit cases; unavailable versus measured-zero
usage; Codex deduplication/cache categories, unknown pricing and resume suppression.
The 69-test matrix uses bundled Node/CLI for subprocesses but source under Bun for
direct helper/service calls; it is not 69 direct packaged-module checks.

`source-bundle-byte-match.json` verifies 296 deployed workspace JS files (Smithy
125, Quarry 117, storage 9, core 30, shared routes 15) and all 186 built web files
against the clean-source build byte for byte. This proves inclusion of el-1onu's
production UI build; it does not claim live provider or full Metrics-screen coverage.

Native console snapshots before build, immediately before smoke, between runs and
after runtime report `IOConsoleLocked=false`, on-console=true. Director acknowledged
this resolved precondition and continuation in the same session. The fixed three-run
sample was declared before execution; every result is retained, no retries/bypass.
All runs include Logs bounds at 600px work area, actual scrolling, text security,
Close/Esc/native close and focus/reopen; delayed onboarding's pending -> active ->
normal Skip -> persisted completion; real Start Session clicks with mocked visible
PTY failure immediately and after navigation; repositories, initialization, isolated
storage, HTTP/WS/SSE and external-server adoption. No provider sessions are started.

Fixtures: `stoneforge-electron-lYpv0C`, `stoneforge-electron-bxOBQe`,
`stoneforge-electron-gdpD2U`; LaunchServices: `stoneforge-launch-ffUEnJ`.
PNG/JSON copied under `evidence/smoke-{1,2,3}/`; Logs end-scroll/native z-order,
active onboarding and completed-navigation screenshots visually inspected. Native
Logs is above the project with visible Close/footer identity. Onboarding JSON in
every run records `(null,null,false) -> (null,"0",true) -> ("true",null,false)`.
Mocked error visibility is asserted by Playwright locators; screenshots are supporting
evidence, not a replacement for those assertions. LaunchServices verifies minimal
PATH, Unicode workspace, bundled runtime and parent-loss cleanup on its own fixture.

Recheck the exact app from a checkout with the scripts, or use standalone copies
under the artifact's `evidence/tools/` (GUI copies still need repository dependencies):

```sh
DESKTOP_APP='/Users/citius/Desktop/Work/Stoneforge-artifacts/el-1zar-5f53cef/Stoneforge Desktop.app'
node apps/desktop/scripts/bundle-manifest.mjs verify "$DESKTOP_APP" \
  /Users/citius/Desktop/Work/Stoneforge-artifacts/el-1zar-5f53cef/BUNDLE_MANIFEST.json
DESKTOP_APP="$DESKTOP_APP" "$DESKTOP_APP/Contents/Resources/runtime/node" \
  apps/desktop/scripts/check-safeguards.mjs
```

## Historical candidate and failures — retained, not superseded as evidence

The previous clean d121628 app is frozen at
`/Users/citius/Desktop/Work/Stoneforge-artifacts/el-1zar-d121628` with its original
`VERIFICATION.md`, `HANDOFF.json`, all logs/scripts and 10,543-entry manifest SHA-256
`be78ee5cf176e0f81ac813306cb75213ad3f09848e28a467d6717d8c6908cd18`.
It passed gate 180/180 (388.07s), package/native PTY, bundled checks 15/15, CLI matrix
69/404 and LaunchServices, but **all three fixed GUI runs failed** at first Logs
native focus (24.51 / 25.26 / 24.94s); onboarding was not reached. The subsequent
15:57:58Z snapshot reported IOConsoleLocked/CGSSessionScreenIsLocked=Yes. No retries,
unlock or assertion bypass were attempted. Source then advanced with el-1onu.
It is not the current candidate and has no GUI acceptance. Its failures remain
visible even though the new-source, unlocked-console sample passed. Earlier
el-31ag/el-4d52 failures remain in reference el-1uyc and their original artifacts.

## Metrics included and remaining limits

The new app includes attribution/usage coverage el-5psa, availability UI/CLI el-33hc,
summary/model/total denominator el-10qu and **active-agent card el-1onu**. Cache hit
uses `read / (uncached + read + creation)`; aggregate ratios are weighted by counts,
and complete measured coverage is required. Legacy/unsupported or measured-empty
ratios are N/A; all-cache/creation/measured-empty rows retain their intended display.
The active-agent fix was independently reviewed before local delivery as 5b58361;
see el-1fqa and `active-agent-cache-el-1onu.md` for 18 card browser / 22 metrics
browser / 18 unit tests and gate evidence. Those prior browser suites were not rerun
as part of this candidate; inclusion is established by ancestry and byte comparison.

Schema 13 adds nullable usage availability. It does not backfill old attribution
or provider counters. Resumed Codex lifetime totals are deliberately suppressed;
interactive paths without the collector and unsupported provider usage can remain
unavailable. Unknown/multiple-model pricing is unavailable, not free usage. No live
provider calls, billing verification or guessed counters/costs were introduced.

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
dispatch active, el-38k9 and Director running, el-4eqh and steward idle. It is not an
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

## Delivery and independent review

Worker commits/pushes the report and uses `sf task complete el-1zar` to enter REVIEW
only after the worker checks above pass. Steward must independently inspect the
final source/report commit and **this exact relocated app**, reverify its manifest,
run required/relevant checks and record its verdict with commit/path/hash/results.
Do not replace it silently with a separately rebuilt app or infer approval from
source tests. No independent approval is claimed in this worker report.

After approval, source-only local delivery uses the approved CLI
`/tmp/stoneforge-el-ptim-151b314/sf task merge el-1zar --local` with the shared root.
If target changes, sync/review/check again and rebuild a new candidate if production
contents change; retain prior identities and results. No manual PR or master publish.
No installed-app replacement, daemon/session stop/restart, live-data backup/migration
or rollback was performed. Human's update decision remains separate; no automatically
dispatched installation task may be created as part of this preparation.
