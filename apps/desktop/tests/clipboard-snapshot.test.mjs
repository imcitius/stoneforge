import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveClipboard, restoreClipboard } from '../scripts/clipboard-snapshot.mjs';

// Mirrors Electron's ClipboardItem: an item without MIME types cannot be built.
class FakeClipboardItem {
  constructor(data) {
    if (Object.keys(data).length === 0) {
      throw new TypeError("Failed to construct 'ClipboardItem': at least one MIME type is required.");
    }
    this.data = data;
  }
}

function fakeClipboard(items) {
  const calls = [];
  return {
    calls,
    clipboard: {
      read: async () => items.map(data => ({ types: Object.keys(data), getType: async type => data[type] })),
      write: async written => { calls.push(['write', written]); },
      clear: async () => { calls.push(['clear']); },
    },
  };
}

test('clipboard snapshot skips items with no MIME types and restores the rest', async () => {
  const { clipboard, calls } = fakeClipboard([{}, { 'text/plain': 'kept', 'text/html': '<b>kept</b>' }, {}]);
  const key = '__testClipboardMixed';
  assert.deepEqual(await saveClipboard({ clipboard, ClipboardItem: FakeClipboardItem }, key), { saved: 1, skipped: 2 });
  assert.deepEqual(await restoreClipboard({ clipboard }, key), { restored: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'write');
  assert.deepEqual(calls[0][1].map(item => item.data), [{ 'text/plain': 'kept', 'text/html': '<b>kept</b>' }]);
  assert.equal(globalThis[key], undefined, 'snapshot is released after restore');
});

test('an empty clipboard (single typeless item) is saved without error and restored by clearing', async () => {
  const { clipboard, calls } = fakeClipboard([{}]);
  // Negative control: the previous save logic fails on exactly this clipboard.
  await assert.rejects(
    Promise.all((await clipboard.read()).map(async item => new FakeClipboardItem(
      Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)])))))),
    /at least one MIME type is required/,
  );
  const key = '__testClipboardEmpty';
  assert.deepEqual(await saveClipboard({ clipboard, ClipboardItem: FakeClipboardItem }, key), { saved: 0, skipped: 1 });
  assert.deepEqual(await restoreClipboard({ clipboard }, key), { restored: 0 });
  assert.deepEqual(calls, [['clear']], 'nothing restorable: clear the sample text instead of writing an empty list');
});

test('restore refuses to run without a saved snapshot', async () => {
  const { clipboard, calls } = fakeClipboard([]);
  await assert.rejects(restoreClipboard({ clipboard }, '__testClipboardMissing'), /No clipboard snapshot/);
  assert.deepEqual(calls, []);
});

test('snapshot functions are self-contained for electron.evaluate serialization', async () => {
  // Playwright evaluates fn.toString() in Electron; rebuilding from source proves no closure is needed.
  const rebuiltSave = new Function(`return (${saveClipboard.toString()})`)();
  const rebuiltRestore = new Function(`return (${restoreClipboard.toString()})`)();
  const { clipboard, calls } = fakeClipboard([{}, { 'text/plain': 'x' }]);
  assert.deepEqual(await rebuiltSave({ clipboard, ClipboardItem: FakeClipboardItem }, '__testClipboardRebuilt'), { saved: 1, skipped: 1 });
  assert.deepEqual(await rebuiltRestore({ clipboard }, '__testClipboardRebuilt'), { restored: 1 });
  assert.equal(calls[0][0], 'write');
});
