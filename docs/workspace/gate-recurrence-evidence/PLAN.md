# el-39znb predeclared matrix (2026-09-26)

Before any investigation test process: base and local master both
8c8cca96b7da052293e21ad945c9925d53a85419; approved ff-only sync was a no-op.

Run sequentially, without stopping other work or generating competing load:
1. Two unchanged full Quarry query-performance suite processes.
2. Two unchanged full PluginExecutor suite processes.
3. One temporary instrumented copy of each full suite (3 processes per suite total).
   Quarry: wall/CPU/resource deltas and SQL counts/rows/elapsed, query plans outside
   measurement. Plugin: real spawn return/event/data/exit/close timeline and timer
   progress; keep actual echo command, existing assertions and timeout unchanged.
4. Remove temporary copies. One required full pnpm check:merge on final source.

Record commands, exits, UTC start/end, wall, child resource usage, load averages,
read-only process snapshots, runtime versions, source hashes, raw output. Do not
interpret process CPU or load as proof of scheduler or I/O cause. Instrumentation
perturbs timings; compare separately. No retry based on outcomes; additional runs
require a concrete new hypothesis approved by Director. No production, threshold,
timeout, retries, skips, gate configuration or live state changes. Passing research
is not a fix. Independent exact-final steward review remains required.
