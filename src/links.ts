// Native deep links: "open this search in the product", so the person can see
// what the agent's query will see. Pure: no `$`. Hosts come from config, never
// from call data; call data only ever fills the encoded query value.
import { DEFAULT_LINKS_TOML } from './default-links.ts'
import type { CallIR } from './ir.ts'
import { tenantOf } from './sites.ts'
import { tryParseToml } from './toml.ts'
import type { TomlTable } from './toml.ts'

/** One declarative template. */
export type LinkTemplate = {
  label: string
  /** Service scope: the root field's prefix before `_` (`confluence`, `jira`, `glean`, `slack`). */
  service: string
  /** Root field name to match: exact, or a prefix when it ends in `*`. */
  field: string
  /** The argument whose (string) value fills `{value}`. */
  arg: string
  /** A configured base by name. */
  base: string
  /** Must start with `{base}`; `{value}` is replaced by the percent-encoded value. */
  template: string
}

/** A result row's link rule: the value of `field` on the item, when it fully matches `match`, fills `template` after `{base}`. */
export type RecordRule = { service: string; field: string; match?: RegExp; base: string; template: string }

/** Named hosts (an empty one means "none"), operation-level searches, and row rules in priority order. Built by loadLinkConfig. */
export type LinkConfig = { bases: Record<string, string>; searches: LinkTemplate[]; records: RecordRule[] }
export type Link = { label: string; url: string }

export const MAX_URL = 2000
export const MAX_LINKS = 3

/** An https base with no credentials, query or fragment, trailing slashes removed; else undefined. */
export function cleanBase(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const text = raw.trim().replace(/\/+$/, '')
  if (text === '') return undefined
  try {
    const url = new URL(text)
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return undefined
    if (url.href.replace(/\/+$/, '') !== text) return undefined
    return text
  } catch {
    return undefined
  }
}

const MAX_RULES = 64
const BASE_NAME = /^[a-z][a-z0-9_]*$/
const MAX_MATCH = 200

/** `{name}rest` with exactly one `{value}` in rest and no other braces; the base name and the template as `{base}rest`. */
function splitUrl(raw: unknown): { base: string; template: string } | undefined {
  if (typeof raw !== 'string' || raw.length > 500) return undefined
  const m = /^\{([a-z][a-z0-9_]*)\}([^{}]*\{value\}[^{}]*)$/.exec(raw)
  if (m === null || m[1] === 'value' || m[1] === 'base' || m[2]!.split('{value}').length !== 2) return undefined
  return { base: m[1]!, template: `{base}${m[2]}` }
}

const tables = (x: unknown): TomlTable[] => (Array.isArray(x) ? x.filter((t): t is TomlTable => typeof t === 'object' && t !== null && !Array.isArray(t)) : [])
const text = (t: TomlTable, key: string): string | undefined => (typeof t[key] === 'string' && t[key] !== '' ? (t[key] as string) : undefined)

type FileRules = { bases: Record<string, string>; records: RecordRule[]; searches: LinkTemplate[] }

/** One links.toml's contents, bad entries dropped with a problem noted. Base names are checked after the merge. */
function readRules(file: string, source: string, problems: string[]): FileRules | undefined {
  const parsed = tryParseToml(source)
  if (!parsed.ok) {
    problems.push(`${file}: ${parsed.error}`)
    return undefined
  }
  const doc = parsed.value
  const out: FileRules = { bases: {}, records: [], searches: [] }
  const bases = doc.bases
  if (typeof bases === 'object' && bases !== null && !Array.isArray(bases)) {
    for (const [name, raw] of Object.entries(bases)) {
      const clean = raw === '' ? '' : cleanBase(raw)
      if (!BASE_NAME.test(name) || name === 'value' || name === 'base' || clean === undefined) problems.push(`${file}: bad base ${name}`)
      else out.bases[name] = clean
    }
  }
  for (const t of tables(doc.record).slice(0, MAX_RULES)) {
    const url = splitUrl(t.url)
    const service = text(t, 'service')
    const field = text(t, 'field')
    const match = text(t, 'match')
    let re: RegExp | undefined
    if (match !== undefined) {
      try {
        re = match.length <= MAX_MATCH ? new RegExp(`^(?:${match})$`) : undefined
      } catch {
        re = undefined
      }
    }
    if (url === undefined || service === undefined || field === undefined || (match !== undefined && re === undefined) || !/^[\w.-]+$/.test(field) || !/^(\*|[a-z][\w-]*)$/.test(service)) {
      problems.push(`${file}: skipped a [[record]] entry`)
      continue
    }
    out.records.push({ service, field, ...(re !== undefined && { match: re }), ...url })
  }
  for (const t of tables(doc.search).slice(0, MAX_RULES)) {
    const url = splitUrl(t.url)
    const [label, service, root, arg] = ['label', 'service', 'root', 'arg'].map(k => text(t, k))
    if (url === undefined || label === undefined || label.length > 40 || service === undefined || root === undefined || arg === undefined) {
      problems.push(`${file}: skipped a [[search]] entry`)
      continue
    }
    out.searches.push({ label, service, field: root, arg, ...url })
  }
  return out
}

