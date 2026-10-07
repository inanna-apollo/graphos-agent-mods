// What every part of the pane shares: the element table, the pane's own UI
// state, and small pure helpers. Pure apart from the element table.

import type { Elements, RenderSurface } from 'claude-code'

import { escapeText } from '../escape.ts'
import { LIMIT_ARGS, PLACE_ARGS, isAuxiliaryList, limitOf } from '../guards.ts'
import type { CallIR, FieldIR, OpType } from '../ir.ts'
import type { LinkConfig } from '../links.ts'
import { wordsOf } from '../risk.ts'
import { fallbackHeadline } from '../summary.ts'
import type { AnnotationIndex } from './annotations.ts'
import { isPersonObject } from './personal.ts'
import type { Anchor } from './plan.ts'
import { COLOR, GLYPH } from './ui/theme.ts'

/**
 * The elements the pane draws with. `Button` is optional: without it (or
 * without an `act` callback) the pane draws read-only, as during a prompt.
 */
export type Kit = Pick<Elements[RenderSurface], 'Box' | 'Text' | 'Code'> & {
  Button?: Elements[RenderSurface]['Button']
  /** A link the terminal or surface opens on a click; absent, a URL is drawn as text. */
  Link?: Elements[RenderSurface]['Link']
  /** Markdown whose links a press answers (`onLinkPress`): a record key drawn as a link that a plain click opens. */
  Markdown?: Elements[RenderSurface]['Markdown']
  /** Where the surface runs surface modules (terminal, desktop); absent, live lines draw still. */
  Client?: Elements['terminal' | 'desktop']['Client']
}

/**
 * The pane's own UI state: plain, serializable, reset when a new call arrives.
 * `field` and `arg` hold a field's dry_run path (response keys), which is
 * unique within one call; it is an address, never drawn.
 */
export type PaneUi = {
  /** The field whose drawer is open, by path. */
  field: string | null
  /** The argument shown in full, as `<field path>(<arg name>)`. */
  arg: string | null
  /** null follows live (the pending head, else the newest settled call); N shows `history[N]`. Kept across drawers, reset when a call arrives. */
  cursor: number | null
  /** The RESULT row opened out to all its fields, as `<call id>:<list>:<index>` (src/view/plan.ts rowKey): it never matches another call's row. */
  row: string | null
  /** The RESULT list opened out past its first rows, as `<call id>:<list>` (src/view/plan.ts moreKey). */
  more?: string | null
}

export const CLOSED: PaneUi = { field: null, arg: null, cursor: null, row: null, more: null }

/**
 * A change to the pane's state. `toggleRaw` asks the host to open or close the
 * raw operation pane (not state: the engine knows if it is open); `openUrl`
 * asks it to open a link the pane drew (a deep link, a record, an auth link):
 * a click on a terminal link can fail (tmux strips OSC 8), a press does not. The host checks it against the configured hosts.
 * `draftPrompt` asks it to put text in the prompt box (an access request to send), never to send it.
 * The host does the `$` call.
 */
export type PaneChange = Partial<PaneUi> & { toggleRaw?: true; openUrl?: string; draftPrompt?: string }

export type Act = (change: PaneChange) => void

/** Everything a part of the form needs to draw. */
export type Ctx = {
  kit: Kit
  /** Cells across the body, inside the pane's blank last column; only rules read it. */
  columns: number
  ui: PaneUi
  /** The shown call's id, for addressing a RESULT row opened out (PaneUi.row). */
  callId?: string
  /** Present only when presses can arrive (settled call, Button in the kit). */
  act: Act | undefined
  /** $.clock time the call arrived, for relative dates. */
  now: number
  /** The call has settled: a quieter copy, the outcome glyph the one color per row. */
  isSettled: boolean
  /** The operation's name, for a press that names the call (an access request's draft). */
  opName?: string
  /** Extra rows between sections: 1 off the terminal, where proportional text packs tighter. */
  sectionGap: number
  /** `ViewOptions.surface`. */
  surface?: RenderSurface
  /** Haiku's notes by node, at the level the plan kept (src/view/annotations.ts). */
  pins: AnnotationIndex
  /** Deep-link hosts, for the record links in argument values (src/format/record-links.ts). */
  links?: LinkConfig
  /** The pane's value column (plan.ts valueColumn): every label gutter, so every value starts at one column. */
  column: number
  /**
   * Where the hover cards pop up (src/view/ui/hover.tsx placeOf): each
   * trigger's rows (Plan.anchors) and the rows in view, `top` the first. A
   * card with no anchor is not drawn.
   */
  /** Where hover cards pop up: each trigger's rows, the rows in view, and the pane's total (a card above a trigger counts its bottom edge from the last row). */
  cards?: { anchors: ReadonlyMap<string, Anchor>; top: number; rows: number; total: number }
}

