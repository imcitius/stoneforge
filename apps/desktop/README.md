# Stoneforge Desktop — macOS technical preview

A single window for local Stoneforge workspaces. Each project has an
independent Node backend, browser session and dashboard. Switching projects keeps
its agents running. The app ships Node 22.23.3, SQLite, PTY and the existing web UI.
Codex and Claude Code must already be installed and authenticated on the Mac.

This is the first implementation slice of [the desktop plan](../../docs/plans/desktop-workspaces.md),
not the completed daily-use release. See [verification and remaining work](../../docs/plans/desktop-spike.md).

`imcitius/stoneforge` is now the main repository (upstream `stoneforge-ai/stoneforge`
is no longer maintained). Its releases are these macOS Desktop builds, created from
`v*` Git tags by `.github/workflows/desktop-release.yml` (see [Releases](#releases)).
Nothing in `.github/workflows` publishes npm
packages: the upstream changesets `publish.yml`, which also created `v<version>`
GitHub releases, was removed so it cannot collide with Desktop tags. CI runs on
push/PR to `master`; the docs/website Cloudflare deploys are manual-only because
they target upstream hosting and secrets.

## Build and run

From the repository root, on macOS arm64:

```sh
pnpm install --frozen-lockfile
pnpm --filter @stoneforge/smithy... build
pnpm --filter @stoneforge/smithy-web build:web
pnpm --filter @stoneforge/desktop build
pnpm --filter @stoneforge/desktop package:mac
open 'apps/desktop/dist/mac/Stoneforge Desktop-darwin-arm64/Stoneforge Desktop.app'
```

Packaging rebuilds the web UI and builds/checks native SQLite against the bundled Node ABI. Packaging also repairs the deployed PTY helper permissions and verifies a real
PTY spawn/output/exit inside the final app, without calling an agent provider. Native files
and the Node executable live outside ASAR. The bundle can be moved independently
of the checkout. Packaging applies and verifies a local ad-hoc code signature after assembling the
final bundle, including its notification identity; external
distribution and notarization are a later step. Intel builds are not verified.

### Release packaging (version, zip, dmg, checksums)

Release builds are Apple Silicon (arm64) only, ad-hoc signed and not notarized.
Pass the release tag to `package:mac`, then archive the final signed app:

```sh
# From the repository root, after `pnpm install --frozen-lockfile`, with the pinned
# Node 22.23.3 first on PATH. Either form works; they must agree if both are set.
STONEFORGE_RELEASE_VERSION=v1.26.0 pnpm --filter @stoneforge/desktop package:mac
# node apps/desktop/scripts/package.mjs --version v1.26.0-rc.1
node apps/desktop/scripts/release-artifacts.mjs --version v1.26.0
```

- The version must be strict semver `MAJOR.MINOR.PATCH[-PRERELEASE]`, optionally
  prefixed with `v` (stripped): `v1.26.0` and `v1.26.0-rc.1` are valid; `v1.2`,
  `1.2.3.4`, leading zeros and build metadata (`+…`) are rejected before any work.
- Release mode refuses to start when the Git tree has modified or untracked files,
  or when the build-info commit is not `HEAD`, and fails if HEAD moves or the tree
  becomes dirty during packaging. It rebuilds `@stoneforge/smithy...` and Desktop
  first, because ignored `dist/` output is not covered by the clean-tree check.
- The version is written to `Info.plist` (`CFBundleShortVersionString` and
  `CFBundleVersion`, both the full semver string, including any prerelease suffix;
  see the [prerelease limitation](#tags-and-prereleases)),
  the bundled `package.json`/`build-info.json` (`"release": true`) and therefore the
  project-toolbar build label and About panel. Without a release version, local packaging is
  unchanged: `package.json`'s version, modified trees allowed (shown as `(modified)`).
- `release-artifacts.mjs` accepts only a clean release-mode arm64 app (default
  `dist/mac/Stoneforge Desktop-darwin-arm64/`, or `--app`/`DESKTOP_APP`). It recreates
  `apps/desktop/dist/release/` with `Stoneforge-Desktop-<version>-arm64.zip`
  (`ditto -c -k --sequesterRsrc --keepParent`, preserving the signature),
  `Stoneforge-Desktop-<version>-arm64.dmg` (UDZO, HFS+, app plus an `/Applications`
  link) and `SHA256SUMS.txt` (check with `shasum -a 256 -c SHA256SUMS.txt`).
- It then extracts the zip and mounts the dmg read-only in temporary directories,
  runs `codesign --verify --deep --strict` on each app, compares each against the
  source app's complete `bundle-manifest.mjs` inventory, checks their version, and runs
  `scripts/check-app.mjs` on the extracted zip app. The GUI smoke needs an unlocked
  graphical session; `--no-smoke` skips it and is not release acceptance.

- When running release mode directly in a worktree, an untracked cache such as a
  hook's `.a5c/` directory counts as dirty. Park it outside the checkout for the
  build (`mv .a5c ../.a5c-parked`, move it back afterwards) instead of relaxing the
  check; `scripts/ci-release-local.sh` (below) builds a clean clone and is unaffected.

For development, rebuild the workspace SQLite addon for the pinned runtime first:

```sh
PATH="$PWD/apps/desktop/node_modules/node/bin:$PATH" pnpm --filter @stoneforge/storage rebuild better-sqlite3
pnpm --filter @stoneforge/desktop dev
```

The right end of the project toolbar shows the bundled version and commit hash. Hover for the full
commit, branch and build time; the macOS About panel shows the same identity.
A `(modified)` suffix means the build included uncommitted source changes.
This metadata is baked into the application, independent of subsequent source edits.

## Releases

GitHub Releases of `imcitius/stoneforge` are produced only by
`.github/workflows/desktop-release.yml`. Pushing a `v*` tag builds the app on a pinned
Apple Silicon runner (`macos-15`, Node 22.23.3, pnpm 8.15.5), verifies it and publishes
the release. Nothing else in the repository publishes npm packages or creates releases.

### Cutting a release

```sh
pnpm release v1.26.0        # validates, checks the tree, prints the commands; changes nothing
git tag -a v1.26.0 -m "Stoneforge Desktop v1.26.0" <commit>
git push origin v1.26.0     # starts the workflow
gh run list --repo imcitius/stoneforge --workflow desktop-release.yml --limit 3
```

`pnpm release` (`scripts/release.mjs`) replaced the former upstream `scripts/release.ts`
(npm publish plus `gh release create v<version>`). It only validates the version with
the same parser as `package:mac`, refuses a dirty tree or an existing local/remote tag
or GitHub release, warns when `HEAD` is not `origin/master`, and prints the exact tag
commands. It creates, pushes and publishes nothing.

#### Tags and prereleases

- Tags are `vMAJOR.MINOR.PATCH` or `vMAJOR.MINOR.PATCH-PRERELEASE` (strict semver, see
  above). Any tag with a `-` (for example `v1.26.0-rc.1`) is published as a GitHub
  **prerelease**, which GitHub never marks as "latest".
- Prefer final tags for releases users should install. `CFBundleVersion` carries the
  prerelease suffix (it is not purely numeric); this is accepted outside the App Store,
  but macOS does not guarantee `1.26.0-rc.1` → `1.26.0` ordering for update/version
  comparisons.
- A release can never be overwritten silently: the workflow fails before building when
  a release (including a draft) already exists for the tag, checks again right before
  publishing, and `gh release create` itself refuses duplicates. To redo a release,
  delete it deliberately or, better, tag a new version.

### What the workflow does

Each step runs one subcommand of `scripts/ci-release.sh`:

1. `resolve`: tag/version (strict semver, `v` required), prerelease and dry-run mode.
2. `preflight`: macOS arm64, exact Node/pnpm pins, checkout `HEAD` = `GITHUB_SHA`
   with a clean tree, the tag points to that commit, no existing release.
3. `pnpm install --frozen-lockfile`, then `build`: the [Build and run](#build-and-run)
   sequence and `package:mac` in release mode with the tag's version.
4. `artifacts`: `release-artifacts.mjs` creates the zip, dmg and `SHA256SUMS.txt`,
   verifies `codesign --verify --deep --strict`, the complete inventory and version of
   the extracted zip and the mounted dmg, and runs the `check-app.mjs` GUI smoke on the
   extracted zip app (GitHub macOS runners have a graphical session; `--no-smoke` is not used).
5. `verify`: independently checks exactly these three files, `shasum -c`, `hdiutil verify`,
   and for the packaged and the extracted app: build-info commit = `GITHUB_SHA`,
   `dirty=false`, `release=true`, version, arm64-only executable and codesign; the tree is
   still clean afterwards.
6. `notes`, then `publish`: `gh release create <tag> --verify-tag --generate-notes`
   (`--prerelease` for `-` tags) with the zip, dmg and `SHA256SUMS.txt`, a fixed section
   (arm64 only; ad-hoc signed, not notarized, first-launch steps; Codex/Claude Code CLIs
   must be installed and authenticated) and GitHub's generated notes.

Any failure fails the job. The job has `contents: write` only, uses no secrets beyond
`GITHUB_TOKEN`, caches the pnpm store and runs one release per ref at a time.

**Dry run.** Actions → *Desktop release* → *Run workflow* (`dry_run` is on by default,
`version` optional; default the tag name or `0.0.0-dryrun.<run number>`). It runs the
same build and verification and uploads `stoneforge-desktop-<version>-arm64` (release
files plus notes, kept 14 days) as a workflow artifact; it never creates a release. A
non-dry-run dispatch must be started on a `v*` tag ref.

**Local rehearsal.** `scripts/ci-release-local.sh [--version v0.0.0-local.1] [--keep]`
clones the committed `HEAD` into a temporary directory, creates the tag only in that
clone, and runs the same subcommands with the environment of a tag push, printing the
`gh release create` command instead of running it. It needs an unlocked graphical
session, Node 22.23.3 first on `PATH`, pnpm 8.15.5 and an authenticated `gh` (used
read-only for the existing-release check). Uncommitted changes are not included.

### Artifacts

| File | Contents |
|------|----------|
| `Stoneforge-Desktop-<version>-arm64.dmg` | Compressed disk image with the app and an `/Applications` link |
| `Stoneforge-Desktop-<version>-arm64.zip` | The same signed app (`ditto`, preserves the signature) |
| `SHA256SUMS.txt` | SHA-256 of both; check with `shasum -a 256 -c SHA256SUMS.txt` |

### First launch (for users)

Apple Silicon Macs only. The app is ad-hoc signed and **not notarized**, so Gatekeeper
blocks the first launch of a downloaded copy. After moving **Stoneforge Desktop** to
`/Applications`, either right-click (Control-click) it → **Open** → **Open** (macOS 15
and later: open it once, then System Settings → Privacy & Security → **Open Anyway**), or:

```sh
xattr -dr com.apple.quarantine '/Applications/Stoneforge Desktop.app'
```

Install and authenticate the Codex and/or Claude Code CLIs before starting agents; the
app bundles Node, SQLite and `sf` but not the provider CLIs or their logins.

## Use

1. Existing local `sf serve` processes can stay running. On macOS Desktop finds
   the selected database's owner, checks its listening socket and workspace health,
   and connects to that process. It never guesses the project from port 3457.
2. Choose **Add project** and select a project folder. If it has no database,
   Desktop offers initialization with the bundled CLI. Choose Review, Auto, or
   Approve; existing configuration and exported data are reused when present.
   Cancel leaves the folder unchanged. Setup progress appears in the project toolbar,
   and failures use a native dialog visible above an open project. Adding a project
   (or launching with `--project=<path>`) is an explicit request to open it, so its
   server and task processing start once, unless task processing was explicitly paused.
3. Projects are tabs in the window's title bar, right of the macOS window buttons;
   the project dashboard uses the full window width beneath the tab bar and toolbar.
   Each tab shows the project name (truncated with an ellipsis) and a status dot:
   ● running, ○ stopped, ◌ starting/stopping (animated unless Reduce Motion is on),
   ✕ error, and an amber **!** badge when a director needs your input. The tooltip
   shows the full name, path and status; the active tab is highlighted. **＋** at the
   end of the tabs opens Add project. Tabs that do not fit move to the **»** menu,
   which lists the remaining projects with their status (it shows a badge when one
   of them needs input); the active project always keeps a visible tab.
   Select a tab with the mouse, ⌘1…⌘8 (⌘9 = last project) or ⌃Tab / ⌃⇧Tab — the
   shortcuts also work while a project dashboard or terminal has focus, and focus
   follows to the newly shown project. In the tab list ← → move focus, Home/End jump,
   Enter/Space select (role `tablist`/`tab` with `aria-selected`). Selecting a tab
   only shows that project: projects, agents and terminal sessions keep running and
   nothing is reloaded. **Selecting never starts a project** (mouse, keyboard, ⌘1…9,
   ⌃Tab, the » menu or a notification): a stopped project shows its state page with
   **Start project** (and **Show logs**), and stays stopped until you start it.
   Desktop does not restore a selection at launch, so nothing starts invisibly.
   Starting a project starts task processing (the dispatch daemon), including on an
   adopted external server, unless you explicitly paused it with `sf daemon stop`
   or the dashboard daemon toggle. A running project with processing stopped shows
   **Task processing paused** in its toolbar/tab status; its tab menu offers
   **Task processing paused — Resume**. Resume persists across restarts. Desktop
   polls status every three seconds, including changes made from the CLI/dashboard.
   Starting does not directly restore director terminals; the daemon may dispatch
   eligible work and recover assigned worker/steward sessions.
   Empty title-bar space drags the window; tabs and buttons do not.
4. Project commands are in each tab's menu: right-click / Control-click a tab, press
   Shift+F10 when it has keyboard focus, or use the compact **⋯** button at the right
   end of the active tab (it follows the tablist in the Tab order; accessible name
   "Actions for <project>"). The menu shows **Start Project** or **Stop Project…** by
   state, **Restart Project…** while running, then **Show Logs**, **Repositories…**
   (needs a running project; it never starts one), **Move Tab Left/Right** and
   **Remove Project…**. Items act on that tab's project only and do not change the
   selection. Stop, Restart and Remove ask for confirmation. Each project has at most
   one start/stop/restart/remove in progress: while one is pending (including its
   dialog) the menu shows Starting…/Stopping… and repeated clicks are ignored, so Start
   starts once and Restart stops and starts once; other projects are unaffected.
   The toolbar beneath the tabs shows the project name, a state label (Running,
   Stopped, Starting…, Stopping…, Error, Needs your input), path and build. Remove only
   removes registration; project files remain. Stop, Restart, Remove and Quit preserve
   the task-processing preference: shutting down a server never means “pause until
   resumed.” An explicit user pause stays paused after a project restart.
5. Drag a tab to reorder, or use **Move Tab Left/Right** in the tab menu. The order is stored in
   `preferences.json` in the application userData directory, never in a project;
   without that file, or when it is invalid, tabs follow registration order. New
   projects are added at the end. (The former project sidebar and its
   View → Project Sidebar / ⌃⌘S toggle were replaced by the tabs; a stored
   `sidebarCollapsed` value is ignored.)
   Getting Started (the dashboard tour) shows once per project. Skip, Esc and
   finishing are stored in that project's workspace settings, so they survive project
   restarts and app relaunches even though each backend start uses a new local port.
   Settings → Restart Onboarding Tour shows it again.
6. Closing the window keeps the application running. Quit asks before stopping
   running project servers and their agents.

When a director needs a human decision, it signals `sf agent await-input` before
asking its question. New and resumed director sessions receive this instruction
even with a workspace prompt override. Structured question tools signal the same
state. Desktop checks every running project, including hidden windows, marks it
**Needs your input**, and sends a native macOS notification with the project name.
Clicking opens that project. Human terminal input clears the request; automatic
inbox delivery and idle wakeups wait until it clears. Requests pending for five
seconds notify once, with at most one notification per session per minute.
Text in terminal history is never treated as a fresh request. A director that
does not signal its question cannot be detected reliably; this does not infer
arbitrary CLI permission prompts. Native alerts follow macOS notification and
Focus settings, and require Desktop to remain running (closing its window is OK).

The registry is `projects.json` in Electron's application userData directory.
Project databases, JSONL exports, prompts and worktrees remain in their workspace.
Project roots are stored canonically: the parent of the realpath of the project's
`.stoneforge` directory, the same path the managed backend reports in its identity
(on macOS `/private/var/…`, not `/var/…`; symlinked folders resolve to their target).
Loading the registry migrates older non-canonical entries and collapses aliases of
one workspace into the first entry (its ID, logs and dashboard storage are kept); an
unavailable folder keeps its stored root and reports "Project folder is unavailable"
when opened. The root is re-resolved before each start. If a backend still reports
a different identity, Desktop stops it, logs the reason to the project's Logs, and
keeps the project in the `error` state (shown in the sidebar) with the differing
roots in the project view and the native error dialog, instead of a silent stop.
Runtime logs are capped at 128 KB per project and persisted under `userData/logs`;
the Logs viewer shows a snapshot of the last 10,000 characters from the current run.
It opens in a separate child window above the project dashboard, sized to the
owner display’s available work area (at most 800 × 560 including native chrome).
Long lines wrap and the log region scrolls while Close stays visible. Close, Esc,
and the native window close action return focus to the owner. Reopening takes a
fresh snapshot; an empty run shows “No logs yet”. Log text cannot execute HTML or
scripts, and the viewer exposes no Node or desktop command bridge.

## Repositories within a project

The project folder does not need to be a Git repository. Use **Repositories** in
Desktop to register existing code checkouts. Tasks select a repository in their
create/detail form; dispatch binds that choice through worktree, resume, tests and
merge. A linked worktree of an already registered repository is rejected as a duplicate.
Existing projects with a committed Git root remain automatic.

The local registry is `.stoneforge/repositories.json`. `sf repo add <id> <path>
--target-branch <branch> --test-command '<command>'` also configures merge targets
and checks. Relative paths are resolved against the project folder. `sf task create
--repository <id>` selects code while retaining the shared project's database.
See [design and verification](../../docs/plans/project-repositories.md).

### Project Node versus the bundled runtime

The bundled Node runs only Stoneforge itself (backend, `sf`, native SQLite). Work
inside a repository — dependency installation, worker sessions and merge checks —
uses the Node the repository declares through `package.json` `engines.node`,
`.nvmrc` or `.node-version`. Stoneforge selects an already installed compatible
executable (PATH, nvm, fnm, Volta, asdf, mise, Homebrew `node@N`, n); it never
downloads Node, edits engine ranges, disables `engine-strict` or retries an engines
mismatch with a loose install. Set an explicit executable per repository with
`sf repo update <id> --node-path /absolute/path/to/bin/node` (or `sf repo add …
--node-path`), and return to automatic selection with `--clear-node-path`. The
selected Node is exposed through `.stoneforge/.runtime/node-shims/` at the front of
PATH; `sf` is never linked there, so it keeps resolving to the bundled CLI. When no
compatible Node exists, worktree preparation and worker start stop before running
any install command with a message listing the executables checked. Directors and
other non-worker sessions log the problem and keep their inherited PATH.
Repositories without a Node requirement are unchanged.

## Ownership and recovery

New Desktop and `sf serve` share `.stoneforge/server.lock`. On macOS, startup also
checks existing database holders with `lsof` to catch old servers without locks.
It never attaches to or kills an unrelated process. Discovered external servers
are monitored by PID, process start time, open database and listening socket;
requests are blocked when that ownership disappears. Stop/Restart/Quit also stop
adopted servers gracefully through their daemon/session APIs before SIGTERM.
The daemon stop request uses `?persist=false`, advertised by the status endpoint's
`supportsTransientStop` field. Older servers that lack this capability receive
SIGTERM through their graceful server-shutdown handler; Desktop does not call their
persisting daemon-stop endpoint.
A legacy server has no identity-token protocol: its routing is checked through
local OS ownership and health; restart it from Desktop to use the current backend. Start/stop and normal parent
exit release the lock. A hard-killed backend can leave a stale lock: read its
`owner.json`, check the recorded process and any remaining agents, and only after
verifying no server/agents still own that workspace remove the `server.lock`
directory. Automatic stale-lock recovery is intentionally not implemented yet;
a dead or reused PID alone is insufficient proof of ownership.

The secret travels through parent/child IPC, never the command line or registry.
The backend also writes a private connection descriptor inside `server.lock`
(directory mode 0700, file mode 0600, ignored by Git). Bundled `sf` discovers this
through `STONEFORGE_ROOT`, authenticates and verifies project/root/instance before
HTTP mutations, and rejects a conflicting `--server`. Restart removes the old
connection and invalidates old agent instance IDs. Task/document/message commands
use the workspace SQLite directly; HTTP commands no longer assume port 3457 in
Desktop. On macOS, CLI commands in standalone workspaces use the same database/socket
discovery and reject a different server; they no longer fall back to a different
project on port 3457. Outside a workspace, explicit server URLs remain supported.
Codex receives PATH and workspace variables in its tool environment, disables
login-shell overrides and shell snapshots for these sessions, and can write shared
workspace data from worktrees. Provider login shells restore the supplied PATH
after profile loading. `sf serve` inside a managed session reports the already
running backend instead of launching another.
Interactive Codex and Claude terminals advertise truecolor and clear inherited `NO_COLOR`,
including after login-shell profiles, so a server started by an automation does
not turn the director monochrome. This applies to newly started sessions; an
adopted older server must be restarted to load the updated provider.
Desktop supplies a UTF-8 character locale when Finder has not provided one or
has supplied a non-UTF-8 locale. This prevents terminal clipboard helpers such as
macOS `pbcopy` from interpreting Cyrillic UTF-8 as MacRoman. It affects newly
started managed backends and their sessions; adopted servers keep their environment.
The native regression `node apps/desktop/scripts/check-clipboard.mjs` checks mouse
selection/Cmd+C in xterm and the macOS helper path; it temporarily uses and restores
the system clipboard, so run it without concurrent clipboard activity.
Explicitly overriding agent environment or using another CLI version is outside
this routing guarantee; this is not an OS sandbox.
HTTP, SSE and all WebSocket upgrades require the project and instance identity.
The main process injects headers only into that project's endpoint. Each project
renderer is sandboxed, has no Node integration, and gets no desktop IPC bridge.
The shell's bridge validates sender/frame and accepts only the defined commands.
External navigation and permission requests are denied in the preview.

This is process/data isolation, not an OS filesystem sandbox for CLI agents.
Provider accounts and their account limits remain shared.

## Verification

For the routine source merge gate (including the Desktop backend tests), use
[`pnpm check:merge`](../../docs/merge-checks.md). The packaged GUI and
LaunchServices checks below remain separate acceptance checks for app artifacts.

```sh
pnpm typecheck
pnpm --filter @stoneforge/desktop build
pnpm --filter @stoneforge/desktop test
bun test packages/smithy/src/server/server.bun.test.ts packages/quarry/src/cli/commands/serve.bun.test.ts
node apps/desktop/scripts/check-app.mjs
node apps/desktop/scripts/check-launch-services.mjs
node apps/desktop/scripts/check-tabs.mjs
node apps/desktop/scripts/check-getting-started.mjs
node apps/desktop/scripts/check-attention.mjs
```

`tests/daemon-lifecycle.test.mjs` exercises real managed and adopted servers: default
processing, explicit CLI pause, stop/start, restart, Resume, Remove and exact
preference/config preservation. `tests/external.test.mjs` also checks explicit Start
on an adopted server with automatic startup disabled.

`tests/canonical-root.test.mjs` covers the registry migration (`/var` vs
`/private/var` and a symlinked alias, started against a real backend) and reports of
genuine identity mismatches through a stub backend.

`check-app.mjs` uses the workspace's Playwright installation to verify the actual
packaged Electron views, HTTP/WS/SSE authentication, isolated storage and project
switching. Its Logs regression injects snapshots into only the temporary manager,
constrains the reported work area to 600px, and checks actual wheel/keyboard
scrolling, long lines, empty logs, Close/Esc/native close, focus, reopening, and
the child window above an open project. It retains viewer PNGs and
`logs-observations.json`; `logs-native-desktop.png` captures native z-order when
macOS screen capture permission is available. The work-area override is test-side;
it does not change the host display configuration. `check-tabs.mjs` launches the packaged app with fresh userData,
a 1024 × 700 window and ten registered temporary projects (Unicode and long names; only
the projects it starts explicitly get a backend). It counts real backend starts per
project and requires that mouse, ⌘N, ⌃Tab, tablist Enter/Space, ⋯ and relaunch selection
of stopped projects start nothing; that Start (double-clicked and requested twice) starts
exactly once, a menu Start of an inactive tab keeps the selection, Stop (clicked twice)
stops only the selected project, reselecting it leaves it stopped, Restart (clicked twice)
stops and starts once with a new backend instance, and Remove keeps the project files.
It checks the per-tab menu items by state, the ⋯ button position, size, accessible name
and Tab order, and that the toolbar has no project buttons. It requires the shell layout and every native
project view to agree (full width below the 76px tab bar + toolbar), checks drag/no-drag
title-bar regions and the traffic-light position, tab status, accessible names,
tooltips and truncation, overflow into the » menu (native menu items recorded, not
tracked) with the active tab kept visible, ⌘1…⌘9 and ⌃Tab/⌃⇧Tab delivered as native key
events to the shell and to focused project views (exactly one switch each, focus follows),
tablist arrow/Home/End/Enter/Tab keyboard behaviour, the per-tab menu via right-click, ⋯ and Shift+F10,
drag-to-reorder and its persistence in userData only, resizes 1440/960/1280/1024 px, a
stopped project, unchanged view markers and backend identities (no reloads), and the
order after a relaunch that starts no project. Screenshots (shell page; plus a native
window capture when Screen Recording permission is available; the status gallery PNG is
a synthetic shell state) and `tabs-observations.json` stay in its printed fixture directory.
`check-getting-started.mjs` opens two temporary projects with fresh userData and checks
that each gets its first Getting Started tour, that Skip/Escape are remembered after a
Desktop project Restart (new backend port/origin) and a full app relaunch, that one
project's dismissal does not affect another, and that Settings → Restart Onboarding Tour
still works. Screenshots and `getting-started-observations.json` stay in its fixture
directory. `check-launch-services.mjs` launches through macOS LaunchServices with
a minimal PATH and a Unicode workspace path, and checks parent-loss cleanup.
Both use temporary fixtures and a separate app-data directory.

Environment isolation: a managed agent session exports `STONEFORGE_*`/`SF_*`
routing variables (workspace root, database path, Desktop instance ID, entity ID).
Test fixtures must never pass them to child `sf` processes. Every backend test and
check script that runs `sf` builds the child environment with `tests/fixture-env.mjs`
(`fixtureEnv(overrides)`), which strips `STONEFORGE_*`, `SF_*`, `ORCHESTRATOR_URL` and
`ELECTRON_RUN_AS_NODE` before applying the fixture's own values, so
`pnpm --filter @stoneforge/desktop test` and the packaged checks (including
`check-launch-services.mjs`) need no `env -u` prefix inside an agent session. New
tests or scripts that spawn `sf` must use that helper rather than `{ ...process.env }`.
`tests/env-isolation.test.mjs` enforces this: it fails if a file that runs `sf.js`
copies `process.env` or does not use `fixtureEnv`, and it reruns the `sf`/backend
test files with `STONEFORGE_ROOT`, `STONEFORGE_DB_PATH`, `STONEFORGE_UPLOAD_DIR`,
`STONEFORGE_DESKTOP_INSTANCE_ID`, `STONEFORGE_SESSION_ID` and `SF_ENTITY_ID` aimed at
an initialized sentinel workspace, requiring every sentinel file (database, WAL/SHM,
config, uploads) to stay byte-for-byte unchanged with the same mtime.

The packaged UI smoke clears these variables in its fixture environment itself. Diagnostics stay
in the printed temporary directory. `DESKTOP_APP` can select a relocated bundle.

The fresh-project regression holds the real workflow-preset request until the
activity page renders, proving that an initially absent tour can appear later.
It waits for the active tour and clicks its normal **Skip tour** button, then
requires persisted completion, cleared step storage and detached tour elements
before navigating to Tasks. It exercises the real **Start Session** click and
visible mocked PTY launch error both immediately after Skip and after full
navigation with completed onboarding. A DOM observer detects returning backdrops
through the remainder of the smoke; it never changes the page. No completion flag
is injected, and no provider session is launched by these mocked checks.
This requires the configured fixture's normal tour to become available; a missing
tour fails the check rather than silently bypassing it.

Onboarding evidence is retained alongside Logs evidence as
`onboarding-observations.json`, `onboarding-active.png`, `onboarding-skipped.png`
and `director-start-*.png`. For stability acceptance, run a fixed set of three
complete smoke invocations against the same identified, separately built `.app`.
Each invocation creates new projects and userData. Save every invocation's output
and exit code, including failures; a later pass does not erase a failed outcome.
The smoke completes onboarding through UI synchronization, without force clicks,
overlay removal, added sleeps, or retrying whole runs until green.

Native focus checks require an unlocked macOS graphical session. If the Logs
focus check fails, retain the failure and inspect the console lock state before
starting another bounded sample; do not bypass native focus assertions. A passing
LaunchServices check alone does not establish Logs or onboarding acceptance.

For a release candidate, keep the relocated app and its evidence outside managed
worktrees. `scripts/bundle-manifest.mjs create APP MANIFEST.json` records the complete
file/directory/link inventory and permissions; `verify` rejects changed or extra
entries and escaping symlinks. Keep the manifest outside the app and record its
SHA-256 separately. With `DESKTOP_APP` set to that exact bundle, run
`"$DESKTOP_APP/Contents/Resources/runtime/node" scripts/check-safeguards.mjs`
from this directory to test bundled ancestry/sync, Git argument safety/local
delivery, workload and metrics on temporary fixtures without provider sessions.
These checks supplement the GUI and source gates. See the
[el-1zar candidate/update runbook](../../docs/workspace/desktop-update-el-1zar.md)
for its recorded results, limitations and the separate Human approval boundary.

Electron 44.4.5 bundles Undici 7.29.1, which can throw an uncaught
`setTypeOfService EINVAL` on macOS. The main process installs a narrow socket
workaround before HTTP requests; other errors still propagate. The Desktop test
suite injects this failure into the pinned Electron runtime, checks the unpatched
failure, and verifies successful requests with the workaround. Remove it once the
bundled Undici includes [the upstream fix](https://github.com/nodejs/undici/pull/5547).

Opt-in provider validation makes real API calls through the packaged terminal:

```sh
node apps/desktop/scripts/check-app.mjs --live
# Or validate Claude alone:
node apps/desktop/scripts/check-app.mjs --claude-only
```

It starts Claude and Codex in separate temporary projects, accepts trust only for
those generated fixtures, observes output with xterm's terminal emulator, tests
resize, and stops the sessions. It does not change provider credentials. A 401
from a provider is a failed live check, not a successful desktop test.
