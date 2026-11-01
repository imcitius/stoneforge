# Stoneforge Desktop — macOS technical preview

A single window for local Stoneforge workspaces. Each project has an
independent Node backend, browser session and dashboard. Switching projects keeps
its agents running. The app ships Node 22.23.3, SQLite, PTY and the existing web UI.
Codex and Claude Code must already be installed and authenticated on the Mac.

This is the first implementation slice of [the desktop plan](../../docs/plans/desktop-workspaces.md),
not the completed daily-use release. See [verification and remaining work](../../docs/plans/desktop-spike.md).

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

For development, rebuild the workspace SQLite addon for the pinned runtime first:

```sh
PATH="$PWD/apps/desktop/node_modules/node/bin:$PATH" pnpm --filter @stoneforge/storage rebuild better-sqlite3
pnpm --filter @stoneforge/desktop dev
```

The sidebar footer shows the bundled version and commit hash. Hover for the full
commit, branch and build time; the macOS About panel shows the same identity.
A `(modified)` suffix means the build included uncommitted source changes.
This metadata is baked into the application, independent of subsequent source edits.

## Use

1. Existing local `sf serve` processes can stay running. On macOS Desktop finds
   the selected database's owner, checks its listening socket and workspace health,
   and connects to that process. It never guesses the project from port 3457.
2. Choose **Add project** and select a project folder. If it has no database,
   Desktop offers initialization with the bundled CLI. Choose Review, Auto, or
   Approve; existing configuration and exported data are reused when present.
   Cancel leaves the folder unchanged. Setup progress appears in the sidebar,
   and failures use a native dialog visible above an open project.
3. Select projects in the sidebar. Start agents using the existing dashboard.
   Opening a project does not resume directors or start its dispatch daemon.
4. **Stop**, **Restart**, **Logs**, and **Remove** apply to the selected project.
   Remove only removes registration; project files remain.
5. The sidebar toggle at the left of the top bar (or **View → Project Sidebar**,
   ⌃⌘S, also while a project dashboard has focus) hides the project list and gives
   its width to the project. It only moves the dashboard: projects, agents and
   terminal sessions keep running and nothing is reloaded. The choice is stored in
   `preferences.json` in the application userData directory, never in a project;
   the sidebar is visible by default and when that file is missing or invalid.
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
node apps/desktop/scripts/check-sidebar.mjs
node apps/desktop/scripts/check-getting-started.mjs
node apps/desktop/scripts/check-attention.mjs
```

`check-app.mjs` uses the workspace's Playwright installation to verify the actual
packaged Electron views, HTTP/WS/SSE authentication, isolated storage and project
switching. Its Logs regression injects snapshots into only the temporary manager,
constrains the reported work area to 600px, and checks actual wheel/keyboard
scrolling, long lines, empty logs, Close/Esc/native close, focus, reopening, and
the child window above an open project. It retains viewer PNGs and
`logs-observations.json`; `logs-native-desktop.png` captures native z-order when
macOS screen capture permission is available. The work-area override is test-side;
it does not change the host display configuration. `check-sidebar.mjs` launches the packaged app with fresh userData in a 1024 × 700
window and three temporary projects. It toggles the sidebar by mouse, Enter/Space and
the View menu item (also with a project view focused), across resizes, project switches,
loading and stopped states, and requires the shell layout and every native project view
bound to agree. It checks accessible name/`aria-expanded`, Tab order, unchanged project
views and backend identities, and persistence over two relaunches. Screenshots and
`sidebar-observations.json` stay in its printed fixture directory.
`check-getting-started.mjs` opens two temporary projects with fresh userData and checks
that each gets its first Getting Started tour, that Skip/Escape are remembered after a
Desktop project Restart (new backend port/origin) and a full app relaunch, that one
project's dismissal does not affect another, and that Settings → Restart Onboarding Tour
still works. Screenshots and `getting-started-observations.json` stay in its fixture
directory. `check-launch-services.mjs` launches through macOS LaunchServices with
a minimal PATH and a Unicode workspace path, and checks parent-loss cleanup.
Both use temporary fixtures and a separate app-data directory. When running backend
tests or LaunchServices from a managed agent session, clear inherited routing
variables for the test process only:

```sh
env -u STONEFORGE_ROOT -u STONEFORGE_DESKTOP_INSTANCE_ID \
  -u STONEFORGE_DB_PATH -u STONEFORGE_UPLOAD_DIR -u ELECTRON_RUN_AS_NODE \
  pnpm --filter @stoneforge/desktop test
# Use the same env prefix for node apps/desktop/scripts/check-launch-services.mjs.
```

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
