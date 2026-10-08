// The RESULT section's lines, from a settled call's outcome. Pure: no $, no
// JSX. Everything here is response content: escaped, and only counts, codes,
// paths and https link URLs ever come out of src/result.ts.

import { leafPolicyCounts } from '../annotate.ts'
import { isAuxiliaryList, own } from '../guards.ts'
import type { CallIR, CallOutcome, FieldIR } from '../ir.ts'
import { configOf, previewLinkOf, serviceOf } from '../links.ts'
import type { LinkConfig } from '../links.ts'
import { emojify } from '../emoji.ts'
import { decodeEntities } from '../entities.ts'
import { esc, humanPlural, humanSingular, humanType, limitOf } from './kit.ts'
import type { RequestItem } from './kit.ts'
import { receiptOf } from './receipt.ts'
import { confirmText } from '../preview/confirm.ts'

/**
 * A row's words as drawn: a web page's `&quot;` as `"`, then escaped, then
 * `:fire:` as the emoji (after escaping, which would show a ZWJ as an escape).
 */
const said = (text: string, max: number) => emojify(esc(decodeEntities(text), max))

export type ResultLine =
  /** `10 of 3,766 results`: rows returned, the total when the response has one, then the list's items in words; `note` is dim after it. */
  | { kind: 'rows'; field: string; text: string; note?: string; /** More rows than the call's limit argument asked for: drawn in the warning tone. */ isWarn?: boolean; /** `field` is a root's alias or name heading its group (several roots). */ isHead?: boolean }
  /** A look at what the list returned: `label  text  extra` rows, then `… N more`. Escaped. */
  | {
      kind: 'preview'
      /** The list's length: shown rows and `more`. */
      size?: number
      field: string
      /** The response key of the root the list is under, when the outcome kept it: keys and hover scopes stay apart when two roots' lists share a field name. */
      root?: string
      /** One of the list's items in words (`issue`, `member`), for a row's card. */
      one: string
      items: PreviewItem[]
      /** Each shown item's place in the list as the response had it (0-based); an item with no label was skipped, so this is not its number among those shown. */
      at?: number[]
      more: number
      /** Set by the planner: kept rows past those shown can be opened out (`more`), or are (`less`), by the toggle row's press. */
      expand?: 'more' | 'less'
    }
  /** A scalar the response carried: `count  42`. */
  | { kind: 'scalar'; field: string; text: string; /** Nothing to report (a root that came back null, or a null that is all a root selected): drawn dim. */ isDim?: boolean }
  /** A GraphQL error: `CODE at path · message`; a policy denial reads `denied: path`. */
  | {
      kind: 'error'
      isDenied: boolean
      text: string
      /** A denial's own words (`realName denied in all 8 items`), and its classification (`require-approval`), apart from `text`. */
      head?: string
      facts?: string
      /** A requestable denial's field and what its token said, escaped: settled and pressable, the line offers `request access` for it. */
      request?: RequestItem
    }
  /** UPSTREAM_AUTH_REQUIRED: the service to link and where. `url` is null unless it is a canonical https URL; `host` is shown beside the label. */
  | { kind: 'auth'; service: string; url: string | null; text: string; host?: string }
  /** The context receipt (src/view/receipt.ts), RESULT's last line, dim: `58 KB · about 14k tokens · description 71%`. Its card lists the heavy fields. */
  | { kind: 'weight'; text: string }
  /** What the response said back of a write's new values (src/preview/confirm.ts): `title On-call runbook ✓ · version 13 ✓`. Escaped. */
  | { kind: 'confirm'; parts: { text: string; state: 'same' | 'differs' | 'new'; label: string; value?: string }[] }

/** One shown row; `denied` are the policy-denied fields inside it, escaped. */
export type PreviewItem = {
  label: string
  /** What the label is a key for, shown after it. */
  text?: string
  extra?: string
  url?: string
  denied?: { field: string; classification?: string; isRequestable?: boolean }[]
  /** For the hover card: every selected field in order; a denied one has `denial` and no value. */
  fields?: { name: string; value?: string; denial?: { classification?: string; isRequestable?: boolean } }[]
}

