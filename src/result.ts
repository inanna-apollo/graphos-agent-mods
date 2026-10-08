// What a settled Agent Services execute call returned, as facts the pane can show.
// Pure: no $. Reads the MCP result (`{ content: [{ type: 'text', text }] }`
// or a bare string) holding a GraphQL response `{ data, errors, extensions }`.
//
// Everything here is response content: untrusted, escaped where drawn. Counts,
// codes, paths and link URLs are extracted, and a short look at each list (up
// to 25 items, at most 12 short fields each, and 5 items once the call is an
// older history entry); nothing else of a value is kept.

import { escapeText } from './escape.ts'
import { isAuxiliaryList, isRecord } from './guards.ts'
import type { CallIR, CallOutcome, FieldIR } from './ir.ts'
import { configOf, recordLinkOf, serviceOf } from './links.ts'
import type { LinkConfig } from './links.ts'
import { persistedWeight, weightOf } from './weight.ts'
import { confirmOf } from './preview/confirm.ts'

/** The response text: a string, MCP content blocks (`[{ type: 'text', text }]`, as core relays an MCP result), or `{ content }`. */
function textOf(result: unknown): string | undefined {
  if (typeof result === 'string') return result
  const blocks = Array.isArray(result) ? result : isRecord(result) && Array.isArray(result.content) ? result.content : undefined
  const block = blocks?.find(one => isRecord(one) && one.type === 'text' && typeof one.text === 'string')
  return isRecord(block) ? (block.text as string) : undefined
}

/** The IR field at a dotted response-key path, to name things by their real names. */
function fieldAt(ir: CallIR, path: string): FieldIR | undefined {
  const walk = (fields: readonly FieldIR[]): FieldIR | undefined => {
    for (const field of fields) {
      if (field.path === path) return field
      const inner = walk(field.children)
      if (inner !== undefined) return inner
    }
    return undefined
  }
  return walk(ir.roots)
}

/** Sibling fields that say how many rows exist in all. `count` and `size` are not among them: they say how many came back. */
const TOTAL_KEYS = ['totalSize', 'totalCount', 'total']
/** A sibling that says the record is about money: its `total` is an amount (`total: 1250, currency: "USD"`), not a row count. */
const MONEY_KEYS = ['currency', 'currencyCode', 'subtotal', 'subTotal', 'amount', 'price', 'tax', 'balance']

/**
 * The sibling that says how many rows a list has in all, and its value: a
 * whole number no smaller than the rows that came back, typed `Int` where the
 * schema says (an amount typed `Float` never is), and a `total` beside a
 * currency or an amount is money, not rows.
 */
function totalOf(ir: CallIR, listPath: string, parent: Record<string, unknown>, length: number): [key: string, total: number] | undefined {
  const at = listPath.slice(0, listPath.lastIndexOf('.'))
  for (const key of TOTAL_KEYS) {
    const value = parent[key]
    if (typeof value !== 'number' || !Number.isInteger(value) || value < length) continue
    const schema = fieldAt(ir, `${at}.${key}`)?.schema
    if (schema !== undefined && (schema.isList || schema.type.replace(/[[\]!]/g, '') !== 'Int')) continue
    if (key === 'total' && MONEY_KEYS.some(money => Object.hasOwn(parent, money))) continue
    return [key, value]
  }
  return undefined
}

type Candidate = [path: string, value: unknown, parent: Record<string, unknown> | undefined]

/**
 * The list under a root that its limit governs: the rows, not a facet or a
 * warning list beside them. Ranked by: not an auxiliary list by name, not a
 * list of bare scalars, a list the schema names, shallowest, then response
 * order. Undefined when the root holds no list.
 */
function mainListOf(ir: CallIR, lists: readonly Candidate[]): Candidate | undefined {
  const rank = ([path, value]: Candidate, order: number) => {
    const items = value as unknown[]
    const field = fieldAt(ir, path)
    const name = field?.name ?? path.split('.').pop() ?? path
    return [isAuxiliaryList(name) ? 1 : 0, items.length > 0 && !items.some(isRecord) ? 1 : 0, field?.schema?.isList === true ? 0 : 1, path.split('.').length, order]
  }
  const ranked = lists.map((one, order) => ({ one, key: rank(one, order) }))
  ranked.sort((a, b) => a.key.reduce((diff, part, at) => (diff !== 0 ? diff : part - (b.key[at] ?? 0)), 0))
  return ranked[0]?.one
}

/** The main list under each root (three levels down at most) and a sibling total when there is one. `totals` are the response paths of the totals used, which a rows line says. */
function rowsOf(ir: CallIR, data: Record<string, unknown>, config: LinkConfig): { rows: CallOutcome['rows']; preview: NonNullable<CallOutcome['preview']>; slots: Slot[]; totals: Set<string> } {
  const rows: CallOutcome['rows'] = []
  const preview: NonNullable<CallOutcome['preview']> = []
  const slots: Slot[] = []
  const totals = new Set<string>()
  for (const [key, value] of Object.entries(data)) {
    // The lists under the root, breadth first, three levels down at most
    // (`slack_searchMessages.messages.matches`), each with its parent for a total.
    const candidates: Candidate[] = [[key, value, undefined]]
    for (let at = 0; at < candidates.length && at < 200; at++) {
      const [path, child] = candidates[at] ?? []
      if (path === undefined || !isRecord(child) || path.split('.').length >= 3) continue
      for (const [inner, grandchild] of Object.entries(child)) candidates.push([`${path}.${inner}`, grandchild, child])
    }
    const hit = mainListOf(ir, candidates.filter(([, child]) => Array.isArray(child)))
    if (hit === undefined) continue
    const [path, list, parent] = hit
    // A total smaller than the rows that came back, a fraction, or an amount is not one.
    const totalKey = parent === undefined ? undefined : totalOf(ir, path, parent, (list as unknown[]).length)
    if (totalKey !== undefined) totals.add(`${path.slice(0, path.lastIndexOf('.'))}.${totalKey[0]}`)
    const field = fieldAt(ir, path)
    const name = field?.name ?? path
    // By the root's response key too: two roots' lists can share a field name (`open` and `closed` both list `issues`).
    rows.push({
      field: name,
      count: (list as unknown[]).length,
      ...(totalKey !== undefined && { total: totalKey[1] as number }),
      root: key,
    })
    const listField = fieldAt(ir, path)
    const { items, at } = previewOf(list as unknown[], serviceOf(fieldAt(ir, key)?.name ?? key), config, listField)
    if (items.length > 0) {
      preview.push({ field: name, root: key, at, items, more: (list as unknown[]).length - items.length })
      slots.push({ listSegments: path.split('.'), at, items })
    }
  }
  return { rows, preview, slots, totals }
}

