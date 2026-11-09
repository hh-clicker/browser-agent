import type { Locator, Page } from 'playwright'
import { loadHhSelectors, type SelectorRegistry } from './selector-registry.js'
import { searchFingerprint, waitForStableSearch } from './search-stability.js'
import { vacancyAccessRestriction } from './selector-repair-context.js'
import { readSearchCards } from './vacancy-search.js'

export type DiagnosticPageType = 'PROFILE' | 'SEARCH' | 'VACANCY' | 'RESUME'
export type DiagnosticMode = 'CURRENT' | 'FULL'
export interface SelectorDiagnosticRow {
  group: string; key: string; purpose: string; selector: string
  source: 'BUNDLED' | 'LOCAL'
  status: 'PASS' | 'FAIL' | 'NOT_CHECKED' | 'NOT_APPLICABLE' | 'STATE_NOT_CHECKED'
  required: boolean
  matched: number; visible: number; message: string
}
export interface SelectorDiagnosticReport {
  pageType: DiagnosticPageType | 'UNKNOWN' | 'FULL'
  checkedAt: string
  status: 'CHECKED' | 'WRONG_PAGE' | 'LOGIN' | 'CAPTCHA' | 'PAGE_UNAVAILABLE' | 'SKIPPED' | 'SELECT_TAB' | 'BLOCKED'
  tabs?: { tabId: string; label: string }[]
  summary?: 'PASSED' | 'FAILED' | 'INCOMPLETE'
  message: string
  rows: SelectorDiagnosticRow[]
  scenarios?: SelectorDiagnosticReport[]
  contextLabel?: string
  tabId?: string
  repairableGroups?: string[]
  repairNote?: string
}

export function detectDiagnosticPage(raw: string): DiagnosticPageType | null {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || !(url.hostname === 'hh.ru' || url.hostname.endsWith('.hh.ru'))
      || url.hostname === 'assessment.hh.ru' || url.hostname.endsWith('.assessment.hh.ru')) return null
    if (/^\/applicant\/profile\/me\/?$/.test(url.pathname)) return 'PROFILE'
    if (/^\/search\/vacancy\/?$/.test(url.pathname)) return 'SEARCH'
    if (/^\/vacancy\/\d+\/?$/.test(url.pathname) || /^\/applicant\/vacancy_response\/?$/.test(url.pathname)) return 'VACANCY'
    if (/^\/resume\/[a-f0-9]{20,100}\/?$/.test(url.pathname) && url.searchParams.get('print') === 'true') return 'RESUME'
    return null
  } catch { return null }
}
export function matchesDiagnosticPage(raw: string, type: DiagnosticPageType): boolean { return detectDiagnosticPage(raw) === type }

export function finishDiagnostic(report: SelectorDiagnosticReport): SelectorDiagnosticReport {
  const children = report.scenarios ?? []
  report.summary = report.status === 'BLOCKED' || report.rows.some(row => row.status === 'FAIL') || children.some(item => item.summary === 'FAILED') ? 'FAILED'
    : report.status !== 'CHECKED' || report.rows.some(row => row.status === 'NOT_CHECKED')
      || children.some(item => item.summary !== 'PASSED') ? 'INCOMPLETE' : 'PASSED'
  return report
}
export function skippedDiagnostic(pageType: DiagnosticPageType, message: string): SelectorDiagnosticReport {
  return finishDiagnostic({ pageType, checkedAt: new Date().toISOString(), status: 'SKIPPED', message, rows: [] })
}
export function blockedDiagnostic(pageType: DiagnosticPageType, dependency: SelectorDiagnosticReport): SelectorDiagnosticReport {
  const failed = dependency.rows.filter(row => row.status === 'FAIL').map(row => `${row.group}.${row.key}`).join(', ')
  return finishDiagnostic({ pageType, checkedAt: new Date().toISOString(), status: 'BLOCKED', rows: [],
    message: `Проверка заблокирована ошибкой шага ${dependency.pageType}${failed ? `: ${failed}` : ''}. Сначала устраните причину на предыдущем шаге.`.slice(0, 500) })
}

