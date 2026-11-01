# Dispatch-claim fixture ID collision — el-1w48v

## Original failed gate (preserved)

Discovered during el-apzlc: pinned Node 22.23.3 `pnpm check:merge` on base
`bdd07d4` **FAILED 193/194, exit 1, 379.08s**. Sole failure: step 171,
`packages/smithy/src/services/dispatch-claim.bun.test.ts`, 52 pass / 1 fail,
test `non-merge steward rejects successor at transaction; preserves
task/events/resources`. Stack: `beforeEach` line 42,
`api.create(createTask({ title: 'claim', createdBy: creator }))` →
`ConflictError ALREADY_EXISTS` / `SQLiteError: UNIQUE constraint failed:
elements.id` (`SQLITE_CONSTRAINT_PRIMARYKEY`). Copies of the original log,
step log and `results.json` are in
`dispatch-claim-id-collision-evidence/original-gate/`. That failure stands; this
change does not reinterpret it as green.

## Mechanism (historical, at `bdd07d4`, before el-4rgbi0)

The analysis in this section describes the generator as it was when the gate
failed. See "Post-el-4rgbi0 semantics" below for the current generator.

Core `generateId` hashes `identifier|createdBy|timestampNs|nonce` with SHA-256,
encodes base36 and truncates. Without a config it uses four characters and
returns nonce 0 without consulting storage. With
`QuarryAPI.getIdGeneratorConfig()` it uses adaptive length (three characters for
a small database) and an SQLite lookup, advancing nonce on collision.

At `bdd07d4` the fixture's `createEntity` (creator) and `createTask` (claim) were
unconfigured. `AgentRegistry` (services) uses its own config with a collision
check but no element count, so its two agents and two direct channels also have
four-character IDs. Before line 42 the database therefore held five
four-character IDs, and the unchecked task candidate could equal any of them.
The historical log has `details.elementId: undefined`, so the exact partner is not
recoverable; this explanation is consistent with the stack, not a reconstruction.
Relevant blobs (fixture, generator, task/entity factories, Quarry API, registry,
Bun storage) are identical on `bdd07d4` and `f1d707a`.

The leading base36 digit is biased (2^256 ≈ 36^49.5): 200k random digests gave
Σp² = 0.134 for the first character, so two random four-character IDs collide
with probability ≈ 2.87e-6 (4.8× the uniform 5.95e-7). For five pre-existing
IDs that is ≈ 1.4e-5 per `beforeEach`, ≈ 0.08% per file run
(`firstchar.{ts,log}`; the script imports the generator from the el-1w48v
worktree path). The bias is a production ID-contract question tracked in
el-45m5h; it was not changed here.

## Post-el-4rgbi0 semantics

el-4rgbi0 (`33d1c4f`, merged to local master) changed `generateId` to use the
**low-order** L base36 digits of the digest (`D mod 36^L`, zero-padded) and
raised the unconfigured default length from 4 to 6 (`DEFAULT_HASH_LENGTH`).
The first-character bias above no longer exists, and an unconfigured fixture
collision is much less likely (~N / 36^6), but unconfigured factories still do
not consult storage, so the database-aware config remains the correct fixture
contract. With `getIdGeneratorConfig()` a small database still uses length 3
(`calculateIdLength(<100)`), i.e. the last three digits of the digest.

## Change

Test-only. Every factory call in `dispatch-claim.bun.test.ts` (creator entity,
claim task, plans, blockers, lower-priority task) receives
`connection.getIdGeneratorConfig()` for the connection that persists it. No
production code, guards, thresholds, retries or dispatch assertions changed.

Regression `fixture factories use database-aware IDs when the claim task
candidate collides`: a restored-in-`finally` Web Crypto digest spy forces only
nonce-zero digests for a seed entity and the `claim` title to equal; other
candidates use native SHA-256. The seed (unconfigured, six low-order digits) and
the configured candidate (`el-` + last L characters of the seed hash, with
L = `calculateIdLength(api.getIdGeneratorConfig().elementCount)`, asserted
unchanged after insertion and shorter than the seed hash) are both occupied
through QuarryAPI, so a length change alone cannot pass. Control: the original
unconfigured expression yields the seed ID and `api.create` rejects
`ALREADY_EXISTS` with the task list unchanged. Fixed expression: three forced
digests observed, a nonzero-nonce candidate observed, four distinct IDs, exact
read-back, seeds and fixture task unchanged, task count +1.

Rebase after el-4rgbi0 (steward el-5qra review): the earlier version occupied
`seed.id.slice(0, -1)` (high-order prefix), which matched the pre-el-4rgbi0
truncation. With low-order digits that prefix is no longer the configured
candidate, so the configured generator succeeded at nonce 0 and the regression
failed (`resolved` = 0) on integrated source. The short seed is now derived from
the low-order digits and the configured length.

## Verification (macOS arm64, Node 22.23.3, pnpm 8.15.5, Bun 1.3.11)

| Command / state | Result | Evidence |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | exit 0, lockfile unchanged | — |
| `bun test packages/smithy/src/services/dispatch-claim.bun.test.ts` (fixed) | 54 pass / 0 fail, 331 assertions | `focused-fixed.log` |
| Mutant: regression's configured call without config (temp copy, removed) | 0 pass / 1 fail, `ALREADY_EXISTS` | `mutant-unconfigured.log` |
| `bun test …dispatch-claim.bun.test.ts` after merging master `1b43de2` (HEAD `6f71483`) | 54 pass / 0 fail, 331 assertions | `focused-merged.log` |
| `pnpm check:merge` at `6f71483` (branch + master `1b43de2`), single run, 2026-11-01T09:39:30Z–09:43:45Z | **194 checks, 0 failed, exit 0, 254.58s**; step 171 dispatch-claim 54 pass / 0 fail | `gate.log`, `gate-results.json`, `gate-171.log` |

Earlier gate attempts at `7b0c416` were killed with their worker sessions before
finishing and are not results. The `6f71483` run predates el-4rgbi0 and is not
evidence for the integrated source.

### After integration with el-4rgbi0 (merge `e1084e2` of master `33d1c4f`)

| Command / state | Result | Evidence |
| --- | --- | --- |
| Steward el-5qra: focused test on `e1084e2` (old regression) | 53 pass / 1 fail, `expect(resolved).toBeGreaterThan(0)` got 0 | review handoff note |
| `bun test …dispatch-claim.bun.test.ts` with rebased regression | 54 pass / 0 fail, 333 assertions | `focused-rebased.log` |
| Mutant: configured call without config | 0 pass / 1 fail, `ALREADY_EXISTS` | `mutant-unconfigured-rebased.log` |
| Mutant: old high-order short seed `seed.id.slice(0, -1)` | 0 pass / 1 fail, `resolved` 0 | `mutant-highorder-shortseed.log` |
| `pnpm check:merge` at `9a7ecc4` (rebased regression + master `33d1c4f`), single foreground run, 2026-11-01T10:26:51Z–10:36:33Z | **195 checks, 0 failed, exit 0, 580.48s**; step 172 dispatch-claim 54 pass / 0 fail, 333 assertions | `gate-integrated.log`, `gate-integrated-results.json`, `gate-integrated-172.log` |

A green gate shows the fixture no longer collided in that run; the regression
(forced collision + unconfigured control) is the deterministic proof.

No live task/app/session/daemon fixtures were used; no gate was retried.
