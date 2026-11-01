/**
 * Packaged-check helpers for the per-tab project menu. Native popups are recorded instead of
 * entering macOS menu tracking (which would wait for a physical click); items are then
 * activated through their real click handlers.
 */
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** Replace Menu.prototype.popup with a recorder (idempotent). Returns a function that restores it. */
export async function recordPopups(electron) {
  await electron.evaluate(({ Menu }) => {
    globalThis.__popups = [];
    if (globalThis.__originalPopup) return;
    globalThis.__originalPopup = Menu.prototype.popup;
    Menu.prototype.popup = function (options) { globalThis.__popups.push({ menu: this, x: options?.x, y: options?.y }); };
  });
  return () => electron.evaluate(({ Menu }) => {
    if (globalThis.__originalPopup) Menu.prototype.popup = globalThis.__originalPopup;
    delete globalThis.__originalPopup;
  });
}

export const popups = (electron) => electron.evaluate(() => globalThis.__popups.map(({ menu, x, y }) => ({ x, y,
  items: menu.items.map((i) => ({ id: i.id, type: i.type, label: i.label, enabled: i.enabled, toolTip: i.toolTip })) })));

/** Waits for the `count`-th recorded popup and returns it. */
export async function waitPopup(electron, count) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const recorded = await popups(electron);
    if (recorded.length >= count) return recorded[count - 1];
    await pause(50);
  }
  throw new Error('No native menu popup was requested');
}

/** Activates the item with this label in the latest recorded popup (`times` clicks in one turn). */
export const clickPopup = (electron, label, times = 1) => electron.evaluate((_e, { label, times }) => {
  const { menu } = globalThis.__popups.at(-1);
  const item = menu.items.find((i) => i.label === label) ?? menu.items.find((i) => i.label.includes(label));
  if (!item) throw new Error(`No popup item ${label}: ${menu.items.map((i) => i.label).join(', ')}`);
  if (!item.enabled) throw new Error(`Popup item ${label} is disabled`);
  for (let index = 0; index < times; index++) item.click();
}, { label, times });

/** Opens the active tab's ⋯ menu with the mouse and activates `label`. */
export async function chooseTabAction(electron, page, label) {
  const before = (await popups(electron)).length;
  await page.locator('#tab-actions').click();
  await waitPopup(electron, before + 1);
  await clickPopup(electron, label);
}
