import type { Page } from 'playwright'
import { loadHhSelectors, type SelectorRegistry, type SelectorDefinition } from './selector-registry.js'
import { diagnoseSelectors, detectDiagnosticPage, type SelectorDiagnosticReport } from './selector-diagnostics.js'
import { selectorRepairBlocker, selectorRepairHtml } from './selector-repair-context.js'
import { generateSelectorRepair, type SelectorRepairInput, type SelectorRepairResult } from '../generation/selector-repair.js'
import { observeSelectorCandidate } from './selector-observations.js'
import { readResumeCards } from './resume-discovery.js'
import { extractResumeText } from './resume-text.js'
import { readSearchCards } from './vacancy-search.js'
import { extractVacancyText } from './vacancy-text.js'

const groupsByPage: Record<string, string> = { PROFILE: 'profile', SEARCH: 'search', RESUME: 'resumeText', VACANCY: 'vacancy' }
const vacancyReadingKeys = new Set(['title', 'description', 'archivedTitle', 'archivedDescription'])
function isArchivedReport(report: SelectorDiagnosticReport): boolean {
  return report.pageType === 'VACANCY' && report.rows.some(row =>
    row.group === 'vacancy' && ['archivedTitle', 'archivedDescription'].includes(row.key) && row.required)
}
function readingDefinitions(registry: SelectorRegistry, groupId: string, archived = false): Record<string, SelectorDefinition> {
  return Object.fromEntries(Object.entries(registry.repairContext(groupId).group.selectors)
    .filter(([key, definition]) => definition.contract?.action === 'read' && (groupId !== 'vacancy'
      || (archived ? ['title', 'archivedTitle', 'archivedDescription'].includes(key) : vacancyReadingKeys.has(key)))))
}

export async function offerSelectorRepair(page: Page, report: SelectorDiagnosticReport, registry: SelectorRegistry): Promise<SelectorDiagnosticReport> {
  report.repairableGroups = []
  const groupId = groupsByPage[report.pageType]
  if (report.status !== 'CHECKED' || !groupId) return report
  const definitions = readingDefinitions(registry, groupId, isArchivedReport(report))
  if (!report.rows.some(row => row.group === groupId && row.status === 'FAIL' && definitions[row.key]?.contract?.action === 'read')) {
    if (report.rows.some(row => row.status === 'FAIL'))
      report.repairNote = 'Ошибки обнаружены в полях, для которых ИИ-починка пока недоступна. Сейчас у вакансии она исправляет только заголовок, описание и признаки архива; селекторы состояния отклика и форм не изменяются.'
    return report
  }
  const blocker = await selectorRepairBlocker(page)
  if (blocker) { report.repairNote = blocker; return report }
  if (groupId === 'vacancy' && !/^\/vacancy\/\d+\/?$/.test(new URL(page.url()).pathname)) return report
  report.repairableGroups = [groupId]
  return report
}

