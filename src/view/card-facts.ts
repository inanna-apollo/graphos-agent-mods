// What a hover card says, as plain strings: derived from the IR and the
// settled outcome only. Pure (no $, no JSX). Every untrusted string is
// escaped and laid flat here, so a card only has to draw it.

import { pickRenderer } from '../format/index.ts'
import { own } from '../guards.ts'
import type { ArgIR, CallIR, CallOutcome, FieldIR, Renderer } from '../ir.ts'
import { isDestructiveName, isWriteName } from '../risk.ts'
import { productOf } from './flags.ts'
import { UNTYPED_JSON, esc, governedList, humanPlural, humanType, isJsonName, limitOf, walk } from './kit.ts'
import { FIRST_PAGE, grouped, ownerOf, rootOfKey, shownScalars } from './outcome.ts'
import type { ResultLine } from './outcome.ts'
import { continuationArg, pagingNote } from './paging.ts'
import { classifiedOf, isPersonObject, isPersonalField } from './personal.ts'
import { GLYPH } from './ui/theme.ts'

/** Schema and call text, escaped first and then laid flat: a newline in it is layout, not content. */
export const flat = (text: string, max: number) => esc(text, max).replace(/\s+/g, ' ').trim()

/** `[Issue!]!` in words: `list of Issue (never null), never null`. Escaped. */
export function typeWords(sdl: string): string {
  const say = (type: string): string => {
    const nonNull = type.endsWith('!')
    const core = nonNull ? type.slice(0, -1) : type
    return core.startsWith('[') && core.endsWith(']') ? `list of ${say(core.slice(1, -1))}` : core
  }
  const items = (type: string): string => {
    const nonNull = type.endsWith('!')
    return `${say(type)}${nonNull ? ' (never null)' : ''}`
  }
  const nonNull = sdl.endsWith('!')
  const core = nonNull ? sdl.slice(0, -1) : sdl
  const body = core.startsWith('[') && core.endsWith(']') ? `list of ${items(core.slice(1, -1))}` : core
  return esc(`${body}, ${nonNull ? 'never null' : 'may be null'}`, 300)
}

/** The value a call set, in full: strings quoted, escaped and flat. */
export function valueText(value: unknown, max = 4_000): string {
  let text: string
  try {
    text = JSON.stringify(value) ?? String(value)
  } catch {
    text = String(value)
  }
  return flat(text, max)
}

/**
 * What Agent Services said about a denied field by real name, from the settled outcome:
 * its classification and requestability, and in how many rows it was denied,
 * the rows of `rootKey` (a response key) when given. The count is the
 * outcome's own tally of distinct rows, shown ones too; an outcome stored
 * before it was kept counts the errors listed.
 */
export function denialsOf(outcome: CallOutcome | undefined, name: string, rootKey?: string) {
  const errors = (outcome?.errors ?? []).filter(error => error.isDenied === true && error.field === name)
  const tagged = (outcome?.preview ?? []).flatMap(list => list.items.flatMap(item => item.denied ?? [])).filter(one => one.field === name || one.field.endsWith(`.${name}`))
  const classification = errors.find(error => error.classification !== undefined)?.classification ?? tagged.find(one => one.classification !== undefined)?.classification
  const requestable = errors.find(error => error.isRequestable !== undefined)?.isRequestable ?? tagged.find(one => one.isRequestable !== undefined)?.isRequestable
  const tallies = (outcome?.denials ?? []).filter(one => one.field === name && (rootKey === undefined || one.root === rootKey))
  if (outcome?.denials !== undefined) return { classification, requestable, count: tallies.reduce((sum, one) => sum + (one.rows ?? 0), 0), of: tallies.find(one => one.of !== undefined)?.of }
  return { classification, requestable, count: errors.reduce((sum, error) => sum + (error.count ?? 1), 0), of: errors.find(error => error.of !== undefined)?.of }
}

/**
 * `classified pii.contact · requestable`: the field's one classification (the
 * schema's, else the one Agent Services gave its denial, as the tree and the flags line
 * say it: src/attention.ts classificationOf), then whether a denial can be
 * requested; empty when neither is known.
 */
