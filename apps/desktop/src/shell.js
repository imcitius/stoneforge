const $ = (id) => document.getElementById(id);
const { fitTabs, splitTabs, focusTarget, dropOrder } = window.StoneforgeTabLayout;
// Tab geometry (px). DRAG_SPACE keeps an empty, draggable part of the title bar.
const TAB_MIN = 96, TAB_MAX = 200, BUTTON = 32, DRAG_SPACE = 72;
let state = { projects: [] };
let adding = false;
let overflowIds = [];
let dragging;
const tabs = new Map();

async function command(name, id, options) {
  if (name === 'add' && adding) return;
  if (name === 'add') { adding = true; render(state); }
  $('error').hidden = true;
  try { render(await window.desktop.command(name, id, options)); }
  catch (error) { $('error').textContent = error.message; $('error').hidden = false; }
  finally { if (name === 'add') { adding = false; render(state); } }
}

function anchor(element) { const rect = element.getBoundingClientRect(); return { x: rect.left, y: rect.bottom }; }
function openTabMenu(tab, point = anchor(tab)) { void command('tab-menu', tab.dataset.project, point); }
function clearDrop() { for (const tab of tabs.values()) tab.classList.remove('drop-before', 'drop-after'); }
function dropAfter(tab, event) { const rect = tab.getBoundingClientRect(); return event.clientX > rect.left + rect.width / 2; }

