# Agent registration ID collisions — el-2zj6n

## Finding and attribution

`registerDirector`, `registerWorker`, `registerSteward` and their shared
`createAgentChannel` called core element factories without
`QuarryAPI.getIdGeneratorConfig()`. This is a demonstrated defect: a candidate
already present in SQLite was returned without collision checking and rejected
by `QuarryAPI.create` with `ALREADY_EXISTS` / `UNIQUE constraint failed: elements.id`.
The four factory calls now receive the existing configuration. No insert retries,
threshold changes, exclusions, or merge configuration changes were introduced.

The historical el-4bwuz integrated gate remains **FAILED: 189/190**, 313.94s,
on reported revision cdc223c/base4c29bb0. Its step131 recorded26pass/1fail in
`orchestrator-api.integration.bun.test.ts`. The failing test's `beforeEach`
registered QueryDirector, QueryWorker1, QueryWorker2, and a steward sequentially;
the stack points to QueryWorker1 registration creating its direct channel.
The database is created anew per test with a randomized temporary filename.
The original fixture unlinks without explicitly closing storage; that is a
separate lifecycle observation, not an established cause of this collision.
The new regression explicitly closes its isolated on-disk SQLite backend before
removing the directory. No live database is opened by the regression.

Historical logs do not contain the conflicting ID or existing row
(`details.elementId` is undefined). They establish a duplicate primary key at
channel insertion, but do not reconstruct the exact generated candidates or rule
out every alternative. The reproduced missing-check mechanism is consistent
with that stack; exact historical attribution remains unproven. The original
27/27 isolated diagnostic does not override the failed integration gate, and this
change does not grant acceptance to el-4bwuz. Its final integration needs review
and the required gate separately.

## ID and SQLite baseline

Core hashes `identifier|createdBy|timestampNs|nonce` with SHA-256, converts it to
base36 and truncates it. Distinct high-resolution timestamps therefore cannot
guarantee distinct truncated IDs. Unconfigured factories use four hash characters
and return the initial candidate without querying storage. API configuration
provides current element count (three characters for a small database) and a
lookup across element types. Existing generator logic increments nonce on a
collision and eventually increases length. This patch uses that logic unchanged.

Quarry `create` persists an already-created element; it does not regenerate an
explicit ID. SQLite retains its global `elements.id` unique constraint. A negative
control verifies that inserting a supplied duplicate ID still rejects and retains
the original row. Collision checking is not an atomic reservation across concurrent
writers, and entity-plus-channel registration is not a single transaction; later
failures may still leave a registered entity without its channel. Neither limitation
is claimed fixed here.

`agent-id-collision-evidence/source-blobs.json` verifies identical Git blobs on
cdc223c, delivered4c29bb0 and assigned baseline24df339 for the API, original test,
generator, channel factory, Quarry API and Bun storage. No adjacent cleanup change
is needed to demonstrate the defect.

## Deterministic regression

`packages/smithy/src/api/agent-id-collision.bun.test.ts` covers all three roles and
both entity/channel allocation. A restored-in-finally Web Crypto digest spy forces
only the seed and target's nonce-zero hashes to match. Later candidates use native
SHA-256. Both three- and four-character IDs are occupied through QuarryAPI so a
length change alone cannot pass. Each case requires an observed nonzero-nonce
candidate, distinct persisted IDs, correct channel membership/agent metadata,
unchanged seed rows, and exact counts. Storage, schema, generator and lookup are
real; no SQL writes bypass QuarryAPI.

Against an adjacent temporary copy of `git show 24df339:packages/smithy/src/api/orchestrator-api.ts`,
the final regression gave **1pass/6fail**, exit1, all six failures duplicate IDs.
Only the test's API import pointed to that baseline copy; both temporary files
were removed. The production working file remained fixed throughout. Corrected
focused API + original API + core generator suites: **141pass/0fail**,394assertions.

An early fixture used an invalid channel member (`system:test`), corrected to a
valid branded-format ID before baseline evaluation. The first fixed fixture used
only a four-character seed: it demonstrated failure before the fix but could pass
by adaptive length alone. It was strengthened as described above before the gate
reached the new suite. Both preliminary logs are retained; neither is substituted
for the final deterministic baseline. The gate's typecheck excludes test files;
production source was unchanged throughout, and final test contents were in place
before its Bun suite executed. No gate failures were retried.

## Verification and evidence

Environment: macOS arm64, Node22.23.3, Bun1.3.11, pnpm8.15.5.

- `pnpm install --frozen-lockfile`: exit0; lockfile unchanged.
- `pnpm --filter @stoneforge/smithy typecheck`: exit0 (production sources).
- Final baseline `bun test packages/smithy/src/api/agent-id-collision.baseline.test.ts`:
  exit1,1pass/6fail; temporary original API module, removed afterwards.
- `bun test packages/smithy/src/api/agent-id-collision.bun.test.ts packages/smithy/src/api/orchestrator-api.integration.bun.test.ts packages/core/src/id/generator.bun.test.ts`:
  exit0,141pass,394assertions.
- Required `pnpm check:merge`: **exit0,191/191 checks,295.89s**. New regression
  7/7 (75 assertions), original API27/27. Tested source/test commit
  `54289c6`; subsequent changes only add evidence/documentation.
  Full logs: `/var/folders/b6/ltn3hn4j3nq1n86rbg2j9zk40000gn/T/stoneforge-merge-check-Pq4S7U/`.
  Gate console, results and both API suite logs are preserved in the evidence folder.
- `git diff --check` and SHA-256 readback of all16 evidence files: passed.

Original console, failing step, full results JSON and isolated diagnostic are
preserved byte-for-byte with original paths and SHA-256 in
`agent-id-collision-evidence/manifest.json`. Investigation logs are preserved there
as well. Current full gate step logs remain in the path recorded below.
Separate root build/lint/test, browser/packaged Desktop, Node Quarry/core/storage,
and live provider suites were not run. Required gate runs its declared typecheck,
Desktop build, isolated Bun suites, Smithy Node and Desktop Node checks. No app
installation, live provider/session, daemon, merge approval or external publication
was performed. Independent steward review remains required.