export function classificationNote(field: FieldIR, outcome: CallOutcome | undefined, withRequest = true): string {
  const denied = denialsOf(outcome, field.name)
  const one = classifiedOf(field) ?? denied.classification
  return [one === undefined ? undefined : `classified ${esc(one, 40)}`, !withRequest || denied.requestable === undefined ? undefined : denied.requestable ? 'requestable' : 'not requestable'].filter(Boolean).join(' · ')
}

const POLICY_WORDS: Record<FieldIR['policy'], string> = {
  allow: 'allowed',
  mask: 'masked: the value comes back hidden',
  deny: 'denied: the field is refused',
  unknown: 'not checked',
}

/** The field's policy in words, with classification and requestability when known. */
export function policyLine(field: FieldIR, outcome: CallOutcome | undefined): string {
  const note = classificationNote(field, outcome)
  return `${POLICY_WORDS[field.policy]}${note === '' ? '' : ` · ${note}`}`
}

/** One set argument as SDL writes it, with where its value came from. */
export function argLine(arg: ArgIR): string {
  const notes = [arg.fromVariable ? 'from a variable' : 'set by the call']
  if (arg.defaultValue !== undefined) notes.push(`default ${esc(arg.defaultValue, 80)}`)
  return `${esc(arg.name, 100)}: ${arg.type === undefined ? '?' : esc(arg.type, 200)} = ${valueText(arg.value, 300)} (${notes.join(', ')})`
}

/** Every declared argument the call left unset, with its default or whether it is required. */
export function unsetLines(field: FieldIR): string[] {
  return (field.omittedArgs ?? [])
    .slice(0, 30)
    .map(arg => `${esc(arg.name, 100)}: ${esc(arg.type, 200)} (unset, ${arg.default !== undefined ? `defaults to ${esc(arg.default, 80)}` : arg.isRequired ? 'required' : 'optional'})`)
}

/** What came back for a field, once settled: rows, a scalar, how many items denied it. */
export function cameBack(field: FieldIR, outcome: CallOutcome | undefined): string[] {
  if (outcome === undefined) return []
  const lines: string[] = []
  // By the root's response key too: two aliases of one field are two roots, each with its own rows.
  const rootKey = field.path.split('.')[0]
  const rows = outcome.rows.find(row => row.field === field.name && (row.root === undefined || row.root === rootKey))
  if (rows !== undefined) {
    lines.push(`${rows.count.toLocaleString('en-US')} row${rows.count === 1 ? '' : 's'}${rows.total !== undefined && rows.total > rows.count ? ` of ${rows.total.toLocaleString('en-US')} in all` : ''}`)
  }
  const scalar = field.children.length === 0 ? (outcome.scalars ?? []).find(one => (one.path === undefined ? one.field === field.name : one.path === field.path)) : undefined
  if (scalar !== undefined) lines.push(`value ${flat(String(scalar.value), 80)}`)
  const denied = denialsOf(outcome, field.name, rootKey)
  if (denied.count > 0) lines.push(`denied in ${denied.of !== undefined ? `${denied.count} of ${denied.of}` : denied.count} item${denied.count === 1 ? '' : 's'}`)
  return lines
}

/** A field's personal-data marker, in words. */
export function personalNote(field: FieldIR): string | undefined {
  if (isPersonObject(field)) return 'a person: the fields under it describe who they are'
  if (isPersonalField(field)) return 'personal data'
  return undefined
}

/**
 * What the policy card says when no selected field names a scope and the
 * schema was read: nothing to grant. Undefined while the schema is unread or
 * a scope is named (the root's `access` row lists it).
 */
export function scopesNote(ir: CallIR): string | undefined {
  const fields = walk(ir.roots)
  const isRead = ir.state !== 'analyzing' && (ir.checks === undefined || ir.checks.schema === 'ok')
  return isRead && fields.length > 0 && fields.every(field => (field.schema?.scopes.length ?? 0) === 0) ? 'no scopes required by the schema' : undefined
}

