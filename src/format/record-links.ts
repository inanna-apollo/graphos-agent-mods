// Keys and ids in argument values that name a record become links to it:
// a Jira issue key in a JQL value or an `issueKey` argument, a Confluence page
// id. The URL is built from the configured host (src/links.ts); the value only
// fills the encoded path. Pure: no `$`.
import { configOf, confluencePageUrl, jiraKeyUrl, serviceOf } from '../links.ts'
import type { LinkConfig } from '../links.ts'
import type { Rendered, Segment } from './types.ts'

const KEY = /[A-Z][A-Z0-9_]+-\d+/y
const WORD = /[A-Za-z0-9_]/
const KEY_ARGS = new Set(['issueKey', 'issueIdOrKey'])
const PAGE_ARGS = new Set(['pageId', 'id'])

/** Splits one JQL value segment at issue keys outside quotes; the keys carry their link. */
function splitKeys(segment: Segment, config: LinkConfig): Segment[] {
  const { text, tone } = segment
  const part = (slice: string, url?: string): Segment => ({ text: slice, ...(tone !== undefined && { tone }), ...(url !== undefined && { url }) })
  const out: Segment[] = []
  let from = 0
  let quote = ''
  let at = 0
  while (at < text.length) {
    const c = text.charAt(at)
    if (quote !== '') {
      if (c === '\\') at++
      else if (c === quote) quote = ''
      at++
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      at++
      continue
    }
    KEY.lastIndex = at
    const hit = KEY.exec(text)
    if (hit !== null && !WORD.test(at === 0 ? '' : text.charAt(at - 1)) && !WORD.test(text.charAt(at + hit[0].length))) {
      const url = jiraKeyUrl(hit[0], config)
      if (url !== undefined) {
        if (at > from) out.push(part(text.slice(from, at)))
        out.push(part(hit[0], url))
        at += hit[0].length
        from = at
        continue
      }
    }
    at++
  }
  if (from === 0 && out.length === 0) return [segment]
  if (text.length > from) out.push(part(text.slice(from)))
  return out
}

/** `rendered` with record links added where the argument names a record; unchanged otherwise. */
export function withRecordLinks(
  rendered: Rendered,
  arg: { name: string; value: unknown },
  renderer: string | undefined,
  rootField: string,
  config: LinkConfig = configOf(undefined),
): Rendered {
  if (renderer === 'jql') {
    if (rendered.isFallback) return rendered
    return { ...rendered, lines: rendered.lines.map(line => line.flatMap(s => (s.tone === 'value' ? splitKeys(s, config) : [s]))) }
  }
  const { value } = arg
  if (typeof value !== 'string') return rendered
  const url = KEY_ARGS.has(arg.name)
    ? jiraKeyUrl(value, config)
    : serviceOf(rootField) === 'confluence' && PAGE_ARGS.has(arg.name)
      ? confluencePageUrl(value, config)
      : undefined
  const [only] = rendered.lines
  if (url === undefined || rendered.lines.length !== 1 || only?.length !== 1 || only[0] === undefined) return rendered
  return { ...rendered, lines: [[{ ...only[0], url }]] }
}