/** Where a shown preview list sits in the response, and which source index each shown item came from. Not kept. */
type Slot = { listSegments: string[]; at: number[]; items: NonNullable<CallOutcome['preview']>[number]['items'] }

const MAX_DENIED_TAGS = 4

/**
 * A denial inside a shown preview item (`members.2.email`, `members.2.user.email`)
 * recorded on that item as a relative field path by real name. False when the
 * error is not inside a shown item, or the item already has the most tags.
 */
function tagItem(ir: CallIR, slots: readonly Slot[], segments: readonly string[], tag: Omit<NonNullable<NonNullable<CallOutcome['preview']>[number]['items'][number]['denied']>[number], 'field'>): boolean {
  for (const slot of slots) {
    const n = slot.listSegments.length
    if (segments.length <= n + 1 || !slot.listSegments.every((segment, at) => segments[at] === segment)) continue
    const index = segments[n]
    if (index === undefined || !isIndex(index)) continue
    // A denial inside a list within the row (`teams.0.members.2.email`) belongs to that inner row, not to the team.
    if (segments.slice(n + 1).some(isIndex)) continue
    const position = slot.at.indexOf(Number(index))
    const item = slot.items[position]
    const rest = segments.slice(n + 1)
    if (item === undefined || rest.length === 0) continue
    const before = segments.slice(0, n)
    const names = rest.map((key, at) => fieldAt(ir, [...before, ...rest.slice(0, at + 1)].join('.'))?.name ?? key)
    const field = names.join('.')
    const denied = item.denied ?? []
    // Tagged on every kept row; it stands as a RESULT line too unless the row is among those shown before the list is opened out.
    if (denied.some(one => one.field === field)) return position < PREVIEW_SHOWN
    if (denied.length >= MAX_DENIED_TAGS) return false
    item.denied = [...denied, { field, ...tag }]
    return position < PREVIEW_SHOWN
  }
  return false
}

const LABEL_KEYS = ['title', 'name', 'summary', 'key', 'subject', 'displayName', 'text', 'url']
/** Who wrote a record that is itself prose (a message): short, so it can be the row's key. */
const AUTHOR_KEYS = ['username', 'userName', 'login', 'handle', 'author', 'authorName']
/** The longest author that stands as a key; a longer one is prose too. */
const AUTHOR_MAX = 40
const EXTRA_KEYS = [
  'key', 'id', 'status', 'lastModified', 'updated', 'created_at', 'createdAt', 'updated_at', 'updatedAt', 'created', 'last_status_change_at', 'timestamp',
]
/** Rows a list keeps (the pane opens out to them on a press), and rows it shows before that. */
const PREVIEW_ITEMS = 25
export const PREVIEW_SHOWN = 5
/**
 * A row's label and its summary are kept whole up to here, and the view wraps
 * them, never cuts: past two or three times a long title or a long chat message,
 * so only a description pasted whole is cut, as a safety bound.
 */
const LABEL_MAX = 1000
const EXTRA_MAX = 80

/** `text` flattened, and cut at `max` characters (code points: a surrogate pair is never halved) only past it. */
const tidy = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  // The first 2 × (max + 1) units hold at least `max + 1` code points when the text has them, so a long text is never spread whole.
  const chars = Array.from(flat.slice(0, (max + 1) * 2))
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : flat
}

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''

/**
 * The containers inside a record that describe the record itself: Jira's
 * opaque `fields`, a search hit's `document`, and a status-like object (`status: { name: "Open" }`).
 * Never a person or another record (`manager`, `creator`), whose name is not
 * this record's.
 */
const OWN_CONTAINERS = ['fields', 'document', 'status', 'state', 'severity', 'priority', 'resolution', 'type', 'issuetype', 'issueType', 'category', 'kind']

/** The record's own descriptive containers, in the order the record lists them. */
const ownContainers = (item: Record<string, unknown>): Record<string, unknown>[] =>
  OWN_CONTAINERS.flatMap(name => {
    const found = item[name]
    return isRecord(found) ? [found] : []
  })

/** The first present string among `keys` on the item, else one level down in one of its own descriptive containers. */
function pick(item: Record<string, unknown>, keys: readonly string[]): { key: string; value: string } | undefined {
  for (const key of keys) if (nonEmpty(item[key])) return { key, value: item[key] }
  for (const nested of ownContainers(item)) {
    for (const key of keys) if (nonEmpty(nested[key])) return { key, value: nested[key] }
  }
  return undefined
}