/** The validate and dry_run results: `validate ✓ · dry_run ✓ 3 allowed, 1 denied`. */
export function checkLine(ir: CallIR, counts: { allow: number; mask: number; deny: number; unknown: number }): string | undefined {
  const checks = ir.checks
  if (checks === undefined) return undefined
  const mark = (outcome: string) => (outcome === 'ok' ? '✓' : outcome === 'not-allowed' ? '✕' : outcome === 'failed' ? '!' : '–')
  const tally = [`${counts.allow} allowed`, counts.mask > 0 ? `${counts.mask} masked` : '', counts.deny > 0 ? `${counts.deny} denied` : ''].filter(Boolean).join(', ')
  const validation = checks.validation === 'ok' && ir.validation?.valid === false ? '✕ invalid' : mark(checks.validation)
  return `validate ${validation} · dry_run ${mark(checks.policy)}${checks.policy === 'ok' ? ` ${tally}` : ''}${ir.isOperationDenied === true ? ' · operation refused' : ''}`
}

// ---- Explanations of types, values, badges, services and RESULT lines,
// derived from the call, schema and outcome.

/** Card fallback when the schema provides no description. */
export const NO_DESCRIPTION = 'no description in the schema'
/** What it says where the schema has not been read. */
export const NO_SCHEMA = 'the schema has not been read for it'

const SCALAR_WORDS: Record<string, readonly [string, string]> = {
  String: ['a string', 'strings'],
  Int: ['a whole number', 'whole numbers'],
  Float: ['a number', 'numbers'],
  Boolean: ['true or false', 'true-or-false values'],
  ID: ['an ID', 'IDs'],
}

/** A named type in words, one and many: a scalar by what it holds (an opaque JSON scalar, by its name or as the schema says, is untyped JSON); any other one by its own name, many by its name said humanly (`Jira_Issue`: a Jira_Issue, issues). */
function namedWords(name: string, scope?: string, isOpaque = false): readonly [string, string] {
  if (isOpaque || isJsonName(name)) return [UNTYPED_JSON, `${UNTYPED_JSON} values`]
  const scalar = own(SCALAR_WORDS, name)
  if (scalar !== undefined) return scalar
  return [`${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${name}`, humanPlural(humanType(name, scope))]
}

/** A type's marks as GraphQL writes them: `[Jira_Issue!]!` is a non-null list of non-null Jira_Issue. */
function typeParts(sdl: string) {
  const type = sdl.replace(/\s+/g, '')
  const isNonNull = type.endsWith('!')
  const core = isNonNull ? type.slice(0, -1) : type
  const isList = core.startsWith('[') && core.endsWith(']')
  const inner = isList ? core.slice(1, -1) : core
  const isItemNonNull = isList && inner.endsWith('!')
  return { isNonNull, isList, isItemNonNull, named: isItemNonNull ? inner.slice(0, -1) : inner }
}

/**
 * A type as GraphQL writes it, in words: `String!` is `a string, never null`;
 * `[Jira_Issue!]!` is `a list, never null, of issues that are never null`.
 * `scope` names the service, whose prefix the type's words drop. Escaped.
 */
export function typeSaid(sdl: string, scope?: string, isOpaque = false): string {
  const { isNonNull, isList, isItemNonNull, named } = typeParts(sdl)
  // A list of lists says its notation's words.
  if (named.startsWith('[')) return typeWords(sdl)
  const [one, many] = namedWords(named, scope, isOpaque)
  if (!isList) return esc(`${one}, ${isNonNull ? 'never null' : 'may be null'}`, 300)
  return esc(`a list${isNonNull ? ', never null,' : ' that may be null,'} of ${many}${isItemNonNull ? ' that are never null' : ', any of which may be null'}`, 300)
}

