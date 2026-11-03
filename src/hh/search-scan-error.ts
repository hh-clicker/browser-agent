/** Only messages created by the scanner are safe to send to the UI. */
export class SearchScanError extends Error {}

export function describeSearchScanFailure(cause: unknown, stage: string, pageNumber?: number): SearchScanError {
  const prefix = pageNumber ? `Страница ${pageNumber}, ${stage}` : stage
  let reason = 'Неожиданная ошибка агента. Повторите сканирование; если ошибка сохранится, сообщите этот этап.'
  if (cause instanceof SearchScanError) {
    reason = cause.message
  } else if (cause instanceof Error) {
    // Classify errors without forwarding URLs, page content or Playwright call logs.
    if (/\b__name is not defined\b/.test(cause.message)) {
      reason = 'Ошибка совместимости обработчика карточек с tsx (__name). Обновите и перезапустите Browser Agent.'
    } else if (cause.name === 'TimeoutError' || /\bTimeout \d+ms exceeded\b/.test(cause.message)) {
      reason = 'Истекло время ожидания HH. Проверьте загрузку страницы и повторите сканирование.'
    } else if (/Target page, context or browser has been closed|Target closed|browser has disconnected/i.test(cause.message)) {
      reason = 'Рабочая вкладка или браузер закрыты. Откройте браузер аккаунта и повторите сканирование.'
    } else if (/Execution context was destroyed|Cannot find context with specified id/i.test(cause.message)) {
      reason = 'Страница перезагрузилась во время чтения. Дождитесь её загрузки и повторите сканирование.'
    } else if (/net::ERR_/.test(cause.message)) {
      reason = 'Сетевая ошибка при загрузке HH. Проверьте соединение и повторите сканирование.'
    } else if (/\bReferenceError\b/.test(cause.message) || cause.name === 'ReferenceError') {
      reason = 'Ошибка выполнения обработчика страницы. Сообщите этот этап для проверки агента.'
    }
  }
  return new SearchScanError(`${prefix}: ${reason}`)
}
