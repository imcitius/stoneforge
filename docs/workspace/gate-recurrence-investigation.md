# Quarry / PluginExecutor gate recurrence — el-39znb, 2026-09-26

## Finding and scope

**Neither historical failure reproduced in the bounded isolated campaign; no
root cause or fix is established.** The two failures must remain separate.
The PluginExecutor incident is a **Bun test deadline of 5000 ms**, not a reported
command timeout: the actual `echo "hello world"` plugin has no explicit timeout,
and `executeCommand` selects the implementation default **300000 ms**. The log
has no spawn/exit/pipe timestamps with which to locate that stall.

List's `<3` requirement for 50→150 returned rows is stricter than a guarantee of
linear work. Existing negative controls count `1+n` and pass at 151/51=2.960784;
they establish sensitivity to the injected N+1 workload, not that every valid
approximately linear implementation must always pass this wall-clock threshold.
The accepted el-2z6 methodology and all thresholds remain unchanged. This report
appends new recurrence evidence rather than reopening or rewriting el-2z6 history.

Read: shared/repository AGENTS, Documentation Directory, el-47e2, el-1bx, el-241,
current el-2pglm / el-2pujj reports, and related el-hkutb / el-1mo5c evidence.
`sf repo list` still requires `pnpm check:merge`. Assigned branch and local master
both started at **8c8cca96b7da052293e21ad945c9925d53a85419**; authorized
`git merge --ff-only master` returned “Already up to date.” No main checkout edit.

## Preserved historical failures

| Gate | Tested revision | Outcome / seconds | List medians ms/query (50 / 100 / 150) | Ratio |
|---|---|---|---|---:|
| el-2pujj / dMwYdr | e3dc52102c8a84f6b23fec9430147c383ff2699e | 187/189, exit1 / 319.94 | .200684 / .424850 / .636896 | 3.173623745851669 |
| el-hkutb / g8qBfX | e3511add8aca7eb9226409f880fc0ef52c597dc4 | 188/189, exit1 / 450.35 | .424337 / .636848 / 1.510345 | 3.559304857848077 |
| el-1mo5c / GPBE9u | fd7cb1ea7dd24e3b10e820cd32760e28ba313711 | 188/189, exit1 / 324.95 | .233444 / .452705 / .740195 | 3.170759794884084 |

All three results.json files were read to completion; not inferred from progress
output or current master. g8qBfX source attribution comes from contemporaneous
commit **a52765dd8f2caecde7de194e3e89e97e18404700** plus branch reflog (preserved).
Its first gate began before the e3511ad commit timestamp, so that SHA identifies
reported source contents, not a claim that HEAD already pointed to that commit
at process launch. The later beac945 integration **8fa6a5b** is a distinct run.
el-2pujj attribution is recorded in its preserved ownership report; el-1mo5c in
its preserved report. Historical runner results do not themselves record SHA or
working-tree hashes. Those retrospective source attributions have that limit.

The performance files took **9.49 / 16.68 / 13.13 s** respectively. PluginExecutor
was **52 pass / 1 fail, 5.76 s** only in dMwYdr (simple-command test 5001.12 ms);
it passed in the other two gates, **.83 / .50 s**. Failures in dMwYdr occurred
roughly **3m25s apart**, in different fresh Bun processes. A shared gate is not
evidence of a common mechanism. Later 88/88 isolated and 189/189 final passes in
el-2pujj do not explain either failure. el-1mo5c's unchanged-source full retry
P1jcfh remains diagnostic only and does not replace its failed acceptance.

`gate-recurrence-evidence/historical-logs.tar.gz` contains gzip copies of every
original step log and results.json for all three failed gates, plus original
outer logs. The manifest records source path, original mtime, byte count and
SHA-256 of **uncompressed** bytes. Historical summary retains every raw list
sample; the archive also retains full create/control samples. Do not discard the
failed results when extracting or comparing evidence.

## Runtime, load and concurrency attribution limits

