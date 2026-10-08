// Which Atlassian site and Slack workspace a person's Agent Services reaches, learned
// from what Agent Services sends back, so record links work with no setup. Pure: no $.
//
// Read vendor metadata URL fields (`self`, `url`, `permalink`, `iconUrl`,
// `_links.base`) under Jira, Confluence or Slack roots. Accept vendor tenant
// hosts: `<name>.atlassian.net` and `<name>.slack.com`. User content and
// model text are excluded. Explicit links.toml values take precedence.

import type { CallIR, FieldIR } from './ir.ts'
import { isRecord } from './guards.ts'
import type { BaseSource } from './links.ts'

/** The named bases (links.toml `[bases]`) a response can teach. */
export type Sites = { atlassian?: string; slack?: string }

/** The bases a response can teach, in the order they are listed. */
export const SITE_KEYS = ['atlassian', 'slack'] as const satisfies readonly (keyof Sites)[]

/** Which base each service's responses can teach. */
const SITE_OF: Readonly<Record<string, keyof Sites>> = { jira: 'atlassian', confluence: 'atlassian', slack: 'slack' }

/** The service the setup question asks for each site (SETUP_QUERY). */
const SETUP_SCOPE: Readonly<Record<keyof Sites, string>> = { atlassian: 'jira', slack: 'slack' }

/** A graph's sites by its services (`search`'s scopes): which it can show, and which the setup question can find. */
export type GraphSites = { shown: (keyof Sites)[]; askable: (keyof Sites)[] }

export function sitesOfGraph(scopes: readonly string[]): GraphSites {
  const shown = SITE_KEYS.filter(site => scopes.some(scope => Object.hasOwn(SITE_OF, scope) && SITE_OF[scope] === site))
  return { shown, askable: SITE_KEYS.filter(site => scopes.includes(SETUP_SCOPE[site])) }
}

/** Each vendor's tenant hosts; the shared ones (the web client, the API, files) are not a tenant. */
const TENANT: Readonly<Record<keyof Sites, RegExp>> = {
  atlassian: /^(?!(?:api|www|status|id|admin|auth|start)\.)[a-z0-9][a-z0-9-]{0,62}\.atlassian\.net$/,
  slack: /^(?!(?:app|api|www|files|slack-files|status|hooks|edgeapi|wss-primary|a)\.)[a-z0-9][a-z0-9-]{0,62}(?:\.enterprise)?\.slack\.com$/,
}

// Where a response names its own site: metadata the vendor writes, never
// content a person wrote. Agent Services reaches Jira through Atlassian's API gateway, so
// every `self` there is on api.atlassian.com (no site), while a status's and a
// priority's `iconUrl` stay on the site itself (live, Oct 7 2026; a status
// Jira Software manages, such as In Review, has its icon on the gateway too,
// so the setup question asks five issues for status and priority). A link in a
// description, a comment, a page body or a Slack message's blocks is someone's
// writing and could name any tenant, so no such subtree is looked into.

/** Subtrees that hold what people wrote: never looked into for a site. */
const CONTENT_KEYS = new Set([
  'description', 'body', 'comment', 'comments', 'content', 'text', 'summary', 'environment', 'renderedFields', 'excerpt',
  'attrs', 'marks', 'storage', 'atlas_doc_format', 'atlasDocFormat', 'view', 'value', 'object',
  'blocks', 'attachments', 'files', 'file', 'elements', 'rich_text', 'unfurl', 'unfurls',
])

/** Objects whose `iconUrl` Jira serves from the site. */
const ICON_OWNERS = new Set(['status', 'priority', 'issuetype'])

/** Whether `key` (under `parent`, at `depth` below the root) is a place the vendor writes its own site. */
function isSiteKey(site: keyof Sites, key: string, parent: string | undefined, depth: number, authTest: boolean): boolean {
  if (site === 'atlassian') return key === 'self' || (key === 'base' && parent === '_links') || (key === 'iconUrl' && parent !== undefined && ICON_OWNERS.has(parent))
  // Slack: the auth test's own `url` (the root object's), and a permalink Slack made for a message.
  return (key === 'url' && depth === 1 && authTest) || key === 'permalink'
}

