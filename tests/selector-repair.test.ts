import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Page } from 'playwright'
import { parseSelectorGroup, SelectorRegistry } from '../src/hh/selector-registry.js'
import { repairReadSelectors as runRepair, offerSelectorRepair } from '../src/hh/selector-repair.js'
import type { SelectorRepairInput, SelectorRepairResult } from '../src/generation/selector-repair.js'
import { diagnoseSelectors } from '../src/hh/selector-diagnostics.js'
import { selectorRepairHtml, selectorRepairBlocker } from '../src/hh/selector-repair-context.js'
import { readResumeCards } from '../src/hh/resume-discovery.js'

// Existing fixture callbacks specify only changed CSS. Expand them into the complete audited wire result.
function response(input: SelectorRepairInput, replacements: Record<string, { kind: string; value: string }>): SelectorRepairResult {
  return {
    selectors: { ...Object.fromEntries(Object.entries(input.group.selectors).map(([key, item]) => [key, { kind: item.kind, value: item.value }])), ...replacements } as SelectorRepairResult['selectors'],
    audit: Object.fromEntries(Object.keys(input.group.selectors).map(key => [key, {
      status: 'verified', include: input.group.selectors[key]!.purpose, exclude: 'Other fields', reason: 'Synthetic fixture observation',
    }])),
  }
}
async function repairReadSelectors(page: Page, group: string, requestId: string, options: NonNullable<Parameters<typeof runRepair>[3]>) {
  const generate = options.generate!
  return runRepair(page, group, requestId, { ...options, generate: async (input, id) =>
    response(input, await generate(input, id) as Record<string, { kind: string; value: string }>) })
}

const hash = 'a'.repeat(36)
const profile = `<main class="ResumeProfileFront-ReactRoot"><h2 data-qa="compact-resume-title">PRIVATE HEADING</h2>
  <article data-qa="resume" data-qa-id="123" data-qa-title="PRIVATE ROLE">
    <a data-qa="resume-card-link-${hash}" href="/resume/${hash}">PRIVATE VIEW</a>
    <a href="/resume/${hash}">PRIVATE EDIT</a><h3 data-qa="resume-title">PRIVATE ROLE</h3>
  </article><input value="Java" data-secret="SECRET_ATTRIBUTE"><textarea>Обычный черновик</textarea>
  <input type="hidden" value="SECRET_HIDDEN"><input type="password" value="SECRET_PASSWORD">
  <input name="access_token" value="SECRET_TOKEN"><textarea name="csrf">SECRET_CSRF</textarea>
  <script>window.privateToken='SECRET_SCRIPT'</script><a href="/account/login?token=SECRET_QUERY">Login</a></main>`

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'hh-repair-'))
  const file = join(directory, 'overrides.json')
  const groups = ['profile', 'common', 'search', 'vacancy', 'response-form', 'letter-form', 'resume-text'].map(name => {
    const group = parseSelectorGroup(JSON.parse(readFileSync(new URL(`../resources/hh-selectors/${name}.json`, import.meta.url), 'utf8')))
    if (group.id === 'profile') group.selectors.resumeLink!.value = 'a.intentionally-missing'
    return group
  })
  return { file, groups, loadSelectors: () => new SelectorRegistry(groups, file), cleanup: () => rmSync(directory, { recursive: true, force: true }) }
}
async function offline(body: string, run: (page: Page) => Promise<void>, url = 'https://hh.ru/applicant/profile/me') {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body }))
    await page.goto(url)
    await run(page)
  } finally { await browser.close() }
}
const fix = { resumeLink: { kind: 'css', value: 'a[data-qa^="resume-card-link-"][href]' } }

