import assert from 'node:assert/strict'
import test from 'node:test'
import { chromium } from 'playwright'
import { readResumeCards } from '../src/hh/resume-discovery.js'
import { parseSelectorGroup, SelectorRegistry } from '../src/hh/selector-registry.js'

test('resume discovery accepts configured XPath selectors and keeps resume URL validation', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext()
    const hash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    let href = `/resume/${hash}`
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body:
      `<main id="profile"><h2>Resumes</h2><article><a href="${href}"><b>Example role</b></a></article></main>` }))
    const page = await context.newPage()
    const registry = new SelectorRegistry([parseSelectorGroup({ schemaVersion: 1, id: 'profile', selectors: {
      root: { kind: 'xpath', value: '//main[@id="profile"]', purpose: 'Profile' },
      resumeSection: { kind: 'css', value: 'h2', purpose: 'Section' },
      resumeCards: { kind: 'css', value: 'article', purpose: 'Cards' },
      resumeLink: { kind: 'xpath', value: './/a[@href]', purpose: 'Link' },
      resumeTitle: { kind: 'xpath', value: './/b', purpose: 'Title' },
      anyResumeLink: { kind: 'css', value: 'a[href]', purpose: 'Links' },
    } })])
    await page.goto('https://hh.ru/applicant/profile/me')
    assert.deepEqual(await readResumeCards(page, registry), [{ hhResumeId: hash, name: 'Example role' }])
    href = `https://example.test/resume/${hash}`
    await page.reload()
    await assert.rejects(readResumeCards(page, registry), /Не удалось прочитать список резюме/)
  } finally { await browser.close() }
})
