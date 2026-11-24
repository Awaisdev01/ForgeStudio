const F = window.__forge;
F.state.messages = [
  { role: 'user', content: 'The error styling looks wrong — make failed tasks stand out with a red left border.' },
  { role: 'assistant', content: 'I read `src/styles.css` and `src/app.js`. Failed tasks only get opacity — no visual error state. Here is the fix:\n\n```css\n.task.failed {\n  border-left: 3px solid #FF6157;\n  background: rgba(255, 97, 87, .06);\n}\n```\n\nStaged the change — review it in the Diffs pane.' },
];
F.state.steps = [
  { name: 'read_file', detail: 'src/styles.css', status: 'done', ms: 42, cls: 'read', output: ':root { --accent: #B7FF45; }\n.task { padding: 10px; border: 1px solid #232528; }' },
  { name: 'edit_file', detail: 'src/styles.css (+3 −0)', status: 'done', ms: 118, cls: 'write', output: 'staged for review in the Diffs pane' },
];
F.renderTranscript();
'chat ok'
