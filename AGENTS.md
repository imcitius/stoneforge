# AGENTS.md

Instructions for the Stoneforge `core` repository in this local workspace.

## Workspace and documentation

- Shared project root: `/Users/citius/Desktop/Work/Stoneforge`. Read its `AGENTS.md`
  as well as these repository instructions. Use `sf` for shared tasks, documents,
  messages and agent data; preserve `STONEFORGE_ROOT` when working in a worktree.
- The registered checkout is `stoneforge/` beneath that root, repository ID `core`,
  local merge target `master`. Confirm current registration with `sf repo list`.
  The project root need not be a Git repository.
- Workers edit only their assigned branch/worktree under the shared project's
  `.stoneforge/.worktrees/core/`. Do not switch branches or edit the main checkout.
  Inspect another revision with `git show master:<path>` when necessary.
- `stoneforge-desktop/` was consolidated into `stoneforge/`; do not recreate it as
  a separate repository. Desktop is part of `core` on local `master`. Older worker
  branches may lack it: inspect the assigned revision before choosing commands.
- At session start run `sf docs dir --content`, then `sf document search "topic"`.
  Discover document IDs from the current directory/search; do not reuse IDs from
  another workspace. Read document contents with `sf document show <id>`.

## Source navigation

| Area | Source |
|------|--------|
| Types, errors, IDs, events | `packages/core/src/` |
| SQLite backends (Bun, Node, browser) | `packages/storage/src/` |
| Shared HTTP route factories | `packages/shared-routes/src/` |
| Quarry API, dependencies, sync, CLI | `packages/quarry/src/` |
| Orchestrator API | `packages/smithy/src/api/orchestrator-api.ts` |
| Dispatch, worker lifecycle, merge, scheduling | `packages/smithy/src/services/` |
| Spawning and session tracking | `packages/smithy/src/runtime/` |
| Repository registry and worktrees | `packages/smithy/src/git/` |
| Built-in role prompts and loader | `packages/smithy/src/prompts/` |
| Shared React components and hooks | `packages/ui/src/` |
| Smithy server and dashboard | `apps/smithy-server/src/`, `apps/smithy-web/src/` |
| Quarry server and dashboard | `apps/quarry-server/src/`, `apps/quarry-web/src/` |
| Desktop on local master | `git show master:apps/desktop/README.md` |
| Documentation site / public site | `apps/docs/`, `apps/website/` |

Inspect manifests for dependency edges: core also depends on `yaml`; shared-routes
uses core/storage, quarry uses core/storage/shared-routes, and smithy uses those
plus quarry. UI has its own React dependencies and peers, not a backend-layer chain.

## Development and verification

The root `package.json` pins **pnpm@8.15.5**. Use `pnpm-lock.yaml` and
`pnpm-workspace.yaml`; do not introduce another package manager or regenerate
unrelated lockfiles. From the assigned repository worktree:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

These root scripts invoke Turbo. Read `turbo.json` and the affected package's
`package.json` before running them. `pnpm test` runs declared package test scripts;
it does not automatically run every runtime suite or every smoke check. A green
`pnpm typecheck` is not evidence that behavior tests passed. Report actual commands,
results and omissions, and distinguish pre-existing failures from regressions.

- Core/storage/quarry/smithy and smithy-server: `test` currently uses Bun;
  `test:node` uses Vitest under Node; `test:all` runs both. Select a package, e.g.
  `pnpm --filter @stoneforge/smithy test:node`.
- Target a Bun-only regression with `bun test path/to/file.bun.test.ts`.
  Inspect imports/config before choosing a runner. Vitest configurations exclude
  `*.bun.test.ts`; a source export condition named `bun` does not change the runner.
- Smithy-web: `test:unit` uses Vitest, `test` uses Playwright. Quarry-web `test`
  uses Playwright. Browser tests need their configured browser/server prerequisites.
- Desktop (when present): `test` uses Node's test runner. Read its README and
  manifest for the pinned runtime, native dependencies and packaged smoke checks.
- Run relevant regression coverage and the currently required repository check
  from `sf repo list`. Do not modify merge configuration to bypass a failing check.

