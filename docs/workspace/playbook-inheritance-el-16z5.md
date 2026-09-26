# Playbook creation investigation — el-16z5

## Findings and limits

The CLI playbook factory omitted `api.getIdGeneratorConfig()`. Its default
four-character ID therefore had no database collision check. If a child ID
collided with the parent, SQLite rejected insertion and the handler returned
`exitCode: 1`, `Failed to create playbook: Element already exists (duplicate id)`.
This is a demonstrated production defect on local master, independent of the
inheritance graph. Other CLI collection factories already pass that configuration.

The fix passes the existing API configuration to `createPlaybook`, enabling the
generator's existing database-aware nonce/length collision handling and adaptive
ID length. It does not change inheritance validation or retry failed commands.
This is not a concurrent-writer reservation guarantee; insertion still enforces
the database's unique ID constraint.

**The historical el-33hc failure is not conclusively attributed.** Its log only
records expected exit code 0 versus actual 1, without `CommandResult.error`,
parent creation result or generated IDs. A collision explains that symptom but
cannot be established retrospectively from those records. Passing runs must not
be interpreted as disproving the historical failure or proving this was its cause.

## Baseline and reproduction

- Original gate: `6392b438c2e5418e50235df55e25c27841e89a64`, 179/180 successful
  checks, failed `playbook.bun.test.ts:618` (`allows valid inheritance chain
  during creation`). `/tmp/el-33hc-gate.log`; full failing step:
  `/var/folders/b6/ltn3hn4j3nq1n86rbg2j9zk40000gn/T/stoneforge-merge-check-Cvgd8R/076.log`.
- Assigned worktree initially pointed to `bb5f967`. Its assigned branch was
  fast-forwarded to local master `e7c00526cc23e312e4def0bea8e259b77359e80f` without
  switching branches or editing the main checkout. Both original playbook source
  and test blobs match the el-33hc revision: source
  `0f3dde7d0eaf1fe1873c33f3f407c214aefe16a7`, test
  `b6b06b8e3603a79c16213282c38bf4e127201350`.
- Before fixing source, a predetermined 100-process diagnostic series copied the
  original suite to `/tmp`, used absolute imports from this worktree, and added
  `result.error` assertions. Each process had a fresh fixture; inherited
  `SF_*`, `STONEFORGE_*`, and `ORCHESTRATOR_URL` were removed from child environments.
  All 100 runs passed 35 tests (3,500 total). Every outcome is retained in
  `/tmp/el-16z5-diagnostic-{000..099}.log` and
  `/tmp/el-16z5-diagnostic-results.json`; source fixture:
  `/tmp/el-16z5-diagnostic.bun.test.ts`. This was a bounded diagnostic experiment,
  not acceptance or retry-until-green.
- A separate forced `Bun.gc(true)` between parent/child creation also passed
  35/35 (`/tmp/el-16z5-gc.log`). An explicit stale-connection close after deleting
  and recreating a temporary database directory did not reproduce an error
  (`/tmp/el-16z5-stale.{ts,log}`). Neither probe proves connection lifetime safe.

## Regression and verification

The new regression deterministically makes parent and child nonce-zero SHA-256
results equal. It retains the real ID generator, database lookup, SQLite storage,
and command handlers. Later candidates use the native digest. The digest spy is
restored in `finally`. The test requires successful child creation, distinct IDs,
exact read-back of both elements, two persisted playbooks, and successful child
validation. Removing the fix makes this test fail, without relying on timing or
random collision frequency.

The original inheritance test now also asserts successful parent creation and
reports both command errors, so future failures retain the missing diagnostic.
Its existing child exit-code and inheritance assertions remain intact.

Environment: macOS arm64, Node 22.23.3, pnpm 8.15.5, Bun 1.3.11.

| Command / state | Result | Evidence |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | exit 0, lockfile unchanged | `/tmp/el-16z5-install.log` |
| `bun test packages/quarry/src/cli/commands/playbook.bun.test.ts`, new regression with unchanged production source | exit 1; 35 pass / 1 fail, duplicate ID error | `/tmp/el-16z5-collision-baseline.log` |
| Same suite after one-line fix | exit 0; 36 pass, 146 assertions | `/tmp/el-16z5-collision-fixed.log` |

One full `pnpm check:merge` returned **exit 0, 179/179 checks**, 154.79 seconds.
Tested executable source matches commit
`aa5512c81a037e042f11e313c4c3b11a5232fbaf`; no source/test edits occurred during
that run. Typecheck completed 17/17 tasks with zero cached; Bun had 8,526 pass,
0 fail and 29 existing skips; Smithy Vitest passed 325 tests, Desktop Node passed
6, and gate regressions passed 5. The 179-step count
is the local-master gate; the historical el-33hc branch includes one additional
metrics CLI suite and had 180 steps. This does not certify that branch's final
integration.

Console: `/tmp/el-16z5-gate.log`. Exact commands, exits, timings and full per-step
logs: `/var/folders/b6/ltn3hn4j3nq1n86rbg2j9zk40000gn/T/stoneforge-merge-check-boamYl/`
(`results.json` included). `git diff --check` passed.

The historical attribution remains unresolved. Independent review should assess
the collision fix on its proven merits; it must not convert the original failure
into a known collision without further evidence. The improved original test will
retain command errors if the symptom recurs. This investigation is handed back
for that explicit limitation rather than declaring historical root cause proven.

No installed application,
live project fixtures, session restarts, merge settings, test exclusions, or
assertion thresholds were changed. Shared documentation/task operations use `sf`.
