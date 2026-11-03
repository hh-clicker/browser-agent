export interface SearchVacancyEnrichment {
  workFormats: string[]
  employmentForm: string | null
  workScheduleByDays: string[]
  workingHours: string[]
  nightShifts: boolean | null
  sideJob: boolean | null
  temporary: boolean | null
  internship: boolean | null
  civilLawContracts: string[]
  flyInFlyOutDurations: string[]
  compensation: { from: number | null; to: number | null; currency: string | null; gross: boolean | null; mode: string | null; frequency: string | null } | null
  responsesCount: number | null
  totalResponsesCount: number | null
  responseLetterRequired: boolean | null
  userTestPresent: boolean | null
  questionInputAvailable: boolean | null
  incompleteResumesAccepted: boolean | null
  showContact: boolean | null
  inboxPossible: boolean | null
  chatWritePossibility: string | null
  professionalRoles: string[]
  languages: Array<{ code: string; level: string }>
  inclusivenessTypes: string[]
  accreditedItEmployer: boolean | null
  trustedEmployer: boolean | null
  companySiteUrl: string | null
  companyDepartment: string | null
  employerRating: string | null
  employerReviewsCount: number | null
  address: string | null
  metroStations: string[]
  district: string | null
  sourceCreatedAt: string | null
  sourceUpdatedAt: string | null
  creationSite: string | null
}

export interface SearchVacancyInitialStateEnrichment {
  publishedAt: string | null
  enrichment: SearchVacancyEnrichment
}

type JsonObject = Record<string, unknown>
const object = (value: unknown): JsonObject | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const string = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null
const boolean = (value: unknown): boolean | null => typeof value === 'boolean' ? value : null
const strings = (value: unknown): string[] => [...new Set(array(value).map(string).filter((item): item is string => item !== null))]
const objects = (value: unknown): JsonObject[] => {
  const single = object(value)
  return single ? [single] : array(value).map(object).filter((item): item is JsonObject => item !== null)
}
const identifiers = (value: unknown): string[] => [...new Set(array(value).flatMap((item) => {
  const id = string(item) ?? (number(item) === null ? null : String(number(item)))
  return id ? [id] : []
}))]

function nestedStrings(source: JsonObject, field: string, nested: string): string[] {
  return [...new Set(objects(source[field]).flatMap((container) => strings(container[nested])))]
}

function roleNames(state: JsonObject): Map<string, string> {
  const result = new Map<string, string>()
  for (const categoryValue of array(object(state.professionalRoleTree)?.items)) {
    const category = object(categoryValue)
    for (const roleValue of array(category?.items)) {
      const role = object(roleValue)
      const id = string(role?.id) ?? (number(role?.id) === null ? null : String(number(role?.id)))
      const name = string(role?.text)
      if (id && name && !result.has(id)) result.set(id, name)
    }
  }
  return result
}

function compensation(value: unknown): SearchVacancyEnrichment['compensation'] {
  const source = object(value)
  if (!source || object(source.noCompensation)) return null
  return {
    from: number(source.from), to: number(source.to), currency: string(source.currencyCode), gross: boolean(source.gross),
    mode: string(source.mode), frequency: string(source.frequency),
  }
}

function readVacancy(source: JsonObject, roles: Map<string, string>): SearchVacancyInitialStateEnrichment {
  const company = object(source.company) ?? {}
  const reviews = object(company.employerReviews) ?? {}
  const address = object(source.address) ?? {}
  const metro = object(address.metroStations) ?? {}
  const publication = object(source.publicationTime) ?? {}
  const lastChange = object(source.lastChangeTime) ?? {}
  return {
    publishedAt: string(publication.$),
    enrichment: {
      workFormats: nestedStrings(source, 'workFormats', 'workFormatsElement'),
      employmentForm: string(source.employmentForm),
      workScheduleByDays: nestedStrings(source, 'workScheduleByDays', 'workScheduleByDaysElement'),
      workingHours: nestedStrings(source, 'workingHours', 'workingHoursElement'),
      nightShifts: boolean(source.nightShifts), sideJob: boolean(source.sideJob), temporary: boolean(source.acceptTemporary),
      internship: boolean(source.internship), civilLawContracts: nestedStrings(source, 'civilLawContracts', 'civilLawContractsElement'),
      flyInFlyOutDurations: nestedStrings(source, 'flyInFlyOutDurations', 'flyInFlyOutDurationsElement'),
      compensation: compensation(source.compensation),
      responsesCount: number(source.responsesCount), totalResponsesCount: number(source.totalResponsesCount),
      responseLetterRequired: boolean(source['@responseLetterRequired']), userTestPresent: boolean(source.userTestPresent),
      questionInputAvailable: boolean(source.show_question_input), incompleteResumesAccepted: boolean(source.acceptIncompleteResumes),
      showContact: boolean(source['@showContact']), inboxPossible: boolean(source.inboxPossibility),
      chatWritePossibility: string(source.chatWritePossibility),
      professionalRoles: objects(source.professionalRoleIds)
        .flatMap((container) => identifiers(container.professionalRoleId))
        .map((id) => roles.get(id) ?? id),
      languages: objects(source.languages).flatMap((container) => array(container.language)).flatMap((value) => {
        const language = object(value); const code = string(language?.isoCode); const level = string(language?.degree)
        return code && level ? [{ code, level }] : []
      }),
      inclusivenessTypes: nestedStrings(source, 'inclusivenessTypes', 'inclusivenessTypesElement'),
      accreditedItEmployer: boolean(company.accreditedITEmployer), trustedEmployer: boolean(company['@trusted']),
      companySiteUrl: string(company.companySiteUrl),
      companyDepartment: string(object(company.department)?.['@name'] ?? object(company.department)?.name ?? company.structureName),
      employerRating: string(reviews.totalRating), employerReviewsCount: number(reviews.reviewsCount),
      address: string(address.displayName),
      metroStations: array(metro.metro).map((value) => string(object(value)?.name)).filter((item): item is string => item !== null),
      district: string(object(address.districtDto)?.name),
      sourceCreatedAt: string(source.creationTime), sourceUpdatedAt: string(lastChange.$), creationSite: string(source.creationSite),
    },
  }
}

/** Returns no enrichment when the SSR snapshot does not describe the rendered cards exactly. */
export function vacancyEnrichmentFromInitialState(vacancyIds: string[], value: unknown): SearchVacancyInitialStateEnrichment[] | null {
  const state = object(value)
  const vacancies = array(object(state?.vacancySearchResult)?.vacancies)
  if (vacancies.length !== vacancyIds.length) return null
  const sources = vacancies.map(object)
  if (sources.some((item) => !item)) return null
  const stateIds = sources.map((item) => string(item?.vacancyId) ?? (number(item?.vacancyId) === null ? '' : String(number(item?.vacancyId))))
  if (stateIds.some((id, index) => id !== vacancyIds[index])) return null
  const roles = roleNames(state!)
  return sources.map((item) => readVacancy(item!, roles))
}
