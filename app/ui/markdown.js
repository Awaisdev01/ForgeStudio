/* ForgeStudio — tiny local markdown renderer (no deps, offline) */
const MD = (() => {
  function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; }

  // minimal highlighter: keywords, strings, numbers, comments — good enough for review UI
  function hl(code, lang) {
    let out = esc(code);
    if (lang && /^(python|py|bash|sh|shell|json|yaml|yml|toml)$/i.test(lang)) {
      out = out.replace(/(&quot;[^&]*?&quot;|'[^']*?')/g, '<span class="str">$1</span>')
               .replace(/(^|\s)(#(?:.*))$/gm, '$1<span class="cm">$2</span>');
    } else {
      out = out
        .replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;|'(?:[^']|\\')*?'|`(?:[^`])*?`)/g, '<span class="str">$1</span>')
        .replace(/\b(function|const|let|var|return|if|else|for|while|class|import|from|export|async|await|def|self|public|private|struct|impl|fn|use|match|type|interface|new|throw|try|catch|finally|switch|case|break|continue|extends|implements|static|this|super|yield|in|of|is|not|and|or|None|True|False|null|undefined|true|false)\b/g, '<span class="kw">$1</span>')
        .replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="num">$1</span>')
        .replace(/(^|\n)(\s*(?:\/\/|#|\/\*|\*)[^\n]*)/g, '$1<span class="cm">$2</span>');
    }
    return out;
  }

  function render(src) {
    if (!src) return '';
    const blocks = [];
    // extract fenced code blocks first
    src = src.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      blocks.push({ lang: lang || 'text', code: code.replace(/\n$/, '') });
      return `\u0000CODEBLOCK${blocks.length - 1}\u0000`;
    });
    let html = esc(src);
    html = html
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/^\s*[-*] (.+)$/gm, '<li>$1</li>')
      .replace(/^\s*(\d+)\. (.+)$/gm, '<li>$2</li>')
      .replace(/(<li>[\s\S]*?<\/li>)(?!\n<li>)/g, (m) => m.includes('<ul') ? m : `<ul>${m}</ul>`)
      .replace(/\n{2,}/g, '</p><p>')
      .replace(/^(?!<[huplo])([\s\S]+)$/, '<p>$1</p>');
    // re-insert code blocks with copy buttons
    html = html.replace(/\u0000CODEBLOCK(\d+)\u0000/g, (_, i) => {
      const b = blocks[Number(i)];
      const id = `cb${Math.random().toString(36).slice(2, 8)}`;
      return `<div class="codeblock"><div class="cb-head"><span class="lang">${esc(b.lang)}</span><button class="copy-btn" data-code-id="${id}">copy</button></div><pre id="${id}">${hl(b.code, b.lang)}</pre></div>`;
    });
    return `<div class="md">${html}</div>`;
  }
  return { render, hl, esc };
})();
