const F = window.__forge;
const appOrig = 'function render() {\n  document.getElementById("app").innerHTML = tasks\n    .map(t => `<div class="task ${t.done ? \'done\' : \'\'}">${t.text}</div>`).join("");\n}';
const appUpd  = 'function render() {\n  document.getElementById("app").innerHTML = tasks\n    .map(t => `<div class="task ${t.done ? \'done\' : \'failed\'}">${t.text}</div>`).join("");\n}';
F.state.pendingDiffs = [
  { path: 'src/styles.css', kind: 'mod', workspace: F.state.workspace,
    original: '.task { padding: 10px; border: 1px solid #232528; border-radius: 8px; margin: 8px 0; }\n.done { opacity: .5; }',
    updated: '.task { padding: 10px; border: 1px solid #232528; border-radius: 8px; margin: 8px 0; }\n.task.failed { border-left: 3px solid #FF6157; background: rgba(255, 97, 87, .06); }\n.done { opacity: .5; }' },
  { path: 'src/app.js', kind: 'mod', workspace: F.state.workspace, status: 'applied', original: appOrig, updated: appUpd },
];
F.renderDiffs();
F.switchTab('diffs');
'diffs ok'
