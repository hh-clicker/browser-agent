import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { browserConfig } from '../config/browser-config.js'

export interface SelectorContract {
  scope: string | { anyOf: string[] }
  cardinality: 'one' | 'many' | 'zeroOrOne'
  action: 'read' | 'open' | 'input' | 'submit'
  reads?: string[]
  mustHave?: string[]
  exclude?: string[]
  referenceTag?: string
  required?: boolean
}
export interface SelectorDefinition { kind: 'css' | 'xpath'; value: string; purpose: string; contract?: SelectorContract }
export interface SelectorGroupContext { pageType: string; task: string; notes?: string[] }
export interface SelectorGroup {
  schemaVersion: 1
  id: string
  context?: SelectorGroupContext
  selectors: Record<string, SelectorDefinition>
}
interface GroupOverride { baseRevision: string; createdAt: string; selectors: Record<string, SelectorDefinition> }

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function shortStrings(value: unknown): boolean {
  return Array.isArray(value) && value.length <= 20 && value.every(entry => typeof entry === 'string' && entry.length <= 500)
}

function contract(value: unknown): boolean {
  return record(value) && (typeof value.scope === 'string' && value.scope.length <= 100
      || record(value.scope) && shortStrings(value.scope.anyOf) && (value.scope.anyOf as unknown[]).length > 0)
    && ['one', 'many', 'zeroOrOne'].includes(String(value.cardinality))
    && ['read', 'open', 'input', 'submit'].includes(String(value.action))
    && ['reads', 'mustHave', 'exclude'].every(key => value[key] === undefined || shortStrings(value[key]))
    && (value.referenceTag === undefined || typeof value.referenceTag === 'string' && value.referenceTag.length <= 800)
    && (value.required === undefined || typeof value.required === 'boolean')
}

function definition(value: unknown): value is SelectorDefinition {
  return record(value) && (value.kind === 'css' || value.kind === 'xpath') && typeof value.value === 'string'
    && value.value.trim().length > 0 && value.value.length <= 4096 && !value.value.includes('\0')
    && typeof value.purpose === 'string' && value.purpose.length <= 1000
    && (value.contract === undefined || contract(value.contract))
}

export function parseSelectorGroup(value: unknown): SelectorGroup {
  if (!record(value) || value.schemaVersion !== 1 || typeof value.id !== 'string'
      || !/^[a-z][a-zA-Z0-9-]{0,63}$/.test(value.id) || !record(value.selectors)) throw new Error('INVALID_SELECTOR_GROUP')
  const entries = Object.entries(value.selectors)
  if (value.context !== undefined && (!record(value.context) || typeof value.context.pageType !== 'string'
      || value.context.pageType.length > 100 || typeof value.context.task !== 'string' || value.context.task.length > 1500
      || value.context.notes !== undefined && !shortStrings(value.context.notes))) throw new Error('INVALID_SELECTOR_CONTEXT')
  if (!entries.length || entries.length > 100 || entries.some(([key, entry]) =>
    !/^[a-z][a-zA-Z0-9]{0,63}$/.test(key) || !definition(entry))) throw new Error('INVALID_SELECTOR_GROUP')
  return structuredClone(value) as unknown as SelectorGroup
}

/** Content revision changes only for this group, not for an unrelated application release. */
export function selectorGroupRevision(group: SelectorGroup): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : record(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
  return createHash('sha256').update(JSON.stringify(canonical(group))).digest('hex')
}

/** Built-in data is immutable; local replacements live in a separate user-owned file. */
export class SelectorRegistry {
  readonly #groups = new Map<string, SelectorGroup>()
  readonly #overrides = new Map<string, GroupOverride>()
  readonly staleGroups = new Set<string>()
  loadIssue: 'INVALID_SELECTOR_OVERRIDES' | null = null

