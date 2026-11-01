import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectLifecycle } from '../dist/lifecycle.js';
import { projectActions, tabMenuModel } from '../dist/tabs.js';

/** In-memory stand-in for ProjectManager: records every start/stop and lets tests hold them open. */
function fixture(states = { a: 'stopped', b: 'ready', c: 'stopped' }) {
  const calls = [];
  const projects = new Map(Object.entries(states).map(([id, state]) => [id, { id, name: id.toUpperCase(), state }]));
  const instances = new Map(Object.entries(states).filter(([, state]) => state === 'ready').map(([id]) => [id, { id, n: 0 }]));
  let starts = 0;
  const gates = { start: undefined, stop: undefined };
  const manager = {
    projects, instances,
    async start(id) {
      calls.push(['start', id]);
      if (instances.has(id)) return instances.get(id);
      projects.get(id).state = 'starting';
      if (gates.start) await gates.start;
      const instance = { id, n: ++starts };
      instances.set(id, instance); projects.get(id).state = 'ready';
      return instance;
    },
    async stop(id) {
      calls.push(['stop', id]);
      if (!instances.has(id)) return;
      projects.get(id).state = 'stopping';
      if (gates.stop) await gates.stop;
      instances.delete(id); projects.get(id).state = 'stopped';
    },
    async remove(id) { calls.push(['remove', id]); await this.stop(id); projects.delete(id); },
  };
  const attached = [], confirms = [];
  let answer = true, changes = 0;
  const lifecycle = new ProjectLifecycle(manager, {
    confirm: async (action, project) => { confirms.push([action, project.id]); return answer; },
    attach: async (id, instance) => { attached.push([id, instance.n]); },
    changed: () => { changes++; },
  });
  return { manager, lifecycle, calls, attached, confirms, gates, projects, instances,
    answer: (value) => { answer = value; }, changes: () => changes };
}
const hold = () => { let release; const promise = new Promise((resolve) => { release = resolve; }); return { promise, release }; };

test('Selecting a stopped project (any number of times) only shows it and never starts it', async () => {
  const f = fixture();
  for (const id of ['a', 'c', 'a', 'a', 'b', 'a']) await f.lifecycle.select(id);
  assert.equal(f.lifecycle.active, 'a');
  assert.deepEqual(f.calls, [], 'No manager.start/stop from selection');
  assert.equal(f.projects.get('a').state, 'stopped');
  assert.equal(f.projects.get('c').state, 'stopped');
  // A running project gets its current instance's view attached, without starting anything.
  assert.deepEqual(f.attached, [['b', 0]]);
  await assert.rejects(f.lifecycle.select('missing'), /Unknown project/);
});

test('Selecting a starting or errored project does not attach a view or start it', async () => {
  const f = fixture({ a: 'starting', b: 'error' });
  await f.lifecycle.select('a'); await f.lifecycle.select('b');
  assert.deepEqual(f.calls, []); assert.deepEqual(f.attached, []);
});

test('Start runs exactly once under repeated clicks, then attaches the new view', async () => {
  const f = fixture();
  const gate = hold(); f.gates.start = gate.promise;
  const clicks = [f.lifecycle.run('start', 'a'), f.lifecycle.run('start', 'a'), f.lifecycle.run('start', 'a')];
  assert.equal(f.lifecycle.pendingAction('a'), 'start');
  assert.equal(f.lifecycle.actions('a').start, false, 'Start is unavailable while pending');
  assert.equal(f.lifecycle.actions('a').stop, false);
  gate.release();
  assert.deepEqual(await Promise.all(clicks), [true, false, false]);
  assert.deepEqual(f.calls, [['start', 'a']]);
  assert.deepEqual(f.attached, [['a', 1]]);
  assert.equal(f.lifecycle.pendingAction('a'), undefined);
  // Already running: Start no longer applies.
  assert.equal(await f.lifecycle.run('start', 'a'), false);
  assert.deepEqual(f.calls, [['start', 'a']]);
  assert.equal(f.lifecycle.active, undefined, 'Starting does not change the selection');
});

test('Stop stops only the requested project, after confirmation; cancel changes nothing', async () => {
  const f = fixture({ a: 'ready', b: 'ready', c: 'stopped' });
  f.answer(false);
  assert.equal(await f.lifecycle.run('stop', 'a'), false);
  assert.deepEqual(f.calls, []); assert.equal(f.projects.get('a').state, 'ready');
  f.answer(true);
  await f.lifecycle.select('b');
  assert.equal(await f.lifecycle.run('stop', 'a'), true);
  assert.deepEqual(f.calls, [['stop', 'a']]);
  assert.equal(f.projects.get('a').state, 'stopped');
  assert.equal(f.projects.get('b').state, 'ready', 'Other projects keep running');
  assert.equal(f.lifecycle.active, 'b', 'Stopping another project keeps the selection');
  assert.deepEqual(f.confirms, [['stop', 'a'], ['stop', 'a']]);
  assert.equal(await f.lifecycle.run('stop', 'c'), false, 'Stop does not apply to a stopped project');
});