/** One line on what a type's marks mean where they stand: `[ ]` a list, `!` never null. */
export function typeLesson(sdl: string): string {
  const { isNonNull, isList, isItemNonNull } = typeParts(sdl)
  if (!isList) return isNonNull ? 'in GraphQL, ! after a type means never null' : 'in GraphQL, a type with no ! after it may be null'
  return [
    'in GraphQL, [ ] is a list',
    isItemNonNull ? 'the ! inside makes each item never null' : 'with no ! inside, an item may be null',
    isNonNull ? 'the ! outside makes the list itself never null' : 'with no ! outside, the list itself may be null',
  ].join('; ')
}

const LIMIT_ARGS = ['limit', 'first', 'last', 'pagesize', 'maxresults', 'top', 'perpage']
const CURSOR_ARGS = ['cursor', 'after', 'before', 'pagetoken', 'nextpagetoken']
const OFFSET_ARGS = ['startat', 'offset', 'start', 'skip']

/**
 * What kind of value an argument takes, in words (a JQL query, a cursor, an
 * ID, a page size), by the renderer the form draws it with, its name and its
 * type; undefined when none of them says.
 */
export function argKind(arg: { name: string; type?: string; value?: unknown; renderer?: Renderer; enumValues?: string[] }, root: FieldIR): string | undefined {
  const renderer = arg.renderer ?? pickRenderer({ name: arg.name, ...(arg.type !== undefined && { type: arg.type }), value: arg.value }, root.name)
  const name = arg.name.toLowerCase()
  const type = (arg.type ?? '').replace(/\s+/g, '')
  if (renderer === 'jql') return "a JQL query, Jira's search language: field = value clauses joined by AND or OR, then ORDER BY"
  if (renderer === 'cql') return `a CQL query, Confluence's search language: clauses such as type = page or text ~ "words", joined by AND or OR`
  if (renderer === 'slack') return 'a Slack search: words, with modifiers such as from:, in: and has:'
  if (CURSOR_ARGS.includes(name)) return 'a cursor: where to pick the list up, as the previous page handed it back'
  if (OFFSET_ARGS.includes(name)) return 'an offset: how many items to skip before this page starts (0 is the first)'
  if (name === 'page') return 'a page number'
  if (LIMIT_ARGS.includes(name)) return 'a page size: at most this many items come back'
  if (renderer === 'id') return 'an ID: it names one record'
  if (renderer === 'url') return 'a URL'
  if (renderer === 'date') return 'a date or a time'
  if ((arg.enumValues?.length ?? 0) > 0) return `one of ${arg.enumValues?.length} fixed values (an enum)`
  if (isJsonName(type)) return `${UNTYPED_JSON}: any shape, which the schema does not describe`
  if (type.startsWith('[')) return 'a list of values'
  if (typeof arg.value === 'object' && arg.value !== null && !Array.isArray(arg.value)) return 'an input object: named fields set inside it'
  if (/^Boolean!?$/.test(type)) return 'a switch: true or false'
  return undefined
}

/** `a`, `a and b`, `a, b and c`. */
const listed = (items: readonly string[]) => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`)

/** The services a call reaches, by the names the flags line uses (`Jira`, `customer data`). Escaped. */
const productsOf = (ir: CallIR) => [...new Set(ir.roots.map(root => productOf(root.service ?? ir.service) ?? '').filter(Boolean))]

/**
 * What the badge's operation type is and what approving the call does, from
 * the operation type and the roots' real names only, never the summary: a
 * query reads (unless a root is named for a change: a query field can still
 * write), a mutation changes data, a subscription streams.
 */
export function badgeFacts(ir: CallIR): { title: string; lines: string[] } {
  const where = productsOf(ir).length === 0 ? '' : ` against ${listed(productsOf(ir))}`
  const approving = `Approving has Agent Services run it once${where}, as you`
  const named = (test: (name: string) => boolean) => ir.roots.filter(root => test(root.name)).map(root => esc(root.name, 120))
  const writes = named(name => isWriteName(name) || isDestructiveName(name))
  const destructive = named(isDestructiveName)
  const be = (names: readonly string[]) => (names.length === 1 ? 'is' : 'are')
  if (ir.opType === 'mutation') {
    return {
      title: 'WRITE · a mutation',
      lines: [
        'A mutation changes data: it creates, updates or deletes.',
        `${approving}: the change is made then.`,
        ...(destructive.length > 0 ? [`${listed(destructive)} ${be(destructive)} named to delete, remove, archive or revoke.`] : []),
      ],
    }
  }
  if (ir.opType === 'subscription') {
    return { title: 'WATCH · a subscription', lines: ['A subscription watches for events.', `Approving starts a stream${where} that keeps sending data as things happen, until it ends.`] }
  }
  return {
    title: 'READ · a query',
    lines: [
      writes.length === 0
        ? 'A query asks for data: it reads, and is not meant to change anything.'
        : `A query asks for data, but ${listed(writes)} ${be(writes)} named for a change: a query field can still change data, so this may.`,
      `${approving}, under your organization's policy.`,
    ],
  }
}

