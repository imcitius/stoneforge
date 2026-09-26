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
