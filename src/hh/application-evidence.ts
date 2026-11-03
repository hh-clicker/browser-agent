/** Ignore tracking parameters, but never accept another vacancy or origin. */
export function isVacancyDetailUrl(actual: string, expected: string): boolean {
  const url = new URL(actual)
  const target = new URL(expected)
  return url.origin === target.origin && url.pathname.replace(/\/$/, '') === target.pathname
}

export function isApplicationContextUrl(actual: string, expected: string, vacancyId: string): boolean {
  const url = new URL(actual)
  return isVacancyDetailUrl(actual, expected) || (url.origin === new URL(expected).origin
    && url.pathname === '/applicant/vacancy_response'
    && url.searchParams.getAll('vacancyId').length === 1
    && url.searchParams.get('vacancyId') === vacancyId)
}

/** Correlate the observed request with this dialog, not another tab/draft. */
export async function isLetterPayload(contentType: string, body: string | null, topicId: string, letter: string): Promise<boolean> {
  if (!body || body.length > 100_000) return false
  // Browser form encoding normalizes textarea LF to CRLF without changing its content.
  const sameText = (value: unknown) => typeof value === 'string'
    && value.replace(/\r\n/g, '\n') === letter.replace(/\r\n/g, '\n')
  try {
    if (contentType.includes('application/json')) {
      const payload: unknown = JSON.parse(body)
      return !!payload && typeof payload === 'object' && !Array.isArray(payload)
        && 'topicId' in payload && String(payload.topicId) === topicId
        && 'text' in payload && sameText(payload.text)
    }
    // Both URL-encoded and multipart browser forms; no cookies or XSRF fields are retained.
    const fields = await new Response(body, { headers: { 'content-type': contentType } }).formData()
    return fields.getAll('topicId').length === 1 && fields.get('topicId') === topicId
      && fields.getAll('text').length === 1 && sameText(fields.get('text'))
  } catch { return false }
}

/** Unknown response schemas fail closed. HTTP 200 or an empty body is not success. */
export function isExplicitLetterSuccess(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false
  const result = payload as Record<string, unknown>
  return (result.success === true || result.success === 'true')
    && (result.status === undefined || result.status === 'success' || result.status === 'ok')
    && (result.error === undefined || result.error === null || result.error === false)
    && (result.errors === undefined || result.errors === null
      || (Array.isArray(result.errors) && result.errors.length === 0))
}