/** Escaped text, capped. Every untrusted string goes through here or a renderer. */
export function esc(value: string, max = 9_000): string {
  return escapeText(value, max).text
}

// Root-name words → the verb the form leads with. From the real name only.
const VERB_WORDS: [string, readonly string[]][] = [
  ['SEARCH', ['search', 'find', 'query', 'lookup']],
  ['LIST', ['list', 'browse', 'enumerate']],
  ['GET', ['get', 'fetch', 'read', 'view', 'show', 'describe', 'retrieve', 'load']],
  ['COUNT', ['count']],
  ['CREATE', ['create', 'add', 'new', 'insert', 'post', 'open']],
  ['UPDATE', ['update', 'edit', 'set', 'modify', 'patch', 'rename', 'move', 'transition', 'assign', 'change', 'upsert']],
  ['DELETE', ['delete', 'remove', 'destroy', 'purge', 'drop', 'wipe', 'erase', 'truncate']],
  ['ARCHIVE', ['archive']],
  ['REVOKE', ['revoke']],
  ['SEND', ['send', 'notify', 'message', 'reply', 'invite']],
  ['WATCH', ['subscribe', 'watch', 'stream', 'listen']],
]

/**
 * The verb word for a root field, from its name's words; none when the name
 * says nothing (the header badge already carries the operation type).
 */
export function verbOf(name: string): string | undefined {
  // Skip the service prefix (`confluence_search` → `search`) only where the name has one: `deleteUser` is all its own words.
  const cut = name.indexOf('_')
  const rest = wordsOf(cut > 0 && cut < name.length - 1 ? name.slice(cut + 1) : name)
  for (const word of rest) {
    const hit = VERB_WORDS.find(([, list]) => list.includes(word))
    if (hit !== undefined) return hit[0]
  }
  return undefined
}

/** Whether a root hands back a list: it is one, or (connection style) one of its children is. */
export function returnsList(root: FieldIR): boolean {
  return root.schema?.isList === true || root.children.some(child => child.schema?.isList === true)
}

const COUNT_NAMES = ['count', 'total', 'totalcount', 'totalsize', 'size']

/**
 * The verb word for a root: its name's own word, else by shape. A list is `LIST`,
 * a lone count-like scalar `COUNT`, any other object `GET`, and `CALL` otherwise
 * (a mutation or subscription without a verb word, or a shape not yet known).
 */
export function rootVerb(root: FieldIR, opType?: OpType): string {
  const named = verbOf(root.name)
  if (named !== undefined) return named
  if (opType === 'mutation' || opType === 'subscription') return 'CALL'
  if (returnsList(root)) return 'LIST'
  const only = root.children.length === 1 ? root.children[0] : undefined
  if (only !== undefined && only.children.length === 0 && COUNT_NAMES.includes(only.name.toLowerCase())) return 'COUNT'
  if (root.schema !== undefined && !root.schema.isList && root.children.length > 0) return 'GET'
  return 'CALL'
}

export { LIMIT_ARGS, PLACE_ARGS, limitOf }

/**
 * The list a root's limit governs: the root itself when it is a list, else
 * the child list the schema names that is not a facet or warning list beside
 * the rows. Undefined when the schema is not read or names none.
 */
export function governedList(root: FieldIR): FieldIR | undefined {
  if (root.schema?.isList === true) return root
  return root.children.find(child => child.schema?.isList === true && !isAuxiliaryList(child.name))
}

/** `[Confluence_SearchResultItem!]!` → `Confluence_SearchResultItem`. */
export function namedType(sdl: string): string {
  return sdl.replace(/[[\]!\s]/g, '')
}

/** What the pane calls an opaque JSON scalar, everywhere it names one: the form, trees, cards and argument kinds. */
export const UNTYPED_JSON = 'untyped JSON'