All three original Bun log headers report **1.3.11 (af24e281)**. Source hashes for
both affected tests, both implementation files, gate runner and pnpm-lock.yaml
are identical across the three reported historical source revisions and this
investigation base. The manifests pin pnpm **8.15.5**. The historical gate logs do
not directly record executable Node/pnpm versions; do not fill that gap from the
current shell. The present campaign measured **Node v22.23.3, Bun 1.3.11,
pnpm 8.15.5, Darwin arm64, 12 logical CPUs**. Frozen install exited0 and changed
no lockfile. Older el-47e2/el-1bx recorded the same version numbers, which is
supporting context rather than per-incident executable provenance.

Recorded loadavg at failed list aggregation:
- dMwYdr: **11.802 / 11.951 / 10.969**;
- g8qBfX: **90.908 / 38.228 / 26.491**;
- GPBE9u: **43.725 / 45.890 / 32.353**.

Available filesystem timestamps and step durations indicate overlapping gates:
dMwYdr's Quarry window overlaps 0mGim9; its later plugin window overlaps SPA3m4.
g8qBfX's Quarry window overlaps LVCg2k. GPBE9u's Quarry window overlaps g8qBfX and
eBPSmr. Exact approximate UTC windows and derivation are in
`historical-concurrency.json`. This is an **mtime-based inference**, not sampled
process/scheduler telemetry or proof of CPU competition at each instant. No
historical per-sample CPU, I/O wait, GC, runqueue or child lifecycle trace exists.
Load and concurrent gates are plausible contributors, **not established causes**.

Raw samples do show variation: g8qBfX's six 150-row batches range **154.10–1059.51
ms**, versus **52.74–126.91 ms** for 50 rows. dMwYdr 150-row batches range
**139.54–212.69 ms**, GPBE9u **165.29–260.21 ms**. All samples enter the existing
median. An outlier/stall explanation cannot be promoted to fact without CPU and
lifecycle observations from a failing sample.

## Predeclared isolated matrix and results

PLAN.md was written and sent to Director (message el-2dpft) before any investigation test. It fixes
two unchanged full-suite processes plus one temporary instrumented full-suite
process per suite (**3/5 allowed processes each**), sequentially, followed by
one required full gate. There were no artificial-load experiments, added sleeps,
forced GC, adaptive repeats, timeout/threshold/retry/skip/gate changes. The existing
suite's long-command timeout control is retained; it is not used as a reproduction
of the historical simple echo timeout.

| Process | Result | Wall seconds | List ratio |
|---|---|---:|---:|
| Quarry unchanged1 | 35/35, exit0 | 8.144 | 2.659368 |
| Quarry unchanged2 | 35/35, exit0 | 7.967 | 2.617456 |
| Plugin unchanged1 | 53/53, exit0 | .679 | — |
| Plugin unchanged2 | 53/53, exit0 | .538 | — |
| Quarry instrumented | 35/35, exit0 | 8.422 | 2.774971 |
| Plugin instrumented | 53/53, exit0 | .551 | — |

`run-diagnostics.py` records UTC endpoints, command/exits, wall duration, child
resource deltas, before/after load and read-only process snapshots (executable
names without argv/environment). It removes shared-project routing variables from
children, matching gate isolation. Temporary copies use actual production code
and local temporary test fixtures; originals are never overwritten. Generated
copies and every output are archived in `diagnostics.tar.gz`; the copies were
removed before gate discovery. Runner syntax validation passed via py_compile;
all generated probes actually executed successfully. Instrumentation changes
costs, so its ratios are separate observations, not an acceptance replacement.

### List work versus elapsed-time stalls

The probe wraps storage query/queryOne **after fixture creation and DB warmup**,
records aggregate call count, returned row count and SQL elapsed time for the
original 256 queries, then gathers EXPLAIN QUERY PLAN outside the timed interval.
It retains all warmup/control samples; use `queries==256` for actual wall-clock
list samples. No timer callbacks are used as a scheduler proxy within this
microtask-heavy synchronous-SQL loop.