test('independent review sees an overbroad candidate and only its corrected result is saved', async () => {
  const storage = setup()
  try {
    await offline(profile, async page => {
      const ids: string[] = []
      const result = await runRepair(page, 'profile', 'two-stage', { loadSelectors: storage.loadSelectors,
        generate: async (input, id) => {
          ids.push(id)
          assert.equal(existsSync(storage.file), false)
          if (!input.review) return response(input, { ...fix, anyResumeLink: { kind: 'css', value: 'a[href]' } })
          assert.equal(input.review.candidate.selectors.anyResumeLink?.value, 'a[href]')
          const observed = input.review.observations.fields.find(row => row.key === 'anyResumeLink')!
          assert.ok(Number(observed.matched) > 2)
          assert.doesNotMatch(JSON.stringify(input.review.observations), /SECRET/)
          assert.ok(input.review.candidate.audit.resumeLink?.reason)
          return response(input, fix)
        },
      })
      assert.deepEqual(ids, ['two-stage', 'two-stage-review'])
      assert.equal(result.rows.find(row => row.key === 'resumeLink')?.status, 'PASS')
      assert.notEqual(storage.loadSelectors().repairContext('profile').group.selectors.anyResumeLink?.value, 'a[href]')
    })
  } finally { storage.cleanup() }
})

test('review failure or unresolved meaning leaves even a valid first candidate unapplied', async () => {
  for (const outcome of ['network', 'unresolved']) {
    const storage = setup()
    try {
      await offline(profile, async page => {
        await assert.rejects(runRepair(page, 'profile', 'review-failure', { loadSelectors: storage.loadSelectors,
          generate: async input => {
            const result = response(input, fix)
            if (input.review) {
              if (outcome === 'network') throw new Error('Synthetic review failure')
              result.audit.resumeLink!.status = 'unresolved'
            }
            return result
          },
        }))
        assert.equal(existsSync(storage.file), false)
      })
    } finally { storage.cleanup() }
  }
})

test('archive repair restores its markers without requiring a description or changing response controls', async () => {
  const storage = setup()
  const group = storage.groups.find(item => item.id === 'vacancy')!
  group.selectors.archivedTitle!.value = '.broken-archive-title'
  group.selectors.archivedDescription!.value = '.broken-archive-description'
  try {
    await offline('<h1 data-qa="vacancy-title">Role <span data-qa="vacancy-title-archived-text">В архиве</span></h1><p data-qa="vacancy-archive-description">Вакансия в архиве</p>', async page => {
      const before = await offerSelectorRepair(page, await diagnoseSelectors(page, 'VACANCY', storage.loadSelectors()), storage.loadSelectors())
      assert.deepEqual(before.repairableGroups, ['vacancy'])
      let calls = 0
      const result = await runRepair(page, 'vacancy', 'archive', { loadSelectors: storage.loadSelectors,
        generate: async input => {
          calls++
          assert.deepEqual(Object.keys(input.group.selectors).sort(), ['archivedDescription', 'archivedTitle', 'title'])
          return response(input, {
            archivedTitle: { kind: 'css', value: '[data-qa="vacancy-title-archived-text"]' },
            archivedDescription: { kind: 'css', value: '[data-qa="vacancy-archive-description"]' },
          })
        },
      })
      assert.equal(calls, 2)
      assert.equal(result.summary, 'PASSED')
      for (const key of ['archivedTitle', 'archivedDescription']) {
        assert.equal(result.rows.find(row => row.key === key)?.status, 'PASS')
        assert.equal(storage.loadSelectors().source('vacancy', key), 'LOCAL')
      }
      for (const key of ['description', 'respond', 'delivered', 'actions'])
        assert.equal(storage.loadSelectors().source('vacancy', key), 'BUNDLED')
    }, 'https://hh.ru/vacancy/123')
  } finally { storage.cleanup() }
})

