/**
 * Save and restore the system clipboard around native clipboard checks.
 *
 * Both functions are passed directly to Playwright's `electron.evaluate`, which
 * serializes them with `toString()`, so they must stay self-contained (no
 * imports or module-scope references). Their first argument is the Electron
 * main-process module (`{clipboard, ClipboardItem}`), the second the
 * `globalThis` key that holds the snapshot inside the Electron process.
 *
 * An empty pasteboard (and some macOS pasteboard items) reads back as an item
 * with no MIME types. `new ClipboardItem({})` throws "at least one MIME type is
 * required", so such items are skipped: they carry no data to restore. When
 * nothing restorable was saved, restore clears the clipboard again instead of
 * leaving the check's sample text behind.
 */
export async function saveClipboard({ clipboard, ClipboardItem }, key = '__savedClipboard') {
  const items = [];
  let skipped = 0;
  for (const item of await clipboard.read()) {
    const types = item?.types ?? [];
    if (types.length === 0) { skipped += 1; continue; }
    const entries = await Promise.all(types.map(async type => [type, await item.getType(type)]));
    items.push(new ClipboardItem(Object.fromEntries(entries)));
  }
  globalThis[key] = items;
  return { saved: items.length, skipped };
}

export async function restoreClipboard({ clipboard }, key = '__savedClipboard') {
  const items = globalThis[key];
  if (!Array.isArray(items)) throw new Error(`No clipboard snapshot saved under ${key}`);
  if (items.length > 0) await clipboard.write(items);
  else await clipboard.clear();
  delete globalThis[key];
  return { restored: items.length };
}