Development servers (do not start another server against a running Desktop project):

```sh
pnpm --filter @stoneforge/smithy-server dev
pnpm --filter @stoneforge/smithy-web dev
pnpm --filter @stoneforge/quarry-server dev
pnpm --filter @stoneforge/quarry-web dev
```

Standalone defaults: Smithy server 3457 / web 5174, Quarry server 3456 / web 5173.
Desktop discovers its project backend; do not assume a fixed port identifies it.

## Desktop builds and explicit updates

Build/verify a separate artifact using the README at the revision being built.
Source commits, merges and build outputs do not update the installed
`~/Applications/Stoneforge Desktop Preview.app`. Determine its version/commit from
its sidebar footer or About panel, not checkout HEAD. Installation is a separate,
explicitly coordinated step after arranging session shutdown. Do not copy over the
running application or restart sessions as part of ordinary implementation/testing.

## Data and implementation conventions

- Task, Message, Document and Entity are core elements; Plan, Workflow, Playbook,
  Channel, Library and Team are collections. Use branded IDs and existing guards.
- Mutate data through QuarryAPI or `sf`, never direct SQLite writes. SQLite serves
  live reads/writes, indexes and FTS. JSONL is the portable sync/export form; exports
  can lag live writes and rewrite files. Do not describe it as an append-only log
  or assume deleting SQLite is safe without a verified complete export/backup.
- `blocked` is computed from dependencies. Never set it directly.
  `sf dependency add --type=blocks A B` means A is blocked **by** B.
- `sendDirectMessage()` takes a document `contentRef`; CLI `sf message send`
  accepts text and handles the document. Include task ID and worker sender in
  messages to the Director.
- Check cycles with DependencyService before adding dependencies; query both
  dependencies and dependents for bidirectional `relates-to` relationships.
- Use existing StoneforgeError/ErrorCode handling; keep changes focused and preserve
  other agents' work. Add regression tests where they catch a meaningful defect.

## Agent workflow and review policy

Current configuration (2026-09-26 snapshot): Director, two ephemeral workers and
one merge steward all specify `codex` / `gpt-6-astra`. Both workers have
`maxConcurrentTasks: 1`. These are settings, not guarantees of model availability,
throughput, reasoning effort or metrics. Verify live state with `sf agent list`
and `sf show <agent-id> --json`; do not infer unsupported controls or measurements.

Director scopes tasks and dependencies. A worker implements one assigned task,
verifies it, commits only its files with a conventional prefix, pushes its assigned
branch, and runs `sf task complete <task-id>`. Do not create PRs directly or take
another task. If blocked, message the Director with task ID and run
`sf task handoff <task-id> --message "Completed / blocker / next step"`.

Before merge, the steward independently reads the task, diff and affected code;
checks every acceptance criterion; verifies relevant tests, failures and limitations;
and records a review verdict with task ID, reviewed commit, commands/results and
remaining risks. Self-review by the implementation worker is insufficient. If the
steward makes substantive implementation changes, obtain another agent's review
before merging. Unmet criteria or newly introduced failures require rejection or
handoff. Report unrelated existing failures to the Director without calling the
checks green. This is an operating policy, not a guaranteed software approval gate.

Workspace role overrides load from the shared root's `.stoneforge/prompts/`.
They **replace** the corresponding built-in file. Preserve the built-in instructions
when adding local policy. The reviewed merge-focus override is stored in
`docs/workspace/steward-merge.md`; see the current orchestration runbook in
`sf docs dir --content` for its activation and maintenance. Merely setting
`roleDefinitionRef` is not evidence that the launch path reads that document.

## Keeping shared documentation current

Search before creating. Update existing documents with
`sf document update <id> --file <path>`. Use appropriate categories (`spec`,
`runbook`, `reference`, etc.) for new documents and add them using
`sf docs add <id>`. Immediately before editing the Documentation Directory, reread
`sf docs dir --content` and preserve all other contributors' entries. Keep commands
aligned with current manifests; separate planned checks from checks actually run.
