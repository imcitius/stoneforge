# Quarry JSONL export and audit events — el-e86r8

## Contract

`QuarryAPI.export({ includeEvents: true })` rejects with `ValidationError`, a
`StoneforgeError` carrying `ErrorCode.INVALID_INPUT` (HTTP status mapping 400).
The guard runs before either SyncService call, including reads/serialization,
directory creation and file writes. Both string and outputPath modes reject.
Omitted/false retains the existing elements/dependencies JSONL representation.
The public optional boolean and its structural type guard remain compatible;
structural validity does not imply the requested feature is supported.

Ordinary successful JSONL export excludes audit events and their oldValue/newValue
snapshots. It is not a complete audit backup. This change adds no event schema,
import/migration, retention policy or backup subsystem and makes no claims about
other ExportOptions. Source, SDK reference/examples, README and CLI help state
this boundary. outputPath's example names a directory, matching its implementation.

## Callers and error surface

Repository search before implementation found direct QuarryAPI.export calls in
SDK integration tests, and the subsequently delivered retention investigation.
No server route or CLI command calls this method. `sf export` calls
`SyncService.exportSync` with separate options (output/full/include-ephemeral);
it has no event export flag. Autosync and direct SyncService behavior are unchanged.
Existing CLI export/import/status coverage runs against isolated fixture files.
No CLI error plumbing or unrelated option behavior is changed. SDK consumers can
catch the rejected promise as StoneforgeError and inspect code INVALID_INPUT.
ValidationError already provides the standard error serialization/status mapping.

## Baseline and regressions

Accepted baseline local master `3420c56198517a39d1219a2c1acfd0099d526429`:
`bun test packages/quarry/src/api/export-events.bun.test.ts` gave **1 pass / 3 fail**.
All three rejection cases observed `undefined` caught error (silent success),
while ordinary default/false control passed. Log: `/tmp/el-e86r8-baseline.log`.

New regressions create a fresh on-disk temporary SQLite database per case and
write only through QuarryAPI: two tasks, a dependency and an update whose retained
event has distinct oldValue/newValue titles. They assert explicit rejection for
string, absent output directory and existing JSONL files; unchanged task/dependency/
event rows and dirty tracking; no created directory or overwritten files; and
identical default/false string/file records without audit snapshots. No mock
export implementation, live SQLite/history/tasks, installed app, provider,
daemon or maintenance el-1clm is used as a fixture.

Initial focused command:
`bun test packages/quarry/src/api/export-events.bun.test.ts packages/quarry/src/api/quarry-api.bun.test.ts packages/quarry/src/api/types.bun.test.ts packages/quarry/src/cli/commands/sync.bun.test.ts`
— **321 pass / 0 fail, 790 assertions**, `/tmp/el-e86r8-focused.log`.
Frozen pnpm install and Quarry typecheck passed; lock unchanged. Public docs build
passed. `pnpm --filter @stoneforge/quarry test:node` exited **1: no test files**;
Quarry currently has no non-Bun test files. This is not passing Node SDK coverage.
Its existing Vitest configuration was not changed to hide that result.

Final integrated gate and retention compatibility results are recorded below.
Independent registered steward review of the exact final commit and approved CLI
local delivery remain required; worker verification is not a merge verdict.


## Integration

Pre-sync gate: **187/187, exit 0, 236.68s**, `/tmp/el-e86r8-gate.log`,
`/var/folders/b6/ltn3hn4j3nq1n86rbg2j9zk40000gn/T/stoneforge-merge-check-ptzEfg/results.json`.
Local master advanced to retention delivery `75b818a`; approved CLI sync was
conflict-free (`7beb139`). The delivered retention test previously characterized
silent success. It now asserts INVALID_INPUT and performs its unchanged JSONL
audit-omission checks using default export. Historical report/probe evidence is
retained, with an explicit current-contract appendix. Final gate follows.

## Final worker verification

Integrated source `6fd35b7` includes local master `75b818a`; subsequent edits only
record these results. Five focused files (four above plus
`packages/smithy/src/services/task-session-retention.bun.test.ts`) pass **333/333,
823 assertions**, `/tmp/el-e86r8-integrated-focused.log`.
Final **`pnpm check:merge`: 188/188, exit 0, 225.87s**;
`/tmp/el-e86r8-integrated-gate.log`, exact commands/results/per-step logs:
`/var/folders/b6/ltn3hn4j3nq1n86rbg2j9zk40000gn/T/stoneforge-merge-check-PSX88u/results.json`.
Includes uncached workspace typecheck, Desktop build, **8,796 Bun pass / 0 fail /
29 existing skips**, Smithy Node/Vitest, Desktop Node and gate regression checks.
`git diff --check` and local target ancestry pass. No gate/threshold changes.
Separate root build/lint/test, browser/packaged GUI, live providers and cross-platform
checks were not run. Quarry Node's no-tests exit remains recorded above, not green.

Existing workspace architecture/retention references and Directory are updated
without discarding historical evidence. No new workspace document was needed.
Only assigned source branch was pushed. Independent exact-final steward review
and approved CLI local merge remain required; installed Desktop/live processes
and closed maintenance were untouched.