test('Restart stops then starts once; concurrent Restart/Stop/Start requests are ignored', async () => {
  const f = fixture({ a: 'ready', b: 'ready' });
  const gate = hold(); f.gates.stop = gate.promise;
  const first = f.lifecycle.run('restart', 'a');
  const others = [f.lifecycle.run('restart', 'a'), f.lifecycle.run('stop', 'a'), f.lifecycle.run('start', 'a')];
  await new Promise((resolve) => setImmediate(resolve));
  gate.release();
  assert.equal(await first, true);
  assert.deepEqual(await Promise.all(others), [false, false, false]);
  assert.deepEqual(f.calls, [['stop', 'a'], ['start', 'a']]);
  assert.deepEqual(f.confirms, [['restart', 'a']], 'One confirmation');
  assert.deepEqual(f.attached, [['a', 1]], 'View attached to the new instance');
  assert.equal(f.projects.get('b').state, 'ready');
});

test('Lifecycle commands on different projects are independent', async () => {
  const f = fixture({ a: 'stopped', b: 'stopped', c: 'ready' });
  const gate = hold(); f.gates.start = gate.promise;
  const a = f.lifecycle.run('start', 'a'), b = f.lifecycle.run('start', 'b');
  assert.equal(f.lifecycle.pendingAction('a'), 'start'); assert.equal(f.lifecycle.pendingAction('b'), 'start');
  assert.equal(await f.lifecycle.run('stop', 'c'), true, 'Stopping c is not blocked by pending starts');
  gate.release();
  assert.deepEqual(await Promise.all([a, b]), [true, true]);
  assert.deepEqual(f.calls.filter(([action]) => action === 'start').map(([, id]) => id), ['a', 'b']);
});

test('Remove confirms, stops, unregisters and clears the selection of that project only', async () => {
  const f = fixture({ a: 'ready', b: 'ready' });
  await f.lifecycle.select('a');
  assert.equal(await f.lifecycle.run('remove', 'a'), true);
  assert.deepEqual(f.calls, [['remove', 'a'], ['stop', 'a']]);
  assert.equal(f.projects.has('a'), false); assert.equal(f.lifecycle.active, undefined);
  await f.lifecycle.select('b'); f.answer(false);
  assert.equal(await f.lifecycle.run('remove', 'b'), false);
  assert.equal(f.projects.has('b'), true); assert.equal(f.lifecycle.active, 'b');
});

test('A failed start is reported and leaves the project startable again', async () => {
  const f = fixture();
  f.manager.start = async (id) => { f.calls.push(['start', id]); f.projects.get(id).state = 'error'; throw new Error('boom'); };
  await assert.rejects(f.lifecycle.run('start', 'a'), /boom/);
  assert.equal(f.lifecycle.pendingAction('a'), undefined);
  assert.equal(f.lifecycle.actions('a').start, true);
  assert.deepEqual(f.attached, []);
});

test('Project actions by state', () => {
  const on = (actions) => Object.entries(actions).filter(([, value]) => value).map(([key]) => key).sort();
  assert.deepEqual(on(projectActions({ state: 'stopped' })), ['logs', 'remove', 'start']);
  assert.deepEqual(on(projectActions({ state: 'error' })), ['logs', 'remove', 'start']);
  assert.deepEqual(on(projectActions({ state: 'error', running: true })), ['logs', 'remove', 'restart', 'stop']);
  assert.deepEqual(on(projectActions({ state: 'starting' })), ['logs', 'remove', 'stop']);
  assert.deepEqual(on(projectActions({ state: 'ready', running: true })), ['logs', 'remove', 'repositories', 'restart', 'stop']);
  assert.deepEqual(on(projectActions({ state: 'stopping', running: true })), ['logs']);
  for (const pending of ['start', 'stop', 'restart', 'remove']) {
    assert.deepEqual(on(projectActions({ state: 'ready', running: true }, pending)), ['logs'], pending);
  }
});

test('Per-tab menu: Start or Stop by state, Restart when running, busy states, secondary items', () => {
  const labels = (entries) => entries.map((entry) => 'id' in entry ? `${entry.label}${entry.enabled ? '' : ' (disabled)'}` : '—');
  assert.deepEqual(labels(tabMenuModel({ state: 'stopped' }, undefined, 0, 3)),
    ['Start Project', '—', 'Show Logs', 'Repositories… (disabled)', '—', 'Move Tab Left (disabled)', 'Move Tab Right', '—', 'Remove Project…']);
  assert.deepEqual(labels(tabMenuModel({ state: 'ready', running: true }, undefined, 1, 3)).slice(0, 5),
    ['Stop Project…', 'Restart Project…', '—', 'Show Logs', 'Repositories…']);
  assert.deepEqual(labels(tabMenuModel({ state: 'starting' }, 'start', 2, 3)),
    ['Starting… (disabled)', '—', 'Show Logs', 'Repositories… (disabled)', '—', 'Move Tab Left', 'Move Tab Right (disabled)', '—', 'Remove Project… (disabled)']);
  assert.deepEqual(labels(tabMenuModel({ state: 'ready', running: true }, 'stop', 0, 1)).slice(0, 2), ['Stopping… (disabled)', 'Restart Project… (disabled)']);
  assert.deepEqual(labels(tabMenuModel({ state: 'stopping', running: true }, undefined, 0, 1)).slice(0, 1), ['Stopping… (disabled)']);
  assert.deepEqual(labels(tabMenuModel({ state: 'error' }, undefined, 0, 1)).slice(0, 1), ['Start Project']);
  assert.equal(tabMenuModel({ state: 'stopped' }, undefined, 0, 1).find((entry) => entry.id === 'repositories').toolTip,
    'Start the project to manage its repositories');
});