/** Each service the call reaches, with the root fields it serves (`open: jira_search…`), in the operation's order. Escaped. */
export function serviceFacts(ir: CallIR): { service: string; roots: string[] }[] {
  const groups = new Map<string, FieldIR[]>()
  for (const root of ir.roots) {
    const key = root.service ?? ir.service ?? ''
    groups.set(key, [...(groups.get(key) ?? []), root])
  }
  // The scope id in brackets only where it adds something: not `Jira (jira)`, `incident.io (incidentio)` or `Acme customer data (acme-customer-data)`.
  const bare = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '')
  return [...groups].map(([key, roots]) => {
    const product = productOf(key)
    return {
      service: product === undefined ? 'a service not yet known' : bare(product) === bare(key) ? product : `${product} (${esc(key, 60)})`,
      roots: roots.map(root => (root.alias === undefined ? esc(root.name, 120) : `${esc(root.alias, 120)}: ${esc(root.name, 120)}`)),
    }
  })
}

/** What the operation name is: the agent's own label for the call, which GraphQL runs the same under any name. Escaped. */
export function opFacts(ir: CallIR): string[] {
  const roots = ir.roots.map(root => (root.alias === undefined ? esc(root.name, 120) : `${esc(root.alias, 120)}: ${esc(root.name, 120)}`))
  return [
    `${ir.opType ?? 'query'} ${esc(ir.opName ?? '', 200)}: the name the agent wrote for this operation.`,
    'The operation name is a label for matching the call to the permission prompt. It does not affect execution.',
    `It asks for ${roots.length} root field${roots.length === 1 ? '' : 's'}: ${roots.join(' · ')}`,
  ]
}

/** Summary credit: model and input sources. */
export const CREDIT_FACTS = ['A one-line headline Haiku wrote from the operation and the schema.'] as const

/** What the header's status word means (`✓ ran`, `ran · 2 errors`, `failed`, `1 of 3`). */
export function statusFacts(word: string, outcome: CallOutcome | undefined): string[] {
  const hasDenials = (outcome?.errors ?? []).some(error => error.isDenied === true) || (outcome?.preview ?? []).some(list => list.items.some(item => (item.denied ?? []).length > 0))
  const queued = /^1 of (\d+)$/.exec(word)
  if (queued !== null) return [`${queued[1]} calls are waiting at their prompts; this pane shows the oldest, and the next as each one settles.`]
  if (word === 'failed') return ['The tool call failed: an error came back instead of a GraphQL response.']
  if (word === 'denied') return ['The call was refused before it ran, at the permission prompt or by a hook: nothing reached Agent Services.']
  if (word === 'errors') return ['The response carried errors and no data: nothing that was asked for came back. RESULT lists each error.']
  if (word === 'needs sign-in') return ['Agent Services answered, but a service the call reads needs your account linked first (UPSTREAM_AUTH_REQUIRED), so nothing came back. Follow the sign-in link under RESULT, then run the call again.']
  const errors = /^ran · (\d+) errors?$/.exec(word)
  if (errors !== null) return [`The response carried data and ${errors[1]} error${errors[1] === '1' ? '' : 's'}: some of what was asked for did not come back. RESULT lists each.`]
  return ['Agent Services ran the call and the response came back.', ...(hasDenials ? ['Fields Agent Services denied came back empty: the flags line and RESULT say which.'] : [])]
}