function fieldsShown(item: NonNullable<CallOutcome['preview']>[number]['items'][number]): PreviewItem['fields'] {
  const denied = new Map((item.denied ?? []).map(one => [one.field, one] as const))
  const listed = (item.fields ?? []).map(one => {
    const tag = denied.get(one.name)
    denied.delete(one.name)
    return {
      name: esc(one.name, 120),
      ...(tag === undefined && one.value !== undefined && { value: said(one.value, 256) }),
      ...(tag !== undefined && { denial: { ...(tag.classification !== undefined && { classification: esc(tag.classification, 20) }), ...(tag.isRequestable !== undefined && { isRequestable: tag.isRequestable }) } }),
    }
  })
  const rest = [...denied.values()].map(tag => ({
    name: esc(tag.field, 120),
    denial: { ...(tag.classification !== undefined && { classification: esc(tag.classification, 20) }), ...(tag.isRequestable !== undefined && { isRequestable: tag.isRequestable }) },
  }))
  return [...listed, ...rest].slice(0, 12)
}

const MESSAGE = 600
const GLYPH_SEP = ' · '

/** `3766` → `3,766`. */
export function grouped(count: number): string {
  return String(Math.trunc(count)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** An https URL exactly as `new URL` writes it, else null: a bad Link would refuse the whole tree. */
export function safeHttps(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.href === url ? url : null
  } catch {
    return null
  }
}

/** How many rows a list returned past the limit argument its root was given (`pageSize: 3`); undefined when it kept to it. */
export function overLimit(outcome: CallOutcome | undefined, ir: CallIR | undefined, root: FieldIR): { asked: number; got: number } | undefined {
  const asked = Array.isArray(root.args) ? limitOf(root) : undefined
  if (asked === undefined) return undefined
  // The rows are the root's main list (src/result.ts); a facet list that is all the call selected is not what the limit governs.
  const row = outcome?.rows.find(one => ownerOf([root], one) !== undefined)
  return row !== undefined && !isAuxiliaryList(row.field) && row.count > asked ? { asked, got: row.count } : undefined
}

/** Past what src/result.ts keeps of a row's label and summary (1,000 characters), escapes included: they are wrapped when drawn, not cut again. */
const LABEL = 2000
/** What a rows line says when no paging argument was set. */
export const FIRST_PAGE = 'first page'

/** Boolean fields that say whether more rows remain, and what `true` means. */
const MORE_FLAGS: Record<string, boolean> = { more: true, hasMoreResults: true, hasNextPage: true, isLast: false }

/** `more` / `hasMoreResults` / `hasNextPage` / `isLast` as words, from a boolean scalar; undefined for any other. */
function moreWords(scalar: { field: string; value: unknown }): { words: string; short: string } | undefined {
  const meaning = own(MORE_FLAGS, scalar.field)
  if (meaning === undefined || typeof scalar.value !== 'boolean') return undefined
  return scalar.value === meaning ? { words: 'more results available', short: 'more available' } : { words: 'last page', short: 'last page' }
}

/** A scalar as the response wrote it: whole numbers grouped, the rest as is. */
function scalarText(value: number | boolean | null | string): string {
  if (typeof value === 'number') return Number.isInteger(value) ? grouped(value) : String(value)
  if (typeof value === 'string') return esc(value, 300)
  return String(value)
}

/** The root whose list a `rows` entry came from: the root itself, or the parent of a connection's list. */
function rootOfList(roots: readonly FieldIR[], field: string): FieldIR | undefined {
  return roots.find(root => root.name === field) ?? roots.find(root => root.children.some(child => child.name === field))
}

/**
 * The root a stored list (a `rows` or `preview` entry) is under: by the
 * root's response key, which tells apart two roots whose lists share a field
 * name; in an outcome stored before lists kept it, by the list's field name.
 */
export function ownerOf(roots: readonly FieldIR[], list: { field: string; root?: string }): FieldIR | undefined {
  return list.root !== undefined ? roots.find(root => root.path === list.root) : rootOfList(roots, list.field)
}

/**
 * The root a scalar's `root` key names: the root with that response key; in an
 * outcome stored before scalars kept it, one whose real name is the key
 * (the first, when aliases share it).
 */
export function rootOfKey(roots: readonly FieldIR[], key: string | undefined): FieldIR | undefined {
  return key === undefined ? undefined : (roots.find(root => root.path === key) ?? roots.find(root => root.name === key))
}

const OFFSET_NAMES = ['offset', 'start', 'startAt']

/** A response field that only repeats what the call said: described as an echo, or equal to the same-named argument (an unset offset that is 0 counts). */
function isEcho(field: FieldIR | undefined, root: FieldIR | undefined, value: unknown): boolean {
  if (field === undefined) return false
  if (/^\s*echoes\b/i.test(field.schema?.description ?? '')) return true
  const arg = root?.args.find(one => one.name === field.name)
  if (arg !== undefined) return arg.value === value || String(arg.value) === String(value)
  // Unset by the call: known omitted from the schema, or (no schema yet) simply not among its arguments.
  return OFFSET_NAMES.includes(field.name) && (value === 0 || value === '0') && root !== undefined && !root.args.some(one => one.name === field.name)
}

/**
 * The scalars worth a line, against the call's IR as it is now: an echo (described
 * `Echoes…`, or equal to its same-named argument, or an unset offset of 0) and a null
 * that is not the root's only selection are left out. The outcome keeps them all, so a
 * later schema (enrichment) changes what is hidden.
 */
export function shownScalars(outcome: CallOutcome, ir?: CallIR): NonNullable<CallOutcome['scalars']> {
  return (outcome.scalars ?? []).filter(scalar => {
    if (scalar.root === undefined) return true
    if (scalar.value === null && scalar.isOnly !== true) return false
    const root = ir === undefined ? undefined : rootOfKey(ir.roots, scalar.root)
    const field = root?.children.find(one => (scalar.path === undefined ? one.name === scalar.field : one.path === scalar.path))
    return !isEcho(field, root, scalar.value)
  })
}

const isIndex = (segment: string) => /^\d+$/.test(segment)

/**
 * An outcome settled before denials were put on their rows (its errors keep
 * paths like `members.0.email` and its preview items no `denied`), told the
 * way a new one is: a denied error inside a shown row becomes a tag on that
 * row and leaves the standalone lines, by the rules src/result.ts tags with
 * at settle time (the list by its response path, the field by real names
 * below it, at most 4 tags a row). Anything else is left as it is; the
 * stored outcome is never changed.
 */
export function attributed(outcome: CallOutcome, ir?: CallIR): CallOutcome {
  const preview = outcome.preview
  if (preview === undefined || preview.length === 0 || !outcome.errors.some(error => error.isDenied === true && error.path !== undefined && error.path.split('.').some(isIndex))) return outcome
  const all = (fields: readonly FieldIR[]): FieldIR[] => fields.flatMap(field => [field, ...all(field.children)])
  const fields = ir === undefined ? [] : all(ir.roots)
  const nameAt = (path: string, fallback: string) => fields.find(field => field.path === path)?.name ?? fallback
  const lists = preview.map(list => ({ ...list, items: list.items.map(item => ({ ...item, ...(item.denied !== undefined && { denied: [...item.denied] }) })) }))
  const errors = outcome.errors.filter(error => {
    if (error.isDenied !== true || error.path === undefined) return true
    const segments = error.path.split('.')
    const at = segments.findIndex(isIndex)
    if (at < 1 || at === segments.length - 1) return true
    const listPath = segments.slice(0, at).join('.')
    const listName = nameAt(listPath, segments[at - 1] ?? '')
    const list = lists.find(one => (one.root === undefined || one.root === segments[0]) && (one.field === listName || one.field === segments[at - 1]))
    // The error's index is the response's; an item with no label was skipped, so the kept items say where each came from.
    const index = Number(segments[at])
    const item = list?.items[list.at === undefined ? index : list.at.indexOf(index)]
    if (item === undefined) return true
    const rest = segments.slice(at + 1).filter(segment => !isIndex(segment))
    const field = rest.map((key, k) => nameAt([listPath, ...rest.slice(0, k + 1)].join('.'), key)).join('.')
    const denied = item.denied ?? []
    if (!denied.some(one => one.field === field)) {
      if (denied.length >= 4) return true
      item.denied = [...denied, { field, ...(error.classification !== undefined && { classification: error.classification }), ...(error.isRequestable !== undefined && { isRequestable: error.isRequestable }), ...(error.hasToken === true && { hasToken: true }) }]
    }
    return false
  })
  return { ...outcome, errors, preview: lists }
}

/**
 * Where a denial sits among a list's items: ` in 3 of 8 items`, ` in all 12
 * items`, ` in 5 items` when the list's length is not known, nothing for a
 * single item of one (or of an unknown list).
 */
export function itemsWords(count: number, of?: number): string {
  if (count <= 1 && (of === undefined || of <= 1)) return ''
  return of === undefined ? ` in ${grouped(count)} items` : count >= of ? ` in all ${grouped(of)} items` : ` in ${grouped(count)} of ${grouped(of)} items`
}

/** A verb a list root's name leads with, which the noun drops: `listOrganizationMembers` → `organization members`. */
const LEADING_VERB = /^(list|search|get|fetch|find|query|lookup|read) /

/** A list root's own name in words, its service prefix and leading verb gone: `incidentio_incidentUpdates` → `incident updates`. */
function rootNoun(root: FieldIR, service: string | undefined): string {
  const words = humanType(root.name, root.service ?? service).replace(LEADING_VERB, '')
  return words.trim() === '' ? root.name : words
}

/**
 * Errors and links first and never shed; then per list its rows line (with
 * `first page` when the call set no paging argument) and a short preview of
 * the rows, then the scalars. The rows lines are the first to go.
 */
export function resultLines(stored: CallOutcome | undefined, ir?: CallIR, links: LinkConfig = configOf()): ResultLine[] {
  if (stored === undefined) return []
  const outcome = attributed(stored, ir)
  const lines: ResultLine[] = []
  // An unreadable or too-large response is a flag (src/view/flags.ts): RESULT does not say it again.
  for (const error of outcome.errors) {
    // A field by its real name, whole (the line wraps); never the whole path.
    const last = error.field ?? error.path?.split('.').filter(segment => segment !== '*').pop()
    const name = last === undefined || last === '' ? undefined : esc(last, 120)
    const items = itemsWords(error.count ?? 1, error.of)
    if (error.isDenied === true) {
      const facts = [
        error.classification === undefined ? '' : esc(error.classification, 20),
        error.isRequestable === undefined ? '' : error.isRequestable ? 'requestable' : 'not requestable',
      ].filter(Boolean)
      const head = name === undefined ? 'denied' : `${name} denied${items}`
      const classification = error.classification === undefined ? '' : esc(error.classification, 20)
      lines.push({
        kind: 'error',
        isDenied: true,
        text: [head, ...facts].join(GLYPH_SEP),
        head,
        facts: classification,
        ...(error.isRequestable === true &&
          name !== undefined && {
            request: {
              what: `\`${name}\``,
              ...(error.coord !== undefined && { coord: esc(error.coord, 200) }),
              ...(error.service !== undefined && { service: esc(error.service, 63) }),
              ...(classification !== '' && { classification }),
              ...(error.reason !== undefined && { reason: esc(error.reason, 300) }),
            },
          }),
      })
      continue
    }
    const where = [error.code === undefined ? '' : esc(error.code, 120), name === undefined ? '' : `at ${name}${items}`].filter(Boolean).join(' ')
    const message = esc(error.message.replace(/\s+/g, ' ').trim(), MESSAGE)
    lines.push({ kind: 'error', isDenied: false, text: [where, message].filter(Boolean).join(' · ') })
  }
  for (const link of outcome.authLinks) {
    const service = esc(link.service, 120)
    const url = safeHttps(link.url)
    const host = url === null ? undefined : esc(new URL(url).host, 253)
    lines.push({ kind: 'auth', service, url, text: `link ${service}`, ...(host !== undefined && { host }) })
  }
  // A write's confirmations first: what came back of what it set. A scalar a confirmation says is not said again.
  const confirms = outcome.confirms ?? []
  if (confirms.length > 0) lines.push({ kind: 'confirm', parts: confirms.map(one => ({ text: confirmText(one), state: one.state, label: one.label, ...(one.value !== undefined && one.value !== '' && { value: one.value }) })) })
  const confirmed = new Set(confirms.flatMap(one => (one.path === undefined ? [] : [one.path])))
  const scalars = shownScalars(outcome, ir).filter(scalar => scalar.path === undefined || !confirmed.has(scalar.path))
  const flags = scalars.flatMap(scalar => {
    const words = moreWords(scalar)
    return words === undefined ? [] : [{ scalar, ...words }]
  })
  const joined = new Set<(typeof flags)[number]>()
  // With several roots every block is headed by its alias (else its name) and the blocks follow the operation's root order.
  const isMulti = (ir?.roots.length ?? 0) > 1
  // A list knows its root (ownerOf); a scalar, by the root's response key (rootOfKey).
  const rootAt = (root: FieldIR | string | undefined) => (root === undefined || ir === undefined ? -1 : ir.roots.indexOf((typeof root === 'string' ? rootOfKey(ir.roots, root) : root) as FieldIR))
  const headOf = (root: FieldIR | string | undefined) => {
    const found = ir?.roots[rootAt(root)]
    return isMulti && found !== undefined ? esc(found.alias ?? found.name, 120) : undefined
  }
  const blocks: { at: number; lines: ResultLine[] }[] = []
  for (const row of outcome.rows) {
    const block: ResultLine[] = []
    const owning = ir === undefined ? undefined : ownerOf(ir.roots, row)
    blocks.push({ at: rootAt(owning), lines: block })
    const field = esc(row.field, 120)
    const count = row.count === 0 ? 'none' : grouped(row.count)
    const isFirstPage = owning?.paging?.isFirstPage === true && row.count > 0
    const flag = flags.find(one => !joined.has(one) && (one.scalar.root === undefined || (ir !== undefined && owning !== undefined && rootOfKey(ir.roots, one.scalar.root) === owning)))
    if (flag !== undefined) joined.add(flag)
    const over = owning === undefined ? undefined : overLimit(outcome, ir, owning)
    // More than the limit asked for is a flag; here the number alone takes the warning tone.
    const note = [isFirstPage ? FIRST_PAGE : '', flag?.short ?? ''].filter(Boolean).join(GLYPH_SEP)
    const base = row.total === undefined || (row.total === 0 && row.count === 0) ? count : `${count} of ${grouped(row.total)}`
    // The items in words after the number they follow: the root's own item type when the root is the list (`4 members`), else the list's name (`5 issues`, `1 issue`).
    const isOwnList = owning !== undefined && owning.name === row.field
    const type = isOwnList && owning.schema?.isList === true ? humanType(owning.schema.type, owning.service ?? ir?.service) : ''
    // With no schema (the checks could not run), a root that is the list says its own name in words, not `incidentio_incidentUpdates`.
    const plain = isOwnList && type === '' ? rootNoun(owning, ir?.service) : row.field
    const number = row.total ?? row.count
    const named = type === '' ? esc(number === 1 ? humanSingular(plain) : plain, 120) : esc(humanPlural(type, number), 120)
    const head = headOf(owning)
    // Under a head, the noun once: `open  5 issues`, and `members  4` where the head already names the items in either number (`members` heads `1 member`).
    const words = type === '' ? [plain, humanSingular(plain)] : [humanPlural(type), type]
    const isSaid = head !== undefined && words.some(word => esc(word, 120).toLowerCase() === head.toLowerCase())
    // Nothing back says `no issues`; none of a total says `none of 12 issues`.
    const text = isSaid ? base : base === 'none' ? `no ${named}` : `${base} ${named}`
    block.push({ kind: 'rows', field: head ?? '', text, ...(head !== undefined && { isHead: true }), ...(note !== '' && { note }), ...(over !== undefined && { isWarn: true }) })
    const shown = outcome.preview?.find(one => one.field === row.field && one.root === row.root)
    if (shown !== undefined && shown.items.length > 0) {
      block.push({
        kind: 'preview',
        size: shown.items.length + shown.more,
        field,
        ...(row.root !== undefined && { root: esc(row.root, 120) }),
        one: type === '' ? esc(humanSingular(plain), 120) : esc(type, 120),
        ...(shown.at !== undefined && { at: shown.at }),
        items: shown.items.map(item => {
          // The record's link from links.toml as it stands now, so an edit to the rules reaches calls stored before it.
          const url = previewLinkOf(serviceOf(owning?.name ?? row.field), item, links)
          return {
            label: said(item.label.replace(/\s+/g, ' ').trim(), LABEL),
            ...(item.text !== undefined && item.text !== '' && { text: said(item.text.replace(/\s+/g, ' ').trim(), LABEL) }),
            ...(item.extra !== undefined && item.extra !== '' && { extra: said(item.extra.replace(/\s+/g, ' ').trim(), LABEL) }),
            ...(((item.fields?.length ?? 0) > 0 || (item.denied?.length ?? 0) > 0) && { fields: fieldsShown(item) }),
            ...(item.denied !== undefined && item.denied.length > 0 && {
              denied: item.denied.slice(0, 4).map(one => ({
                field: esc(one.field, 120),
                ...(one.classification !== undefined && { classification: esc(one.classification, 20) }),
                ...(one.isRequestable !== undefined && { isRequestable: one.isRequestable }),
              })),
            }),
            ...(url !== undefined && { url }),
          }
        }),
        more: shown.more,
      })
    }
  }
  for (const scalar of scalars) {
    const flag = flags.find(one => one.scalar === scalar)
    const owner = scalar.root ?? scalar.path ?? scalar.field
    const head = headOf(owner)
    const block: ResultLine[] = []
    blocks.push({ at: rootAt(owner), lines: block })
    // A root that came back null, or a null that is a root's only selection, says so; it is not a value.
    const isNone = scalar.value === null && (scalar.root === undefined || scalar.isOnly === true)
    const text = isNone ? 'none returned' : scalarText(scalar.value)
    // The root's only field under its head says the value alone: `total  412`.
    const field = head === undefined ? esc(scalar.field, 120) : scalar.root === undefined || scalar.isOnly === true ? head : `${head}  ${esc(scalar.field, 120)}`
    if (flag === undefined) block.push({ kind: 'scalar', field, text, ...(isNone && { isDim: true }) })
    else if (!joined.has(flag)) block.push({ kind: 'scalar', field: head ?? '', text: flag.words })
  }
  // Root order, stable: lines of one root keep the order they were made in; unknown roots (-1) go last.
  const order = (at: number) => (at < 0 ? Number.MAX_SAFE_INTEGER : at)
  const sorted = isMulti ? blocks.map((block, index) => ({ ...block, index })).sort((a, b) => order(a.at) - order(b.at) || a.index - b.index) : blocks
  for (const block of sorted) lines.push(...block.lines)
  // What the response cost in context closes RESULT: a result Claude Code kept out of it says so here even when there is nothing else to show.
  const receipt = receiptOf(outcome, ir)
  if (receipt !== undefined) lines.push({ kind: 'weight', text: receipt.line })
  return lines
}

/** Real failures in a response: a policy denial is shown as denied and is never one. */
export function failureCount(outcome: CallOutcome | undefined): number {
  return (outcome?.errors ?? []).reduce((sum, error) => sum + (error.isExpected === true || error.isDenied === true ? 0 : (error.count ?? 1)), 0)
}

/** Whether Agent Services denied anything in the response: an error, a tag on a shown row, or a counted denial. */
export function hasDenials(outcome: CallOutcome | undefined): boolean {
  if (outcome === undefined) return false
  return outcome.errors.some(error => error.isDenied === true) || (outcome.denials?.length ?? 0) > 0 || (outcome.preview ?? []).some(list => list.items.some(item => (item.denied?.length ?? 0) > 0))
}

/**
 * The call ran and Agent Services answered it as valid: a readable response with no
 * validation error, or one Claude Code kept out of the context for its size (a
 * response that big was no validation error). A validation that predicted failure
 * (a schema checked mid-change) is then stale, and the pane stops saying the call will fail.
 */
export function ranValid(outcome: CallOutcome | undefined): boolean {
  return outcome !== undefined && (outcome.isUnreadable !== true || outcome.isTooLarge === true) && !outcome.errors.some(error => /VALIDATION|GRAPHQL_PARSE/i.test(error.code ?? ''))
}

/**
 * Whether the pane may say every field is allowed: policy allowed each one
 * it checked and none is unchecked, the call will not fail validation, the
 * operation is not refused, and (once it ran) Agent Services denied nothing the policy
 * check did not predict.
 */
export function isAllAllowed(ir: CallIR, outcome?: CallOutcome): boolean {
  const counts = leafPolicyCounts(ir.roots)
  return counts.allow > 0 && counts.mask + counts.deny + counts.unknown === 0 && (ranValid(outcome) || (ir.state !== 'invalid' && ir.validation?.valid !== false)) && ir.isOperationDenied !== true && !hasDenials(outcome)
}

/**
 * Whether the policy row says `✓ write allowed`: a mutation whose roots Agent Services
 * allows, with nothing it returns masked or denied (in the policy check or,
 * once it ran, the response). The decision on the write is what matters, not
 * a count of the fields it returns. A root with no decision of its own is
 * allowed when every field in it is.
 */
export function isWriteAllowed(ir: CallIR, outcome?: CallOutcome): boolean {
  if (ir.opType !== 'mutation' || ir.roots.length === 0 || ir.isOperationDenied === true || hasDenials(outcome)) return false
  const counts = leafPolicyCounts(ir.roots)
  if (counts.mask + counts.deny > 0) return false
  const isAllowed = (root: FieldIR) => {
    if (root.policy !== 'unknown') return root.policy === 'allow'
    const own = leafPolicyCounts([root])
    return own.allow > 0 && own.unknown === 0
  }
  return ir.roots.every(isAllowed)
}
