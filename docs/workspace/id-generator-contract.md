# Element ID generator contract — el-4rgbi0

Director decision 2026-11-01 (production ID contract), based on el-45m5h research
(evidence carried unchanged in `docs/workspace/id-base36-bias-el-45m5h/`, original
commit `cb11f7a`, cherry-picked with `-x`; steward review in shared reference
el-3uxnw). Implementation: `packages/core/src/id/generator.ts`.

## Contract

| Aspect | Contract |
|---|---|
| Root format | `ROOT_ID_PATTERN` `/^el-[0-9a-z]{3,8}$/`, unchanged. A leading `0` is now reachable. |
| Hierarchical IDs | `el-{hash}.{n}` (up to 3 levels), unchanged. |
| Hash input | SHA-256 over `identifier|createdBy|timestampNs|nonce`, unchanged. |
| Hash digits | **Low-order** L base36 digits of the digest D: `D mod 36^L`, zero-padded to L (`toBase36Digits`, `generateIdHashDigits`). |
| Length with `hashLength` | That value, clamped to 3..8. |
| Length with `elementCount` | `calculateIdLength(elementCount)`; bands unchanged. |
| Length with neither | `DEFAULT_HASH_LENGTH` = **6** (was 4). Applies also to a config holding only `checkCollision`. |
| Collision handling | Unchanged: with `checkCollision`, nonce 0..9, then length + 1, up to 8; then `ConflictError` / `ALREADY_EXISTS`. |
| Determinism | Same components + length → same digits (`generateIdHashDigits`). `generateId` adds a high-resolution timestamp and counter, so repeated calls are not expected to return equal IDs. |
| Stored IDs | Untouched, valid opaque strings. No code in this repository recomputes IDs from their inputs; no migration. |

### Uniformity

For a uniform 256-bit digest write 2^256 = q·M + r with M = 36^L. r residues
occur q + 1 times, the others q times, so the relative pair-collision excess
`M·Σp² − 1` equals r(M − r)/2^512, at most ~5.03e-131 for L ≤ 8. Each character,
including the first, has probability 1/36 within 1e-60. SHA-256 uniformity is a
model assumption, not proven from input uniqueness.

The previous method, `truncateHash(toBase36(D), L)`, kept the leading digits of a
variable-length rendering. With 36^49 < 2^256 < 36^50, the first character was
`1..5` ≈ 16.12% each, `6` ≈ 6.41%, `7..z` ≈ 0.448% each and `0` never. That made
the pair-collision probability ≈ 5.055× uniform for L = 3..8 (5.0499× at L = 2).
`toBase36`, `truncateHash` and `generateIdHash` remain exported with unchanged
behavior for compatibility; `generateId` no longer uses that pair of helpers.

### Collision model for `calculateIdLength`

The old comment said the bands gave a "~1% collision probability". That is wrong
even with uniform digits. With N existing IDs and S = 36^L:

| L | Band upper bound N | One new ID hits an existing one ≈ N/S | Any pair among N ≈ 1 − exp(−N(N−1)/2S) |
|---|---|---|---|
| 3 | 100 | 0.21% | ~10.1% |
| 4 | 500 | 0.030% | ~7.2% |
| 5 | 3,000 | 0.0050% | ~7.2% |
| 6 | 20,000 | 0.0009% | ~8.8% |
| 7 | 100,000 | 0.0001% | ~6.2% |

These bands are sized so that a collision on any single insert is rare. When a
collision does happen, `checkCollision` resolves it. **The thresholds are
unchanged.** Only the comment was corrected.

### Default length without config

For a caller with no configuration (and so no collision check), the chance that a
new ID equals one of N existing IDs is about N/36^L:

- N = 10,000 at L = 6: about 0.0005%.
- N = 10,000 at the former L = 4: about 0.6% if digits are uniform, and 2.97% with
  the old bias.

The longer default reduces this risk. It does not remove it. Production callers
that are moving to `getIdGeneratorConfig()` are tracked separately in el-4htfn.

### `checkCollision` is not a reservation

`checkCollision` (for example `QuarryAPI.getIdGeneratorConfig()`, which uses
`api.get(id)`) is a read-only pre-check of IDs already visible when it runs. It
does not reserve the ID it returns. Two overlapping generations can return the
same ID, and the second `api.create` then fails with `ALREADY_EXISTS` /
`ConflictError`. The steward's el-45m5h probe reproduced this with a controlled
digest schedule. Fixing it is out of scope here and belongs to a separate backlog
item.

## Compatibility audit

A grep of production code for regexes and other assumptions about ID length found:

- Every root-ID validator uses `{3,8}`: `core/src/types/{document,library,team,channel,message}.ts` and `core/src/errors/factories.ts`.
- `playbook.ts` and `workflow.ts` use `el-[a-z0-9]+`.
- The mention regex in `shared-routes/src/messages.ts` uses `el-[a-z0-9]+`.
- `quarry/src/services/id-length-cache.ts` has a minimum length of 4. It is used only with config/`elementCount`, so it was left unchanged.

None of these assumes exactly 4 characters.

One test fixture coupled to the old behavior: `smithy/src/api/agent-id-collision.bun.test.ts`, from el-2zj6n. It assumed:

- a default length of 4;
- that the 3-character ID was a *prefix* of the 4-character ID.

Under low-order digits, the shorter ID is a *suffix* of the longer one. The fixture now derives both occupied IDs from the forced digest. Its intent is unchanged: the generator must consult SQLite and advance the nonce.

## Tests

`packages/core/src/id/generator-distribution.bun.test.ts` (22 tests) covers:

- **Low-order digit contract:** zero-padding, low-order rather than leading digits, clamping, an independent BigInt reference for L = 3..8, and suffix extension.
- **Determinism of `generateIdHashDigits`.**
- **Exact BigInt checks:**
  - relative excess equals r(M−r)/2^512 and is < 1e-130;
  - each first character has probability 1/36 within 1e-60;
  - negative control: the old method gives 5.05–5.06× for L = 3..8.
- **Monte-Carlo checks on 20,000 deterministic SHA-256 digests** (counter-seeded, so results are reproducible and cannot flake):
  - first character has chi-square_35 < 70 for L = 3, 6 and 8; the old method fails by more than 100×;
  - pair-collision ratio is within ±15% of uniform for L = 2 and 3; the old method gives 4–6×.
- **End-to-end `generateId` first-character check:** n = 2,000, loose bound chi-square < 200. For uniform digits a false failure has probability below 1e-23; the old method scores about 7,700.
- **Default length:** 6 with no config and with a config holding only `checkCollision`; adaptive length with `elementCount`; explicit `hashLength` takes precedence; length escalation still starts from the default.

Baseline: putting back only the old `generateId` wiring and the old default makes 4 of these tests fail — the end-to-end distribution test and three default-length tests. All pass on the change.