/** Whether a type is an opaque JSON scalar by its name (`JSON`, `Jira_JSON`), which the schema does not describe. */
export const isJsonName = (sdl: string) => /(?:^|_)JSON$/i.test(namedType(sdl))

/**
 * A GraphQL type as a reader says it: the service prefix dropped and the
 * words split, `[Confluence_SearchResultItem!]` → `search result item`; an
 * opaque JSON scalar is `untyped JSON`. The full type stays in hover cards
 * and the raw view.
 */
export function humanType(sdl: string, scope?: string): string {
  if (isJsonName(sdl)) return UNTYPED_JSON
  // Java-ish wrapper suffixes say nothing to a reader: `Jira_IssueBean` is an issue.
  // `Response` stays: `SearchResponse` is a response, and trimming it would leave `search`.
  const full = namedType(sdl)
  // The service's own scope names the prefix (`acme-customer-data` → `Acme_Customer_Data_`); else the first segment goes.
  const scoped = scope === undefined ? '' : `${scope.replace(/[^A-Za-z0-9]+/g, '_')}_`
  const bare = scoped.length > 1 && full.length > scoped.length && full.toLowerCase().startsWith(scoped.toLowerCase()) ? full.slice(scoped.length) : undefined
  const name = (bare ?? full.replace(/^[A-Za-z][A-Za-z0-9]*_(?=[A-Za-z])/, ''))
    .replace(/(?<=[a-z0-9])(?:Bean|DTO|Dto|Impl)$/, '')
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_]+/)
    .filter(Boolean)
  // Acronyms keep their case (`URL`, `ID`); other words go lower.
  const lowered = words.map(word => (/^[A-Z0-9]+$/.test(word) && word.length > 1 ? word : word.toLowerCase()))
  // The service's own words lead a type that repeats them (`customer data member` in `acme-customer-data` is a `member`).
  const scopeWords = (scope ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  for (let from = 0; from < scopeWords.length; from++) {
    const lead = scopeWords.slice(from)
    if (lowered.length > lead.length && lead.every((word, at) => lowered[at]?.toLowerCase() === word)) return lowered.slice(lead.length).join(' ')
  }
  return lowered.join(' ')
}

/** `search result item` → `search result items`; one count keeps the singular. */
export function humanPlural(words: string, count?: number): string {
  if (count === 1) return words
  if (words === UNTYPED_JSON) return `${UNTYPED_JSON} values`
  if (/[^aeiou]y$/.test(words)) return `${words.slice(0, -1)}ies`
  if (/(s|x|z|ch|sh)$/.test(words)) return `${words}es`
  return `${words}s`
}

/** Nouns whose singular ends in `s`, so their plural adds `es` (`statuses`); a stem is a word of its own or the end of a camelCase one, never the end of `abuses`. */
const S_STEMS = ['status', 'alias', 'bonus', 'campus', 'virus', 'bus', 'focus', 'census', 'corpus', 'canvas', 'atlas', 'bias', 'lens']
const S_PLURAL = new RegExp(`(?:^|[^A-Za-z])(?:${S_STEMS.join('|')})es$|(?:^|[a-z])(?:${S_STEMS.map(stem => `${stem.slice(0, 1).toUpperCase()}${stem.slice(1)}`).join('|')})es$`)

/** `issues` → `issue`, `matches` → `match`, `entries` → `entry`, `statuses` → `status`: a list's name for one of its items. A word that does not end like a plural stays. */
export function humanSingular(words: string): string {
  if (/[^aeiou]ies$/.test(words)) return `${words.slice(0, -3)}y`
  if (/(ss|x|z|ch|sh)es$/.test(words) || S_PLURAL.test(words)) return words.slice(0, -2)
  if (/[^su]s$/.test(words)) return words.slice(0, -1)
  return words
}

/** Every field below and including `fields`, depth first. */
export function walk(fields: readonly FieldIR[]): FieldIR[] {
  return fields.flatMap(field => [field, ...walk(field.children)])
}

/** A restricted field's policy hue; a settled pane dims it (struct), never drops it. */
export function policyColor(field: FieldIR): string | undefined {
  if (field.policy === 'mask') return COLOR.mask
  if (field.policy === 'deny') return COLOR.deny
  return undefined
}

