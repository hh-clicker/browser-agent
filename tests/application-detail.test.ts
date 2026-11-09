import assert from 'node:assert/strict'
import test from 'node:test'
import { chromium, type Page } from 'playwright'
import { applyVacancy as apply, inspectApplication as inspect, vacancyArchived as archived, type ApplicationTask, type ApplicationControl } from '../src/hh/application.js'
import { bundledSelectors } from './helpers/bundled-selectors.js'
import { readFileSync } from 'node:fs'
import { parseSelectorGroup, SelectorRegistry } from '../src/hh/selector-registry.js'

const target = 'https://hh.ru/vacancy/123'
const bundled = bundledSelectors()
const applyVacancy: typeof apply = (page, task, control, registry = bundled) => apply(page, task, control, registry)
const inspectApplication: typeof inspect = (page, url, registry = bundled) => inspect(page, url, registry)
const vacancyArchived: typeof archived = (page, url, registry = bundled) => archived(page, url, registry)

function configuredApplication(change: (registry: ReturnType<typeof parseSelectorGroup>) => void): SelectorRegistry {
  return new SelectorRegistry(['common', 'vacancy', 'response-form', 'letter-form'].map(file => {
    const group = parseSelectorGroup(JSON.parse(readFileSync(new URL(`../resources/hh-selectors/${file}.json`, import.meta.url), 'utf8')))
    change(group)
    return group
  }))
}

test('application honors configured action selectors instead of falling back to hardcoded buttons', async () => {
  const registry = configuredApplication(group => {
    if (group.id === 'vacancy') {
      group.selectors.title!.kind = 'xpath'; group.selectors.title!.value = '//h1'
      group.selectors.respond!.value = '.missing-configured-response'
    }
  })
  await offline('immediate', { success: true }, async (page, control, _requests, permits) => {
    assert.equal(await applyVacancy(page, task, control, registry), 'NOT_SENT')
    assert.equal(permits(), 0)
  })
})

test('letter attachment uses the configured attach control after confirmed delivery', async () => {
  const registry = configuredApplication(group => {
    if (group.id === 'letterForm') group.selectors.attach!.value = '.missing-configured-attach'
  })
  await offline('immediate', { success: true }, async (page, control, _requests, permits) => {
    assert.equal(await applyVacancy(page, task, control, registry), 'SENT_LETTER_UNCONFIRMED')
    assert.equal(permits(), 1)
  })
})
const task: ApplicationTask = {
  itemId: 'test-item', runId: 'test-run', profileId: 'test-profile', hhResumeId: 'ABC123', hhVacancyId: '123',
  // Deliberately invalid search metadata: detail application must not depend on it.
  sourceUrl: 'not-a-search-url', searchPage: 999, coverLetter: 'Test letter',
}

