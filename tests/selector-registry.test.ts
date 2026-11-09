import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSelectorGroup, SelectorRegistry, selectorGroupRevision, type SelectorDefinition } from '../src/hh/selector-registry.js'

const profile = parseSelectorGroup(JSON.parse(readFileSync(new URL('../resources/hh-selectors/profile.json', import.meta.url), 'utf8')))
const rootOverride: SelectorDefinition = { kind: 'xpath', value: '//main[@id="profile"]', purpose: 'Synthetic profile' }

test('local override survives an unchanged group and a changed group falls back to bundled selectors', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hh-selectors-'))
  const file = join(directory, 'overrides.json')
  try {
    const another = { ...structuredClone(profile), id: 'another' }
    const store = new SelectorRegistry([profile, another], file)
    store.saveOverride('profile', { root: rootOverride })
    store.saveOverride('another', { root: rootOverride })
    assert.equal(new SelectorRegistry([profile, another], file).locator('profile', 'root'), 'xpath=//main[@id="profile"]')
    const updated = structuredClone(profile)
    updated.selectors.root = { kind: 'css', value: 'main.new-profile', purpose: 'Updated profile' }
    const afterUpdate = new SelectorRegistry([updated, another], file)
    assert.equal(afterUpdate.locator('profile', 'root'), 'css=main.new-profile')
    assert.equal(afterUpdate.locator('another', 'root'), 'xpath=//main[@id="profile"]')
    assert.deepEqual([...afterUpdate.staleGroups], ['profile'])
    afterUpdate.resetOverride('another')
    assert.equal(afterUpdate.locator('another', 'root'), 'css=.ResumeProfileFront-ReactRoot')
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).groups, {})
    assert.equal(profile.selectors.root?.value, '.ResumeProfileFront-ReactRoot')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('revision is independent of object property order but changes with the selector contract', () => {
  const reordered = { ...profile, selectors: Object.fromEntries(Object.entries(profile.selectors).reverse()) }
  assert.equal(selectorGroupRevision(profile), selectorGroupRevision(reordered))
  const updated = structuredClone(profile)
  updated.selectors.root = rootOverride
  assert.notEqual(selectorGroupRevision(profile), selectorGroupRevision(updated))
})

test('invalid override file falls back without silently overwriting the broken file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hh-selectors-invalid-'))
  const file = join(directory, 'overrides.json')
  try {
    writeFileSync(file, '{broken json')
    const store = new SelectorRegistry([profile], file)
    assert.equal(store.locator('profile', 'root'), 'css=.ResumeProfileFront-ReactRoot')
    assert.equal(store.loadIssue, 'INVALID_SELECTOR_OVERRIDES')
    assert.equal(readFileSync(file, 'utf8'), '{broken json')
    assert.throws(() => store.saveOverride('profile', { unknown: rootOverride }), /INVALID_SELECTOR_OVERRIDE/)
    assert.throws(() => store.locator('profile', 'unknown'), /UNKNOWN_SELECTOR/)
    assert.throws(() => store.locator('unknown', 'root'), /UNKNOWN_SELECTOR_GROUP/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('recovery context keeps shipped instructions and returns an isolated snapshot', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hh-selectors-context-'))
  const file = join(directory, 'overrides.json')
  try {
    const registry = new SelectorRegistry([profile], file)
    registry.saveOverride('profile', { root: { ...rootOverride, purpose: 'Model instruction', contract: {
      scope: '$page', cardinality: 'many', action: 'submit', referenceTag: '<button>Send</button>',
    } } })
    const context = new SelectorRegistry([profile], file).repairContext('profile')
    assert.equal(context.baseRevision, selectorGroupRevision(profile))
    assert.equal(context.group.selectors.root?.value, rootOverride.value)
    assert.equal(context.group.selectors.root?.purpose, profile.selectors.root?.purpose)
    assert.deepEqual(context.group.selectors.root?.contract, profile.selectors.root?.contract)
    assert.deepEqual(context.group.context, profile.context)
    context.group.selectors.root!.contract!.scope = 'changed'
    assert.equal(registry.repairContext('profile').group.selectors.root?.contract?.scope, '$page')

    const updated = structuredClone(profile)
    updated.selectors.root!.contract!.mustHave = ['New requirement']
    const afterUpdate = new SelectorRegistry([updated], file)
    assert.deepEqual([...afterUpdate.staleGroups], ['profile'])
    assert.equal(afterUpdate.locator('profile', 'root'), `css=${profile.selectors.root!.value}`)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('bundled page groups have valid bounded recovery metadata', () => {
  for (const file of ['profile', 'common', 'search', 'vacancy', 'response-form', 'letter-form', 'resume-text']) {
    const group = parseSelectorGroup(JSON.parse(readFileSync(
      new URL(`../resources/hh-selectors/${file}.json`, import.meta.url), 'utf8')))
    assert.ok(group.context?.task)
    for (const selector of Object.values(group.selectors)) {
      assert.ok(selector.purpose)
      assert.ok(selector.contract?.scope)
    }
  }
  const invalid = structuredClone(profile)
  invalid.selectors.root!.contract!.referenceTag = 'x'.repeat(801)
  assert.throws(() => parseSelectorGroup(invalid), /INVALID_SELECTOR_GROUP/)
})