/** Read-only checks. No navigation, focus, clicks or input. */
export async function diagnoseSelectors(page: Page, requestedType?: DiagnosticPageType,
  registry: SelectorRegistry = loadHhSelectors()): Promise<SelectorDiagnosticReport> {
  const originalUrl = page.url()
  const detectedType = detectDiagnosticPage(originalUrl)
  const pageType = requestedType ?? detectedType
  const report: SelectorDiagnosticReport = { pageType: pageType ?? 'UNKNOWN', checkedAt: new Date().toISOString(), status: 'CHECKED',
    message: 'Проверены элементы и читаемые поля. Отправка откликов и нажатия не выполнялись.', rows: [] }
  const stop = (status: SelectorDiagnosticReport['status'], message: string) => finishDiagnostic({ ...report, status, message, rows: [] })
  const deadline = Date.now() + 45_000
  try {
    const url = new URL(originalUrl)
    const hh = url.protocol === 'https:' && (url.hostname === 'hh.ru' || url.hostname.endsWith('.hh.ru'))
      && url.hostname !== 'assessment.hh.ru' && !url.hostname.endsWith('.assessment.hh.ru')
    if (!hh) return stop('WRONG_PAGE', 'Активна неподходящая вкладка. Выберите нужную страницу HH; assessment.hh.ru не проверяется.')
    if (/^\/(?:account\/login|auth\/applicant)(?:\/|$)/.test(url.pathname)) return stop('LOGIN', 'HH открыл страницу входа. Войдите вручную.')
    if (/captcha/i.test(url.pathname) || await page.locator('[data-qa*="captcha" i],iframe[src*="captcha" i],.g-recaptcha,.smart-captcha').filter({ visible: true }).count()
      || await page.getByText(/пройдите капчу|подтвердите,? что вы не робот|введите текст с картинки/i).first().isVisible())
      return stop('CAPTCHA', 'Пройдите проверку безопасности HH вручную.')
    if (!pageType || detectedType !== pageType) return stop('WRONG_PAGE', 'Активная вкладка не соответствует проверяемым страницам HH. Для резюме нужна печатная страница ?print=true.')
    if (pageType === 'VACANCY') {
      const restriction = await vacancyAccessRestriction(page)
      if (restriction) return stop('SKIPPED', `${restriction} Селекторы страницы не проверялись.`)
    }
    const documentTime = await page.evaluate(() => performance.timeOrigin)
    if (pageType === 'SEARCH') {
      const settled = await waitForStableSearch(page, registry).catch(() => 'MISSING' as const)
      if (settled === 'UNSTABLE') return stop('PAGE_UNAVAILABLE', 'Выдача продолжает изменяться. Дождитесь загрузки и повторите диагностику.')
    }
    const initialSearch = pageType === 'SEARCH' ? await searchFingerprint(page, registry).catch(() => null) : null
    const groups = pageType === 'PROFILE' ? ['profile'] : pageType === 'SEARCH' ? ['search']
      : pageType === 'RESUME' ? ['resumeText'] : ['vacancy', 'responseForm', 'letterForm']
    const visible = async (selector: string) => await page.locator(selector).filter({ visible: true }).count().catch(() => 0) > 0
    const archivedTitlePresent = pageType === 'VACANCY' && await visible('[data-qa="vacancy-title-archived-text"]')
    const archivedDescriptionPresent = pageType === 'VACANCY' && await visible('[data-qa="vacancy-archive-description"]')
    const archived = archivedTitlePresent || archivedDescriptionPresent
    const delivered = pageType === 'VACANCY' && (await visible(registry.locator('vacancy', 'delivered'))
      || await visible('.vacancy-actions_responded:not([data-qa="vacancy-serp__vacancy"] *):not([data-qa="vacancy-view-vacancies-from-search"] *)'))
    const detail = /^\/vacancy\/\d+\/?$/.test(url.pathname)
    const questionnaire = pageType === 'VACANCY' && await visible('[data-qa="employer-asking-for-test"], [data-qa="task-body"], [data-qa="task-question"]')
    const emptySearch = pageType === 'SEARCH' && await page.getByText(/по вашему запросу ничего не найдено|вакансии не найдены|ничего не найдено/i).first().isVisible()
    const formStates: Record<string, { open: boolean; suspected: boolean }> = {}
    for (const group of groups.filter(id => id === 'responseForm' || id === 'letterForm')) {
      const open = await visible(registry.locator(group, 'form'))
      const hints = group === 'responseForm' ? 'form[name="vacancy_response"], [data-qa="vacancy-response-submit-popup"]'
        : 'form[action="/applicant/vacancy_response/edit_ajax"], [data-qa="vacancy-response-letter-submit"]'
      formStates[group] = { open, suspected: open || await visible(hints) }
    }
    for (const group of groups) {
      const definitions = registry.repairContext(group).group.selectors
      const resolve = (owner: string, key: string, path: string[] = []): Locator | null => {
        const id = `${owner}.${key}`
        if (path.includes(id) || path.length > 8) return null
        const definition = registry.repairContext(owner).group.selectors[key]
        if (!definition) return null
        const scope = definition.contract?.scope ?? '$page'
        const parent = resolveScope(owner, scope, [...path, id])
        if (scope !== '$page' && !parent) return null
        let target = parent ? parent.locator(registry.locator(owner, key)) : page.locator(registry.locator(owner, key))
        if (key === 'form' && (owner === 'responseForm' || owner === 'letterForm')) target = page.locator(registry.locator(owner, key))
        if (key === 'dialog' && (owner === 'responseForm' || owner === 'letterForm')) target = target.filter({ has: page.locator(registry.locator(owner, 'form')) })
        return target
      }
      const resolveScope = (owner: string, scope: string | { anyOf: string[] }, path: string[] = []): Locator | null => {
        if (scope === '$page') return null
        const refs = typeof scope === 'string' ? [scope] : scope.anyOf
        let combined: Locator | null = null
        for (const ref of refs) {
          const [parentGroup, key]: [string, string] = ref.includes('.') ? ref.split('.') as [string, string] : [owner, ref]
          const target = key === 'form' && (parentGroup === 'responseForm' || parentGroup === 'letterForm')
            ? page.locator(registry.locator(parentGroup, key)) : resolve(parentGroup, key, path)
          if (target) combined = combined ? combined.or(target) : target
        }
        return combined
      }
      for (const [key, definition] of Object.entries(definitions)) {
        const contract = definition.contract
        const row: SelectorDiagnosticRow = { group, key, purpose: definition.purpose, selector: registry.locator(group, key),
          source: registry.source(group, key), status: 'NOT_CHECKED', required: contract?.required ?? contract?.cardinality === 'one',
          matched: 0, visible: 0, message: '' }
        report.rows.push(row)
        const notApplicable = (message: string) => { row.status = 'NOT_APPLICABLE'; row.required = false; row.message = message }
        const stateNotChecked = (message: string) => { row.status = 'STATE_NOT_CHECKED'; row.required = false; row.message = message }
        try {
          if (Date.now() > deadline) { row.message = 'Истёк лимит времени проверки.'; continue }
          const form = formStates[group]
          if (form && key !== 'attach' && !form.suspected) { stateNotChecked('Форма не открыта. Её селекторы в этом снимке не проверялись; автоматически форма не открывается.'); continue }
          if (group === 'letterForm' && key === 'attach' && !delivered) { stateNotChecked('Кнопка добавления письма проверяется после отправленного отклика.'); continue }
          if (form && !form.open && key !== 'attach' && key !== 'form') { row.message = 'Есть признаки формы, но её основной селектор не сработал.'; continue }
          if (group === 'vacancy') {
            if (!detail && key !== 'questionnaire') { stateNotChecked('Открыта форма отклика, а не страница вакансии.'); continue }
            if (!archived && ['archivedTitle','archivedDescription'].includes(key)) { stateNotChecked('Вакансия не архивная; признаки архива в этом снимке не проверялись.'); continue }
            if (key === 'archivedTitle' && archivedTitlePresent || key === 'archivedDescription' && archivedDescriptionPresent) row.required = true
            if (!delivered && ['delivered','viewResponse','respondAgain'].includes(key)) { stateNotChecked('Состояние после отправленного отклика в этом снимке не наблюдается.'); continue }
            if (archived && ['description','actions','respond'].includes(key)
              || (delivered || questionnaire) && key === 'respond') {
              notApplicable('Элемент не требуется в текущем состоянии вакансии.'); continue
            }
          }
          if (group === 'responseForm' && ['resumeList','resumeOptions','selectedResume'].includes(key)
              && !await visible(registry.locator(group, 'resumeList'))) {
            const trigger = resolve(group, 'resumeTrigger')?.filter({ visible: true })
            const expanded = trigger && await trigger.count() === 1 && await trigger.getAttribute('aria-expanded') === 'true'
            if (expanded) {
              if (key === 'resumeList') row.required = true
              else { row.message = 'Выбор резюме раскрыт, но родительский список не распознан; сначала проверьте resumeList.'; continue }
            } else {
              if (await visible(registry.locator(group, 'selectWrapper')))
                stateNotChecked('Раскрытый список выбора резюме не обнаружен; варианты не проверялись. Раскройте его вручную и повторите диагностику.')
              else notApplicable('В форме нет признака раскрываемого выбора резюме; проверка вариантов списка не применяется.')
              continue
            }
          }
          if (emptySearch && group === 'search' && ['cards','title','employerLink','employerName'].includes(key)) {
            notApplicable('HH показал пустую выдачу.'); continue
          }
          if (group === 'responseForm' && key === 'letter' && await visible(registry.locator(group, 'addLetter'))
              && !await visible(row.selector)) { stateNotChecked('Поле письма ещё не раскрыто; его селектор не проверялся.'); continue }
          const scope = form && key === 'form' ? '$page' : contract?.scope ?? '$page'
          const parent = resolveScope(group, scope)
          if (scope !== '$page' && !parent) { row.message = 'Область поиска не определена в реестре.'; continue }
          // Alternative scopes may each legitimately contain a copy (e.g. delivery notice and top actions).
          // Cardinality belongs to each parent, not to their combined descendants.
          const parentTargets = parent ? await parent.filter({ visible: true }).all() : [null]
          if (!parentTargets.length) {
            if (group === 'profile' && key === 'resumeLink' && !await visible(registry.locator('profile','anyResumeLink'))) {
              notApplicable('В профиле нет резюме.'); continue
            }
            if (row.required && group === 'profile' && key === 'resumeLink' || row.required && group === 'search' && ['title','employerLink','employerName'].includes(key))
              row.message = 'Нет родительских карточек; проверка поля зависит от их распознавания.'
            else notApplicable('Родительская область отсутствует в текущем состоянии страницы.')
            continue
          }
          if (parentTargets.length > 100) { row.message = 'Превышен лимит областей диагностического снимка.'; continue }
          let invalid = false
          let partial = false
          let disabledSubmit = false
          const formTargets = form?.open ? page.locator(registry.locator(group, 'form')).filter({ visible: true }) : null
          const formId = formTargets && await formTargets.count() === 1 ? await formTargets.getAttribute('id') ?? '' : ''
          const hiddenReadable = key === 'initialState' || group === 'letterForm' && key === 'topic'
          for (const parentItem of parentTargets) {
            let target = parentItem ? parentItem.locator(row.selector) : page.locator(row.selector)
            if (key === 'dialog' && form) target = target.filter({ has: page.locator(registry.locator(group, 'form')) })
            if (group === 'vacancy') target = target.locator('xpath=self::*[not(ancestor::*[@data-qa="vacancy-serp__vacancy" or @data-qa="vacancy-view-vacancies-from-search"])]')
            const count = await target.count()
            const visibleCount = await target.filter({ visible: true }).count()
            row.matched += count; row.visible += visibleCount
            const relevantCount = hiddenReadable ? count : visibleCount
            if (row.required && typeof scope === 'string' && relevantCount === 0 || contract?.cardinality === 'one' && relevantCount > 1
              || contract?.cardinality === 'zeroOrOne' && relevantCount > 1) invalid = true
            if (count > 500) { partial = true; continue }
            const reads = contract?.reads ?? []
            const supported = reads.filter(field => ['textContent','innerText','visibleText','href','closestLinkHref','value','nonEmptyValue','data-qa-title','templateJson',
              'id','form','data-magritte-select-option','aria-selected','aria-disabled'].includes(field))
            if (reads.length !== supported.length) partial = true
            const inspected = hiddenReadable ? target : target.filter({ visible: true })
            const valid = await inspected.evaluateAll((nodes, args) => nodes.every(node => {
              if (args.formGroup && args.key === 'form') {
                if (!(node instanceof HTMLFormElement)) return false
                if (args.group === 'letterForm') {
                  try {
                    const action = new URL(node.getAttribute('action') ?? '', location.href)
                    if (action.origin !== location.origin || action.pathname !== '/applicant/vacancy_response/edit_ajax') return false
                  } catch { return false }
                }
              }
              if (args.formGroup && args.key === 'submit') {
                const forms = [...document.forms].filter(form => form.id === args.formId && args.formId)
                if (forms.length !== 1 || !(node instanceof HTMLButtonElement || node instanceof HTMLInputElement)
                    || node.form !== forms[0]) return false
              }
              return args.reads.every(field => {
              if (field === 'textContent') return Boolean(node.textContent?.trim())
              if (field === 'innerText' || field === 'visibleText') return node instanceof HTMLElement && Boolean(node.innerText.trim())
              if (field === 'templateJson') {
                const text = node instanceof HTMLTemplateElement ? node.content.textContent : node.textContent
                if (!text?.trim() || text.length > 4_000_000) return false
                try { const parsed: unknown = JSON.parse(text); return parsed !== null && typeof parsed === 'object' }
                catch { return false }
              }
              if (field === 'value') return 'value' in node || node.hasAttribute('value')
              if (field === 'nonEmptyValue') return 'value' in node && typeof node.value === 'string' && Boolean(node.value.trim())
              if (field === 'id') return Boolean(node.id.trim())
              if (field === 'form') return (node instanceof HTMLButtonElement || node instanceof HTMLInputElement)
                && node.form instanceof HTMLFormElement && node.form.id === args.formId
              if (field === 'data-magritte-select-option') return /^[a-f0-9]{20,100}$/i.test(node.getAttribute(field) ?? '')
              if (field === 'aria-selected' || field === 'aria-disabled') {
                const value = node.getAttribute(field)
                return value === null || value === 'true' || value === 'false'
              }
              if (field === 'href' || field === 'closestLinkHref') {
                const anchor = field === 'closestLinkHref' ? node.closest('a[href]') : node
                const href = anchor?.getAttribute('href')
                if (!href) return false
                try {
                  const link = new URL(href, location.href)
                  if (link.protocol !== 'https:' || !(link.hostname === 'hh.ru' || link.hostname.endsWith('.hh.ru'))) return false
                  if (args.group === 'profile' && args.key === 'resumeLink' && !/^\/resume\/[a-f0-9]{20,100}\/?$/.test(link.pathname)) return false
                  if (args.group === 'search' && args.key === 'title' && !/^\/vacancy\/\d+\/?$/.test(link.pathname)) return false
                  if (args.group === 'vacancy' && args.key === 'respond') return link.pathname === '/applicant/vacancy_response'
                    && link.searchParams.getAll('vacancyId').length === 1 && link.searchParams.get('vacancyId') === args.vacancyId
                  return true
                } catch { return false }
              }
              return Boolean(node.getAttribute(field)?.trim())
                || args.group === 'profile' && args.key === 'resumeCards' && Boolean(node.textContent?.trim())
              })
            }), { reads: supported, group, key, formGroup: Boolean(form), formId,
              vacancyId: url.pathname.match(/^\/vacancy\/(\d+)/)?.[1] ?? url.searchParams.get('vacancyId') })
            if (!valid) invalid = true
            if (form && key === 'submit' && await inspected.evaluateAll(nodes => nodes.some(node => node.matches(':disabled') || node.getAttribute('aria-disabled') === 'true')))
              disabledSubmit = true
          }
          if (typeof scope === 'object' && row.required && (hiddenReadable ? row.matched : row.visible) === 0) invalid = true
          row.status = invalid ? 'FAIL' : partial ? 'NOT_CHECKED'
            : row.matched === 0 || !hiddenReadable && row.visible === 0 ? 'NOT_APPLICABLE' : 'PASS'
          row.message = invalid ? 'Не соблюдены количество элементов или требования к читаемым полям.'
            : partial ? 'Часть правил чтения ещё не поддерживается диагностикой.'
              : !row.matched ? 'Необязательный элемент отсутствует.' : 'Элемент и его читаемые поля соответствуют контракту.'
          if (!invalid && !partial && disabledSubmit)
            stateNotChecked('Кнопка найдена и связана с формой, но сейчас неактивна. Её доступность после заполнения полей не проверялась.')
        } catch (cause) {
          const invalidSelector = cause instanceof Error && /Unexpected token|not a valid selector|not a valid XPath|Unsupported token|Unknown engine|InvalidSelectorError/i.test(cause.message)
          row.status = invalidSelector ? 'FAIL' : 'NOT_CHECKED'
          row.message = invalidSelector ? 'Некорректный синтаксис селектора.' : 'Страница изменилась или проверку не удалось завершить; сырая ошибка не сохраняется.'
        }
      }
    }
    if (archived && !report.rows.some(row => row.group === 'vacancy' && ['archivedTitle','archivedDescription'].includes(row.key) && row.status === 'PASS')) {
      for (const row of report.rows.filter(row => row.group === 'vacancy' && ['archivedTitle','archivedDescription'].includes(row.key))) {
        row.status = 'FAIL'
        row.message = 'HH показывает архивную вакансию, но селекторы реестра не подтвердили ни один признак архива.'
      }
    }
    if (pageType === 'SEARCH' && !report.rows.some(row => row.required && row.status === 'FAIL')) {
      await readSearchCards(page, registry, warning => {
        for (const missed of warning.rows) {
          const row = report.rows.find(item => item.group === missed.group && item.key === missed.key)
          if (row && row.status !== 'FAIL') Object.assign(row, missed)
        }
      }).catch(() => undefined)
    }
    if (initialSearch && (await searchFingerprint(page, registry)).value !== initialSearch.value)
      return stop('PAGE_UNAVAILABLE', 'Выдача изменилась во время проверки. Повторите диагностику после загрузки.')
    if (page.url() !== originalUrl || await page.evaluate(() => performance.timeOrigin) !== documentTime)
      return stop('PAGE_UNAVAILABLE', 'Страница сменилась во время проверки. Повторите диагностику.')
    if (pageType === 'VACANCY' && !detail && !questionnaire && !Object.values(formStates).some(form => form.suspected)) {
      report.status = 'SKIPPED'
      report.message = 'Открыт адрес отклика, но форма и задание не распознаны. Нельзя подтвердить корректность этой страницы.'
      return finishDiagnostic(report)
    }
    const result = finishDiagnostic(report)
    result.message = result.summary === 'FAILED' ? 'Обнаружены несоответствия селекторов или читаемых полей.'
      : result.summary === 'INCOMPLETE' ? 'Проверка неполная: часть данных не удалось проверить.'
        : 'Проверки текущего состояния пройдены. Непроверенные состояния отмечены отдельно; нажатия и отправка не проверялись.'
    return result
  } catch { return stop('PAGE_UNAVAILABLE', 'Страница закрыта или недоступна. Повторите диагностику.') }
}