// Entirely synthetic markup: no user's HTML, personal data, tokens or remote assets.
function fixture(mode: 'popup' | 'immediate' | 'already' | 'recommendation-only'
  | 'single-immediate' | 'single-already' | 'header-only-already' | 'letter-kept' | 'captcha-after-click'
  | 'letter-already-viewed' | 'fixed-required' | 'fixed-optional' | 'select-required'
  | 'immediate-stale' | 'letter-stale' | 'archived'): string {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>
    <h1 data-qa="vacancy-title">Test vacancy${mode === 'archived' ? '<span data-qa="vacancy-title-archived-text">В архиве</span>' : ''}</h1>
    <div data-qa="vacancy-description"><p>Build services.</p></div>
    ${mode === 'archived' ? '<p data-qa="vacancy-archive-description">Работодатель больше не принимает отклики</p>' : ''}
    <div class="vacancy-actions_magritte-vacancy-top" id="actions">
      <a role="button" data-qa="vacancy-response-link-top" href="/applicant/vacancy_response?vacancyId=123">Apply</a>
    </div>
    <div class="vacancy-actions_responded" id="delivered" hidden>
      <h2>Резюме доставлено</h2><button data-qa="responded-success-attach-cover-letter">Attach letter</button>
      <button data-qa="vacancy-response-link-view-topic">Chat</button>
    </div>
    <div data-qa="vacancy-serp__vacancy">
      <a data-qa="vacancy-serp__vacancy_response" href="/applicant/vacancy_response?vacancyId=999">Other vacancy</a>
      <span data-qa="vacancy-serp__vacancy_responded">Вы откликнулись</span>
      <div class="vacancy-actions_responded"><h2>Резюме доставлено</h2>
        <button data-qa="vacancy-response-link-view-topic">Other vacancy chat</button>
      </div>
    </div>
    <div role="dialog" id="response" hidden><h2>Test vacancy</h2>
      <form id="RESPONSE_MODAL_FORM_ID" name="vacancy_response">
        <div class="${mode.startsWith('fixed-') ? 'fixed-resume' : 'magritte-select-layout___test'}">
          <div role="button" tabindex="0" id="resume"><span data-qa="resume-title">Test resume</span></div>
        </div>
        <textarea data-qa="vacancy-response-popup-form-letter-input" ${mode.endsWith('-required') ? '' : 'hidden'}></textarea>
        ${mode.endsWith('-required') ? '<p>Сопроводительное письмо обязательное для этой вакансии</p>' : ''}
      </form>
      <button data-qa="add-cover-letter" type="button">Add letter</button>
      <button data-qa="vacancy-response-submit-popup" form="RESPONSE_MODAL_FORM_ID" type="submit" ${mode.endsWith('-required') ? 'disabled' : ''}>Submit</button>
    </div>
    <div role="listbox" data-qa="magritte-select-option-list" id="list" hidden>
      <div role="option" data-magritte-select-option="ABC123" aria-selected="true" aria-disabled="false">Selected resume</div>
    </div>
    <div role="dialog" id="letter-dialog" hidden>
      <form id="cover-letter-test" method="post" action="/applicant/vacancy_response/edit_ajax">
        <input name="topicId" value="321" type="hidden">
        <textarea name="text" data-qa="vacancy-response-popup-form-letter-input"></textarea>
      </form>
      <p id="letter-error" hidden>Отклик уже просмотрен работодателем.</p>
      <button data-qa="vacancy-response-letter-submit" type="submit" form="cover-letter-test">Send letter</button>
    </div>
    <script>
      const byId = id => document.getElementById(id);
      window.submissions = 0;
      window.selectedClicks = 0;
      window.resumeClicks = 0;
      window.submittedLetter = null;
      function markApplied() {
        byId('actions').innerHTML = '<button data-qa="vacancy-response-link-top-again">Other resume</button><button data-qa="vacancy-response-link-view-topic">Chat</button>';
        if (${JSON.stringify(mode)}.startsWith('single-')) byId('actions').remove();
        byId('delivered').hidden = false;
      }
      byId('resume').onclick = () => {
        window.resumeClicks++;
        if (${JSON.stringify(mode)}.startsWith('fixed-')) return;
        byId('list').hidden = !byId('list').hidden;
      };
      byId('response').querySelector('textarea').oninput = e => {
        if (${JSON.stringify(mode)}.endsWith('-required')) {
          document.querySelector('[data-qa="vacancy-response-submit-popup"]').disabled = !e.target.value.trim();
        }
      };
      document.querySelector('[role="option"]').onclick = () => { window.selectedClicks++; }; // HH does not close it!
      document.querySelector('[data-qa="add-cover-letter"]').onclick = () => {
        byId('response').querySelector('textarea').hidden = false;
      };
      document.querySelector('[data-qa="vacancy-response-link-top"]').onclick = e => {
        e.preventDefault();
        if (${JSON.stringify(mode)} === 'captcha-after-click') {
          const captcha = document.createElement('div'); captcha.className = 'smart-captcha'; captcha.textContent = 'Check';
          document.body.append(captcha); return;
        }
        if (['immediate', 'single-immediate', 'letter-kept', 'letter-already-viewed', 'immediate-stale', 'letter-stale'].includes(${JSON.stringify(mode)})) {
          window.submissions++;
          sessionStorage.setItem('application-posted', 'true');
          if (${JSON.stringify(mode)} !== 'immediate-stale') markApplied();
        }
        else byId('response').hidden = false;
      };
      byId('RESPONSE_MODAL_FORM_ID').onsubmit = e => {
        e.preventDefault(); window.submissions++;
        window.submittedLetter = byId('response').querySelector('textarea').value;
        byId('response').hidden = true; markApplied();
      };
      document.querySelector('[data-qa="responded-success-attach-cover-letter"]').onclick = () => {
        byId('letter-dialog').hidden = false;
      };
      byId('cover-letter-test').onsubmit = async e => {
        e.preventDefault();
        await fetch('/applicant/vacancy_response/edit_ajax', { method: 'POST', body: new FormData(e.target) });
        if (${JSON.stringify(mode)} === 'letter-already-viewed') { byId('letter-error').hidden = false; return; }
        // Closing only the popup is insufficient: the detail attachment button must disappear too.
        byId('letter-dialog').hidden = true;
        if (${JSON.stringify(mode)} === 'letter-stale') sessionStorage.setItem('letter-posted', 'true');
        if (!['letter-kept', 'letter-stale'].includes(${JSON.stringify(mode)})) document.querySelector('[data-qa="responded-success-attach-cover-letter"]').remove();
      };
      if (['already', 'single-already', 'header-only-already'].includes(${JSON.stringify(mode)})) markApplied();
      if (${JSON.stringify(mode)} === 'header-only-already') byId('delivered').hidden = true;
      if (${JSON.stringify(mode)} === 'recommendation-only') byId('actions').remove();
      if (${JSON.stringify(mode)} === 'archived') byId('actions').remove();
      if (sessionStorage.getItem('application-posted') === 'true') markApplied();
      if (sessionStorage.getItem('letter-posted') === 'true') document.querySelector('[data-qa="responded-success-attach-cover-letter"]')?.remove();
    </script></body></html>`
}

async function offline(mode: Parameters<typeof fixture>[0], responseBody: unknown,
  run: (page: Page, control: ApplicationControl, requests: string[], permits: () => number) => Promise<void>, extraHtml = ''): Promise<void> {
  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' })
    const requests: string[] = []
    // Every request is fulfilled locally or aborted. No HH traffic, even if a test fails.
    await context.route('**/*', async route => {
      const request = route.request()
      requests.push(request.url())
      if (request.url() === target && request.method() === 'GET') {
        await route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture(mode) + extraHtml })
      } else if (request.url() === 'https://hh.ru/applicant/vacancy_response/edit_ajax' && request.method() === 'POST') {
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify(responseBody) })
      } else await route.abort()
    })
    let permits = 0
    await run(await context.newPage(), { allowed: async () => true, permit: async () => { permits++; return true } }, requests, () => permits)
  } finally { await browser.close() }
}

test('detail popup selects by hash, closes already-selected list and finds footer letter button', async () => {
  await offline('popup', {}, async (page, control, requests, permits) => {
    assert.equal(await applyVacancy(page, task, control), 'SENT')
    assert.equal(permits(), 1)
    assert.equal(await page.evaluate('window.submissions'), 1)
    assert.equal(await page.evaluate('window.selectedClicks'), 0)
    assert.equal(await page.evaluate('window.submittedLetter'), task.coverLetter)
    assert.equal(requests.some(url => url.includes('/search/')), false)
    assert.equal(requests.some(url => url.includes('vacancyId=999')), false)
  })
})

// This advisory is deliberately not recognised by text or selector: only pointer interception matters.
const advisory = `<script>
  const showAdvice = () => {
    const advice = document.createElement('aside');
    advice.style.cssText = 'position:fixed;inset:0;z-index:999999;background:white';
    advice.textContent = 'Optional profile advice'; document.body.append(advice);
  };
</script>`

test('an advisory hiding Apply is cleared by one reload before requesting a permit', async () => {
  await offline('immediate', { success: true }, async (page, control, requests, permits) => {
    assert.equal(await applyVacancy(page, { ...task, coverLetter: '' }, control), 'SENT')
    assert.equal(requests.filter(url => url === target).length, 2)
    assert.equal(permits(), 1)
    assert.equal(await page.evaluate('window.submissions'), 1)
  }, advisory + `<script>if (!sessionStorage.getItem('advice-once')) {
    sessionStorage.setItem('advice-once', '1'); showAdvice();
  }</script>`)
})

test('an advisory that survives reload stops without force click or repeated reloads', async () => {
  await offline('immediate', {}, async (page, control, requests, permits) => {
    assert.equal(await applyVacancy(page, task, control), 'NOT_SENT')
    assert.equal(requests.filter(url => url === target).length, 2)
    assert.equal(permits(), 0)
  }, advisory + '<script>showAdvice();</script>')
})

test('captcha is never dismissed through an advisory recovery reload', async () => {
  await offline('immediate', {}, async (page, control, requests, permits) => {
    assert.equal(await applyVacancy(page, task, control), 'CAPTCHA')
    assert.equal(requests.filter(url => url === target).length, 1)
    assert.equal(permits(), 0)
  }, '<div data-qa="captcha" style="position:fixed;inset:0;z-index:999999">Security check</div>')
})

test('advice after delivery reloads into letter attachment without another permit or generation', async () => {
  await offline('immediate', { success: true }, async (page, control, requests, permits) => {
    let generations = 0
    const outcome = await applyVacancy(page, task, { ...control, prepareLetter: async () => {
      generations++
      return { text: task.coverLetter, source: 'GENERATED', errorCode: null, generationId: 'synthetic' }
    } })
    assert.equal(outcome, 'SENT')
    assert.equal(requests.filter(url => url === target).length, 2)
    assert.equal(requests.filter(url => url.endsWith('/edit_ajax')).length, 1)
    assert.equal(permits(), 1)
    assert.equal(generations, 1)
    assert.equal(await page.evaluate('window.submissions'), 0) // Counter reset after reload; no new response.
  }, advisory + `<script>
    document.querySelector('[data-qa="vacancy-response-link-top"]')?.addEventListener('click', () => {
      if (!sessionStorage.getItem('advice-once')) { sessionStorage.setItem('advice-once', '1'); showAdvice(); }
    });
  </script>`)
})

test('advice while filling the response form preserves prepared letter and the first permit', async () => {
  await offline('popup', {}, async (page, control, requests, permits) => {
    let generations = 0
    assert.equal(await applyVacancy(page, task, { ...control, prepareLetter: async () => {
      generations++
      return { text: task.coverLetter, source: 'GENERATED', errorCode: null, generationId: 'synthetic' }
    } }), 'SENT')
    assert.equal(requests.filter(url => url === target).length, 2)
    assert.equal(permits(), 1)
    assert.equal(generations, 1)
    assert.equal(await page.evaluate('window.submittedLetter'), task.coverLetter)
    assert.equal(await page.evaluate('window.submissions'), 1)
  }, advisory + `<script>
    document.querySelector('#RESPONSE_MODAL_FORM_ID textarea').addEventListener('input', () => {
      if (!sessionStorage.getItem('advice-once')) { sessionStorage.setItem('advice-once', '1'); showAdvice(); }
    });
  </script>`)
})

test('archived detail is not an application error and does not collect text or request submission', async () => {
  await offline('archived', {}, async (page, control, _requests, permits) => {
    let collected = false
    let generated = false
    const outcome = await applyVacancy(page, task, {
      ...control,
      vacancyText: () => { collected = true },
      prepareLetter: async () => { generated = true; return null },
    })
    assert.equal(outcome, 'VACANCY_ARCHIVED')
    assert.equal(permits(), 0)
    assert.equal(collected, false)
    assert.equal(generated, false)
    assert.equal(await vacancyArchived(page, target), true)
    assert.equal(await inspectApplication(page, target), 'VACANCY_ARCHIVED')
  })
})

test('fixed resume with required letter submits without clicking a nonexistent selector', async () => {
  await offline('fixed-required', {}, async (page, control) => {
    assert.equal(await applyVacancy(page, task, control), 'SENT')
    assert.equal(await page.evaluate('window.resumeClicks'), 0)
    assert.equal(await page.evaluate('window.submittedLetter'), task.coverLetter)
    assert.equal(await page.evaluate('window.submissions'), 1)
  })
})

test('fixed resume with empty required letter asks for text without submitting', async () => {
  await offline('fixed-required', {}, async (page, control) => {
    assert.equal(await applyVacancy(page, { ...task, coverLetter: '' }, control), 'LETTER_REQUIRED')
    assert.equal(await page.evaluate('window.resumeClicks'), 0)
    assert.equal(await page.evaluate('window.submissions'), 0)
  })
})

test('fixed resume with optional empty letter also bypasses the selector', async () => {
  await offline('fixed-optional', {}, async (page, control) => {
    assert.equal(await applyVacancy(page, { ...task, coverLetter: '' }, control), 'SENT')
    assert.equal(await page.evaluate('window.resumeClicks'), 0)
    assert.equal(await page.evaluate('window.submittedLetter'), '')
  })
})

test('selectable resume with required letter still verifies the selected hash', async () => {
  await offline('select-required', {}, async (page, control) => {
    assert.equal(await applyVacancy(page, task, control), 'SENT')
    assert.ok(Number(await page.evaluate('window.resumeClicks')) > 0)
    assert.equal(await page.evaluate('window.selectedClicks'), 0)
    assert.equal(await page.evaluate('window.submittedLetter'), task.coverLetter)
  })
})

test('already-applied detail does not acquire a permit or click another-resume button', async () => {
  await offline('already', {}, async (page, control, _requests, permits) => {
    assert.equal(await applyVacancy(page, task, control), 'ALREADY_APPLIED')
    assert.equal(permits(), 0)
    assert.equal(await page.evaluate('window.submissions'), 0)
  })
})

test('captures description before permit without changing application outcome', async () => {
  await offline('fixed-optional', {}, async (page, control) => {
    let snapshot: string | undefined
    const outcome = await applyVacancy(page, { ...task, coverLetter: '' }, {
      ...control,
      vacancyText: text => { snapshot = text },
      permit: async () => {
        assert.equal(snapshot, 'Build services.')
        return control.permit()
      },
    })
    assert.equal(outcome, 'SENT')
  })
})

test('already-applied detail still captures its description without sending', async () => {
  await offline('already', {}, async (page, control, _requests, permits) => {
    let snapshot: string | undefined
    assert.equal(await applyVacancy(page, task, { ...control, vacancyText: text => { snapshot = text } }), 'ALREADY_APPLIED')
    assert.equal(snapshot, 'Build services.')
    assert.equal(permits(), 0)
  })
})

test('missing description does not prevent the normal application flow', async () => {
  await offline('fixed-optional', {}, async (page, control) => {
    await page.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => {
        document.querySelector('[data-qa="vacancy-description"]')?.remove()
      })
    })
    let captured = false
    assert.equal(await applyVacancy(page, { ...task, coverLetter: '' }, {
      ...control, vacancyText: () => { captured = true },
    }), 'SENT')
    assert.equal(captured, false)
  })
})

test('recommendation success and apply button are never used for current vacancy', async () => {
  await offline('recommendation-only', {}, async (page, control, _requests, permits) => {
    assert.equal(await applyVacancy(page, task, control), 'NOT_SENT')
    assert.equal(permits(), 0)
  })
})

test('unavailable resume never submits the popup', async () => {
  await offline('popup', {}, async (page, control) => {
    assert.equal(await applyVacancy(page, { ...task, hhResumeId: 'MISSING123' }, control), 'RESUME_UNAVAILABLE')
    assert.equal(await page.evaluate('window.submissions'), 0)
  })
})

test('refused one-time permit prevents the first click', async () => {
  await offline('popup', {}, async (page, control) => {
    assert.equal(await applyVacancy(page, task, { ...control, permit: async () => false }), 'STOPPED')
    assert.equal(await page.evaluate('window.submissions'), 0)
    assert.equal(await page.locator('#response').isVisible(), false)
  })
})

test('separate letter supports HH string success and confirms changed detail UI', async () => {
  await offline('immediate', { success: 'true' }, async (page, control, requests) => {
    assert.equal(await applyVacancy(page, task, control), 'SENT')
    assert.equal(requests.filter(url => url.endsWith('/edit_ajax')).length, 1)
    assert.equal(await page.evaluate('window.submissions'), 1)
  })
})

test('unfamiliar network response does not veto persistent detail confirmation', async () => {
  await offline('immediate', {}, async (page, control, requests) => {
    assert.equal(await applyVacancy(page, task, control), 'SENT')
    assert.equal(requests.filter(url => url.endsWith('/edit_ajax')).length, 1)
    assert.equal(await page.evaluate('window.submissions'), 1)
  })
})

test('closing the letter popup without removing detail attachment button is not confirmation', async () => {
  await offline('letter-kept', { success: 'true' }, async (page, control, requests, permits) => {
    assert.equal(await applyVacancy(page, task, control), 'SENT_LETTER_UNCONFIRMED')
    assert.equal(requests.filter(url => url.endsWith('/edit_ajax')).length, 1)
    assert.equal(permits(), 1)
  })
})

test('stale application detail is reloaded once before reporting an unknown result', async () => {
  await offline('immediate-stale', {}, async (page, control, _requests, permits) => {
    assert.equal(await applyVacancy(page, { ...task, coverLetter: '' }, control), 'SENT')
    assert.equal(permits(), 1)
    assert.equal(await page.evaluate('window.submissions'), 0)
  })
})

test('stale letter detail is reloaded once before reporting an unconfirmed attachment', async () => {
  await offline('letter-stale', {}, async (page, control, requests) => {
    assert.equal(await applyVacancy(page, task, control), 'SENT')
    assert.equal(requests.filter(url => url.endsWith('/edit_ajax')).length, 1)
    assert.equal(await page.locator('[data-qa="responded-success-attach-cover-letter"]').count(), 0)
  })
})

test('specific HH rejection after employer view has its own application outcome', async () => {
  await offline('letter-already-viewed', {}, async (page, control, requests) => {
    assert.equal(await applyVacancy(page, task, control), 'SENT_LETTER_REJECTED_ALREADY_VIEWED')
    assert.equal(requests.filter(url => url.endsWith('/edit_ajax')).length, 1)
    assert.equal(await page.evaluate('window.submissions'), 1)
  })
})

test('captcha after a potentially submitting click keeps UNKNOWN and blocks the queue separately', async () => {
  await offline('captcha-after-click', {}, async (page, control) => {
    const blockers: string[] = []
    assert.equal(await applyVacancy(page, task, { ...control, block: reason => blockers.push(reason) }), 'UNKNOWN')
    assert.deepEqual(blockers, ['CAPTCHA'])
    assert.equal(await page.evaluate('window.submissions'), 0)
  })
})

test('single resume: immediate delivery without popup or other-resume button is success', async () => {
  await offline('single-immediate', {}, async (page, control, _requests, permits) => {
    assert.equal(await applyVacancy(page, { ...task, coverLetter: '' }, control), 'SENT')
    assert.equal(permits(), 1)
    assert.equal(await page.evaluate('window.submissions'), 1)
    assert.equal(await page.locator('#response').isVisible(), false)
    assert.equal(await page.locator('[data-qa="vacancy-response-link-top-again"]').count(), 0)
  })
})

test('single resume: an existing delivery notice prevents repeat submission', async () => {
  await offline('single-already', {}, async (page, control, _requests, permits) => {
    assert.equal(await applyVacancy(page, task, control), 'ALREADY_APPLIED')
    assert.equal(permits(), 0)
    assert.equal(await page.evaluate('window.submissions'), 0)
  })
})

test('read-only inspection confirms an existing application without clicking', async () => {
  await offline('already', {}, async (page, _control, _requests, permits) => {
    assert.equal(await inspectApplication(page, target), 'ALREADY_APPLIED')
    assert.equal(permits(), 0)
    assert.equal(await page.evaluate('window.submissions'), 0)
  })
})

test('read-only inspection does not submit when an application is absent', async () => {
  await offline('popup', {}, async (page, _control, _requests, permits) => {
    assert.equal(await inspectApplication(page, target), 'NOT_SENT')
    assert.equal(permits(), 0)
    assert.equal(await page.evaluate('window.submissions'), 0)
  })
})

test('single resume: immediate delivery can proceed to separate letter without other-resume button', async () => {
  await offline('single-immediate', { success: true }, async (page, control, requests) => {
    assert.equal(await applyVacancy(page, task, control), 'SENT')
    assert.equal(requests.filter(url => url.endsWith('/edit_ajax')).length, 1)
    assert.equal(await page.evaluate('window.submissions'), 1)
  })
})

test('header-only confirmation still works when the delivery notice is absent', async () => {
  await offline('header-only-already', {}, async (page, control, _requests, permits) => {
    assert.equal(await applyVacancy(page, task, control), 'ALREADY_APPLIED')
    assert.equal(permits(), 0)
  })
})