/** A human-ish date reads better than an id: a date-like extra wins when present. */
const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}/.test(value)

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `2026-10-01T19:17:11.000Z` → `Oct 1 2026`: short, and never cut mid-timestamp. */
export function shortDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined
  return match && month ? `${month} ${Number(match[3])} ${match[1]}` : tidy(value, EXTRA_MAX)
}

function extraOf(item: Record<string, unknown>, labelKey: string, label: string, skip: readonly string[] = []): string | undefined {
  const found = EXTRA_KEYS.filter(key => !skip.includes(key) && (key !== labelKey || item[key] !== label))
    .map(key => pick(item, [key]))
    .filter((one): one is { key: string; value: string } => one !== undefined && one.value !== label)
  const best = found.find(one => isDate(one.value)) ?? found[0]
  if (best === undefined) return undefined
  return isDate(best.value) ? shortDate(best.value) : tidy(best.value, EXTRA_MAX)
}

const MAX_FIELDS = 12
const VALUE_MAX = 256
/** A key inside opaque JSON is response content too: kept short. */
const JSON_KEY_MAX = 120
/** In opaque JSON, the scalar that names an object (`status: { name: "Open" }`). */
const NAME_KEYS = ['name', 'displayName', 'value', 'key']

/** The last segment of a response-key path: the key the field's value sits under. */
const keyOf = (field: FieldIR) => field.path.split('.').pop() ?? field.name

const scalarText = (value: unknown): string | undefined =>
  typeof value === 'string' ? tidy(value, VALUE_MAX) : typeof value === 'number' || typeof value === 'boolean' ? String(value) : value === null ? 'null' : undefined

/**
 * What an opaque JSON value (a leaf whose value is an object: Jira's
 * `fields`) holds that a reader can use, under the field's name: its
 * top-level scalars (`fields.summary`), and the name of each object at its
 * top (`fields.status.name`). Never deeper, never lists.
 */
function jsonFields(name: string, value: Record<string, unknown>, room: number): NonNullable<Slot['items'][number]['fields']> {
  const found: NonNullable<Slot['items'][number]['fields']> = []
  for (const [key, inner] of Object.entries(value)) {
    if (found.length >= room) break
    const at = `${name}.${tidy(key, JSON_KEY_MAX)}`
    if (isRecord(inner)) {
      const named = NAME_KEYS.find(one => typeof inner[one] === 'string' || typeof inner[one] === 'number')
      const text = named === undefined ? undefined : scalarText(inner[named])
      if (named !== undefined && text !== undefined) found.push({ name: `${at}.${named}`, value: text })
    } else if (!Array.isArray(inner)) {
      const text = scalarText(inner)
      if (text !== undefined) found.push({ name: at, value: text })
    }
  }
  return found
}

/**
 * An item's selected scalar leaves in selection order by real name, one level
 * into nested objects as `user.email`; an opaque JSON leaf by what it holds
 * (jsonFields).
 */
function fieldsOf(item: Record<string, unknown>, listField: FieldIR): NonNullable<Slot['items'][number]['fields']> {
  const found: NonNullable<Slot['items'][number]['fields']> = []
  for (const child of listField.children) {
    if (found.length >= MAX_FIELDS) break
    const value = item[keyOf(child)]
    if (isRecord(value) && child.children.length > 0) {
      for (const inner of child.children) {
        const text = scalarText(value[keyOf(inner)])
        if (text !== undefined) found.push({ name: `${child.name}.${inner.name}`, value: text })
      }
    } else if (isRecord(value)) {
      // A leaf with an object value is opaque JSON: GraphQL would make an object type take a selection.
      found.push(...jsonFields(child.name, value, MAX_FIELDS - found.length))
    } else {
      const text = scalarText(value)
      if (text !== undefined) found.push({ name: child.name, value: text })
    }
  }
  return found.slice(0, MAX_FIELDS)
}

const RAW_MAX = 12
const RAW_VALUE_MAX = 80
/** A link a record carries (a Slack permalink with its thread) is longer than an id: kept whole to here. */
const RAW_URL_MAX = 256

/**
 * The item's short identifier-like scalars, for matching link rules when drawn
 * (src/links.ts): top-level and one level down (`fields.key`), strings of at most
 * 80 characters with no spaces (an https URL, up to 256), and numbers. Small by
 * design; never whole objects.
 */
function rawOf(item: Record<string, unknown>): Record<string, string> {
  const found: Record<string, string> = {}
  const keep = (name: string, value: unknown) => {
    if (Object.keys(found).length >= RAW_MAX) return
    if (typeof value === 'string' && value !== '' && value.length <= (value.startsWith('https://') ? RAW_URL_MAX : RAW_VALUE_MAX) && !/\s/.test(value)) found[name] = value
    else if (typeof value === 'number' && Number.isSafeInteger(value)) found[name] = String(value)
  }
  for (const [name, value] of Object.entries(item)) keep(name, value)
  for (const [name, value] of Object.entries(item)) {
    if (!isRecord(value)) continue
    for (const [inner, innerValue] of Object.entries(value)) keep(`${name}.${inner}`, innerValue)
  }
  return found
}

/** An issue-style key (`DEV-634`): an id, not something a reader reads. */
const ID_LIKE = /^[A-Za-z][A-Za-z0-9_]*-\d+$/

/** The readable text an id-keyed item carries inside an opaque nested object (`fields.summary`). */
function nestedText(item: Record<string, unknown>): string | undefined {
  for (const nested of ownContainers(item)) {
    const found = pick(nested, ['summary', 'title', 'name'])
    if (found !== undefined) return tidy(found.value, LABEL_MAX)
  }
  return undefined
}

