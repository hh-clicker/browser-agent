export const CODE_ASSESSMENT_BINDING = '__hhClickerGenerateCodeSolution'

export const CODE_ASSISTANT_SCRIPT = String.raw`(() => {
  'use strict';
  if (window.top !== window || location.origin !== 'https://assessment.hh.ru' || !/^\/code\/\d+\/?$/.test(location.pathname)) return;
  if (window.__hhClickerCodeAssistantInstalled) return;
  window.__hhClickerCodeAssistantInstalled = true;

  const HOST_ID = 'hh-clicker-code-assistant';
  const BINDING = '__hhClickerGenerateCodeSolution';
  let busy = false;
  let scheduled = false;
  let elements = null;
  let taskSignature = '';

  const normalize = value => String(value || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const counter = () => {
    const match = normalize(document.querySelector('[data-qa="task-counter"]')?.textContent).match(/(\d+)\s*из\s*(\d+)/i);
    return match ? { taskNumber: Number(match[1]), taskCount: Number(match[2]) } : { taskNumber: null, taskCount: null };
  };
  const signature = () => normalize(document.querySelector('h1[data-qa="title"]')?.textContent) + '|' + JSON.stringify(counter());
  const monacoModel = () => {
    const api = window.monaco?.editor;
    const models = typeof api?.getModels === 'function' ? api.getModels() : [];
    const uri = document.querySelector('.monaco-editor[role="code"][data-uri]')?.getAttribute('data-uri');
    const matching = models.find(model => model.uri?.toString() === uri);
    return matching || (models.length === 1 ? models[0] : null);
  };
  const extract = () => {
    const titleElement = document.querySelector('h1[data-qa="title"]');
    const statementRoot = titleElement?.closest('section');
    const model = monacoModel();
    const mode = document.querySelector('[data-mode-id]')?.getAttribute('data-mode-id');
    return {
      title: normalize(titleElement?.textContent), statement: normalize(statementRoot?.innerText),
      language: String(model?.getLanguageId?.() || mode || '').trim(), code: String(model?.getValue?.() || ''), ...counter(),
    };
  };
  const currentLabel = () => {
    const value = counter(); return value.taskNumber && value.taskCount ? 'ASK CODEX [' + value.taskNumber + '/' + value.taskCount + ']' : 'ASK CODEX';
  };
  const tokenClass = type => {
    const value = String(type || '').toLowerCase();
    if (value.includes('comment')) return 'tok-comment';
    if (value.includes('string')) return 'tok-string';
    if (value.includes('regexp')) return 'tok-regexp';
    if (value.includes('number')) return 'tok-number';
    if (value.includes('keyword')) return 'tok-keyword';
    if (/type|class|interface|struct|enum/.test(value)) return 'tok-type';
    if (/function|method/.test(value)) return 'tok-function';
    return '';
  };
  const renderCode = (code, language) => {
    const value = String(code || '');
    elements.code.replaceChildren();
    if (!value) return;
    let tokenLines;
    try { tokenLines = window.monaco?.editor?.tokenize?.(value, language); } catch {}
    if (!Array.isArray(tokenLines)) { elements.code.textContent = value; return; }
    const sourceLines = value.split('\n');
    const fragment = document.createDocumentFragment();
    sourceLines.forEach((line, lineIndex) => {
      const tokens = Array.isArray(tokenLines[lineIndex]) ? tokenLines[lineIndex] : [];
      let cursor = 0;
      tokens.forEach((token, tokenIndex) => {
        const start = Math.max(cursor, Math.min(line.length, Number(token.offset) || 0));
        const nextOffset = tokenIndex + 1 < tokens.length ? Number(tokens[tokenIndex + 1].offset) : line.length;
        const end = Math.max(start, Math.min(line.length, Number.isFinite(nextOffset) ? nextOffset : line.length));
        if (start > cursor) fragment.append(document.createTextNode(line.slice(cursor, start)));
        const span = document.createElement('span'); span.className = tokenClass(token.type);
        span.textContent = line.slice(start, end); fragment.append(span); cursor = end;
      });
      if (cursor < line.length) fragment.append(document.createTextNode(line.slice(cursor)));
      if (lineIndex + 1 < sourceLines.length) fragment.append(document.createTextNode('\n'));
    });
    elements.code.append(fragment);
  };
  const show = (title, code, explanation = '', warnings = [], language = '') => {
    ensure(); elements.panel.hidden = false; elements.title.textContent = title; renderCode(code, language);
    elements.explanation.textContent = [explanation, ...warnings].filter(Boolean).join('\n\n');
  };
  const setBusy = value => {
    busy = value; if (!elements) return; elements.button.disabled = value; elements.button.textContent = value ? 'CODEX…' : currentLabel();
  };
  const ask = async () => {
    if (busy) return;
    const input = extract();
    if (!input.title || !input.statement || !input.language) {
      show('Ошибка разбора', '', 'Не удалось получить условие, язык или модель редактора.'); return;
    }
    const requestedTask = signature();
    taskSignature = requestedTask;
    setBusy(true); show('Codex', '', 'Решение добавляется в очередь…');
    try {
      const bridge = window[BINDING];
      if (typeof bridge !== 'function') throw new Error('BRIDGE_UNAVAILABLE');
      const result = await bridge(input);
      if (signature() !== requestedTask) throw new Error('TASK_CHANGED');
      show('Решение готово', result.code, result.explanation, result.warnings, input.language);
    } catch (error) {
      const code = error instanceof Error ? error.message : 'UNKNOWN_ERROR';
      show('Ошибка Codex', '', code.replace(/^.*?:\s*/, ''));
    } finally { setBusy(false); ensure(); }
  };
  function ensure() {
    if (!document.body) return;
    let host = document.getElementById(HOST_ID);
    if (!host) {
      host = document.createElement('div'); host.id = HOST_ID; document.body.appendChild(host);
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = '<style>:host{all:initial}button{font:700 13px system-ui;cursor:pointer}.ask{position:fixed;left:20px;bottom:20px;z-index:2147483647;height:40px;padding:0 14px;border:0;border-radius:8px;background:#2563eb;color:#fff;box-shadow:0 8px 20px #0004}.ask:disabled{cursor:wait;opacity:.72}.panel{position:fixed;left:20px;bottom:74px;z-index:2147483647;width:min(640px,calc(100vw - 40px));max-height:min(680px,calc(100vh - 110px));border-radius:8px;background:#111827;color:#f9fafb;font:14px/1.45 system-ui;box-shadow:0 14px 36px #0005;overflow:hidden}.head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #ffffff1f}.title{flex:1;font-weight:700}.minor{border:0;background:transparent;color:#d1d5db}.code{overflow:auto;max-height:430px;margin:0;padding:12px;background:#0b1020;color:#e5e7eb;font:13px/1.45 Consolas,monospace;white-space:pre;tab-size:4}.tok-comment{color:#6a9955}.tok-string{color:#ce9178}.tok-regexp{color:#d16969}.tok-number{color:#b5cea8}.tok-keyword{color:#c586c0}.tok-type{color:#4ec9b0}.tok-function{color:#dcdcaa}.explanation{overflow:auto;max-height:110px;padding:10px 12px;white-space:pre-wrap;color:#d1d5db;border-top:1px solid #ffffff1f}</style><section class="panel" hidden><div class="head"><span class="title">Codex</span><button class="minor close" type="button">×</button></div><pre class="code"></pre><div class="explanation"></div></section><button class="ask" type="button">ASK CODEX</button>';
      elements = { panel: root.querySelector('.panel'), title: root.querySelector('.title'), code: root.querySelector('.code'), explanation: root.querySelector('.explanation'), button: root.querySelector('.ask') };
      elements.button.addEventListener('click', ask);
      root.querySelector('.close').addEventListener('click', () => { elements.panel.hidden = true; });
      taskSignature = signature();
    }
    const nextSignature = signature();
    if (taskSignature && nextSignature && taskSignature !== nextSignature && !busy) {
      taskSignature = nextSignature; elements.panel.hidden = true;
    }
    if (!busy) elements.button.textContent = currentLabel();
  }
  const update = () => {
    if (scheduled) return; scheduled = true;
    requestAnimationFrame(() => { scheduled = false; ensure(); });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ensure, { once: true }); else ensure();
  const startObserver = () => new MutationObserver(update).observe(document.documentElement, { childList: true, subtree: true });
  if (document.documentElement) startObserver(); else document.addEventListener('DOMContentLoaded', startObserver, { once: true });
})();`
