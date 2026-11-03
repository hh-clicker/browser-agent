export const ASSESSMENT_BINDING = '__hhClickerAnswerAssessmentQuestion'

// This source runs in the page. It only extracts the visible single-choice question and renders a local UI;
// the Playwright binding performs validation and owns all communication with Generation Agent.
export const ASSESSMENT_ASSISTANT_SCRIPT = String.raw`(() => {
  'use strict';
  if (window.top !== window || location.origin !== 'https://assessment.hh.ru' || !location.pathname.startsWith('/tests/')) return;
  if (window.__hhClickerAssessmentAssistantInstalled) return;
  window.__hhClickerAssessmentAssistantInstalled = true;

  const HOST_ID = 'hh-clicker-assessment-assistant';
  const BINDING = '__hhClickerAnswerAssessmentQuestion';
  let busy = false;
  let scheduled = false;
  let elements = null;

  const normalize = value => String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const counter = () => {
    const match = normalize(document.querySelector('[data-qa="tasks-counter"]')?.textContent).match(/(\d+)\s*из\s*(\d+)/i);
    return match ? { taskNumber: Number(match[1]), taskCount: Number(match[2]) } : { taskNumber: null, taskCount: null };
  };
  const answerText = (input, questionRoot) => {
    const label = input.closest('label');
    if (!label) return normalize(input.value);
    const parts = Array.from(label.querySelectorAll('p, li, code, pre'))
      .filter(node => !questionRoot?.contains(node)).map(node => normalize(node.textContent)).filter(Boolean);
    return [...new Set(parts)].join(' ') || normalize(input.value);
  };
  const extract = () => {
    const questionRoot = document.querySelector('[data-qa="text-description"]');
    const inputs = Array.from(document.querySelectorAll('form input[name="answer"][type="radio"]'));
    const answers = inputs.map(input => answerText(input, questionRoot));
    return {
      question: normalize(questionRoot?.textContent), answers,
      title: normalize(document.querySelector('[data-qa="test-name"]')?.textContent), ...counter(),
    };
  };
  const clearHighlights = () => document.querySelectorAll('[data-hh-clicker-answer]').forEach(node => {
    node.style.removeProperty('outline'); node.style.removeProperty('outline-offset'); node.removeAttribute('data-hh-clicker-answer');
  });
  const highlight = answerNumber => {
    clearHighlights();
    const input = Array.from(document.querySelectorAll('form input[name="answer"][type="radio"]'))[answerNumber - 1];
    const card = input?.closest('[class*="checkable-card-wrapper"]') || input?.closest('label');
    if (card) {
      card.setAttribute('data-hh-clicker-answer', 'true'); card.style.outline = '2px solid #22c55e'; card.style.outlineOffset = '3px';
      card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  };
  const show = (title, message, meta = '') => {
    ensure(); elements.panel.hidden = false; elements.title.textContent = title; elements.message.textContent = message; elements.meta.textContent = meta;
  };
  const label = () => {
    const value = counter(); return value.taskNumber && value.taskCount ? 'ASK CODEX [' + value.taskNumber + '/' + value.taskCount + ']' : 'ASK CODEX';
  };
  const setBusy = value => {
    busy = value; if (!elements) return; elements.button.disabled = value; elements.button.textContent = value ? 'CODEX…' : label();
  };
  const ask = async () => {
    if (busy) return;
    const input = extract();
    if (!input.question || input.answers.length < 2 || input.answers.some(answer => !answer)) {
      show('Ошибка разбора', 'Не удалось получить вопрос или хотя бы два варианта ответа.'); return;
    }
    clearHighlights(); setBusy(true); show('Codex', 'Задание добавляется в очередь…');
    try {
      const bridge = window[BINDING];
      if (typeof bridge !== 'function') throw new Error('BRIDGE_UNAVAILABLE');
      const result = await bridge(input);
      highlight(result.answerNumber);
      const confidence = { high: 'высокая', medium: 'средняя', low: 'низкая' }[result.confidence] || result.confidence;
      show('Codex · вариант ' + result.answerNumber, result.answer + (result.explanation ? '\n\n' + result.explanation : ''), 'Уверенность: ' + confidence);
    } catch (error) {
      const code = error instanceof Error ? error.message : 'UNKNOWN_ERROR';
      show('Ошибка Codex', 'Не удалось получить ответ.', code.replace(/^.*?:\s*/, ''));
    } finally { setBusy(false); }
  };
  function ensure() {
    if (!document.body) return;
    let host = document.getElementById(HOST_ID);
    if (!host) {
      host = document.createElement('div'); host.id = HOST_ID; document.body.appendChild(host);
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = '<style>:host{all:initial}button{font:700 13px system-ui;cursor:pointer}.ask{position:fixed;right:20px;bottom:20px;z-index:2147483647;height:40px;padding:0 14px;border:0;border-radius:8px;background:#2563eb;color:#fff;box-shadow:0 8px 20px #0004}.ask:disabled{cursor:wait;opacity:.72}.panel{position:fixed;right:20px;bottom:74px;z-index:2147483647;width:min(440px,calc(100vw - 40px));max-height:min(520px,calc(100vh - 110px));border-radius:8px;background:#111827;color:#f9fafb;font:14px/1.45 system-ui;box-shadow:0 14px 36px #0005;overflow:hidden}.head{display:flex;gap:8px;padding:10px 12px;border-bottom:1px solid #ffffff1f}.title{flex:1;font-weight:700}.minor{border:0;background:transparent;color:#d1d5db}.message{overflow:auto;max-height:390px;padding:12px;white-space:pre-wrap}.meta{padding:8px 12px;border-top:1px solid #ffffff1f;color:#9ca3af;font-size:12px}</style><section class="panel" hidden><div class="head"><span class="title">Codex</span><button class="minor copy" type="button">Copy</button><button class="minor close" type="button">×</button></div><div class="message"></div><div class="meta"></div></section><button class="ask" type="button">ASK CODEX</button>';
      elements = { panel: root.querySelector('.panel'), title: root.querySelector('.title'), message: root.querySelector('.message'), meta: root.querySelector('.meta'), button: root.querySelector('.ask') };
      elements.button.addEventListener('click', ask);
      root.querySelector('.close').addEventListener('click', () => { elements.panel.hidden = true; });
      root.querySelector('.copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(elements.message.textContent || ''); } catch {} });
    }
    if (!busy && elements) elements.button.textContent = label();
  }
  const update = () => {
    if (scheduled) return; scheduled = true;
    requestAnimationFrame(() => { scheduled = false; ensure(); });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ensure, { once: true }); else ensure();
  const startObserver = () => new MutationObserver(update).observe(document.documentElement, { childList: true, subtree: true });
  if (document.documentElement) startObserver(); else document.addEventListener('DOMContentLoaded', startObserver, { once: true });
})();`