/** Where a record keeps a short reference a person says aloud: `INC-1055`, `DEV-634`. */
const REF_KEYS = ['key', 'reference', 'number', 'identifier']
/** What a record is called, to follow its reference. */
const TITLE_KEYS = ['title', 'name', 'summary', 'subject', 'displayName']

/** The record's short reference, when it has one; its internal id (a ULID) is never it. */
function refOf(item: Record<string, unknown>): { key: string; value: string } | undefined {
  for (const key of REF_KEYS) {
    const value = item[key]
    if (typeof value === 'string' && ID_LIKE.test(value)) return { key, value }
  }
  return undefined
}

/** Where a record keeps what a person wrote: an update's message, a description. */
const PROSE_KEYS = ['message', 'body', 'description', 'text', 'summary', 'content']

/**
 * What a person wrote in the record, when its label is a name or a status
 * (`Documenting` for an incident update): the row's text, wrapped when drawn,
 * so the part worth reading is not left out. Words only, never the label again.
 */
function proseOf(item: Record<string, unknown>, label: string): string | undefined {
  for (const key of PROSE_KEYS) {
    const value = item[key]
    if (typeof value === 'string' && value.trim() !== label && /\S\s+\S/.test(value.trim())) return tidy(value, LABEL_MAX)
  }
  return undefined
}

/**
 * The record a list item stands for: a Relay edge's `node` (`edges { cursor
 * node { title } }`) when the edge has no label of its own, else the item.
 * A record that names itself is never relabelled by an object it holds (a
 * pod's `node`).
 */
function recordOf(item: Record<string, unknown>): Record<string, unknown> {
  const node = item.node
  return isRecord(node) && refOf(item) === undefined && pick(item, LABEL_KEYS) === undefined ? node : item
}

/** A record's own id as its label, when nothing names it better: a string, or a whole number. */
function idOf(record: Record<string, unknown>): { key: string; value: string } | undefined {
  const id = record.id
  if (nonEmpty(id)) return { key: 'id', value: id }
  return typeof id === 'number' && Number.isSafeInteger(id) ? { key: 'id', value: String(id) } : undefined
}

/** Up to PREVIEW_ITEMS items of a list as a label and a second short field. Response content: never keep whole objects. */
function previewOf(list: unknown[], service: string, config: LinkConfig, listField?: FieldIR): { items: Slot['items']; at: number[] } {
  const items: Slot['items'] = []
  const at: number[] = []
  for (const [index, item] of list.slice(0, PREVIEW_ITEMS).entries()) {
    if (!isRecord(item)) continue
    // What names the row is the record's own: inside a Relay edge, its node. The card's fields stay the item's, by the names the call selected (`node.title`).
    const record = recordOf(item)
    // A short reference a person says (`INC-1055`) is the key; its title or summary is what follows it.
    const ref = refOf(record)
    let label = ref ?? pick(record, LABEL_KEYS)
    // A record that is only prose (a message) is keyed by its short author when it has one, and its words are the row's text.
    if (ref === undefined && (label === undefined || PROSE_KEYS.includes(label.key))) {
      const author = pick(record, AUTHOR_KEYS)
      if (author !== undefined && [...author.value].length <= AUTHOR_MAX && proseOf(record, author.value) !== undefined) label = author
    }
    // A record with nothing that names it (`{ id email }`, `{ id sku }`) is keyed by its id.
    label ??= idOf(record)
    if (label === undefined) continue
    const text = tidy(label.value, LABEL_MAX)
    const extra = extraOf(record, label.key, label.value, ref === undefined ? [] : ['id'])
    const titled = ref === undefined ? undefined : pick(record, TITLE_KEYS)
    const text2 = (titled === undefined ? undefined : tidy(titled.value, LABEL_MAX)) ?? (ID_LIKE.test(label.value) ? nestedText(record) : undefined) ?? proseOf(record, label.value)
    const url = recordLinkOf(service, record, config)
    const fields = listField === undefined ? [] : fieldsOf(item, listField)
    const raw = rawOf(record)
    items.push({ label: text, ...(Object.keys(raw).length > 0 && { raw }), ...(text2 !== undefined && { text: text2 }), ...(extra !== undefined && { extra }), ...(url !== undefined && { url }), ...(fields.length > 0 && { fields }) })
    at.push(index)
  }
  return { items, at }
}

const isNumeric = (value: string) => /^-?\d+(\.\d+)?$/.test(value)

/**
 * Scalars that say how much or whether: a count, a total, a has-more flag, an echoed
 * argument (numbers, booleans, null and numeric strings), and, for a root that is one
 * record with no list in it (`slack_authTest { team url }`), its short text fields,
 * whitespace laid flat and bounded: a list's wrapper keeps no text (a cursor is not news).
 * These are raw facts: which of them are worth a line (echoes, nulls, an unset
 * offset) is decided when drawn, against the call's latest IR (src/view/outcome.ts).
 */
