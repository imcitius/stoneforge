# Git identity for worktree sync and merge (el-apzlc)

## Contract and provenance

Git resolves author and committer separately in the **actual commit worktree** and
invocation environment. Stoneforge does not supply identity defaults, reuse a prior
commit's author, or write identity config. Shared repository config, conditional
includes, `extensions.worktreeConfig`, role-specific `author.*`/`committer.*`,
`GIT_AUTHOR_*`/`GIT_COMMITTER_*`, `EMAIL`, and command-local Git config can affect
resolution. `git var GIT_AUTHOR_IDENT` and `git var GIT_COMMITTER_IDENT` are the
validation authority; an email is not subjected to an additional RFC validator
(Git accepts a local-address email and even an explicitly empty email). This check
establishes Git acceptance, not ownership of the supplied identity.

Source: `packages/smithy/src/git/identity.ts`, `git/merge.ts`, CLI
`commands/task.ts` and `commands/merge.ts`. Merge/docs stewards use the same merge
helper. Git subprocesses inherit the caller environment. Codex `server-manager.ts`
inherits its process environment, while `headless.ts` adds per-thread environment
and disables login shells/shell snapshots for project threads. Claude `env.ts`
inherits process environment plus caller overrides. None supplies a default Git
identity. A shell export does not prove an already-running application or another
agent process inherited it.

Read-only worker diagnosis (source base `bdd07d4`) found both Git identity probes
exit 128, the identity config query exit 1 (no `user.*`, `author.*`, `committer.*`),
and no identity env variables, `EMAIL`, `GIT_CONFIG_COUNT` or `GIT_CONFIG_PARAMETERS`
in that worker's environment (presence only; no environment dump). This is not an
assertion about every live session. Historical diagnosis is in shared runbook **el-of6**.

## Operator commands

Diagnose in the actual failing worktree and the same process environment:

```sh
git -C '<worktree>' config --show-origin --get-regexp '^(user|author|committer)\.(name|email|useconfigonly)$'
git -C '<worktree>' var GIT_AUTHOR_IDENT
git -C '<worktree>' var GIT_COMMITTER_IDENT
```

**Persistent configuration (not authorized, not applied).** A supported
repository-scoped baseline is `user.name`/`user.email` in the registered
repository's common local Git config (`<repo>` = path from `sf repo list`).
Worktree/conditional and role/env overrides still take precedence; verify both
probes in each actual cwd. If the owner later authorizes persistence:

```sh
git -C '<repo>' config --local user.name '<name>'
git -C '<repo>' config --local user.email '<email>'
```

**Temporary diagnostic/operational workaround (authorized).** The Human decision
recorded in el-apzlc/el-of6 (2026-09-27) authorizes only command-local values, with
author and committer explicitly the same:

```sh
env GIT_AUTHOR_NAME='Ilya Rubinchik' GIT_AUTHOR_EMAIL='ilya@r-4k.com' \
    GIT_COMMITTER_NAME='Ilya Rubinchik' GIT_COMMITTER_EMAIL='ilya@r-4k.com' \
    git commit -m '...'
```

The same env prefix may precede an approved CLI `task sync` / `task merge` command.
It is an invocation override, not a persistent repair or app update. No `--global`
setting is recommended; Git's own `--global` hint in original errors is retained
verbatim as evidence, not authorization.

## Failure boundary and preservation

Before squash/regular integration, the helper probes both roles in the new detached
merge worktree, before `git merge` modifies its index. Absent review-target creation
and publication are deferred until this probe passes. The empty temporary checkout
may be created and removed; the source branch/worktree, target commits and task
lifecycle are preserved on identity failure. The failure carries task/source/
commit-worktree context, source-worktree context when supplied, original Git stderr
and corrective guidance. No source cleanup or success bookkeeping follows it.
`GitIdentityError` is typed, so a source name containing `CONFLICT` is not
misclassified as a merge conflict.

Sync probes before a commit-producing merge in the task worktree. Up-to-date and
ordinary fast-forward paths do not require identity; configured `merge.ff` and
`branch.<name>.mergeOptions` commit/ff/squash controls are respected. Configured
no-commit/squash operations keep Git's native behavior. Non-conflict Git failures
now return the normal CLI failure envelope and nonzero exit in both JSON and plain
modes, with the original error and task/source/worktree context (JSON errors on
**stderr**). Conflict-result semantics are unchanged.

The probe is not a lock against concurrent config/env/repository changes, nor a
hook, signing, remote delivery or ownership check. Fetch/target resolution can
precede it. Later Git errors remain errors; preflight is not proof of delivery.

## Verification summary

`packages/smithy/src/git/identity.bun.test.ts` uses isolated real Git repositories,
local bare remotes, SQLite projects and current-source CLI subprocesses (system/global
Git config excluded, synthetic identities, no live project state). Coverage: missing/
partial/malformed identities; valid shared and role config; command-local identity
and Git-config overrides; distinct author/committer in commit objects; conditional
and worktree-specific config in the actual merge cwd; plain/JSON failure exits and
original errors; no merge/commit on failed preflight; source/index/target/remote/task
preservation; no premature review-target creation; no-op/ff/no-ff/no-commit controls;
unrelated Git-error preservation. Result: **54/54, 552 assertions**.

Required `pnpm check:merge` runs (Node v22.23.3 pinned first on PATH, Bun 1.3.11,
pnpm 8.15.5):

| Source | Result | Note |
|--------|--------|------|
| `7a991d2` (base `bdd07d4`) | 193/194, exit 1 | Untouched `dispatch-claim` fixture `UNIQUE elements.id` (el-1w48v) |
| `9c9943a` (merge of `1b43de2`) | 194/195, exit 1 | Untouched quarry list-scaling ratio 3.097 vs < 3, load ~15 (el-55qcdj) |
| `4501265` (authorized single rerun) | **195/195, exit 0** | Scaling ratio 2.589 |
| Final synced commit (merge of `5d28744`) | see task el-apzlc handoff/completion | Required gate rerun after master sync |

Raw logs are kept outside the repository (local temporary files and the el-apzlc task
record), per the Director rule of 2026-11-01. Root build/lint/full Playwright and
packaged GUI/provider acceptance are not implied by these runs.

## Operational CLI

Sync/merge used the Director-approved installed Preview `runtime/sf` (build
`d58bd815`, dirty=false); its four Director-supplied SHA256 hashes were re-verified
before each use. Nothing was rebuilt or replaced; no live task/app/session/daemon
state was used as a fixture; no Git identity config was written.