/** Known metadata containers inside JSON scalars; arbitrary JSON keys are content. */
function metadataKeys(site: keyof Sites, key: string, root: boolean): readonly string[] {
  if (site === 'slack') {
    if (root) return ['url', 'permalink', 'messages', 'message', 'matches']
    if (['messages', 'message', 'matches'].includes(key)) return ['permalink', 'messages', 'matches']
    return []
  }
  if (key === '_links') return ['base']
  if (ICON_OWNERS.has(key)) return ['self', 'iconUrl']
  if (key === 'fields') return [...ICON_OWNERS]
  if (root || ['issues', 'results', 'values'].includes(key)) return ['self', '_links', 'fields', 'issues', 'results', 'values']
  return []
}

/** Conflicting aliases have no trustworthy mapping from response key to field. */
function responseFields(fields: readonly FieldIR[]): FieldIR[] {
  const names = new Map<string, string | undefined>()
  for (const field of fields) {
    const key = field.alias ?? field.name
    if (!names.has(key)) names.set(key, field.name)
    else if (names.get(key) !== field.name) names.set(key, undefined)
  }
  return fields.filter(field => names.get(field.alias ?? field.name) === field.name)
}

/** How much of a response is looked through: enough for any real one, bounded for a huge one. */
const MAX_NODES = 5_000
const MAX_DEPTH = 12

/** `https://<tenant>` when `value` is an https URL on one of `site`'s tenant hosts, with no credentials or port. */
export function tenantOf(site: keyof Sites, value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2_000 || !value.startsWith('https://')) return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') return undefined
  const host = url.hostname.toLowerCase()
  return TENANT[site].test(host) ? `https://${host}` : undefined
}

/**
 * The sites an Agent Services response shows, from the vendor's own metadata under each
 * Jira, Confluence or Slack root's part of `data` (isSiteKey), never from what
 * a person wrote there (CONTENT_KEYS); the first one found for each.
 */
export function sitesIn(ir: CallIR, response: unknown): Sites {
  const found: Sites = {}
  const data = isRecord(response) && isRecord(response.data) ? response.data : undefined
  if (data === undefined) return found
  let nodes = 0
  const look = (site: keyof Sites, value: unknown, key: string, parent: string | undefined, depth: number, authTest: boolean, field?: FieldIR) => {
    if (found[site] !== undefined || nodes++ > MAX_NODES || depth > MAX_DEPTH) return
    // Check the real selected field name, including for scalar strings.
    if (depth > 0 && CONTENT_KEYS.has(key)) return
    if (typeof value === 'string') {
      if (isSiteKey(site, key, parent, depth, authTest)) {
        const tenant = tenantOf(site, value)
        if (tenant !== undefined) found[site] = tenant
      }
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) look(site, item, key, parent, depth + 1, authTest, field)
      return
    }
    if (!isRecord(value)) return
    if (field !== undefined && field.children.length > 0) {
      for (const child of responseFields(field.children)) {
        const responseKey = child.alias ?? child.name
        if (Object.hasOwn(value, responseKey)) look(site, value[responseKey], child.name, key, depth + 1, authTest, child)
      }
    } else {
      // JSON scalars have no field selection. Restrict traversal to known
      // metadata containers; arbitrary nested objects may contain user content.
      for (const inner of metadataKeys(site, key, parent === undefined)) {
        if (Object.hasOwn(value, inner)) look(site, value[inner], inner, key, depth + 1, authTest)
      }
    }
  }
  for (const root of responseFields(ir.roots)) {
    const service = root.service ?? root.name.slice(0, Math.max(0, root.name.indexOf('_')))
    // Own keys only: a root named `constructor_x` or `toString_x` must not reach Object's.
    const site = Object.hasOwn(SITE_OF, service) ? SITE_OF[service] : undefined
    if (site === undefined) continue
    const key = root.alias ?? root.name
    if (Object.hasOwn(data, key)) look(site, data[key], root.name, undefined, 0, /^slack_auth_?test$/i.test(root.name), root)
  }
  return found
}

/**
 * The bases a response may still teach: empty in the shipped file and named by
 * no file of the person's, so nothing is configured and nothing
 * learned. The cheap gate before a response is parsed for a site.
 */
export function learnable(sources: Readonly<Record<string, BaseSource>>): (keyof Sites)[] {
  return SITE_KEYS.filter(site => sources[site] === 'unset')
}