/** The root field a path starts at, and the field that holds `field`. */
export function placeOf(roots: readonly FieldIR[], field: FieldIR): { root: FieldIR | undefined; parent: FieldIR | undefined } {
  const find = (list: readonly FieldIR[], parent: FieldIR | undefined): FieldIR | undefined => {
    for (const one of list) {
      if (one === field) return parent ?? one
      const found = find(one.children, one)
      if (found !== undefined) return found
    }
    return undefined
  }
  const root = roots.find(one => one === field || walk(one.children).includes(field))
  return { root, parent: root === field ? undefined : find(roots, undefined) }
}

/**
 * What came back for a field inside a list's rows, once settled: in how many
 * of the rows shown it holds a value, and the first few values. Undefined
 * when the outcome kept none. Escaped.
 */
export function valuesBack(field: FieldIR, parent: FieldIR | undefined, outcome: CallOutcome | undefined): string | undefined {
  if (outcome === undefined || parent === undefined || field.children.length > 0) return undefined
  const rootKey = field.path.split('.')[0]
  const list = (outcome.preview ?? []).find(one => one.field === parent.name && (one.root === undefined || one.root === rootKey))
  if (list === undefined) return undefined
  const values = list.items.flatMap(item => item.fields?.find(one => one.name === field.name)?.value ?? [])
  if (values.length === 0) return undefined
  // Whole (the card wraps them); the first three, or four when one would be left: a name says more than `1 more`.
  const shown = (values.length <= 4 ? values : values.slice(0, 3)).map(value => flat(value, 400))
  const rest = values.length - shown.length
  return `${values.length} of the ${list.items.length} rows shown: ${shown.join(', ')}${rest > 0 ? `, and ${rest} more` : ''}`
}

type RowsLine = Extract<ResultLine, { kind: 'rows' }>
type ScalarLine = Extract<ResultLine, { kind: 'scalar' }>

/** Booleans that say whether more rows remain, and what `true` means (src/view/outcome.ts). */
const MORE_FLAGS: Record<string, boolean> = { more: true, hasMoreResults: true, hasNextPage: true, isLast: false }

/** The root a RESULT rows line is about: its list's (the preview after it), else its head's, else the only root. */
export function rowsRootOf(line: RowsLine, next: ResultLine | undefined, ir: CallIR): FieldIR | undefined {
  if (next?.kind === 'preview') return ownerOf(ir.roots, next)
  if (line.field !== '') return ir.roots.find(root => esc(root.alias ?? root.name, 120) === line.field)
  return ir.roots.length === 1 ? ir.roots[0] : undefined
}

/** The more-rows flag the response sent under `root` (`isLast false`), escaped. */
function flagOf(root: FieldIR, outcome: CallOutcome | undefined): string | undefined {
  const flag = (outcome?.scalars ?? []).find(one => own(MORE_FLAGS, one.field) !== undefined && (one.root === undefined || one.root === root.path || one.root === root.name))
  return flag === undefined ? undefined : `${esc(flag.field, 120)} is ${String(flag.value)}`
}

/** How the list goes on past this page, in words: the argument to set and the field to set it from. */
function nextPage(root: FieldIR): string | undefined {
  const paging = root.paging
  if (paging?.moreField !== undefined && paging.via.length === 1 && paging.kind !== 'page') return `call again with ${esc(paging.via[0] ?? '', 120)} set to this response's ${esc(paging.moreField, 120)}`
  if (paging?.kind === 'page' && paging.via.length === 1) return `call again with ${esc(paging.via[0] ?? '', 120)} one higher${paging.pageCountField === undefined ? '' : `, up to ${esc(paging.pageCountField, 120)}`}`
  const token = root.children.find(child => continuationArg(child, root) !== undefined)
  if (token !== undefined) return `call again with ${esc(continuationArg(token, root) ?? '', 120)} set to this response's ${esc(token.name, 120)}`
  return paging === undefined ? undefined : esc(pagingNote(paging), 300)
}

