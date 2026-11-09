import assert from 'node:assert/strict'
import test from 'node:test'
import { chromium } from 'playwright'
import { ClickObstructedError, ensureClickReady } from '../src/hh/click-readiness.js'

test('trial identifies interception without dispatching a click and distinguishes missing or disabled targets', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(`<button id="target" onclick="this.textContent='clicked'">Ready</button>
      <button disabled id="disabled">Disabled</button>
      <aside style="position:fixed;inset:0;z-index:100" id="overlay">Advice</aside>`)
    await assert.rejects(ensureClickReady(page.locator('#target')), ClickObstructedError)
    assert.equal(await ensureClickReady(page.locator('#missing')), false)
    assert.equal(await ensureClickReady(page.locator('#disabled')), false)
    await page.locator('#overlay').evaluate(element => element.remove())
    assert.equal(await ensureClickReady(page.locator('#target')), true)
    assert.equal(await page.locator('#target').innerText(), 'Ready')
  } finally { await browser.close() }
})