export async function repairReadSelectors(page: Page, groupId: string, requestId: string,
    options: { loadSelectors?: () => SelectorRegistry; generate?: (input: SelectorRepairInput, requestId: string) => Promise<unknown> } = {}): Promise<SelectorDiagnosticReport> {
  const load = options.loadSelectors ?? loadHhSelectors
  const registry = load()
  const pageType = detectDiagnosticPage(page.url())
  if (!pageType || groupsByPage[pageType] !== groupId) throw new Error('Выбранная группа не соответствует странице.')
  const blocker = await selectorRepairBlocker(page)
  if (blocker) throw new Error(blocker)
  const url = page.url()
  const documentTime = await page.evaluate(() => performance.timeOrigin)
  const before = await offerSelectorRepair(page, await diagnoseSelectors(page, pageType, registry), registry)
  if (!before.repairableGroups?.includes(groupId)) throw new Error('На этой странице нет подходящей поломки селекторов чтения. Повторите диагностику.')
  const original = registry.repairContext(groupId)
  const archived = isArchivedReport(before)
  const readDefinitions = readingDefinitions(registry, groupId, archived)
  const unobservedKeys = new Set(before.rows.filter(row => row.group === groupId && row.status === 'STATE_NOT_CHECKED'
    && Object.hasOwn(readDefinitions, row.key)).map(row => row.key))
  const brokenKeys = before.rows.filter(row => row.group === groupId && row.status === 'FAIL' && Object.hasOwn(readDefinitions, row.key)).map(row => row.key)
  const diagnostics = Object.keys(readDefinitions).map<SelectorRepairInput['diagnostics'][number]>(key => {
    const row = before.rows.find(item => item.group === groupId && item.key === key)
    return { key, status: row?.status ?? 'NOT_CHECKED', matched: row?.matched ?? 0, visible: row?.visible ?? 0,
      required: readDefinitions[key]!.contract?.required === true,
      message: row?.message ?? 'Селектор не был проверен; его необходимо проверить по HTML и контракту.' }
  })
  const html = await selectorRepairHtml(page)
  const input: SelectorRepairInput = { group: { ...original.group, selectors: readDefinitions }, brokenKeys, diagnostics, html }
  const generate = options.generate ?? generateSelectorRepair
  const unchangedPage = async () => {
    if (page.isClosed() || page.url() !== url || await page.evaluate(() => performance.timeOrigin) !== documentTime)
      throw new Error('Страница изменилась во время работы ИИ. Исправление не сохранено; повторите диагностику.')
    const blocked = await selectorRepairBlocker(page)
    if (blocked) throw new Error(blocked)
  }
  const decode = (value: unknown): SelectorRepairResult => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ИИ вернул некорректные селекторы. Исправление не сохранено.')
    const result = value as SelectorRepairResult
    if (!result.selectors || !result.audit || Object.keys(result.selectors).length !== Object.keys(readDefinitions).length
        || Object.keys(result.audit).length !== Object.keys(readDefinitions).length) throw new Error('ИИ вернул неполный набор селекторов или обоснований.')
    for (const key of Object.keys(readDefinitions)) {
      if (unobservedKeys.has(key)) {
        const original = readDefinitions[key]!
        result.selectors[key] = { kind: original.kind, value: original.value }
      }
      const item = result.selectors[key]
      const audit = result.audit[key]
      const invalidSelector = !item || typeof item !== 'object' || !['css','xpath'].includes(item.kind) || typeof item.value !== 'string'
          || !item.value.trim() || item.value.length > 4096 || item.value.includes('\0') || /\[REDACTED\]/.test(item.value)
          || Object.keys(item).some(field => !['kind','value'].includes(field))
          || /^(?:css=)?(?:body|html|\*)$|^(?:xpath=)?(?:\.?\/\/)(?:body|html|\*)$/.test(item.value.trim())
      const invalidAudit = !audit || !['verified','absent','unresolved'].includes(audit.status)
          || !['include','exclude','reason'].every(field => typeof audit[field as keyof typeof audit] === 'string'
            && audit[field as keyof typeof audit].trim() && audit[field as keyof typeof audit].length <= 1200)
      if (!unobservedKeys.has(key) && invalidSelector || invalidAudit)
        throw new Error('ИИ предложил недопустимое исправление или обоснование. Локальные селекторы не изменены.')
    }
    return result
  }
  const proposal = decode(await generate(input, requestId))
  await unchangedPage()
  const proposedDefinitions = Object.fromEntries(Object.entries(proposal.selectors).map(([key, value]) =>
    [key, { ...value, purpose: readDefinitions[key]!.purpose }]))
  registry.previewOverride(groupId, proposedDefinitions)
  const observations = await observeSelectorCandidate(page, html, { ...input.group, selectors: Object.fromEntries(
    Object.entries(readDefinitions).map(([key, definition]) => [key, { ...definition, ...proposal.selectors[key] }])) })
  // The first candidate is never persisted. The second request is independent and has its own idempotency key.
  const reviewed = decode(await generate({ ...input, review: { candidate: proposal, observations } }, `${requestId}-review`))
  await unchangedPage()
  const unconfirmed = Object.entries(reviewed.audit).filter(([key, item]) => !unobservedKeys.has(key)
    && (item.status === 'unresolved' || item.status === 'absent' && readDefinitions[key]!.contract?.required === true)).map(([key]) => key)
  if (unconfirmed.length)
    throw new Error(`ИИ не подтвердил смысл или полноту полей: ${unconfirmed.slice(0, 5).join(', ')}${unconfirmed.length > 5 ? ' и другие' : ''}. Исправление не сохранено.`)
  const raw = reviewed.selectors
  if (page.isClosed() || page.url() !== url || await page.evaluate(() => performance.timeOrigin) !== documentTime)
    throw new Error('Страница изменилась во время работы ИИ. Исправление не сохранено; повторите диагностику.')
  const blockedAfterGeneration = await selectorRepairBlocker(page)
  if (blockedAfterGeneration) throw new Error(blockedAfterGeneration)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Object.keys(raw).length || Object.keys(raw).length > 100)
    throw new Error('ИИ вернул некорректные селекторы. Исправление не сохранено.')
  const replacements: Record<string, SelectorDefinition> = {}
  for (const [key, input] of Object.entries(raw)) {
    if (unobservedKeys.has(key)) continue
    const value = input as { kind?: unknown; value?: unknown }
    if (!Object.hasOwn(readDefinitions, key) || !value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(field => !['kind', 'value'].includes(field))
        || !['css', 'xpath'].includes(String(value.kind)) || typeof value.value !== 'string' || !value.value.trim()
        || value.value.length > 4096 || value.value.includes('\0') || /\[REDACTED\]/.test(value.value)
        || /^(?:css=)?(?:body|html|\*)$|^(?:xpath=)?(?:\.?\/\/)(?:body|html|\*)$/.test(value.value.trim()))
      throw new Error('ИИ предложил недопустимое исправление. Локальные селекторы не изменены.')
    replacements[key] = { kind: value.kind as 'css' | 'xpath', value: value.value, purpose: readDefinitions[key]!.purpose }
  }
  const candidate = registry.previewOverride(groupId, replacements)
  const after = await diagnoseSelectors(page, pageType, candidate)
  const rows = after.rows.filter(row => row.group === groupId && Object.hasOwn(readDefinitions, row.key))
  if (after.status !== 'CHECKED' || brokenKeys.some(key => !rows.some(row => row.key === key && row.status === 'PASS'))
      || rows.some(row => row.status === 'FAIL' || row.required && row.status === 'NOT_CHECKED')
      || rows.some(row => reviewed.audit[row.key]?.status === 'absent' && row.matched > 0)
      || before.rows.some(old => old.group === groupId && old.status === 'PASS' && Object.hasOwn(readDefinitions, old.key)
        && !rows.some(row => row.key === old.key && row.status === 'PASS')))
    throw new Error('Селекторы ИИ не прошли проверку на странице. Исправление не сохранено.')
  // Exercise the real reader as well as the structural contract, without navigation or clicks.
  try {
    if (groupId === 'profile' && !(await readResumeCards(page, candidate)).length) throw new Error('EMPTY_RESUMES')
    if (groupId === 'search' && !(await readSearchCards(page, candidate)).length) throw new Error('EMPTY_CARDS')
    if (groupId === 'resumeText') await extractResumeText(page, new URL(url).pathname.split('/')[2]!, candidate)
    if (groupId === 'vacancy' && !archived && await extractVacancyText(page, new URL(url).pathname.split('/')[2]!, candidate) === null) throw new Error('MISSING_TEXT')
  } catch { throw new Error('Исправление не прошло проверку чтением данных. Локальные селекторы не изменены.') }
  if (page.isClosed() || page.url() !== url || await page.evaluate(() => performance.timeOrigin) !== documentTime)
    throw new Error('Страница изменилась во время проверки. Исправление не сохранено.')
  const finalBlocker = await selectorRepairBlocker(page)
  if (finalBlocker) throw new Error(finalBlocker)
  const current = load()
  if (JSON.stringify(current.repairContext(groupId)) !== JSON.stringify(original))
    throw new Error('Селекторы изменились во время работы ИИ. Повторите диагностику.')
  try { current.mergeOverride(groupId, replacements) }
  catch { throw new Error('Не удалось сохранить локальное исправление селекторов.') }
  for (const row of after.rows) row.source = (row.group === groupId ? current : registry).source(row.group, row.key)
  after.repairableGroups = []
  after.repairNote = 'Локальное исправление сохранено после двух шагов ИИ и проверки чтением данных; штатные селекторы не изменены.'
  return after
}
