# Quarry scaling investigation — el-2z6, 2026-09-26

## Status: not reproduced; no fix claimed

The original create-scaling failure remains unresolved. Its ratio was
7.216375025823988 against `< 4`, with exit 1 in the first el-5xd full run
(173 steps, 163.30 s). The test took 85.20 ms; the entire performance file
1.72 s. Evidence: `/tmp/el-5xd-check-merge-first.log`, lines 4088–4127.
The old run did not log the three batch durations or host load, so they cannot
be reconstructed from that ratio. A later passing run does not invalidate it.

This investigation observed 41 passing executions of the target assertion,
including one in the full sequence below. This does **not** establish the
cause, justify changing the threshold, or establish a fix. Director decision
is required before further implementation, as specified in the task.

## Base and environment

The assigned branch initially pointed to bb5f967. `git merge --ff-only master`
advanced only that branch to local master b7e5c8b, including Desktop. No branch
switch, installed-app replacement/restart or stopping other sessions occurred.
All tests ran in the assigned core worktree. macOS arm64, 12 logical CPUs,
36 GiB RAM, Bun 1.3.11 (af24e281), Node v22.23.3, pnpm 8.15.5.
`pnpm install --frozen-lockfile` returned 0; no lockfile changes.

Production code, assertions, dataset sizes and thresholds were unchanged.
Temporary instrumentation imported `loadavg` from `node:os` and logged the
following immediately before the original assertion, after all timed batches:

```ts
console.log('[scaling-baseline]', JSON.stringify({
  sizes, perItemTimes,
  durations: perItemTimes.map((time, i) => time * sizes[i]),
  ratio, loadavg: loadavg(),
}));
```

This instrumentation was removed after measurement. The test file is identical
to b7e5c8b. No warmup, retry-on-failure, artificial delay, CPU stress or forced GC
was introduced. Repeated runs were a fixed diagnostic sample, not a gate retry
policy. Every nonzero exit is retained.

## Exact attempts

A temporary Python runner (`/tmp/el-2z6-runs.py`) used sequential
`subprocess.run`, file-backed combined stdout/stderr, monotonic wall duration
and `os.getloadavg()` before/after every command. It removed inherited
`STONEFORGE_*`, `SF_*`, `ORCHESTRATOR_URL` from child environments and set
`RUN_INTEGRATION_TESTS=false`, matching the proposed gate's isolation. It
returned 1 if **any** command failed, while continuing to collect all results.
The shared sf environment was unchanged. Groups ran sequentially:

1. 20 independent processes running
   `bun test packages/quarry/src/api/query-performance.bun.test.ts`.
   Total child wall time 7.221 s, aggregate exit **1**: 18 files passed, two
   failed in the adjacent **list** scaling assertion. The assigned create
   assertion passed 20/20, ratio 0.451815–1.498893. Load averages at the target
   ranged from [8.169, 16.498, 18.145] to [8.445, 16.692, 18.223].
2. Full sequence on b7e5c8b: `pnpm typecheck --force`,
   `pnpm --filter @stoneforge/desktop build`, then one
   `bun test ./<file>` process for every `*.bun.test.ts`, recursively sorted
   within each of `packages/{core,storage,quarry,smithy}/src` in that order;
   finally `pnpm --filter @stoneforge/smithy test:node` and
   `pnpm --filter @stoneforge/desktop test`.
   **171 steps, 114.359 s summed child wall time, exit 1**.
   Only `packages/smithy/src/git/project-repositories.bun.test.ts` failed
   (`CONCURRENT_MODIFICATION`, already tracked as el-52s). All 96 Quarry
   files passed. Performance file: 33 pass, 0 fail, 0.323 s; target ratio
   0.811309, batches 0.522042 / 2.368625 / 4.235375 ms;
   load [9.533, 15.646, 17.742]. Per-step 1-minute load ranged 7.675–12.181.
   **This was not `pnpm check:merge`**: that script is absent from b7e5c8b.
   The sequence follows the proposed 502a86e runner, without its runner's
   self-tests or renamed `model-pricing.bun.test.ts` (still `.test.ts` on this
   base). No claim is made that the proposed 173-step gate passed.
3. 20 fresh processes running
   `bun test packages/quarry/src/api/query-performance.bun.test.ts -t 'consistent per-item'`.
   20/20 passed, aggregate exit 0, total child wall time 1.372 s;
   ratio 0.194736–0.248387; load [7.859, 13.824, 16.856].

Logs and exact per-command durations/exit/load records:

- `/tmp/el-2z6-install.log`
- `/tmp/el-2z6-baseline-isolated/{000..019}.log` and `results.json`
- `/tmp/el-2z6-baseline-full/{000..170}.log` and `results.json`
  (target 043.log, unrelated failure 130.log)
- `/tmp/el-2z6-baseline-focused/{000..019}.log` and `results.json`
- Group runner outputs: `/tmp/el-2z6-baseline-{isolated,full,focused}.log`

The tables below preserve measured target durations even if temporary logs
expire. The ratio is `(duration100 / 100) / (duration10 / 10)`.

## Interpretation and next decision

The test performs one timed batch each for 10, 50 and 100 tasks on fresh
in-memory databases, always in increasing order. Sub-millisecond 10-task
batches make a single ratio vulnerable to scheduling/GC/JIT variability.
Focused cold-process runs had 10-task times 1.769–2.134 ms versus
0.494–0.925 ms after preceding file tests; the small denominator's timing
clearly depends on prior execution. That is evidence of order/warmup
sensitivity, **not proof of the cause of the original 7.216375 failure**.
No scheduler/GC trace was captured in that original run. Inspection of task
creation shows fixed serialization/hash and indexed transaction inserts,
without a loop over existing tasks; inspection alone cannot exclude regression.