/**
 * A RESULT rows line in words (`5 issues · first page · more available`):
 * the list it counts, how many came back against the total and the limit,
 * what each part of its note means, and how the list goes on past this page.
 */
export function rowsFacts(line: RowsLine, next: ResultLine | undefined, ir: CallIR, outcome: CallOutcome | undefined): { label: string; text: string }[] {
  const root = rowsRootOf(line, next, ir)
  if (root === undefined) return []
  const list = governedList(root) ?? root
  const row = outcome?.rows.find(one => ownerOf(ir.roots, one) === root)
  const limit = limitOf(root)
  const limitArg = root.args.find(arg => LIMIT_ARGS.includes(arg.name.toLowerCase()))?.name
  const facts: { label: string; text: string }[] = []
  if (line.isHead === true) facts.push({ label: 'head', text: `${line.field}: the root's response key, ${root.alias === undefined ? 'its own name' : `the alias the agent gave ${esc(root.name, 120)}`}` })
  if (list.schema !== undefined) facts.push({ label: 'list', text: `${esc(list.coordinate, 200)} · ${esc(list.schema.type, 200)}` })
  if (row !== undefined) {
    const total = row.total === undefined ? '' : `, of ${grouped(row.total)} in all (the response's own total)`
    const asked = limit === undefined ? '' : `; the call asked for at most ${limit}${limitArg === undefined ? '' : ` (${esc(limitArg, 60)})`}`
    facts.push({ label: 'count', text: `${grouped(row.count)} came back${total}${asked}` })
  }
  if (line.isWarn === true) facts.push({ label: 'over', text: 'more than the call asked for: the service did not hold to the limit' })
  const flag = flagOf(root, outcome)
  for (const part of (line.note ?? '').split(GLYPH.separator).filter(Boolean)) {
    if (part === FIRST_PAGE) facts.push({ label: 'page', text: `first page: the call set none of its paging arguments${root.paging === undefined || root.paging.via.length === 0 ? '' : ` (${esc(root.paging.via.join(', '), 120)})`}, so the list starts at its beginning` })
    else if (part === 'more available' || part === 'more') facts.push({ label: 'more', text: `more available: ${flag === undefined ? 'the response says' : `the response's ${flag}, so`} more results remain past this page` })
    else if (part === 'last page') facts.push({ label: 'last', text: `last page: ${flag === undefined ? 'the response says' : `the response's ${flag}, so`} there is nothing more to fetch` })
  }
  const onward = nextPage(root)
  if (onward !== undefined) facts.push({ label: 'next', text: onward })
  return facts
}

/**
 * The response field a RESULT value line shows (`total  412`, `count  42`, or
 * a more-rows flag said in words), and its raw value, found as the line was
 * made (src/view/outcome.ts resultLines): by its root's head and its name.
 */
export function scalarOf(line: ScalarLine, ir: CallIR, outcome: CallOutcome | undefined): { field: FieldIR | undefined; value: string | undefined } {
  if (outcome === undefined) return { field: undefined, value: undefined }
  const isMulti = ir.roots.length > 1
  const isFlag = line.text === 'more results available' || line.text === 'last page'
  for (const scalar of shownScalars(outcome, ir)) {
    const root = rootOfKey(ir.roots, scalar.root ?? scalar.path ?? scalar.field)
    const head = isMulti && root !== undefined ? esc(root.alias ?? root.name, 120) : undefined
    const drawn = isFlag ? (head ?? '') : head === undefined ? esc(scalar.field, 120) : scalar.root === undefined || scalar.isOnly === true ? head : `${head}  ${esc(scalar.field, 120)}`
    if (drawn !== line.field || isFlag !== (own(MORE_FLAGS, scalar.field) !== undefined)) continue
    const field = scalar.path !== undefined ? walk(ir.roots).find(one => one.path === scalar.path) : (root?.children.find(one => one.name === scalar.field) ?? (root?.name === scalar.field ? root : undefined))
    return { field, value: flat(String(scalar.value), 80) }
  }
  return { field: undefined, value: undefined }
}
