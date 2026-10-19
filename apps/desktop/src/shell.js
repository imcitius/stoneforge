const $ = (id) => document.getElementById(id);
let state = { projects: [] };
let adding = false;
async function command(name, id) {
  if (name === 'add' && adding) return;
  if (name === 'add') { adding = true; render(state); }
  $('error').hidden = true;
  try { render(await window.desktop.command(name, id)); }
  catch (error) { $('error').textContent = error.message; $('error').hidden = false; }
  finally { if (name === 'add') { adding = false; render(state); } }
}
function renderSidebar(collapsed) {
  const sidebar = $('sidebar'), toggle = $('sidebar-toggle');
  // Hidden removes the panel from layout and the tab order; keep focus on a visible control.
  if (collapsed && sidebar.contains(document.activeElement)) toggle.focus();
  sidebar.hidden = collapsed;
  const label = collapsed ? 'Show project sidebar' : 'Hide project sidebar';
  toggle.setAttribute('aria-expanded', String(!collapsed));
  toggle.setAttribute('aria-label', label); toggle.title = `${label} (⌃⌘S)`;
}
function render(next) {
  state = next;
  renderSidebar(!!state.sidebarCollapsed);
  if (state.build) {
    const { version, commit, branch, dirty, builtAt } = state.build;
    $('build').textContent = `v${version} · ${commit.slice(0, 12)}${dirty ? ' (modified)' : ''}`;
    $('build').title = `Commit: ${commit}\nBranch: ${branch}\nBuilt: ${builtAt ?? 'unknown'}`;
  }
  for (const id of ['add', 'add-empty']) $(id).disabled = adding || !!state.progress;
  $('add-progress').hidden = !adding && !state.progress;
  $('add-progress').textContent = state.progress || (adding ? 'Adding project…' : '');
  const focused = document.activeElement?.dataset.project;
  $('projects').replaceChildren(...state.projects.map((project) => {
    const button = document.createElement('button'); button.dataset.project = project.id;
    if (project.id === state.active) button.setAttribute('aria-current', 'page');
    button.title = project.root;
    const name = document.createElement('strong'); name.textContent = project.name;
    const status = document.createElement('span'); status.textContent = project.needsInput ? 'Needs your input' : project.state;
    if (project.needsInput) status.className = 'needs-input';
    button.append(name, status); button.onclick = () => command('open', project.id); return button;
  }));
  if (focused) [...$('projects').children].find((el) => el.dataset.project === focused)?.focus();
  const project = state.projects.find((item) => item.id === state.active);
  $('name').textContent = project?.name ?? 'Your workspace';
  $('path').textContent = project?.root ?? 'Choose a project to begin';
  $('empty').hidden = !!project; $('actions').hidden = !project;
  $('status').hidden = !project || project.state === 'ready';
  $('status').textContent = project ? (project.error || ({ starting: 'Opening project…', stopped: state.sidebarCollapsed ? 'Project stopped. Show the project sidebar and select it to open it again.' : 'Project stopped. Select it in the sidebar to open it again.', stopping: 'Stopping agents and saving state…' }[project.state] ?? project.state)) : '';
}
$('add').onclick = $('add-empty').onclick = () => command('add');
$('sidebar-toggle').onclick = () => {
  const collapsed = !state.sidebarCollapsed;
  // Apply locally at once; the main process then moves the project view and confirms.
  render({ ...state, sidebarCollapsed: collapsed });
  void command('sidebar', collapsed ? 'collapsed' : 'expanded');
};
for (const button of document.querySelectorAll('[data-command]')) button.onclick = () => command(button.dataset.command, state.active);
window.desktop.subscribe(render);
command('list');
