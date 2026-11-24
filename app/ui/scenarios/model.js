const F = window.__forge;
document.getElementById('model-pop').classList.add('open');
document.getElementById('model-search').value = '';
const ev = new Event('input', { bubbles: true });
document.getElementById('model-search').dispatchEvent(ev);
renderModelList('');
'model ok'