function scalarsOf(ir: CallIR, data: Record<string, unknown>, totals: ReadonlySet<string>): NonNullable<CallOutcome['scalars']> {
  const found: NonNullable<CallOutcome['scalars']> = []
  const texts = new Map<string, number>()
  const keep = (path: string, value: unknown, rootKey: string, isRoot: boolean, isOnly: boolean, isRecordRoot = false) => {
    // A single record's text: the first few fields of each root, bounded.
    if (typeof value === 'string' && !isNumeric(value)) {
      const count = texts.get(rootKey) ?? 0
      // A paging cursor or a request's token is plumbing, not what came back.
      if (!(isRecordRoot || isRoot) || value.trim() === '' || count >= MAX_TEXT_FIELDS || PLUMBING.test(path.split('.').pop() ?? '')) return
      texts.set(rootKey, count + 1)
      value = tidy(value, MAX_TEXT_VALUE)
    }
    const isKept = typeof value === 'number' || typeof value === 'boolean' || value === null || typeof value === 'string'
    // A total a rows line already says (`10 of 3,766`) is not a line of its own.
    if (!isKept || totals.has(path)) return
    const field = fieldAt(ir, path)
    found.push({
      field: field?.name ?? path.split('.').pop() ?? path,
      value: value as number | boolean | null | string,
      path,
      // By the root's response key, as `rows` are: two aliases of one field are two roots.
      ...(!isRoot && { root: rootKey }),
      ...(!isRoot && isOnly && { isOnly: true }),
    })
  }
  // Linear in the response: a root that is an untyped map of 20,000 keys is read once, and no further than the lines kept.
  for (const [key, value] of Object.entries(data)) {
    if (found.length >= MAX_SCALARS) break
    if (!isRecord(value)) {
      keep(key, value, key, true, true)
      continue
    }
    const entries = Object.entries(value)
    const isOnly = entries.length === 1
    const isRecordRoot = !entries.some(([, child]) => Array.isArray(child))
    for (const [inner, child] of entries) {
      if (found.length >= MAX_SCALARS) break
      if (!Array.isArray(child) && !isRecord(child)) keep(`${key}.${inner}`, child, key, false, isOnly, isRecordRoot)
    }
  }
  return found.slice(0, MAX_SCALARS)
}

const MAX_SCALARS = 12
/** A single record's text fields kept per root, and how long each is kept (it wraps when drawn, never cut). */
const MAX_TEXT_FIELDS = 8
const MAX_TEXT_VALUE = 300
const PLUMBING = /^(cursor|next|after|before|nextPage|requestId|request_id)$|(Cursor|Token|_token|_cursor)$/

const isIndex = (segment: string) => /^\d+$/.test(segment)
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const MAX_TOKEN = 16_384

/** Base64url text to a string (UTF-8), or undefined when it is not base64url. No platform decoder is assumed. */
function decodeBase64Url(text: string): string | undefined {
  const bytes: number[] = []
  let bits = 0
  let held = 0
  for (const char of text.replace(/=+$/, '')) {
    const value = BASE64URL.indexOf(char)
    if (value < 0) return undefined
    held = (held << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((held >> bits) & 0xff)
      held &= (1 << bits) - 1
    }
  }
  try {
    return decodeURIComponent(bytes.map(byte => `%${byte.toString(16).padStart(2, '0')}`).join(''))
  } catch {
    return undefined
  }
}

const CLASSIFICATION = /^[a-z0-9.-]{1,20}$/

/**
 * Agent Services' own classification of a denied field, read from the payload of its
 * `denial_context` JWT (the middle segment; display only, never verified).
 * Only the classification string comes out: the token, its ids and its rule
 * ids are never kept. A malformed token reads as nothing.
 */
export function classificationOf(token: string, field?: string): string | undefined {
  return denialFactsOf(token, field).classification
}

/** What an access request's draft names: the denied field's schema coordinate, its service and the policy's reason. */
export type DenialFacts = { classification?: string; coord?: string; service?: string; reason?: string }

const COORD = /^[A-Za-z_][A-Za-z0-9_]{0,99}\.[A-Za-z_][A-Za-z0-9_]{0,99}$/
const SERVICE = /^[a-z0-9][a-z0-9-]{0,62}$/
const REASON_MAX = 300

/**
 * What the `denial_context` JWT says of a denied field (its payload; display
 * only, never verified): the classification, the field's schema coordinate
 * (`Slack_User.realName`), the service name, and the policy's reason, each
 * checked against its own shape and bounded. Ids, rule ids and the token
 * itself are never kept. A malformed token reads as nothing.
 */
export function denialFactsOf(token: string, field?: string): DenialFacts {
  if (token.length > MAX_TOKEN) return {}
  const payload = token.split('.')[1]
  if (payload === undefined) return {}
  const text = decodeBase64Url(payload)
  if (text === undefined) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return {}
  }
  if (!isRecord(parsed)) return {}
  const blocked = Array.isArray(parsed.blocked_fields) ? parsed.blocked_fields.filter(isRecord) : []
  const own = blocked.find(one => typeof one.coord === 'string' && field !== undefined && one.coord.endsWith(`.${field}`))
  const chosen = own ?? (blocked.length === 1 ? blocked[0] : undefined)
  const { classification, coord, reason } = chosen ?? {}
  const service = parsed.service_name
  return {
    ...(typeof classification === 'string' && CLASSIFICATION.test(classification) && { classification }),
    ...(typeof coord === 'string' && COORD.test(coord) && { coord }),
    ...(typeof service === 'string' && SERVICE.test(service) && { service }),
    ...(typeof reason === 'string' && reason.trim() !== '' && { reason: tidy(reason, REASON_MAX) }),
  }
}

/** The length of the list a response path runs through: its first index's parent, when `path` has exactly one index. */
function listLength(data: Record<string, unknown> | undefined, segments: readonly string[]): number | undefined {
  const at = segments.findIndex(isIndex)
  if (at < 1 || segments.slice(at + 1).some(isIndex)) return undefined
  let node: unknown = data
  for (const key of segments.slice(0, at)) node = isRecord(node) ? node[key] : undefined
  return Array.isArray(node) ? node.length : undefined
}

/** What the denials of one field came to under one root, while the errors are read. */
type Tally = { root: string; field: string; rows: Set<string>; list?: string; of?: number; classification?: string; coord?: string; service?: string; reason?: string; isRequestable: boolean; isPrivate: boolean; hasToken: boolean }