test('unobserved archive fields neither block ordinary vacancy repair nor get overwritten', async () => {
  const storage = setup()
  const group = storage.groups.find(item => item.id === 'vacancy')!
  group.selectors.title!.value = '.broken-title'
  group.selectors.description!.value = '.broken-description'
  group.selectors.archivedTitle!.value = '.old-archive-title'
  group.selectors.archivedDescription!.value = '.old-archive-description'
  try {
    await offline('<h1 data-qa="vacancy-title">Role</h1><div data-qa="vacancy-description">Build services.</div><div class="vacancy-actions_magritte-vacancy-top"><a data-qa="vacancy-response-link-top" href="/applicant/vacancy_response?vacancyId=123">Respond</a></div>', async page => {
      let calls = 0
      const result = await runRepair(page, 'vacancy', 'inactive-archive', { loadSelectors: storage.loadSelectors,
        generate: async input => {
          calls++
          assert.equal(input.diagnostics.find(row => row.key === 'archivedTitle')?.status, 'STATE_NOT_CHECKED')
          if (input.review) assert.equal(input.review.candidate.selectors.archivedTitle?.value, '.old-archive-title')
          const result = response(input, {
            title: { kind: 'css', value: 'h1[data-qa="vacancy-title"]' },
            description: { kind: 'css', value: '[data-qa="vacancy-description"]' },
            archivedTitle: { kind: 'css', value: 'h1' },
            archivedDescription: { kind: 'css', value: 'p' },
          })
          result.audit.archivedTitle!.status = 'unresolved'
          result.audit.archivedDescription!.status = 'unresolved'
          return result
        },
      })
      assert.equal(calls, 2)
      assert.equal(result.rows.find(row => row.key === 'title')?.status, 'PASS')
      assert.equal(storage.loadSelectors().source('vacancy', 'title'), 'LOCAL')
      assert.equal(storage.loadSelectors().source('vacancy', 'archivedTitle'), 'BUNDLED')
      assert.equal(storage.loadSelectors().repairContext('vacancy').group.selectors.archivedTitle?.value, '.old-archive-title')
    }, 'https://hh.ru/vacancy/123')
  } finally { storage.cleanup() }
})

// Synthetic V1 table selectors and V2 list markup: no captured HH HTML or personal data.
const oldLayout = {
  root: '.profile-layout-v1', resumeSection: '.profile-heading',
  resumeCards: 'table.resume-table > tbody > tr',
  resumeLink: 'td:first-child > a.view-resume', resumeTitle: '.resume-title',
}
const redesigned = `<main data-screen="resume-library"><section aria-label="Мои резюме"><h2>Мои резюме</h2>
  <ul><li class="resume-card"><div><a data-action="view" href="https://hh.ru/resume/${hash}"><span class="role">Java-разработчик</span></a></div>
  <nav><a data-action="edit" href="/resume/${hash}">Редактировать</a></nav></li></ul></section></main>`
const redesignedFix = Object.fromEntries(Object.entries({
  root: 'main[data-screen="resume-library"]', resumeSection: 'section > h2', resumeCards: 'ul > li.resume-card',
  resumeLink: 'a[data-action="view"]', resumeTitle: 'span.role',
}).map(([key, value]) => [key, { kind: 'css', value }]))
const distractor = `<aside class="profile-layout-v1"><h2 class="profile-heading">Пример резюме</h2>
  <table class="resume-table"><tbody><tr><td><a href="/resume/${'b'.repeat(36)}">Образец</a><span class="resume-title">Пример</span></td></tr></tbody></table></aside>`

for (const [name, body] of [
  ['complete DOM redesign removes old tags, classes and nesting', redesigned],
  ['old root and heading still match an unrelated block', distractor + redesigned],
  ['old root becomes ambiguous after duplicated layout blocks', distractor + distractor + redesigned],
]) test(name!, async () => {
  const storage = setup()
  try {
    for (const [key, value] of Object.entries(oldLayout)) storage.groups[0]!.selectors[key]!.value = value
    await offline(body!, async page => {
      const before = await diagnoseSelectors(page, 'PROFILE', storage.loadSelectors())
      assert.ok(before.rows.some(row => row.status === 'FAIL'))
      let calls = 0
      const result = await repairReadSelectors(page, 'profile', 'redesign', {
        loadSelectors: storage.loadSelectors,
        generate: async input => {
          calls++
          assert.ok(input.html.includes('data-screen="resume-library"'))
          assert.ok(input.html.includes(`href="https://hh.ru/resume/${hash}"`))
          assert.deepEqual(input.diagnostics.map(row => row.key).sort(), Object.keys(input.group.selectors).sort())
          const link = input.diagnostics.find(row => row.key === 'resumeLink')!
          assert.equal(link.required, true)
          if (name!.startsWith('complete')) {
            assert.equal(link.status, 'NOT_CHECKED')
            assert.equal(input.diagnostics.find(row => row.key === 'resumeCards')?.status, 'NOT_APPLICABLE')
            assert.ok(!input.brokenKeys.includes('resumeLink'))
          }
          return redesignedFix
        },
      })
      assert.equal(calls, 2)
      assert.ok(result.rows.every(row => row.status !== 'FAIL'))
      assert.deepEqual(await readResumeCards(page, storage.loadSelectors()), [{ hhResumeId: hash, name: 'Java-разработчик' }])
      assert.equal(storage.groups[0]!.selectors.root!.value, oldLayout.root)
    })
  } finally { storage.cleanup() }
})