  constructor(groups: readonly SelectorGroup[], private readonly overrideFile?: string) {
    for (const input of groups) {
      const group = parseSelectorGroup(input)
      if (this.#groups.has(group.id)) throw new Error('DUPLICATE_SELECTOR_GROUP')
      this.#groups.set(group.id, group)
    }
    this.#loadOverrides()
  }

  locator(groupId: string, key: string): string {
    const baselineSelectors = this.#group(groupId).selectors
    if (!Object.hasOwn(baselineSelectors, key)) throw new Error('UNKNOWN_SELECTOR')
    const replacements = this.#overrides.get(groupId)?.selectors
    const selector = (replacements && Object.hasOwn(replacements, key) ? replacements[key] : baselineSelectors[key])!
    // Explicit engine prevents an override from choosing a custom Playwright selector engine.
    return `${selector.kind}=${selector.value}`
  }

  revision(groupId: string): string { return selectorGroupRevision(this.#group(groupId)) }

  previewOverride(groupId: string, replacements: Record<string, SelectorDefinition>): SelectorRegistry {
    const groups = [...this.#groups.keys()].map(id => this.repairContext(id).group)
    const target = groups.find(group => group.id === groupId)
    if (!target) throw new Error('UNKNOWN_SELECTOR_GROUP')
    for (const [key, value] of Object.entries(replacements)) {
      if (!Object.hasOwn(target.selectors, key) || !definition(value)) throw new Error('INVALID_SELECTOR_OVERRIDE')
      target.selectors[key] = { ...target.selectors[key]!, kind: value.kind, value: value.value }
    }
    return new SelectorRegistry(groups)
  }

  mergeOverride(groupId: string, replacements: Record<string, SelectorDefinition>): void {
    this.saveOverride(groupId, { ...this.#overrides.get(groupId)?.selectors, ...replacements })
  }

  source(groupId: string, key: string): 'BUNDLED' | 'LOCAL' {
    if (!Object.hasOwn(this.#group(groupId).selectors, key)) throw new Error('UNKNOWN_SELECTOR')
    return Object.hasOwn(this.#overrides.get(groupId)?.selectors ?? {}, key) ? 'LOCAL' : 'BUNDLED'
  }

  /** Recovery instructions always come from the shipped contract, never from local/model metadata. */
  repairContext(groupId: string): { group: SelectorGroup; baseRevision: string } {
    const group = structuredClone(this.#group(groupId))
    for (const [key, replacement] of Object.entries(this.#overrides.get(groupId)?.selectors ?? {})) {
      group.selectors[key] = { ...group.selectors[key]!, kind: replacement.kind, value: replacement.value }
    }
    return { group, baseRevision: this.revision(groupId) }
  }

  saveOverride(groupId: string, replacements: Record<string, SelectorDefinition>): void {
    const baseline = this.#group(groupId)
    const entries = Object.entries(replacements)
    if (!entries.length || entries.some(([key, value]) => !Object.hasOwn(baseline.selectors, key) || !definition(value)))
      throw new Error('INVALID_SELECTOR_OVERRIDE')
    const next = new Map(this.#overrides)
    next.set(groupId, { baseRevision: this.revision(groupId), createdAt: new Date().toISOString(),
      selectors: Object.fromEntries(entries.map(([key, value]) => [key,
        { kind: value.kind, value: value.value, purpose: baseline.selectors[key]!.purpose }])) })
    this.#persist(next)
    this.#overrides.clear()
    for (const [key, value] of next) this.#overrides.set(key, value)
    this.staleGroups.delete(groupId)
  }

  resetOverride(groupId: string): void {
    this.#group(groupId)
    const next = new Map(this.#overrides)
    next.delete(groupId)
    this.#persist(next)
    this.#overrides.delete(groupId)
  }

  #group(id: string): SelectorGroup {
    const group = this.#groups.get(id)
    if (!group) throw new Error('UNKNOWN_SELECTOR_GROUP')
    return group
  }

  #loadOverrides(): void {
    if (!this.overrideFile || !existsSync(this.overrideFile)) return
    try {
      if (statSync(this.overrideFile).size > 256_000) throw new Error('TOO_LARGE')
      const stored: unknown = JSON.parse(readFileSync(this.overrideFile, 'utf8'))
      if (!record(stored) || stored.schemaVersion !== 1 || !record(stored.groups)
          || Object.keys(stored.groups).length > 50) throw new Error('INVALID_STORE')
      for (const [id, value] of Object.entries(stored.groups)) {
        const group = this.#groups.get(id)
        if (!group || !record(value) || value.baseRevision !== selectorGroupRevision(group)) {
          this.staleGroups.add(id)
          continue
        }
        if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
            || !record(value.selectors) || !Object.keys(value.selectors).length
            || Object.entries(value.selectors).some(([key, entry]) =>
              !Object.hasOwn(group.selectors, key) || !definition(entry))) throw new Error('INVALID_OVERRIDE')
        this.#overrides.set(id, structuredClone(value) as unknown as GroupOverride)
      }
    } catch {
      this.#overrides.clear()
      this.loadIssue = 'INVALID_SELECTOR_OVERRIDES'
    }
  }

  #persist(groups: Map<string, GroupOverride>): void {
    if (!this.overrideFile) throw new Error('SELECTOR_OVERRIDE_STORAGE_UNAVAILABLE')
    mkdirSync(dirname(this.overrideFile), { recursive: true })
    const temporary = `${this.overrideFile}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, groups: Object.fromEntries(groups) }, null, 2) + '\n',
        { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      renameSync(temporary, this.overrideFile)
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary)
    }
  }
}

export function loadHhSelectors(): SelectorRegistry {
  // Load the whole store even when the caller needs one group: saving an override must
  // preserve valid replacements for other page types.
  const files = ['profile', 'common', 'search', 'vacancy', 'response-form', 'letter-form', 'resume-text']
  const groups = files.map(file => parseSelectorGroup(JSON.parse(readFileSync(
    new URL(`../../resources/hh-selectors/${file}.json`, import.meta.url), 'utf8'))))
  return new SelectorRegistry(groups, join(dirname(browserConfig.profilesRootDirectory), 'hh-selector-overrides.json'))
}