/**
 * Where a named base's value comes from: the person's links.toml,
 * the shipped links.toml, a site learned from an Agent Services response (src/sites.ts), or
 * nowhere (`unset`: empty in the shipped file, so a response may still teach it).
 * `off` is the person's own links.toml setting one to "": turned off, never learned.
 */
export type BaseSource = 'user' | 'off' | 'shipped' | 'learned' | 'unset'

export type LinkSources = {
  /** Text of the shipped links.toml; the embedded copy when absent. */
  shipped?: string
  /** Text of the user's override file, if there is one. */
  user?: string
  /** Sites learned from Agent Services responses (src/sites.ts): each fills only a base no file sets. */
  learned?: Readonly<Record<string, string | undefined>>
}

/**
 * The link configuration: shipped links.toml, then the user's file on top (its
 * [[record]] rules first, its [bases] replacing), then a site learned from a
 * response where neither names one. A bad file or entry is skipped and named in
 * `problems`; nothing throws. `baseSources` says where each named base's value came from.
 */
export function loadLinkConfig(sources: LinkSources = {}): { config: LinkConfig; problems: string[]; baseSources: Record<string, BaseSource> } {
  const problems: string[] = []
  const shipped = readRules('links.toml', sources.shipped ?? DEFAULT_LINKS_TOML, problems)
  const user = sources.user === undefined ? undefined : readRules('your links.toml', sources.user, problems)
  const bases: Record<string, string> = { ...shipped?.bases, ...user?.bases }
  const from: Record<string, BaseSource> = {}
  for (const [name, value] of Object.entries(shipped?.bases ?? {})) from[name] = value === '' ? 'unset' : 'shipped'
  for (const [name, value] of Object.entries(user?.bases ?? {})) from[name] = value === '' ? 'off' : 'user'
  // Only a base nobody set (empty in the shipped file, absent from the person's own): a site the person turned off stays off.
  for (const [name, site] of Object.entries(sources.learned ?? {})) {
    const clean = name === 'atlassian' || name === 'slack' ? tenantOf(name, site) : undefined
    if (clean !== undefined && Object.hasOwn(bases, name) && from[name] === 'unset') {
      bases[name] = clean
      from[name] = 'learned'
    }
  }
  const known = (rule: { base: string }, kind: string) => {
    if (Object.hasOwn(bases, rule.base)) return true
    problems.push(`${kind} uses an undefined base {${rule.base}}`)
    return false
  }
  const records = [...(user?.records ?? []), ...(shipped?.records ?? [])].filter(rule => known(rule, '[[record]]'))
  const searches = [...(shipped?.searches ?? []), ...(user?.searches ?? [])].filter(rule => known(rule, '[[search]]'))
  return { config: { bases, searches, records }, problems, baseSources: from }
}

/** The configuration from link files and learned sites. */
export function configOf(sources: LinkSources = {}): LinkConfig {
  return loadLinkConfig(sources).config
}

function matches(t: LinkTemplate, rootName: string): boolean {
  const named = t.field.endsWith('*') ? rootName.startsWith(t.field.slice(0, -1)) : rootName === t.field
  const cut = rootName.indexOf('_')
  return named && cut > 0 && rootName.slice(0, cut) === t.service
}

/** A lone surrogate (half of a pair, as a model can write one): encodeURIComponent throws on it, and a link is worked out while the pane draws. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g

/** encodeURIComponent, plus `'` (which URL parsing would otherwise rewrite to %27, breaking the round trip). A lone surrogate becomes U+FFFD, so this never throws. */
export function encode(value: string): string {
  return encodeURIComponent(value.replace(LONE_SURROGATE, '\ufffd')).replace(/'/g, '%27')
}

function resolveBase(base: string, config: LinkConfig): string | undefined {
  return Object.hasOwn(config.bases, base) ? cleanBase(config.bases[base]) : undefined
}

function build(t: { base: string; template: string }, value: string, config: LinkConfig): string | undefined {
  const base = resolveBase(t.base, config)
  if (base === undefined || value === '') return undefined
  // Worked out while the pane draws, from text a model wrote: whatever it holds, no link rather than a throw.
  try {
    const url = t.template.replace(/\{base\}|\{value\}/g, m => (m === '{base}' ? base : encode(value)))
    if (url.length > MAX_URL) return undefined
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || parsed.href !== url || parsed.origin !== new URL(base).origin) return undefined
    return url
  } catch {
    return undefined
  }
}

/** Links for a call: built-ins then extras, each over the roots in order; at most 3, de-duplicated. */
export function linksOf(ir: CallIR, config: LinkConfig = configOf()): Link[] {
  const out: Link[] = []
  const seen = new Set<string>()
  for (const t of config.searches) {
    for (const root of ir.roots) {
      if (!matches(t, root.name)) continue
      const arg = root.args.find(a => a.name === t.arg)
      if (arg === undefined || typeof arg.value !== 'string') continue
      const url = build(t, arg.value, config)
      if (url === undefined || seen.has(url)) continue
      seen.add(url)
      out.push({ label: t.label, url })
      if (out.length >= MAX_LINKS) return out
    }
  }
  return out
}