If further reproduction establishes measurement noise, a candidate is warmup
on a disposable database followed by a fixed number of independent fresh-database
samples for each unchanged size, with interleaved order and median per-item
comparison, retaining `< 4` and diagnostic durations. It must retain detection
of persistent superlinear growth (for example a controlled quadratic-cost
negative check). This is a proposal, not an implemented or validated fix.
Director should decide whether to extend reproduction/profiling under the
original load or authorize a separately evaluated robustness change. Do not
close el-2z6 based on this report.

## Adjacent list failure (reported separately)

Isolated file runs 4 and 7 returned 1 because `should maintain list performance
as dataset grows` yielded 3.088225363422673 and 3.8142901155325566 against `< 3`.
This test already uses a warmup plus median of five queries. Its assertion
compares total time for 50 and 150 items and demands strictly sublinear growth.
Its comment inaccurately refers to 2x data; actual size ratio is 3. No change
was made to this separate assertion or comment during the create investigation.
Reported to Director el-3kyh, message el-2og5; no duplicate task created.

## Raw target measurements

Durations are milliseconds; process exit is for the whole selected test file.

### isolated

| Run | 10 tasks ms | 50 tasks ms | 100 tasks ms | Per-item ratio | Process exit |
|---|---:|---:|---:|---:|---:|
| 1 | 0.559292 | 2.514791 | 4.789666 | 0.856380 | 0 |
| 2 | 0.656250 | 2.995333 | 5.352292 | 0.815587 | 0 |
| 3 | 0.834917 | 3.423875 | 4.781000 | 0.572632 | 0 |
| 4 | 0.494208 | 2.423417 | 4.673792 | 0.945714 | 1 |
| 5 | 0.725500 | 2.349750 | 4.204583 | 0.579543 | 0 |
| 6 | 0.723750 | 2.235417 | 7.009708 | 0.968526 | 0 |
| 7 | 0.925000 | 2.245750 | 4.179291 | 0.451815 | 1 |
| 8 | 0.573458 | 2.400292 | 4.469375 | 0.779373 | 0 |
| 9 | 0.656708 | 2.122500 | 4.540458 | 0.691397 | 0 |
| 10 | 0.617416 | 2.573625 | 4.243458 | 0.687293 | 0 |
| 11 | 0.510625 | 2.433500 | 4.722167 | 0.924782 | 0 |
| 12 | 0.565958 | 2.569167 | 4.415542 | 0.780189 | 0 |
| 13 | 0.644167 | 4.433125 | 9.655375 | 1.498893 | 0 |
| 14 | 0.620541 | 2.506125 | 4.963709 | 0.799900 | 0 |
| 15 | 0.697292 | 2.994583 | 5.414625 | 0.776522 | 0 |
| 16 | 0.782250 | 2.335000 | 4.824791 | 0.616784 | 0 |
| 17 | 0.547000 | 2.837125 | 4.898916 | 0.895597 | 0 |
| 18 | 0.626667 | 2.526542 | 4.326417 | 0.690385 | 0 |
| 19 | 0.850792 | 2.279000 | 5.016417 | 0.589617 | 0 |
| 20 | 0.551333 | 2.174208 | 4.972333 | 0.901875 | 0 |

### focused

| Run | 10 tasks ms | 50 tasks ms | 100 tasks ms | Per-item ratio | Process exit |
|---|---:|---:|---:|---:|---:|
| 1 | 1.997250 | 2.764166 | 4.066416 | 0.203601 | 0 |
| 2 | 2.057333 | 2.635416 | 4.006375 | 0.194736 | 0 |
| 3 | 1.841417 | 2.755625 | 4.075584 | 0.221329 | 0 |
| 4 | 1.885291 | 2.608875 | 4.185458 | 0.222006 | 0 |
| 5 | 1.800708 | 2.695375 | 4.087750 | 0.227008 | 0 |
| 6 | 1.907750 | 2.570750 | 4.085667 | 0.214162 | 0 |
| 7 | 1.769042 | 2.618833 | 3.995875 | 0.225878 | 0 |
| 8 | 1.941208 | 2.830375 | 4.334458 | 0.223287 | 0 |
| 9 | 1.873291 | 2.707833 | 4.179458 | 0.223108 | 0 |
| 10 | 2.133666 | 2.620833 | 4.187625 | 0.196264 | 0 |
| 11 | 1.963625 | 2.763709 | 4.481375 | 0.228219 | 0 |
| 12 | 1.851167 | 2.672125 | 4.201667 | 0.226974 | 0 |
| 13 | 1.789000 | 2.608708 | 4.224333 | 0.236128 | 0 |
| 14 | 1.858250 | 2.575292 | 4.240709 | 0.228210 | 0 |
| 15 | 2.047416 | 2.848917 | 4.361583 | 0.213029 | 0 |
| 16 | 1.936583 | 2.849500 | 4.230666 | 0.218460 | 0 |
| 17 | 1.965125 | 2.757625 | 4.380375 | 0.222906 | 0 |
| 18 | 2.020166 | 3.011875 | 5.017833 | 0.248387 | 0 |
| 19 | 1.895750 | 2.642958 | 4.386125 | 0.231366 | 0 |
| 20 | 1.975875 | 3.231084 | 4.665958 | 0.236146 | 0 |

### full

| Run | 10 tasks ms | 50 tasks ms | 100 tasks ms | Per-item ratio | Process exit |
|---|---:|---:|---:|---:|---:|
| 44 | 0.522042 | 2.368625 | 4.235375 | 0.811309 | 0 |