/** The policy glyph drawn before a restricted field's name (`✕ email`, `◐ excerpt`); none when allowed or unknown. */
export function policyMark(field: FieldIR): string | undefined {
  if (field.policy === 'mask') return GLYPH.mask
  if (field.policy === 'deny') return GLYPH.deny
  return undefined
}

/** A field drawer's policy row (src/view/drawers.tsx), which the plan counts too: the glyph, the words, the color. */
export const POLICY_WORDS: Record<FieldIR['policy'], { glyph: string; text: string; color?: string }> = {
  allow: { glyph: GLYPH.allow, text: 'allowed', color: COLOR.allow },
  mask: { glyph: GLYPH.mask, text: 'masked for your role', color: COLOR.mask },
  deny: { glyph: GLYPH.deny, text: 'denied for your role', color: COLOR.deny },
  unknown: { glyph: GLYPH.unknown, text: 'policy unknown' },
}
/** After the drawer's policy words when Agent Services sent a denial token. */
export const TOKEN_NOTE = ' · denial token present (an access request can use it)'

/** Splits summary text on `[[Type.field]]` refs. Text parts are escaped. */
export function refParts(text: string): { text: string; ref?: string }[] {
  const parts: { text: string; ref?: string }[] = []
  const pattern = /\[\[([^\]]{1,200})\]\]/g
  let at = 0
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0
    if (index > at) parts.push({ text: esc(text.slice(at, index), 600) })
    const ref = (match[1] ?? '').trim()
    // Shown as the bare field name; the coordinate addresses the drawer.
    parts.push({ text: esc(ref.slice(ref.lastIndexOf('.') + 1), 200), ref })
    at = index + match[0].length
  }
  if (at < text.length) parts.push({ text: esc(text.slice(at), 600) })
  return parts
}


/**
 * Until Haiku answers: only what the deterministic headline adds beyond the
 * badge and the root line below it, the scale, said humanly (`asks for 10
 * search result items`). Empty when it adds nothing; then no line is drawn.
 */
export function fallbackScale(ir: CallIR): string {
  // A root that is itself a list with no limit: `list of members`, the item type said humanly.
  const root = ir.roots.length === 1 ? ir.roots[0] : undefined
  if (root?.schema?.isList === true && limitOf(root) === undefined) return `list of ${humanPlural(humanType(root.schema.type, ir.service))}`
  const headline = fallbackHeadline(ir)
  const cut = headline.indexOf(' · ')
  if (cut < 0) return ''
  const scale = headline.slice(cut + 3)
  const limited = /^asks for (\d+) × (\S+)$/.exec(scale)
  if (limited !== null) return `asks for ${limited[1]} ${humanPlural(humanType(limited[2] ?? '', ir.service), Number(limited[1]))}`
  return humanType(scale, ir.service)
}

/**
 * The line the headline slot draws while there is no Haiku summary: the
 * scale when the fallback headline has one, else the root field name and
 * the limit (`slack_searchMessages · asks for 4`). Never empty for a parsed call.
 */
export function fallbackLine(ir: CallIR): string {
  const scale = fallbackScale(ir)
  // An unlimited list keeps the root's name beside its scale: the badge says READ, nothing else says which list.
  if (scale.startsWith('list of ')) return `${esc(ir.roots[0]?.name ?? '', 80)} · ${scale}`
  if (scale !== '') return scale
  const names = ir.roots.map(root => esc(root.name, 80)).join(', ')
  const only = ir.roots.length === 1 ? ir.roots[0] : undefined
  const limit = only === undefined ? undefined : limitOf(only)
  return [names, limit === undefined ? '' : `asks for ${limit}`].filter(Boolean).join(' · ') || 'Reading this call…'
}

/** The most omitted arguments a card or drawer lists. */
const MAX_OMITTED = 8

/**
 * Arguments the call left out, one per line as SDL writes an argument:
 * `pageSize: Int = 10`, `cursor: String!`. Escaped. Defaults and required
 * ones alike: the form shows only the defaults.
 */
export function omittedLines(field: FieldIR): string[] {
  return (field.omittedArgs ?? []).slice(0, MAX_OMITTED).map(arg => esc(`${arg.name}: ${arg.type}${arg.default === undefined ? '' : ` = ${arg.default}`}`, 160))
}

