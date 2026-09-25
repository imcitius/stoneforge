const $ = (id) => document.getElementById(id);
let state = { projects: [] };
async function command(name, id) {
  $('error').hidden = true;
  try { render(await window.desktop.command(name, id)); }
  catch (error) { $('error').textContent = error.message; $('error').hidden = false; }
}
function render(next) {
  state = next;
  const focused = document.activeElement?.dataset.project;
  $('projects').replaceChildren(...state.projects.map((project) => {
    const button = document.createElement('button'); button.dataset.project = project.id;
    if (project.id === state.active) button.setAttribute('aria-current', 'page');
    button.title = project.root;
    const name = document.createElement('strong'); name.textContent = project.name;
    const status = document.createElement('span'); status.textContent = project.state;
    button.append(name, status); button.onclick = () => command('open', project.id); return button;
  }));
  if (focused) [...$('projects').children].find((el) => el.dataset.project === focused)?.focus();
  const project = state.projects.find((item) => item.id === state.active);
  $('name').textContent = project?.name ?? 'Your workspace';
  $('path').textContent = project?.root ?? 'Choose a project to begin';
  $('empty').hidden = !!project; $('actions').hidden = !project;
  $('status').hidden = !project || project.state === 'ready';
  $('status').textContent = project ? (project.error || ({ starting: 'Opening project…', stopped: 'Project stopped. Select it in the sidebar to open it again.', stopping: 'Stopping agents and saving state…' }[project.state] ?? project.state)) : '';
}
$('add').onclick = $('add-empty').onclick = () => command('add');
for (const button of document.querySelectorAll('[data-command]')) button.onclick = () => command(button.dataset.command, state.active);
window.desktop.subscribe(render);
command('list');
