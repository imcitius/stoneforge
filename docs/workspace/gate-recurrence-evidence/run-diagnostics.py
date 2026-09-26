#!/usr/bin/env python3
"""One bounded el-39znb campaign. Run from repo root; never retries a result.
Output directory must not exist. Copies are removed even if a child fails.
Instrumentation is intentionally separate from the unchanged baseline.
"""
import datetime
import hashlib
import json
import os
from pathlib import Path
import resource
import subprocess
import sys
import time

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=False)
q = Path('packages/quarry/src/api/query-performance.bun.test.ts')
p = Path('packages/smithy/src/services/plugin-executor.bun.test.ts')
impl = p.with_name('plugin-executor.ts')
temps = [q.with_name('el-39znb-query.bun.test.ts'), p.with_name('el-39znb-plugin.bun.test.ts'), impl.with_name('el-39znb-plugin.ts')]
assert not any(f.exists() for f in temps)
env = {k: v for k, v in os.environ.items() if not k.startswith(('STONEFORGE_', 'SF_')) and k != 'ORCHESTRATOR_URL'}
env['RUN_INTEGRATION_TESTS'] = 'false'

def output(args):
    return subprocess.check_output(args, text=True).strip()

meta = {'head': output(['git', 'rev-parse', 'HEAD']), 'utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'versions': {s: output([s, '--version']) for s in ['node', 'bun', 'pnpm']},
        'uname': list(os.uname()), 'cpuCount': os.cpu_count(),
        'sourceHashes': {str(f): hashlib.sha256(f.read_bytes()).hexdigest() for f in [q, p, impl, Path('packages/quarry/src/api/quarry-api.ts'), Path('pnpm-lock.yaml')]}}
(out / 'environment.json').write_text(json.dumps(meta, indent=2)+'\n')
results = []

def snapshot():
    # Executable names only: avoid arguments/environment from unrelated sessions.
    return output(['ps', '-axo', 'pid,ppid,%cpu,etime,comm'])

def run(label, file):
    args = ['bun', 'test', str(file)]
    (out / (label+'-ps-before.txt')).write_text(snapshot())
    start = time.monotonic(); utc = datetime.datetime.now(datetime.timezone.utc).isoformat()
    load = os.getloadavg(); usage = resource.getrusage(resource.RUSAGE_CHILDREN)
    with (out / (label+'.log')).open('w') as log:
        child = subprocess.run(args, env=env, stdout=log, stderr=subprocess.STDOUT)
    after = resource.getrusage(resource.RUSAGE_CHILDREN)
    results.append({'label': label, 'command': args, 'code': child.returncode, 'utcStart': utc,
                    'utcEnd': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    'wallSeconds': time.monotonic()-start, 'loadBefore': load, 'loadAfter': os.getloadavg(),
                    'childResourceDelta': {k: getattr(after,k)-getattr(usage,k) for k in ['ru_utime','ru_stime','ru_inblock','ru_oublock','ru_nvcsw','ru_nivcsw']}})
    (out / (label+'-ps-after.txt')).write_text(snapshot())
    (out / 'results.json').write_text(json.dumps(results, indent=2)+'\n')
    print(json.dumps(results[-1]), flush=True)

def replace_once(text, old, new):
    assert text.count(old) == 1, (old, text.count(old))
    return text.replace(old,new)

try:
    for label, file in [('quarry-1',q),('quarry-2',q),('plugin-1',p),('plugin-2',p)]:
        run(label,file)
    text=q.read_text()
    text=replace_once(text, '    let count = 0;\n    const start = clock();', '''    // Diagnostic copy only. No logging inside the timed interval.
    const db = (freshApi as any).backend;
    const sqlStats = new Map<string, any>();
    const original: Record<string, any> = {};
    for (const method of ['query', 'queryOne']) {
      original[method] = db[method].bind(db);
      db[method] = (sql: string, params: unknown[]) => {
        const begin = performance.now();
        const result = original[method](sql, params);
        const elapsed = performance.now() - begin;
        const key = method + ':' + sql;
        const stat = sqlStats.get(key) ?? { method, sql, params, calls: 0, rows: 0, ms: 0 };
        stat.calls++; stat.rows += Array.isArray(result) ? result.length : Number(result != null); stat.ms += elapsed;
        sqlStats.set(key, stat);
        return result;
      };
    }
    const cpuStart = process.cpuUsage();
    const resourceStart = process.resourceUsage();
    let count = 0;
    const start = clock();''')
    text=replace_once(text, '    const duration = clock() - start;\n    expect(count)', '''    const duration = clock() - start;
    const cpu = process.cpuUsage(cpuStart);
    const resourceEnd = process.resourceUsage();
    for (const method of ['query', 'queryOne']) db[method] = original[method];
    // Query plan collection and log serialization are outside the timed interval.
    const stats = [...sqlStats.values()].map(stat => ({...stat,
      plan: original.query('EXPLAIN QUERY PLAN ' + stat.sql, stat.params), params: undefined }));
    console.log('[list-probe]', JSON.stringify({ size, queries, wall: duration, cpu,
      resourceDelta: Object.fromEntries(Object.keys(resourceStart).map(key =>
        [key, (resourceEnd as any)[key] - (resourceStart as any)[key]])), stats }));
    expect(count)''')
    temps[0].write_text(text)
    text=impl.read_text()
    text=replace_once(text, '      const child = spawn(command, {', '''      const probeStart = performance.now();
      const probeEvents: unknown[] = [];
      const record = (event: string, detail?: unknown) => probeEvents.push({event, ms: performance.now()-probeStart, detail});
      let lastTick = performance.now(), maxTickGap = 0, ticks = 0;
      const ticker = setInterval(() => { const now = performance.now(); maxTickGap = Math.max(maxTickGap, now-lastTick); lastTick = now; ticks++; }, 20);
      ticker.unref();
      const child = spawn(command, {''')
    text=replace_once(text, '      const killProcessGroup =', '''      record('spawn-return', {pid: child.pid});
      child.on('spawn', () => record('spawn'));
      child.stdout?.on('data', data => record('stdout', {bytes: data.length}));
      child.stderr?.on('data', data => record('stderr', {bytes: data.length}));
      child.on('exit', (code, signal) => record('exit', {code, signal}));
      child.on('error', error => record('error', error.message));
      child.on('close', (code, signal) => {
        record('close', {code, signal}); clearInterval(ticker);
        console.log('[spawn-probe]', JSON.stringify({pluginName, timeout, ticks, maxTickGap, events: probeEvents}));
      });
      const killProcessGroup =''')
    temps[2].write_text(text)
    temps[1].write_text(replace_once(p.read_text(), "'./plugin-executor.js'", "'./el-39znb-plugin.js'"))
    # Preserve exact generated sources for review; they never enter gate discovery.
    for f in temps: (out / (f.name+'.txt')).write_bytes(f.read_bytes())
    run('quarry-instrumented', temps[0])
    run('plugin-instrumented', temps[1])
finally:
    for f in temps: f.unlink(missing_ok=True)
sys.exit(int(any(r['code'] for r in results)))
