# Projects containing multiple repositories

A Stoneforge project owns data and agent coordination. Its root need not contain
Git or any commits. Each code repository has a stable project-local ID, a checkout
path, a default merge target and an optional test command. One task targets one
repository; a change spanning repositories is a plan with dependent tasks.

## Implementation

- `.stoneforge/repositories.json` is a versioned local registry, independent of the
  project's optional Git. It includes the canonical Git common directory to detect
  duplicate linked worktrees and replacement of a checkout. Writes use an exclusive
  lock and atomic rename. Repository paths are relative to the project when possible.
- Without this file, a committed Git repository at the project root is exposed as
  `default`. Existing single-repository projects need no configuration migration.
  Empty/non-Git roots expose zero repositories and keep their database/UI available.
- WorktreeManager separates `workspaceRoot` (shared data and generated worktree
  paths) from `repositoryRoot` (Git commands). New repository worktrees live under
  `.stoneforge/.worktrees/<repository-id>/`. Existing default paths are preserved.
- Task metadata records repositoryId and locks it before dispatch, with optimistic
  concurrency checking. The core API rejects changing/removing an already bound
  repository, including generic metadata edits. Target branches are resolved and
  persisted when dispatch pins a task. Resume validates the worktree's Git identity.
- Dispatch, worker sessions, recovery, tests, merge, GitHub PR operations and CLI
  task merge/sync resolve the task's repository. Ambiguous tasks stay pending with
  a warning; they do not prevent later unambiguous tasks from being dispatched.
- The director works in project context and receives repository instructions.
  Multi-repository inbox triage runs in project context without manufacturing a
  code worktree. Workers receive the shared instruction path and their repository.
- `STONEFORGE_ROOT` keeps CLI database/API calls attached to the shared project,
  regardless of the repository/worktree used as cwd. This does not create an OS
  filesystem sandbox or separate provider accounts.
- A missing/replaced checkout is reported as unavailable. Other registered
  repositories continue to work. Repairing a moved registration is currently an
  explicit local configuration operation; paths/identities are not guessed.

## Commands and UI

```sh
sf repo add core ./stoneforge --target-branch master --test-command 'pnpm typecheck'
sf repo list
sf task create --title 'Fix an issue' --repository core
sf task update <task-id> --repository core
sf task create --title 'Second repository change' --repository another --plan <plan-id>
sf repo remove unused
```

`sf repo` commands use the project's authenticated running server. Relative add
paths resolve against the project root. Add requires an existing checkout with a
commit and refuses a second entry sharing the same Git common directory. Removing
registration never deletes files and is refused while tasks reference it or managed
worktrees remain. CLI task creation can leave the repository unspecified for later
selection; dispatch selects automatically only if exactly one repository exists.

Desktop's **Repositories** button lists/adds/removes registrations. The task create
form and detail panel select the repository, with errors, loading and empty states.
Selection is fixed once dispatch starts. Per-repository branch/test settings are
accepted by `sf repo add` and stored in the registry; they can be edited there.

## This workspace

`stoneforge/` is the single code checkout, including `apps/desktop`. The earlier
`stoneforge-desktop/` directory was a linked worktree of this same repository,
not an independent Desktop repository. Consolidation fast-forwards local `master`,
preserves local documentation in an external backup, and removes the linked
worktree using Git. The shared project remains the parent `Stoneforge/` folder.
Register only `core` at `./stoneforge`; do not initialize a wrapper Git to run tasks.

## Self-hosted development

Build and verify a separate application artifact. Keep the currently installed
application running until an explicit update/restart step. Source commits and task
merges do not replace the running app. This release does not add an autonomous
self-update mechanism.

## Optional metadata Git

A local service repository remains optional. If desired later, track only an
explicit allowlist of instructions, configuration, documentation and JSONL exports.
Do not add nested code repositories, SQLite/WAL files, credentials, logs or generated
worktrees. Creating a wrapper Git repository is not needed for dispatch.

## Acceptance checks

Real temporary Git repositories verify independent worktrees with identical branch
names, different merge targets/test commands, restart, task binding, wrong-worktree
rejection, duplicate linked-checkout rejection and missing-checkout isolation.
A real Desktop backend test registers repositories through `sf`, invokes CLI from
the other repository, restarts the backend and merges only the task's bound repository.
The existing single-project worktree/daemon/assignment/merge tests remain relevant.
No live model calls or external pushes are needed for these checks.

The packaged Electron smoke test also registers two repositories through the native
Desktop dialog, changes a task repository in the rendered UI, and verifies persisted
selection. Web build outputs belong only to their frontend Turbo tasks; packaging
rebuilds the UI before deployment to prevent stale SDK cache entries replacing it.
