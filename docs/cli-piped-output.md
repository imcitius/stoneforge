# CLI output through subprocess pipes

`sf` waits for pending stdout and stderr writes before exiting with the command's
exit code. This applies to both built Node entrypoints, Quarry and Smithy, which
share `packages/quarry/src/cli/runner.ts`. JSON envelopes, plain/quiet formatting,
error destinations and command exit codes are unchanged.

The runner queues an empty write on each stream and awaits both callbacks after
`run()` finishes. These callbacks follow earlier writes, including direct output
from command handlers. It then retains the explicit `process.exit(exitCode)` so
handles left by commands/plugins do not keep completed CLI invocations alive.
This does not flush a forcibly killed process, change signal handlers or manage
output from background work scheduled after the command returns.

## Reproduction and cause (el-3num, 2026-09-26)

On macOS arm64 / Node 22.23.3, the installed Desktop CLI and freshly compiled
Quarry/Smithy CLI at local source `bb7a938667e4f4e2a10b741c8610581cefa1de57`
were tested against a new temporary SQLite workspace. Four documents containing
Cyrillic, Hebrew, CJK and emoji were created through QuarryAPI and attached to a
temporary library. No real workspace documents or libraries were changed.

For each of the three CLIs:

| Invocation / output destination | Exit | Raw bytes | Result |
| --- | --- | --- | --- |
| `library docs <fixture-id> --json`, subprocess stdout pipe | 0 | 65,536 | Truncated, invalid JSON |
| Same JSON command, stdout redirected to a file | 0 | 1,148,710 | Complete JSON |
| Plain library listing, stdout pipe | 0 | 217 | All four rows and summary |

An instrumented subprocess observed nonzero `process.stdout.writableLength`
immediately before the existing forced exit (624,422; a queue length, not a raw
UTF-8 byte count). A control that waited for trailing stream callbacks before
calling the original exit returned all 1,148,710 bytes and exact expected document
objects. This isolates premature process exit with pending pipe writes as the
cause; neither the formatter nor the API truncated the data. The observed 64 KiB
cutoff is environment-dependent, not an API response limit.

Local evidence: `/tmp/el-3num-evidence/` contains `reproduce.mjs`, `fixture.json`,
`before.json`, raw `before-*.stdout`, `probe.mjs`, `probe-run.mjs`,
`probe-results.json`, and before/after regression logs. The retained fixture lives
under the system temporary directory. These are investigation artifacts, not
installed application updates.

## Regression coverage

```sh
pnpm install --frozen-lockfile
bun test packages/quarry/src/cli/piped-output.bun.test.ts
pnpm check:merge
```

The Bun test rebuilds both real CLI entrypoints with pnpm, then spawns **Node**
with piped stdout/stderr; it does not mock streams or execute the CLI under Bun.
All data is temporary, seeded through QuarryAPI, with inherited project/actor/
server routing removed. It verifies:

- More than 1 MiB of parseable Unicode JSON, exact equality of every document
  field, document count, final newline, exit 0 and empty stderr.
- Plain library listing, large plain document content and exact quiet-mode bytes.
- Large Unicode plain/JSON stderr, empty stdout and exit 2.
- Usage, missing-library and validation errors with exits 2, 3 and 4 in both modes.
- Successful output and timely process exit despite an intentionally active timer.

Before the fix: 14 pass / 4 fail (both entrypoints' large JSON and active-timer
JSON cases). After the fix: 18 pass / 0 fail. The new file is automatically
included by `check:merge`'s isolated Bun-file discovery. To additionally verify a
separate CLI artifact against the same temporary fixture, set `SF_TEST_CLI` to
its launcher when running this test directly. Artifact checks never replace or
restart the installed application.

## Worker acceptance and separate artifact

Runtime source tested at `139b95a671b47f6554659ce4b20192351856ced2`, including
local target `37a4969d19e9bd8239c5739e9c911b14557073b0`. pnpm 8.15.5,
Bun 1.3.11, Node 22.23.3, macOS arm64:

- `pnpm install --frozen-lockfile`: exit 0; unchanged manifests/lockfile.
- Targeted regression: exit 0, 18/18 tests, 166 assertions, 19.72 s.
- `pnpm check:merge`: exit 0, **178/178 steps**, 162.47 s runner time;
  uncached typecheck 17/17, 8,516 Bun pass / 29 existing skips, 325 Vitest,
  6 Desktop Node and 5 gate regression tests. Desktop build passed.
- An earlier gate invocation was explicitly interrupted during a documentation
  merge conflict. It is not acceptance evidence; its log is retained as
  `/tmp/el-3num-evidence/check-merge-interrupted.log`. The conflict was resolved
  preserving current activation/review details; the successful full run followed
  the completed sync and ran from a clean worktree.

Gate logs: `/tmp/el-3num-evidence/check-merge.log`, `gate-summary.json`; exact
commands, per-step exits/times and full logs:
`/var/folders/b6/ltn3hn4j3nq1n86rbg2j9zk40000gn/T/stoneforge-merge-check-xBKQ7N/results.json`.

Separate macOS arm64 artifact: `/tmp/stoneforge-el-3num-139b95a/sf`, created with
`pnpm --filter @stoneforge/smithy deploy --prod /tmp/stoneforge-el-3num-139b95a`
(exit 0). Its launcher uses its own Node 22.23.3 copied from the previously verified
el-ptim artifact. All **295 workspace JavaScript files** match the build byte for
byte (Smithy 124, Quarry 117, core 30, storage 9, shared-routes 15).
`BUILD_INFO.json` records source commit, lockfile hash and SHA-256 of those files,
Node, launcher and package manifest. BUILD_INFO SHA-256:
`0b1968ac81b9d221c45da018c5cee509244c3d3c7f752cfe09e2816b08b2c13b`.

Artifact regression command:

```sh
SF_TEST_CLI=/tmp/stoneforge-el-3num-139b95a/sf bun test packages/quarry/src/cli/piped-output.bun.test.ts
```

Exit 0: **26/26 tests**, 244 assertions, 16.78 s. This includes all 18 built-source
entrypoint cases plus eight artifact cases using the same isolated fixture;
`/tmp/el-3num-evidence/artifact-regression.log`. The active-timer preload cases
apply to the two direct Node entrypoints. The later evidence-only commit changes
no runtime source compared with the tested/artifact commit above.

The installed application/CLI, real libraries and active sessions were not replaced
or restarted. Source acceptance does not fix the installed CLI. Cross-platform,
packaged GUI and live-provider checks were not run; see `merge-checks.md` for gate
exclusions. Independent steward review of the final commit and the artifact is
required before local delivery or approval of this new artifact for operational
use. Continue to use approved el-ptim CLI for task sync/merge until that approval.