/**
 * Whether a hint is a value range (`max 100`, `default 10`), which the main
 * form shows inline. Restrictions (`requires a bounded query`, timezones,
 * `one of` lists) are for the hover card only.
 */
export const rangeHint = (hint: string): boolean => /^(?:max|min|default)\b/i.test(hint.trim())

/** A GraphQL name cut to `max` cells with `…`, so it never wraps mid-identifier. */
export const clipName = (name: string, max: number): string => (name.length <= max ? name : `${name.slice(0, max - 1)}…`)

/** A field's schema hints (`max 100`), escaped. */
export function hintLines(field: FieldIR): string[] {
  return (field.schema?.hints ?? []).slice(0, 4).map(hint => esc(hint, 80))
}

// ---- Descriptions

/** Sentences that are boilerplate in a schema description: links out, scope lists, return notes. */
const BOILERPLATE = /^(?:for\s+more\s+information|scoped\s+oauth\s+requires|returns?\s*:)/i
const stem = (word: string) => word.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/s$/, '')

/**
 * A schema description as one short sentence: the first sentence of the body.
 * A title line that only repeats the purpose (`List incidents` before `List
 * existing incidents.`) is skipped; whitespace is collapsed; boilerplate
 * sentences (`For more information see…`, `Scoped OAuth requires…`,
 * `Returns: …`, any sentence naming scopes) are dropped. Escaped. Undefined
 * when nothing is left. The full text belongs to the hover card.
 */
export function summaryOfDescription(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const paragraphs = esc(raw, 1_200)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .split(/\n\s*\n/)
    .map(paragraph => paragraph.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  const sentencesOf = (paragraph: string) => paragraph.split(/(?<=[.!?])\s+/).filter(sentence => sentence !== '' && !BOILERPLATE.test(sentence) && !/\bscopes?\b/i.test(sentence))
  const bodies = paragraphs.map(sentencesOf)
  const title = paragraphs[0]
  const rest = bodies.slice(1).flat()
  // A title is one short line with no closing punctuation.
  const isTitle = title !== undefined && !/[.!?]$/.test(title) && bodies.length > 1 && rest.length > 0
  if (isTitle) {
    const next = (rest[0] ?? '').split(/\s+/).map(stem)
    const words = title.split(/\s+/).map(stem).filter(Boolean)
    if (words.every(word => next.includes(word))) return rest[0]
  }
  return bodies.flat()[0]
}

// ---- Conditional and opaque fields

/** A dim word after a field's name in its return tree. `isWarn` draws it in the warning color, still dim. */
export type FieldTag = { text: string; isWarn: boolean }

/** Whether the root's `include` argument names `value` (a string, a comma list or a list). */
function includes(root: FieldIR, value: string): boolean {
  const arg = root.args.find(one => one.name === 'include')?.value
  const parts = Array.isArray(arg) ? arg : typeof arg === 'string' ? arg.split(',') : []
  return parts.some(part => String(part).trim() === value)
}

/** The field needs an `include` value the call did not give: its mode and the value. */
export function missingInclude(root: FieldIR, field: FieldIR): { mode: 'only' | 'full'; value: string } | undefined {
  const need = field.schema?.requiresInclude
  return need === undefined || includes(root, need.value) ? undefined : { mode: need.mode, value: need.value }
}

/** The tags a field gets in its return tree: `untyped JSON` for opaque JSON, and how it depends on `include`. Escaped. */
export function tagsOf(root: FieldIR, field: FieldIR): FieldTag[] {
  const tags: FieldTag[] = []
  if (isPersonObject(field)) tags.push({ text: '  person', isWarn: false })
  if (field.schema?.isOpaque === true) tags.push({ text: `  ${UNTYPED_JSON}`, isWarn: false })
  const gap = missingInclude(root, field)
  if (gap !== undefined) {
    const value = esc(gap.value, 40)
    tags.push(gap.mode === 'only' ? { text: ` · only with include=${value}`, isWarn: true } : { text: ` · reference only (full with include=${value})`, isWarn: false })
  }
  return tags
}

/**
 * One denied field an access request's draft asks for: how the person reads
 * it (`` `email` on customer data members ``), and what the denial token said
 * of it (the schema coordinate, the service, the classification, the policy's
 * reason), each escaped where it was kept.
 */
export type RequestItem = { what: string; coord?: string; service?: string; classification?: string; reason?: string }