// ---- Record links: "open this row", for the items a call returned.

/** Keys of a returned record whose value is a URL to open, trusted only on a configured host. */
const URL_KEYS = ['url', 'webUrl', 'permalink', 'htmlUrl', 'html_url', 'webViewLink', 'webLink', 'web_url'] as const
const MAX_VALUE = 200

/** The service a root field belongs to: its prefix before `_`. */
export const serviceOf = (rootName: string): string => {
  const cut = rootName.indexOf('_')
  return cut > 0 ? rootName.slice(0, cut) : ''
}

/** The origins the person configured: every named base that is set. */
export function allowedOrigins(config: LinkConfig): Set<string> {
  const origins = new Set<string>()
  for (const raw of Object.values(config.bases)) {
    const base = cleanBase(raw)
    if (base !== undefined) origins.add(new URL(base).origin)
  }
  return origins
}

/** `raw` when it is a canonical https URL (round-trips unchanged), no credentials, within MAX_URL, on a configured origin; else undefined. */
export function openableUrl(raw: unknown, config: LinkConfig): string | undefined {
  if (typeof raw !== 'string' || raw.length > MAX_URL) return undefined
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.href !== raw) return undefined
    return allowedOrigins(config).has(url.origin) ? raw : undefined
  } catch {
    return undefined
  }
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)

/** `a.b` on the item: a flat key of that exact name first (previews keep `fields.key` flat), else a walk down nested objects. */
function valueAt(item: Record<string, unknown>, path: string): unknown {
  if (Object.hasOwn(item, path)) return item[path]
  let at: unknown = item
  for (const part of path.split('.')) {
    if (!isRecord(at) || !Object.hasOwn(at, part)) return undefined
    at = at[part]
  }
  return at
}

/** The URL of a record's own value (the configured host); undefined when no rule fits. */
function ruleLink(service: string, item: Record<string, unknown>, config: LinkConfig): string | undefined {
  for (const rule of config.records) {
    if (rule.service !== '*' && rule.service !== service) continue
    const raw = valueAt(item, rule.field)
    const value = typeof raw === 'string' ? raw : typeof raw === 'number' && Number.isSafeInteger(raw) ? String(raw) : ''
    if (value === '' || value.length > MAX_VALUE || (rule.match !== undefined && !rule.match.test(value))) continue
    const url = build(rule, value, config)
    if (url !== undefined) return url
  }
  return undefined
}

/** The URL of a Jira issue key on the configured Atlassian site, or undefined. */
export function jiraKeyUrl(key: string, config: LinkConfig = configOf()): string | undefined {
  return ruleLink('jira', { key }, config)
}

/** The URL of a Confluence page id on the configured Atlassian site, or undefined. */
export function confluencePageUrl(id: string | number, config: LinkConfig = configOf()): string | undefined {
  return ruleLink('confluence', { id: String(id) }, config)
}

/**
 * Where one returned record opens. A [[record]] rule over the record's own
 * field first (the host is a configured base); else a URL the response gave,
 * only if it is canonical https on a configured origin. Response data never
 * picks the host.
 */
export function recordLinkOf(service: string, item: Record<string, unknown>, config: LinkConfig = configOf()): string | undefined {
  const own = ruleLink(service, item, config)
  if (own !== undefined) return own
  for (const key of URL_KEYS) {
    const url = openableUrl(item[key], config)
    if (url !== undefined) return url
  }
  const webui = valueAt(item, '_links.webui')
  if (typeof webui === 'string' && webui.startsWith('/') && !webui.startsWith('//')) {
    const site = config.bases.atlassian
    return site === undefined ? undefined : openableUrl(`${site}/wiki${webui}`, config)
  }
  return undefined
}

/** The parts of a stored preview item that link matching reads (CallOutcome.preview items). */
export type PreviewLinkItem = { label?: string; raw?: Record<string, string>; fields?: { name: string; value?: string }[]; url?: string }

const ID_LIKE = /^[A-Za-z][A-Za-z0-9_]*-\d+$/

/**
 * The link for a stored preview item, worked out now from the current config:
 * the item's kept raw fields, else (outcomes stored before `raw` existed) its
 * selected `fields`, and an id-like label standing as `key`. The stored `url`
 * is a last resort, accepted only if still on a configured origin.
 */
export function previewLinkOf(service: string, item: PreviewLinkItem, config: LinkConfig = configOf()): string | undefined {
  const record: Record<string, unknown> = { ...item.raw }
  for (const field of item.fields ?? []) if (field.value !== undefined && !Object.hasOwn(record, field.name)) record[field.name] = field.value
  if (typeof item.label === 'string' && ID_LIKE.test(item.label) && !Object.hasOwn(record, 'key')) record.key = item.label
  return recordLinkOf(service, record, config) ?? openableUrl(item.url, config)
}
