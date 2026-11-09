import assert from 'node:assert/strict'
import test from 'node:test'
import { chromium, type Page } from 'playwright'
import { checkAuthorization as inspectAuthorization, HH_PROFILE_URL } from '../src/hh/authorization-check.js'
import { readResumeCards } from '../src/hh/resume-discovery.js'
import { readFileSync } from 'node:fs'
import { parseSelectorGroup, SelectorRegistry } from '../src/hh/selector-registry.js'

const common = parseSelectorGroup(JSON.parse(readFileSync(new URL('../resources/hh-selectors/common.json', import.meta.url), 'utf8')))
const profile = parseSelectorGroup(JSON.parse(readFileSync(new URL('../resources/hh-selectors/profile.json', import.meta.url), 'utf8')))
function checkAuthorization(page: Page) {
  // Auth fixtures must not depend on the local installation's saved overrides.
  return inspectAuthorization(page, new SelectorRegistry([common]))
}

// Synthetic markup only: never copy a real profile, contact details or session state into fixtures.
async function offline(body: string, check: (page: Page) => Promise<void>,
  options: { redirectTo?: string; status?: number } = {}): Promise<void> {
  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' })
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body, status: options.status ?? 200 }))
    const page = await context.newPage()
    if (options.redirectTo) {
      // Playwright route handlers only cover the first URL of an HTTP redirect chain.
      // Simulate its final destination at the navigation boundary instead of sending
      // a synthetic 302 that allows the next request to reach the real HH server.
      const goto = page.goto.bind(page)
      page.goto = (url, navigationOptions) => goto(url === HH_PROFILE_URL ? options.redirectTo! : url, navigationOptions)
    }
    await check(page)
  } finally {
    await browser.close()
  }
}

test('successful profile navigation does not depend on profile controls, names or resumes', async () => {
  await offline('<main>Updated profile layout</main>', async page => {
    assert.equal((await checkAuthorization(page)).status, 'AUTHORIZED')
    assert.equal(page.url(), HH_PROFILE_URL)
  })
})

for (const loginUrl of [
  'https://hh.ru/account/login?role=applicant&backUrl=%2Fapplicant%2Fprofile%2Fme&force_login=true',
  'https://hh.ru/auth/applicant',
]) {
  test(`login redirect requires authentication: ${new URL(loginUrl).pathname}`, async () => {
    await offline('<main>Sign in</main>', async page => {
      const result = await checkAuthorization(page)
      assert.equal(result.status, 'REQUIRED', `${result.message}; synthetic URL: ${page.url()}`)
    }, { redirectTo: loginUrl })
  })
}

test('known login redirect does not depend on a working CAPTCHA selector', async () => {
  const broken = structuredClone(common)
  broken.selectors.challenge!.value = '['
  await offline('<main>Sign in</main>', async page => {
    const result = await inspectAuthorization(page, new SelectorRegistry([broken]))
    assert.equal(result.status, 'REQUIRED', result.message)
  }, { redirectTo: 'https://hh.ru/account/login?role=applicant' })
})

test('captcha on the profile URL is not treated as authorization', async () => {
  await offline('<main><div data-qa="captcha">Security check</div></main>', async page => {
    const result = await checkAuthorization(page)
    assert.equal(result.status, 'UNKNOWN')
    assert.match(result.message, /проверку безопасности/)
  })
})

test('captcha redirect is not treated as authorization', async () => {
  await offline('<main>Security check</main>', async page => {
    assert.equal((await checkAuthorization(page)).status, 'UNKNOWN')
  }, { redirectTo: 'https://hh.ru/captcha' })
})

test('redirect away from HH cannot confirm authorization even at a matching path', async () => {
  await offline('<main>Not HH</main>', async page => {
    assert.equal((await checkAuthorization(page)).status, 'UNKNOWN')
  }, { redirectTo: 'https://example.test/applicant/profile/me' })
})

test('HTTP failure on the profile URL cannot confirm authorization', async () => {
  await offline('<main>Unavailable</main>', async page => {
    assert.equal((await checkAuthorization(page)).status, 'UNKNOWN')
  }, { status: 503 })
})

test('closed page cannot confirm authorization', async () => {
  await offline('<main>Profile</main>', async page => {
    await page.close()
    assert.equal((await checkAuthorization(page)).status, 'UNKNOWN')
  })
})

test('resume discovery remains a separate read after authorization without edit controls', async () => {
  const id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  await offline(`<main class="ResumeProfileFront-ReactRoot">
    <h2 data-qa="compact-resume-title">Resumes</h2>
    <div data-qa="resume" data-qa-id="1" data-qa-title="Example role">
      <a data-qa="resume-card-link-${id}" href="/resume/${id}">Example role</a>
    </div></main>`, async page => {
    assert.equal((await checkAuthorization(page)).status, 'AUTHORIZED')
    assert.deepEqual(await readResumeCards(page, new SelectorRegistry([profile])), [{ hhResumeId: id, name: 'Example role' }])
  })
})