/**
 * Sites read back from storage, each checked again as a response's would be:
 * a stored value that is no longer a vendor tenant host (an edited file, a
 * stricter rule) is dropped, never trusted for having been stored.
 */
export function learnedOf(stored: unknown): Sites {
  const found: Sites = {}
  if (!isRecord(stored)) return found
  for (const site of SITE_KEYS) {
    const tenant = tenantOf(site, stored[site])
    if (tenant !== undefined) found[site] = tenant
  }
  return found
}

/** `yourco.atlassian.net` from a base URL; the text itself when it is not one. */
export function hostOf(base: string): string {
  try {
    return new URL(base).host
  } catch {
    return base
  }
}

/** What each named base is for. */
const BASE_TITLE: Readonly<Record<string, string>> = { atlassian: 'Jira and Confluence', slack: 'Slack', glean: 'Glean' }
/** What a person writes to set one, as an example only. */
const BASE_EXAMPLE: Readonly<Record<string, string>> = { atlassian: 'https://yourco.atlassian.net', slack: 'https://yourco.slack.com', glean: 'https://app.glean.com' }

const SOURCE_WORDS: Readonly<Record<BaseSource, string>> = {
  user: 'from your links.toml',
  off: 'turned off by your links.toml, so no response will teach it',
  shipped: 'the shipped default',
  learned: 'learned from an Agent Services response; /gas links forget clears it',
  unset: 'not set',
}

/**
 * One line for each named base: its value and where it comes from, and for an
 * unset one how to set it. `file` is where the person's links.toml goes.
 */
export function describeBases(bases: Readonly<Record<string, string>>, sources: Readonly<Record<string, BaseSource>>, file: string | undefined): string[] {
  const where = file ?? 'your links.toml'
  return Object.keys(bases).map(name => {
    const source = sources[name] ?? 'user'
    const label = `${name}${Object.hasOwn(BASE_TITLE, name) ? ` (${BASE_TITLE[name]})` : ''}`
    if (source !== 'unset') return `  ${label}: ${bases[name] === '' ? 'no site' : bases[name]} (${SOURCE_WORDS[source]})`
    const example = Object.hasOwn(BASE_EXAMPLE, name) ? BASE_EXAMPLE[name] : 'https://wiki.example.com'
    const learns = (SITE_KEYS as readonly string[]).includes(name) ? ' The first Agent Services response that shows it teaches it.' : ''
    return `  ${label}: not set. Set it with ${name} = "${example}" under [bases] in ${where}.${learns}`
  })
}

const SETUP_QUERY: Readonly<Record<keyof Sites, string>> = {
  atlassian: '`query FindAtlassianSite { jira_searchAndReconsileIssuesUsingJql(jql: "updated >= -365d ORDER BY updated DESC", maxResults: 5, fields: ["status", "priority"]) { issues { fields } } }`',
  slack: '`query FindSlackWorkspace { slack_authTest { url } }`',
}

/**
 * What `/gas setup` puts in the prompt box for the person to send: read-only
 * Agent Services queries whose answers carry their Atlassian site and Slack workspace,
 * one for each of `wanted`. The pane learns the sites from those answers, not
 * from Claude.
 */
export function setupPrompt(wanted: readonly (keyof Sites)[] = SITE_KEYS): string {
  const [only, ...more] = wanted
  if (only !== undefined && more.length === 0) {
    const [what, kind] = only === 'slack' ? ['Slack', 'workspace'] : ['Jira and Confluence', 'site']
    return `Run this read-only GraphOS Agent Services query so the GraphOS Inspector pane can link ${what} records to our ${kind}. Change nothing, and skip it if it fails or needs a sign-in: ${SETUP_QUERY[only]}.`
  }
  return `Run these two read-only GraphOS Agent Services queries, each on its own, so the GraphOS Inspector pane can link Jira, Confluence and Slack records to our sites. Change nothing, and skip one that fails or needs a sign-in: ${SITE_KEYS.map(site => SETUP_QUERY[site]).join(' and ')}.`
}

/** Both questions: what `/gas setup` drafts when neither site is set. */
export const SETUP_PROMPT = setupPrompt(SITE_KEYS)
