document.getElementById('palette').classList.add('open');
document.getElementById('palette-input').value = '';
const ev = new Event('input', { bubbles: true });
document.getElementById('palette-input').dispatchEvent(ev);
'palette ok'