const MAX_TALLY_ROWS = 100_000
/** Most (root, field) pairs tallied: what is kept in $.state stays bounded however many fields a response denies. */
const MAX_TALLIES = 100

/**
 * Folds one denial into the tally of its field under its root. A row is the
 * innermost list item the field sits in (`teams.0.members.2` for
 * `teams.0.members.2.email`), so a field denied twice in one row, by two
 * paths (`creator.user.email`, `assignee.user.email`), is one row; a path
 * with no list index belongs to a root that is not a list, and has no rows.
 */
function tallyDenial(
  tallies: Map<string, Tally>,
  segments: readonly string[],
  field: string,
  data: Record<string, unknown> | undefined,
  facts: { classification: string | undefined; visibility: unknown; hasToken: boolean; facts?: DenialFacts },
): void {
  const root = segments[0]
  if (root === undefined) return
  const key = `${root}\u0000${field}`
  if (tallies.size >= MAX_TALLIES && !tallies.has(key)) return
  const tally = tallies.get(key) ?? { root, field, rows: new Set<string>(), isRequestable: false, isPrivate: false, hasToken: false }
  tallies.set(key, tally)
  let last = -1
  segments.forEach((segment, at) => {
    if (at > 0 && isIndex(segment)) last = at
  })
  if (last > 0 && tally.rows.size < MAX_TALLY_ROWS) {
    tally.rows.add(segments.slice(0, last + 1).join('.'))
    tally.list ??= segments.slice(0, last).filter(segment => !isIndex(segment)).join('.')
    tally.of ??= listLength(data, segments)
  }
  if (facts.classification !== undefined) tally.classification ??= facts.classification
  if (facts.facts?.coord !== undefined) tally.coord ??= facts.facts.coord
  if (facts.facts?.service !== undefined) tally.service ??= facts.facts.service
  if (facts.facts?.reason !== undefined) tally.reason ??= facts.facts.reason
  if (facts.visibility === 'requestable') tally.isRequestable = true
  else if (facts.visibility !== undefined) tally.isPrivate = true
  if (facts.hasToken) tally.hasToken = true
}

/** The longest error message kept, in characters; it wraps when drawn. */
const MESSAGE_MAX = 600
/** Most error lines an outcome keeps, each of its own kind (errors of one kind are one line with a count): far past what a response says. */
const MAX_ERRORS = 50

/** Most characters of a saved result the mod will read back: the 4 MiB `$.fs.read` bound, held lower. */
export const MAX_SAVED = 2_000_000

/**
 * Claude Code swaps a result over its size limit for a stand-in text that
 * names the file it saved the whole result to, in one of two forms:
 * `result (79,951 characters across 1 line) exceeds maximum allowed tokens.
 * Output has been saved to <path>`, or (2.1.29x) `<persisted-output> Output
 * too large (58.2KB). Full output saved to: <path> Preview (first 2KB): …`.
 * What that text says: the size and the saved path.
 */