test('fixing only failed ancestors leaves blocked children broken and cannot be saved', async () => {
  const storage = setup()
  try {
    for (const [key, value] of Object.entries(oldLayout)) storage.groups[0]!.selectors[key]!.value = value
    await offline(redesigned, async page => {
      await assert.rejects(repairReadSelectors(page, 'profile', 'ancestors-only', {
        loadSelectors: storage.loadSelectors,
        generate: async input => {
          assert.ok(input.diagnostics.some(row => row.key === 'resumeLink' && row.status === 'NOT_CHECKED'))
          return { root: redesignedFix.root, resumeSection: redesignedFix.resumeSection }
        },
      }), /не прошли проверку/)
      assert.equal(existsSync(storage.file), false)
    })
  } finally { storage.cleanup() }
})

test('relative and absolute hrefs stay distinct, a wrong prefix is rejected rather than persisted', async () => {
  for (const href of [`/resume/${hash}`, `https://hh.ru/resume/${hash}`]) {
    const storage = setup()
    try {
      const body = profile.replace(`href="/resume/${hash}">PRIVATE VIEW`, `href="${href}">PRIVATE VIEW`)
      await offline(body, async page => {
        if (href.startsWith('https:')) {
          await assert.rejects(repairReadSelectors(page, 'profile', 'wrong-prefix', {
            loadSelectors: storage.loadSelectors,
            generate: async () => ({ resumeLink: { kind: 'css', value: 'a[data-qa^="resume-card-link-"][href^="/resume/"]' } }),
          }))
          assert.equal(existsSync(storage.file), false)
        }
        await repairReadSelectors(page, 'profile', 'right-prefix', {
          loadSelectors: storage.loadSelectors,
          generate: async input => {
            assert.ok(input.html.includes(`href="${href}"`))
            return { resumeLink: { kind: 'css', value: `a[data-qa^="resume-card-link-"][href^="${href.startsWith('https:') ? 'https://hh.ru/resume/' : '/resume/'}"]` } }
          },
        })
        assert.deepEqual(await readResumeCards(page, storage.loadSelectors()), [{ hhResumeId: hash, name: 'PRIVATE ROLE' }])
      })
    } finally { storage.cleanup() }
  }
})

test('repair HTML preserves useful text, attributes and link shape but excludes technical secrets', async () => {
  await offline(profile, async page => {
    const html = await selectorRepairHtml(page)
    assert.doesNotMatch(html, /SECRET|<script|\[TEXT\]|__ID__/)
    assert.match(html, /PRIVATE HEADING/)
    assert.match(html, /Обычный черновик/)
    assert.match(html, /value="Java"/)
    assert.ok(html.includes(`href="/resume/${hash}"`))
    assert.ok(html.includes(`resume-card-link-${hash}`))
    assert.match(html, /token=\[REDACTED\]/)
  })
})

test('full repair HTML keeps deeply nested company names, all cards and pagination after a large result list', async () => {
  const longClass = 'long-attribute-' + 'x'.repeat(2100)
  const cards = Array.from({ length: 4000 }, (_, index) => `<article class="result-card"><a href="/vacancy/${index + 1}">Position ${index}</a></article>`).join('')
  const nestedCompany = '<div>'.repeat(40) + '<span data-qa="company-name">Deep company name</span>' + '</div>'.repeat(40)
  const body = `<main class="${longClass}">${cards}${nestedCompany}<nav data-qa="pager-block"><a href="?page=1">Next page</a></nav><template id="page-state">{"total":4000}</template></main>`
  await offline(body, async page => {
    const html = await selectorRepairHtml(page)
    assert.ok(html.length > 160000)
    assert.equal((html.match(/class="result-card"/g) ?? []).length, 4000)
    assert.ok(html.includes(`class="${longClass}"`))
    assert.match(html, /Deep company name/)
    assert.match(html, /data-qa="pager-block"/)
    assert.match(html, /Next page/)
    assert.match(html, /<template id="page-state">\{"total":4000\}<\/template>/)
    assert.doesNotMatch(html, /STRUCTURE_TRUNCATED/)
    assert.ok(html.endsWith('</body></html>'))
  })
})