function onTabKey(event) {
  const tab = event.currentTarget;
  if ((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') { event.preventDefault(); openTabMenu(tab); return; }
  const shown = [...$('projects').children];
  const target = focusTarget(event.key, shown.indexOf(tab), shown.length);
  if (target === undefined) return;
  event.preventDefault();
  // Arrow keys move focus only (manual activation): selecting can start a stopped project.
  shown.forEach((item, index) => { item.tabIndex = index === target ? 0 : -1; });
  shown[target].focus();
}

function tabElement(id) {
  let tab = tabs.get(id);
  if (tab) return tab;
  tab = document.createElement('button');
  tab.type = 'button'; tab.id = `tab-${id}`; tab.dataset.project = id; tab.draggable = true;
  tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', 'panel');
  const dot = document.createElement('span'); dot.className = 'dot'; dot.setAttribute('aria-hidden', 'true');
  const name = document.createElement('span'); name.className = 'tab-name';
  tab.append(dot, name);
  tab.addEventListener('click', () => command('open', id));
  tab.addEventListener('keydown', onTabKey);
  tab.addEventListener('contextmenu', (event) => { event.preventDefault(); openTabMenu(tab, { x: event.clientX, y: event.clientY }); });
  tab.addEventListener('dragstart', (event) => {
    dragging = id; tab.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-stoneforge-project', id);
  });
  tab.addEventListener('dragend', () => { dragging = undefined; tab.classList.remove('dragging'); clearDrop(); });
  tab.addEventListener('dragover', (event) => {
    if (!dragging || dragging === id) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'move';
    const after = dropAfter(tab, event);
    tab.classList.toggle('drop-after', after); tab.classList.toggle('drop-before', !after);
  });
  tab.addEventListener('dragleave', () => tab.classList.remove('drop-before', 'drop-after'));
  tab.addEventListener('drop', (event) => {
    if (!dragging) return;
    event.preventDefault();
    const ids = state.projects.map((project) => project.id);
    const order = dropOrder(ids, dragging, id, dropAfter(tab, event));
    dragging = undefined; clearDrop();
    if (order.join() === ids.join()) return;
    // Show the new order at once; the main process persists it and confirms.
    render({ ...state, projects: order.map((item) => state.projects.find((project) => project.id === item)) });
    void command('reorder', undefined, { order });
  });
  tabs.set(id, tab);
  return tab;
}

function updateTab(tab, project) {
  const selected = project.id === state.active;
  const { kind, label } = project.status;
  tab.dataset.state = project.state; tab.dataset.status = kind;
  tab.setAttribute('aria-selected', String(selected));
  tab.setAttribute('aria-label', `${project.name}, ${label}`);
  tab.title = `${project.name}\n${project.root}\n${label}`;
  tab.querySelector('.tab-name').textContent = project.name;
}

/** Fit tabs to the title bar; the rest go to the » menu. The active tab always stays visible. */
function renderTabs() {
  const list = $('projects'), bar = $('titlebar'), overflow = $('overflow');
  const ids = state.projects.map((project) => project.id);
  for (const [id, tab] of tabs) if (!ids.includes(id)) { tab.remove(); tabs.delete(id); }
  const style = getComputedStyle(bar);
  const available = bar.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - BUTTON - DRAG_SPACE;
  const fit = fitTabs({ count: ids.length, available, min: TAB_MIN, max: TAB_MAX, overflow: BUTTON });
  const { shown, hidden } = splitTabs(ids, state.active, fit.visible);
  overflowIds = hidden;
  list.style.setProperty('--tab-width', `${fit.width}px`);
  const focused = document.activeElement?.dataset?.project;
  shown.forEach((id, index) => {
    const tab = tabElement(id);
    updateTab(tab, state.projects.find((project) => project.id === id));
    if (list.children[index] !== tab) list.insertBefore(tab, list.children[index] ?? null);
  });
  for (const id of hidden) tabs.get(id)?.remove();
  // Roving tabindex: one tab stop in the tablist (the focused tab, else the active one).
  const stop = shown.includes(focused) ? focused : shown.includes(state.active) ? state.active : shown[0];
  for (const id of shown) tabs.get(id).tabIndex = id === stop ? 0 : -1;
  overflow.hidden = !hidden.length;
  const hiddenProjects = state.projects.filter((project) => hidden.includes(project.id));
  const label = `${hidden.length} more project${hidden.length === 1 ? '' : 's'}`;
  const waiting = hiddenProjects.filter((project) => project.status.kind === 'attention').length;
  overflow.classList.toggle('attention', waiting > 0);
  overflow.setAttribute('aria-label', waiting ? `${label}, ${waiting} need your input` : label);
  overflow.title = [label + ':', ...hiddenProjects.map((project) => `${project.name} — ${project.status.label}`)].join('\n');
  if (focused && tabs.get(focused) && document.activeElement !== tabs.get(focused)) {
    if (shown.includes(focused)) tabs.get(focused).focus(); else if (hidden.length) overflow.focus();
  }
}

function render(next) {
  state = next;
  document.body.classList.toggle('fullscreen', !!state.fullscreen);
  if (state.build) {
    const { version, commit, branch, dirty, builtAt } = state.build;
    $('build').textContent = `v${version} · ${commit.slice(0, 12)}${dirty ? ' (modified)' : ''}`;
    $('build').title = `Commit: ${commit}\nBranch: ${branch}\nBuilt: ${builtAt ?? 'unknown'}`;
  }
  for (const id of ['add', 'add-empty']) $(id).disabled = adding || !!state.progress;
  $('add-progress').hidden = !adding && !state.progress;
  $('add-progress').textContent = state.progress || (adding ? 'Adding project…' : '');
  renderTabs();
  const project = state.projects.find((item) => item.id === state.active);
  $('name').textContent = project?.name ?? 'Your workspace';
  $('path').textContent = project?.root ?? 'Choose a project to begin';
  $('path').title = project?.root ?? '';
  if (project) { $('panel').setAttribute('aria-labelledby', `tab-${project.id}`); $('panel').removeAttribute('aria-label'); }
  else { $('panel').removeAttribute('aria-labelledby'); $('panel').setAttribute('aria-label', 'Your workspace'); }
  $('empty').hidden = !!project; $('actions').hidden = !project;
  $('status').hidden = !project || project.state === 'ready';
  $('status').textContent = project ? (project.error || ({ starting: 'Opening project…', stopped: 'Project stopped. Select its tab to open it again.', stopping: 'Stopping agents and saving state…' }[project.state] ?? project.state)) : '';
}

$('add').onclick = $('add-empty').onclick = () => command('add');
$('overflow').onclick = () => command('overflow', undefined, { ...anchor($('overflow')), ids: overflowIds });
for (const button of document.querySelectorAll('[data-command]')) button.onclick = () => command(button.dataset.command, state.active);
new ResizeObserver(() => renderTabs()).observe($('titlebar'));
window.desktop.subscribe(render);
command('list');