export function truncationOf(result: unknown): { chars?: number; path?: string } | undefined {
  const text = textOf(result)
  // JSON responses can quote an engine notice as ordinary record content.
  if (text !== undefined && /^\s*(?:\{|\[|")/.test(text)) return undefined
  if (text === undefined || !(/exceeds maximum allowed tokens/i.test(text) || /^\s*<persisted-output>\s*Output too large/i.test(text))) return undefined
  const counted = /\(([\d,]+) characters/.exec(text)?.[1]
  const sized = /Output too large \((\d+(?:\.\d+)?)\s*(B|KB|MB)\)/i.exec(text)
  const chars = counted !== undefined ? Number(counted.replace(/,/g, '')) : sized === null ? undefined : Math.round(Number(sized[1]) * ({ b: 1, kb: 1024, mb: 1024 * 1024 } as Record<string, number>)[(sized[2] ?? 'B').toLowerCase()]!)
  // The path is the rest of its line, whatever it holds (a home folder with a space in it, a Windows path), to the file's extension.
  const line = /saved to:?[ \t]*([^\r\n]+)/i.exec(text)?.[1]?.trim()
  const path = line === undefined ? undefined : /^(.*?\.(?:txt|json))(?=[\s.,;)]|$)/.exec(line)?.[1]
  return {
    ...(chars !== undefined && Number.isFinite(chars) && { chars }),
    // Only a file Claude Code itself saved: an absolute path under a `.claude/projects/` tree, never a `..` walk.
    ...(path !== undefined && SAVED_PATH.test(path) && !path.includes('..') && { path }),
  }
}

/** Where Claude Code saves an oversized result: `<home>/.claude/projects/<project>/[<session>/]tool-results/<file>.txt|json`, by `/` or (Windows) `\`, from a drive or the root. */
const SAVED_PATH = /^(?:[A-Za-z]:)?[\\/](?:[^\\/\r\n]+[\\/])*\.claude[\\/]projects[\\/][^\\/]+[\\/](?:[^\\/]+[\\/])?tool-results[\\/][A-Za-z0-9._-]+\.(?:txt|json)$/

/**
 * The tool result to read a response from: the content blocks (`result`) when they
 * hold the response itself, else the model-facing `text`. A stand-in error text
 * for an oversized result never wins over blocks that hold the whole response.
 */
export function pickResult(text: unknown, result: unknown): unknown {
  const asText = typeof text === 'string' ? text : undefined
  if (asText !== undefined && truncationOf(asText) === undefined) return asText
  return textOf(result) !== undefined && truncationOf(result) === undefined ? result : (asText ?? result)
}

/** A response's text, unwrapped once more when it is itself a content-block array (a saved tool result). */
function responseOf(text: string): unknown {
  const parsed: unknown = JSON.parse(text)
  const inner = Array.isArray(parsed) ? textOf(parsed) : undefined
  return inner === undefined ? parsed : JSON.parse(inner)
}

/** The parsed GraphQL response in a tool result (see textOf, responseOf), or undefined when there is none or it is not JSON. */
export function responseIn(result: unknown): unknown {
  const text = textOf(result)
  if (text === undefined) return undefined
  try {
    return responseOf(text)
  } catch {
    return undefined
  }
}

/** How much of a result that is not a GraphQL response the pane says, escaped: enough for `upstream … timed out after 30s`, and its line wraps. */
const UNREADABLE_MAX = 300

/** What the pane says of a result with no text in it at all. */
export const NO_TEXT = 'no text came back'

/**
 * A result that is not a GraphQL response (a timeout's text, an HTML error
 * page, JSON that is not an object): nothing came back to read, and the text
 * itself, whitespace laid flat, escaped and bounded, is its one error line.
 */
function unreadableOf(text: string | undefined): CallOutcome {
  // A saved tool result is content blocks: what the tool said is the text inside.
  let said = text ?? ''
  try {
    const parsed: unknown = JSON.parse(said)
    if (Array.isArray(parsed)) said = textOf(parsed) ?? said
  } catch {
    // Not JSON: the text as it is.
  }
  const flat = said.replace(/\s+/g, ' ').trim()
  const message = flat === '' ? NO_TEXT : escapeText(flat, UNREADABLE_MAX).text
  return { rows: [], errors: [{ message }], authLinks: [], hasData: false, isUnreadable: true }
}

export function outcomeOf(ir: CallIR, result: unknown, config: LinkConfig = configOf()): CallOutcome {
  const text = textOf(result)
  if (text === undefined) return unreadableOf(undefined)
  let response: unknown
  try {
    response = responseOf(text)
  } catch {
    // Claude Code's stand-in for a result over its size limit: the call ran, and its response is in a file.
    const found = truncationOf(text)
    if (found === undefined) return unreadableOf(text)
    return { rows: [], errors: [], authLinks: [], isUnreadable: true, isTooLarge: true, ...(found.chars !== undefined && { size: found.chars }) }
  }
  if (!isRecord(response)) return unreadableOf(text)

  const errors: CallOutcome['errors'] = []
  const authLinks: CallOutcome['authLinks'] = []
  const data = isRecord(response.data) ? response.data : undefined
  const found = data === undefined ? undefined : rowsOf(ir, data, config)
  // Errors that share a code and a normalized path (`root.*.email`) are one entry with a count, tagged rows counted in, and so are errors at no path that share a code and a message; the entry is listed once a denial of it is not on a shown row.
  const grouped = new Map<string, { entry: CallOutcome['errors'][number]; seen: Set<string>; hits: number; isListed: boolean }>()
  const tallies = new Map<string, Tally>()
  for (const error of Array.isArray(response.errors) ? response.errors : []) {
    if (!isRecord(error)) continue
    const extensions = isRecord(error.extensions) ? error.extensions : {}
    const code = typeof extensions.code === 'string' ? extensions.code : undefined
    const segments = Array.isArray(error.path) && error.path.length > 0 ? error.path.map(String) : undefined
    if (code === 'UPSTREAM_AUTH_REQUIRED') {
      // Told once per service and URL; with no https link to show, it is an error like any other.
      let isLinked = false
      for (const source of Array.isArray(extensions.sources) ? extensions.sources : []) {
        if (!isRecord(source) || typeof source.authorizationUrl !== 'string' || !/^https:\/\//.test(source.authorizationUrl)) continue
        isLinked = true
        const link = { service: String(source.name ?? extensions.service ?? ''), url: source.authorizationUrl }
        if (!authLinks.some(one => one.service === link.service && one.url === link.url)) authLinks.push(link)
      }
      if (isLinked) continue
    }
    const isDenied = typeof extensions.denial_context === 'string' || code === 'CONSTELLATION_ACCESS_DENIED'
    const keys = segments?.filter(segment => !isIndex(segment))
    const name = keys === undefined || keys.length === 0 ? undefined : (fieldAt(ir, keys.join('.'))?.name ?? keys[keys.length - 1])
    const facts = isDenied && typeof extensions.denial_context === 'string' ? denialFactsOf(extensions.denial_context, name) : {}
    const classification = facts.classification
    if (isDenied && segments !== undefined && name !== undefined) tallyDenial(tallies, segments, name, data, { classification, visibility: extensions.visibility, hasToken: typeof extensions.denial_context === 'string', facts })
    const isExpected = isDenied && keys !== undefined && fieldAt(ir, keys.join('.'))?.policy === 'deny'
    const isTagged =
      isDenied &&
      segments !== undefined &&
      found !== undefined &&
      found.slots.length > 0 &&
      tagItem(ir, found.slots, segments, {
        ...(classification !== undefined && { classification }),
        ...(extensions.visibility !== undefined && { isRequestable: extensions.visibility === 'requestable' }),
        ...(isExpected && { isExpected: true }),
        ...(typeof extensions.denial_context === 'string' && { hasToken: true }),
      })
    const path = segments?.map(segment => (isIndex(segment) ? '*' : segment)).join('.')
    const message = typeof error.message === 'string' ? tidy(error.message, MESSAGE_MAX) : 'error'
    // Every policy denial of a field is the same kind of error, whatever code carried it; an error at no path is one kind by its code and message.
    const key = segments === undefined ? `${code ?? ''}\u0001${message}` : `${isDenied ? 'denied' : (code ?? '')}\u0000${path ?? ''}`
    let group = grouped.get(key)
    if (group === undefined) {
      const total = segments === undefined ? undefined : listLength(data, segments)
      const entry: CallOutcome['errors'][number] = {
        message,
        ...(code !== undefined && { code }),
        ...(path !== undefined && { path }),
        ...(name !== undefined && { field: name }),
        ...(isDenied && { isDenied: true }),
        ...(isExpected && { isExpected: true }),
        ...(isDenied && extensions.visibility !== undefined && { isRequestable: extensions.visibility === 'requestable' }),
        ...(classification !== undefined && { classification }),
        ...(facts.coord !== undefined && { coord: facts.coord }),
        ...(facts.service !== undefined && { service: facts.service }),
        ...(facts.reason !== undefined && { reason: facts.reason }),
        ...(isDenied && typeof extensions.denial_context === 'string' && { hasToken: true }),
        ...(total !== undefined && { of: total }),
      }
      group = { entry, seen: new Set(), hits: 0, isListed: false }
      grouped.set(key, group)
    }
    // Distinct items at a path; each error at no path.
    if (segments !== undefined) group.seen.add(segments.join('.'))
    group.hits += 1
    const count = segments === undefined ? group.hits : group.seen.size
    if (count > 1) group.entry.count = count
    if (isTagged || group.isListed) continue
    // A safety bound on what is kept in $.state: past it, an error of a kind not yet listed is left out.
    if (errors.length >= MAX_ERRORS) continue
    group.isListed = true
    errors.push(group.entry)
  }
  // A denied field shows its tag, never a value.
  for (const slot of found?.slots ?? []) {
    for (const item of slot.items) {
      for (const tag of item.denied ?? []) {
        const own = item.fields?.find(one => one.name === tag.field)
        if (own !== undefined) delete own.value
        else if ((item.fields?.length ?? 0) < MAX_FIELDS) item.fields = [...(item.fields ?? []), { name: tag.field }]
      }
    }
  }
  const denials = [...tallies.values()].map(tally => ({
    root: tally.root,
    field: tally.field,
    ...(tally.rows.size > 0 && { rows: tally.of === undefined ? tally.rows.size : Math.min(tally.rows.size, tally.of) }),
    ...(tally.rows.size > 0 && tally.of !== undefined && { of: tally.of }),
    ...(tally.list !== undefined && { list: tally.list }),
    ...(tally.classification !== undefined && { classification: tally.classification }),
    ...(tally.coord !== undefined && { coord: tally.coord }),
    ...(tally.service !== undefined && { service: tally.service }),
    ...(tally.reason !== undefined && { reason: tally.reason }),
    ...(tally.isPrivate ? { isRequestable: false } : tally.isRequestable ? { isRequestable: true } : {}),
    ...(tally.hasToken && { hasToken: true }),
  }))
  // What the response cost in context: bounded and small (src/weight.ts), kept in place of the response, which is not.
  const weight = weightOf(ir, response)
  // A write's new values the response says back: confirmed, or not, by field.
  const confirms = confirmOf(ir, data)
  return {
    rows: found?.rows ?? [],
    // At most 3 roots keep a preview, 25 rows each: about 150 KB for a three-root Slack search of long messages, which only the newest history entry keeps; an older one keeps about 20 KB of it (compactOutcome).
    ...(found !== undefined && found.preview.length > 0 && { preview: found.preview.slice(0, 3) }),
    ...(data !== undefined && { scalars: scalarsOf(ir, data, found?.totals ?? new Set()) }),
    errors,
    ...(denials.length > 0 && { denials }),
    authLinks,
    hasData: data !== undefined,
    ...(weight !== undefined && { weight }),
    ...(confirms.length > 0 && { confirms }),
  }
}

/**
 * A full response recovered from a saved file or retained content blocks when
 * Claude received a saved-output notice. Its measured weight is marked as
 * persisted because Claude saw only the preview and the file's path.
 */
export function savedOutcome(full: CallOutcome): CallOutcome {
  return full.weight === undefined ? full : { ...full, weight: persistedWeight(full.weight) }
}

/** What an older history entry keeps of a row's label and text, and of a card's field value: more than a closed row draws (three rows). */
const COMPACT_TEXT = 400
const COMPACT_VALUE = 80

/**
 * An outcome as an older history entry keeps it (src/queue.ts): each list's
 * rows the pane shows before a press (PREVIEW_SHOWN), the rest counted in
 * `more`, and each row's words and card values held to a few hundred
 * characters, so twenty entries stay small when $.state is written. A
 * denial on a row it drops is already one of the outcome's error lines.
 * The same outcome again when there is nothing to trim.
 */
export function compactOutcome(outcome: CallOutcome): CallOutcome {
  const preview = outcome.preview
  if (preview === undefined) return outcome
  const isCompact = preview.every(list => list.items.length <= PREVIEW_SHOWN && list.items.every(item => item.label.length <= COMPACT_TEXT && (item.text?.length ?? 0) <= COMPACT_TEXT && (item.fields ?? []).every(field => (field.value?.length ?? 0) <= COMPACT_VALUE)))
  if (isCompact) return outcome
  return {
    ...outcome,
    preview: preview.map(list => {
      const items = list.items.slice(0, PREVIEW_SHOWN).map(item => ({
        ...item,
        label: tidy(item.label, COMPACT_TEXT),
        ...(item.text !== undefined && { text: tidy(item.text, COMPACT_TEXT) }),
        ...(item.fields !== undefined && { fields: item.fields.map(field => (field.value === undefined ? field : { ...field, value: tidy(field.value, COMPACT_VALUE) })) }),
      }))
      return { ...list, items, ...(list.at !== undefined && { at: list.at.slice(0, items.length) }), more: list.more + list.items.length - items.length }
    }),
  }
}
