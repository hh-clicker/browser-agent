import type { Page } from 'playwright'
import type { SelectorGroup } from './selector-registry.js'
import type { SelectorRepairObservations } from '../generation/selector-repair.js'

/** Generic CSS/XPath observations on the same sanitized, inert snapshot given to the model. No HH rules or golden selectors. */
export async function observeSelectorCandidate(page: Page, html: string, group: SelectorGroup): Promise<SelectorRepairObservations> {
  return page.evaluate(({ html, definitions }) => {
    const document = new DOMParser().parseFromString(html, 'text/html')
    const cache = new Map<string, Element[]>()
    // Object methods avoid tsx/esbuild function-name helpers in the serialized browser callback.
    const inspect = {
    query(root: Document | Element, kind: string, value: string): Element[] {
      if (kind === 'css') return [...root.querySelectorAll(value)]
      const result = document.evaluate(value, root, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null)
      return Array.from({ length: result.snapshotLength }, (_, i) => result.snapshotItem(i)).filter((node): node is Element => node instanceof Element)
    },
    roots(key: string, chain: string[]): (Document | Element)[] {
      const definition = definitions[key]
      if (!definition) throw new Error('Unknown scope')
      const scope = definition.contract?.scope ?? '$page'
      if (scope === '$page') return [document]
      const refs = typeof scope === 'string' ? [scope] : scope.anyOf
      // All eligible repair groups refer only to their own reading scopes.
      return [...new Set(refs.flatMap(ref => inspect.nodes(ref, chain)))]
    },
    nodes(key: string, chain: string[] = []): Element[] {
      if (cache.has(key)) return cache.get(key)!
      if (chain.includes(key) || chain.length > 100) throw new Error('Cyclic scope')
      const definition = definitions[key]
      if (!definition) throw new Error('Unknown selector')
      const found = inspect.roots(key, [...chain, key]).flatMap(root => inspect.query(root, definition.kind, definition.value))
      cache.set(key, found)
      return found
    },
    example(element: Element) {
      const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim()
      return { tag: element.tagName.toLowerCase(), text: text.slice(0, 250), textTruncated: text.length > 250,
        href: element.getAttribute('href'), value: element.getAttribute('value'),
        html: element.outerHTML.slice(0, 700), htmlTruncated: element.outerHTML.length > 700 }
    },
    }
    return { fields: Object.entries(definitions).map(([key, definition]) => {
      try {
        const parents = inspect.roots(key, [key])
        if (parents.length > 100) throw new Error('Too many scopes')
        const counts = parents.map(root => inspect.query(root, definition.kind, definition.value).length)
        const matches = inspect.nodes(key)
        const indices = [...new Set([0, Math.floor(matches.length / 2), matches.length - 1])].filter(index => index >= 0 && index < matches.length)
        return { key, scopeCount: parents.length, countPerScope: counts, matched: matches.length,
          examples: indices.map(index => inspect.example(matches[index]!)),
          parentExamplesWhenEmpty: !matches.length ? parents.slice(0, 2).filter((node): node is Element => node instanceof Element).map(node => inspect.example(node)) : [],
          error: null }
      } catch { return { key, error: 'Selector or scope could not be evaluated', examples: [] } }
    }) }
  }, { html, definitions: group.selectors })
}
