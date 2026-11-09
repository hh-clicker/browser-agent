import { readFileSync } from 'node:fs'
import { parseSelectorGroup, SelectorRegistry } from '../../src/hh/selector-registry.js'

/** Offline fixtures must not read the user's installed selector overrides. */
export function bundledSelectors(): SelectorRegistry {
  return new SelectorRegistry(['profile', 'common', 'search', 'vacancy', 'response-form', 'letter-form', 'resume-text']
    .map(file => parseSelectorGroup(JSON.parse(readFileSync(
      new URL(`../../resources/hh-selectors/${file}.json`, import.meta.url), 'utf8')))))
}
