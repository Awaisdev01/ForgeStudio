const F = window.__forge;
F.switchTab('files');
const srcDir = [...document.querySelectorAll('.tree .node')].find(n => n.dataset.dir === 'true' && n.querySelector('.n-label')?.textContent === 'src');
if (srcDir) { srcDir.click(); await new Promise(r => setTimeout(r, 700)); }
const file = [...document.querySelectorAll('.tree .node')].find(n => n.dataset.path?.endsWith('app.js'));
if (file) await F.openFileViewer(file.dataset.path);
'files ok'
