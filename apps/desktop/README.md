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
of the checkout. Packaging currently produces an unsigned local `.app`; external
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
5. Closing the window keeps the application running. Quit asks before stopping
   running project servers and their agents.

The registry is `projects.json` in Electron's application userData directory.
Project databases, JSONL exports, prompts and worktrees remain in their workspace.
Runtime logs are capped at 128 KB per project and persisted under `userData/logs`;
the Logs dialog shows the last 10 KB from the current run.

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
Interactive Codex terminals advertise truecolor and clear inherited `NO_COLOR`,
including after login-shell profiles, so a server started by an automation does
not turn the director monochrome. This applies to newly started sessions; an
adopted older server must be restarted to load the updated provider.
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

```sh
pnpm typecheck
pnpm --filter @stoneforge/desktop build
pnpm --filter @stoneforge/desktop test
bun test packages/smithy/src/server/server.bun.test.ts packages/quarry/src/cli/commands/serve.bun.test.ts
node apps/desktop/scripts/check-app.mjs
node apps/desktop/scripts/check-launch-services.mjs
```

`check-app.mjs` uses the workspace's Playwright installation to verify the actual
packaged Electron views, HTTP/WS/SSE authentication, isolated storage and project
switching. `check-launch-services.mjs` launches through macOS LaunchServices with
a minimal PATH and a Unicode workspace path, and checks parent-loss cleanup.
Both use temporary fixtures and a separate app-data directory. Diagnostics stay
in the printed temporary directory. `DESKTOP_APP` can select a relocated bundle.

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