test('validated local repair preserves bundled selectors and other local replacements', async () => {
  const storage = setup()
  try {
    storage.loadSelectors().saveOverride('search', { accountMenu: { kind: 'css', value: '.local-menu', purpose: 'menu' } })
    await offline(profile, async page => {
      let calls = 0
      const result = await repairReadSelectors(page, 'profile', 'request', {
        loadSelectors: storage.loadSelectors,
        generate: async input => { calls++; assert.doesNotMatch(input.html, /SECRET/); assert.match(input.html, /PRIVATE ROLE/); return fix },
      })
      assert.equal(calls, 2)
      assert.equal(result.rows.find(row => row.key === 'resumeLink')?.status, 'PASS')
      assert.equal(result.rows.find(row => row.key === 'resumeLink')?.source, 'LOCAL')
      assert.equal(storage.loadSelectors().source('search', 'accountMenu'), 'LOCAL')
      assert.equal(storage.groups[0]!.selectors.resumeLink!.value, 'a.intentionally-missing')
      assert.match(result.repairNote ?? '', /сохранено/)
    })
  } finally { storage.cleanup() }
})

test('broad selectors, regressions and action keys are rejected without persistence', async () => {
  for (const output of [
    { resumeLink: { kind: 'css', value: 'a[href*="/resume/"]' } },
    { ...fix, resumeTitle: { kind: 'css', value: '.missing-title' } },
    { ...fix, root: { kind: 'css', value: 'body' } },
    { submit: { kind: 'css', value: 'button' } },
  ]) {
    const storage = setup()
    try {
      await offline(profile, async page => {
        await assert.rejects(repairReadSelectors(page, 'profile', 'request', { loadSelectors: storage.loadSelectors, generate: async () => output }))
        assert.equal(existsSync(storage.file), false)
      })
    } finally { storage.cleanup() }
  }
})

test('navigation during generation prevents saving even a valid selector', async () => {
  const storage = setup()
  try {
    await offline(profile, async page => {
      await assert.rejects(repairReadSelectors(page, 'profile', 'request', {
        loadSelectors: storage.loadSelectors, generate: async () => { await page.reload(); return fix },
      }), /Страница изменилась/)
      assert.equal(existsSync(storage.file), false)
    })
  } finally { storage.cleanup() }
})

test('a local change made while AI is running is not overwritten', async () => {
  const storage = setup()
  try {
    await offline(profile, async page => {
      await assert.rejects(repairReadSelectors(page, 'profile', 'request', {
        loadSelectors: storage.loadSelectors, generate: async () => {
          storage.loadSelectors().saveOverride('profile', { root: { kind: 'css', value: 'main', purpose: 'root' } })
          return fix
        },
      }), /Селекторы изменились/)
      const current = storage.loadSelectors()
      assert.equal(current.locator('profile', 'root'), 'css=main')
      assert.equal(current.source('profile', 'resumeLink'), 'BUNDLED')
    })
  } finally { storage.cleanup() }
})

test('access denial and obstructing dialogs do not trigger AI repairs', async () => {
  const storage = setup()
  try {
    for (const body of ['<p>Вам недоступна эта вакансия. Войдите как пользователь, у которого есть доступ на просмотр.</p>',
      profile + '<div role="dialog">HH advice</div>']) {
      await offline(body, async page => {
        const registry = storage.loadSelectors()
        assert.ok(await selectorRepairBlocker(page))
        const offered = await offerSelectorRepair(page, await diagnoseSelectors(page, undefined, registry), registry)
        assert.deepEqual(offered.repairableGroups, [])
        await assert.rejects(repairReadSelectors(page, 'profile', 'request', {
          loadSelectors: storage.loadSelectors, generate: async () => assert.fail('must not call AI'),
        }))
      })
    }
  } finally { storage.cleanup() }
})