Every real list sample makes **256 count + 256 element + 256 batch-tag calls**.
Element and tag rows returned per sample are **12800 / 25600 / 38400**, exactly
256*n. No N+1 statement growth is observed. COUNT and element selection use the
type index; plans also show temporary B-tree for count(DISTINCT), SELECT DISTINCT
and ORDER BY, plus indexed tags. Thus constant SQL call count does **not** prove
linear SQLite work: sorting/distinct costs and JSON materialization still scale
with rows. Source confirms per-row deserialization and no optional hydration here.

Measured six post-warmup instrumented wall intervals:
- 50: **48.51–59.21 ms**; process CPU **48.53–58.54 ms**;
- 100: **89.41–102.73 ms**; process CPU **89.89–115.42 ms**;
- 150: **130.57–145.64 ms**; process CPU **131.27–148.49 ms**.

CPU and wall are comparable in these successful samples. Process CPU includes
runtime helper threads and can exceed wall; wall-minus-CPU is **not** a measured
scheduler delay. In-memory fixture samples report zero major faults, swaps and
fsRead/fsWrite deltas; these OS counters do not rule out all waits/cache effects.
Minor faults/context switches occur. No failing interval was captured with these
counters, so they cannot classify a historical failure as scheduler, GC or I/O.

### Plugin spawn, command and pipe lifecycle

Temporary instrumentation attaches to the real node:child_process spawn and
records monotonic spawn-return, spawn, stdout/stderr, exit, error and close events.
A 20 ms unref timer records progress without blocking or delaying the command.
For echo: spawn-return **2.169 ms**, spawn **2.325**, stdout **4.655** (12 bytes),
exit0 **5.433**, close0 **5.462**. Zero timer ticks means it finished before the
first tick; it does not prove scheduler latency was zero. The awaited executor
resolves on **close**, which includes pipe closure, not merely child exit.

A future failure therefore needs to distinguish: synchronous spawn delay; shell
not exiting; exit observed but inherited pipes not closing; or event delivery /
runtime scheduling delay. This campaign captured none of those failures. Raising
the command timeout would not address the independently enforced 5s Bun deadline.

## Narrow follow-up proposal (not implemented)

Ask Director to authorize a single bounded diagnostic on a naturally occurring
recurrence with buffered per-list CPU/wall/SQL phases and child lifecycle events,
plus event-loop progress and OS process state on a **real echo stall**. Do not
simulate the incident by sleeping. Preserve baseline assertions and compare
instrumented overhead separately. A recurring CPU-bound SQL phase would justify
profiling DISTINCT/count/sort and row materialization; a wall-only gap would
justify scheduler/GC/I/O tracing instead. A Plugin exit-before-close observation
would direct a separate pipe-lifecycle investigation. None is established here.

Separately, Director may review whether list acceptance should require strictly
sublinear total time for full materialization. Any revised complexity contract
needs its own task and negative controls; this research does not authorize
loosening `<3` or claim that the present query is asymptotically quadratic.

## Required gate and delivery

The single full `pnpm check:merge` on **8ed49d4ec494c06d0f70a1d850eb390761f33cf4**
passed **190/190, exit0, 306.53s runner / 307.181s wall**, 20:30:48–20:35:55 UTC.
Its production/tests equal base8c8cca9. Quarry35/35 and PluginExecutor53/53 passed;
list ratio **2.749983208**. Full per-step logs/results and outer-run metadata are
archived in `gate-recurrence-evidence/final-gate.tar.gz`; original directory is
`/var/folders/b6/ltn3hn4j3nq1n86rbg2j9zk40000gn/T/stoneforge-merge-check-ChYxpS/`.
Only research documentation/evidence changed after that tested source state.
All573 historical archived files were rehashed successfully. `git diff --check`
passed. No additional isolated/full run was made; no historical failure is erased. Separate root
build/lint/test, Playwright/GUI, packaged/live providers and cross-platform checks
are not claimed; the gate runs its declared uncached typecheck, source Desktop
build, isolated Bun, Smithy Vitest and Desktop Node checks.

Independent steward review of the exact final research commit is required before
approved CLI local delivery. This is worker research, not independent approval.
Installed app, daemon, live sessions/tasks/providers and maintenance were untouched.
