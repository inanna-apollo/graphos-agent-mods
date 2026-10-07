// What a write will change, read from its own arguments and the schema: no
// read of the current state (v1). Pure: no $.
//
// For each mutation root: the target (an issue key, a page id, a channel and
// thread, a comment id), the kind of change (create, update, transition,
// delete, assign, react), and the new values field by field, Jira's `update`
// operations as + and −, bodies flattened to lines (./flatten.ts). A root the
// hand-mapped table knows (./table.ts) reads as the table says; any other is
// read generically from its arguments: the id-like ones name the target,
// every other one it sets is a new value. Flags that need no read (`@channel`,
// `replyBroadcast`, `notifyUsers: false`, admin overrides, `deleteSubtasks`,
// a delete that cannot be undone) come with it.
//
// Everything in the model is escaped (src/escape.ts): the values are the
// model's, the descriptions the schema's. The words are ours. Computed on
// demand from the IR (memoized per IR), never stored: v2 adds the
// before-state beside it (`ChangeRow.before`, `ChangeBlock.current`).

import { emojify } from '../emoji.ts'
import { escapeText } from '../escape.ts'
import { isRecord, own } from '../guards.ts'
import type { ArgIR, CallIR, FieldIR } from '../ir.ts'
import { wordsOf } from '../risk.ts'
import { broadcastsIn, broadcastsInBlocks, confluenceFormat, flatten, isAdf, stringOf } from './flatten.ts'
import type { BodyFormat, Broadcast, Line } from './flatten.ts'
import { JIRA_FIELDS, mappingOf } from './table.ts'
import type { ArgReading, ChangeKind, Mapping, ReadSpec } from './table.ts'

export type { ChangeKind } from './table.ts'

/** `+` a value the call sets or adds, `-` one it removes or deletes, `±` one it edits in place (Jira's `edit`), ` ` one it restates (said dim). */
export type Sign = '+' | '-' | '±' | ' '

/** What a row's card says: where the value is in the call, what the schema says of it, and what it means. All escaped. */
export type ChangeCard = {
  /** The call's argument the value is in. */
  arg: string
  /** Where inside the argument, for a field of opaque JSON or an input object (`fields.summary`). */
  path?: string
  /** The argument's type as the SDL writes it, once the schema is read. */
  type?: string
  /** The argument's schema description, once the schema is read (untrusted, escaped). */
  description?: string
  /** What the new value means, in our words. */
  meaning: string
  /** The value as the call wrote it, laid flat. */
  raw?: string
  /** The value sits inside untyped JSON, which the schema does not describe. */
  isJson?: boolean
  /** Inside an input object, by its type (`Pagerduty_CreateIncidentInput`). */
  inputType?: string
}

/** A body's lines (./flatten.ts), escaped: the first are drawn, the count says the rest. */
export type ChangeBody = { lines: Line[]; total: number; format: BodyFormat; isCapped: boolean; isRaw: boolean; links: string[]; mentions: string[] }

export type ChangeRow = {
  sign: Sign
  /** The field, as the reader knows it (`summary`, `body`, `version`). */
  label: string
  /** The value on one line; for a body, its size (`12 lines · rich text`). */
  text: string
  /** Restated, not a change: required on every call and set to what it almost always is. */
  isDim?: true
  body?: ChangeBody
  card: ChangeCard
  /**
   * Where the response says the value back, below the root's response key, by
   * real field names (`version.number`): RESULT confirms it once the call ran
   * (./confirm.ts). `value` is the call's value, raw.
   */
  back?: { path: string; value: unknown; format?: BodyFormat }
  /** v2: what the record holds now. v1 never reads it. */
  before?: string
}

/** One part of a target: an argument that names it, or where it is. */
export type TargetPart = {
  arg: string
  role: 'id' | 'where'
  /** How the header says it: `issue DEV-634`, `in C0123`. */
  words: string
  value: string
  type?: string
  description?: string
}

export type Target = {
  /** The header's words, parts ` · ` apart: `comment 10042 · on DEV-634`. */
  words: string
  /** The same for a sentence, parts a space apart: `comment 10042 on DEV-634`. */
  short: string
  parts: TargetPart[]
  /** What the target is: `issue`, `page`, `message`. */
  noun: string
}

/** A risk the call's own arguments show: drawn on the flags line, said in full on its card. */
export type PreviewFlag = { text: string; detail: string; tone: 'write' | 'warn' }

export type ChangeBlock = {
  /** The root's response key path, as the form's blocks are keyed. */
  path: string
  /** The root's real name, escaped. */
  root: string
  kind: ChangeKind
  /** `CHANGES`, or what a create makes: `NEW MESSAGE`. */
  section: string
  target: Target
  rows: ChangeRow[]
  /** Rows past MAX_ROWS, counted only. */
  more: number
  /** Dim words at the block's foot: that the current state is not read, what a delete leaves. */
  notes: string[]
  flags: PreviewFlag[]
  /** Read from the hand-mapped table, or generically from the schema; `unread` when reading its arguments failed (the block says so, never nothing). */
  source: 'mapped' | 'schema' | 'unread'
  /** How the change was read, for the section's card. */
  how: string
  /** v1: a create has no current state (`none`); anything else's is `not-read`. v2 adds the read's states. */
  current: 'none' | 'not-read'
  /** The change in a few words, for the transcript line. */
  phrase: string
  /** The stored read (v2), never run here. */
  read?: ReadSpec
}

/**
 * `blocks` are drawn, at most MAX_BLOCKS (the last saying how many more there
 * are); `all` is every write root's block, drawn or not, so a flag on the
 * ninth root (`@channel`, `cannot be undone`) is still raised.
 */
export type WritePreview = { blocks: ChangeBlock[]; all: ChangeBlock[] }

/** Write roots drawn per call, rows per block, and characters of a value: generous bounds. */
export const MAX_BLOCKS = 8
export const MAX_ROWS = 24
const VALUE_MAX = 2_000
const RAW_MAX = 2_000
const ITEMS_MAX = 20
/** How deep a value's lists are read for its one-line words; deeper, a list is `[nested list]`. */
const DEPTH_MAX = 16

const e = (text: string, max = VALUE_MAX) => escapeText(text, max).text
/** A value as one line: escaped, whitespace laid flat. */
const flatText = (text: string, max = VALUE_MAX) => e(text, max).replace(/\s+/g, ' ').trim()

/** What a new-value note says when the current state is not read. */
export const NOT_READ = 'new values only · current state not read'
/** What a delete's note says. */
export const DELETE_NOT_READ = 'not read first · its contents are not shown'
/** What a block says when its root's arguments could not be read. */
export const UNREAD = 'what this call changes could not be read: the form below shows its arguments'
/** The note under the last block drawn when more write roots follow. */
export const moreWrites = (count: number) => `${count} more write${count === 1 ? '' : 's'} not shown`

// ---- Values

/** A JSON value from an argument: the value, or a JSON string that holds an object or a list. */
function jsonOf(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (trimmed.length > 256 * 1024 || !(trimmed.startsWith('{') || trimmed.startsWith('['))) return value
  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

/** The value at a dotted path into the call's arguments (`fields.project.key`); undefined when unset. */
function valueAt(root: FieldIR, path: string): unknown {
  const [head, ...rest] = path.split('.')
  let value: unknown = root.args.find(arg => arg.name === head)?.value
  for (const key of rest) {
    value = jsonOf(value)
    if (Array.isArray(value) && /^\d+$/.test(key)) value = value[Number(key)]
    else if (isRecord(value) && Object.prototype.hasOwnProperty.call(value, key)) value = value[key]
    else return undefined
  }
  return value
}

const isSet = (value: unknown) => value !== undefined

/** The scalar that names an object (`status: { name: "Done" }` → `Done`, `priority: { id: "2" }` → `id 2`), else undefined. */
function namedOf(value: Record<string, unknown>): string | undefined {
  for (const key of ['name', 'displayName', 'value', 'key']) {
    const one = value[key]
    if (typeof one === 'string' || typeof one === 'number') return String(one)
  }
  if (typeof value.accountId === 'string') return value.accountId
  if (typeof value.id === 'string' || typeof value.id === 'number') return `id ${value.id}`
  return undefined
}

/** A value on one line, as the reader takes it: a string as is, an object by what names it, a list's items ` · ` apart, lists read DEPTH_MAX deep. Escaped. */
export function shortValue(value: unknown, depth = 0): string {
  const parsed = jsonOf(value)
  if (parsed === null) return 'none'
  if (typeof parsed === 'string') return parsed.trim() === '' ? '(empty)' : flatText(parsed)
  if (typeof parsed === 'number' || typeof parsed === 'boolean') return String(parsed)
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return 'none'
    if (depth >= DEPTH_MAX) return '[nested list]'
    const items = parsed.slice(0, ITEMS_MAX).map(item => (isRecord(item) ? (namedOf(item) ?? flatText(stringOf(item), 200)) : shortValue(item, depth + 1)))
    return flatText(`${items.join(' · ')}${parsed.length > ITEMS_MAX ? ` · +${parsed.length - ITEMS_MAX} more` : ''}`)
  }
  if (isRecord(parsed)) return flatText(namedOf(parsed) ?? stringOf(parsed))
  return flatText(stringOf(parsed))
}

/** The value as the call wrote it, for the card: flat JSON, escaped. */
const rawOf = (value: unknown) => flatText(stringOf(value), RAW_MAX)

/** Plain words a body's count line says its format in (`rich text`, `page markup`); the row's card has the technical name (FORMAT_WORDS). */
export const FORMAT_SHORT: Record<BodyFormat, string> = { adf: 'rich\u00a0text', storage: 'page\u00a0markup', wiki: 'wiki\u00a0markup', mrkdwn: 'Slack\u00a0markup', blocks: 'Slack\u00a0layout', attachments: 'attachments', text: 'plain\u00a0text' }

/** `12 lines`, its words held together where a line breaks. */
const linesWord = (count: number) => `${count.toLocaleString('en-US')}\u00a0line${count === 1 ? '' : 's'}`

/** A body row, or a value row when the body is one short line: a one-line message reads as its words. */
function bodyRow(label: string, value: unknown, format: BodyFormat, card: ChangeCard, sign: Sign = '+', back?: string): ChangeRow {
  const flat = flatten(value, format)
  const only = flat.lines[0]
  const backed = back === undefined ? {} : { back: { path: back, value, format } }
  const body: ChangeBody = { lines: flat.lines, total: flat.total, format, isCapped: flat.isCapped, isRaw: flat.isRaw === true, links: flat.links, mentions: flat.mentions }
  if (flat.total <= 1 && only !== undefined && only.kind !== 'code' && only.text.length <= 200) return { sign, label, text: only.text === '' ? '(empty)' : only.text, card, body, ...backed }
  if (flat.total === 0) return { sign, label, text: '(empty)', card, body, ...backed }
  return { sign, label, text: `${linesWord(flat.total)}${flat.isCapped ? ' or more' : ''} · ${FORMAT_SHORT[format]}`, card, body, ...backed }
}

// ---- Target

/** Words before a where part, and the part's value. */
function partOf(root: FieldIR, arg: string, role: TargetPart['role'], words: string): TargetPart | undefined {
  const value = valueAt(root, arg)
  if (!isSet(value) || value === null || value === '') return undefined
  const top = root.args.find(one => one.name === arg.split('.')[0])
  const shown = shortValue(value)
  return {
    arg: e(arg, 200),
    role,
    words: `${words === '' ? '' : `${words} `}${shown}`,
    value: shown,
    ...(top?.type !== undefined && !arg.includes('.') && { type: e(top.type, 200) }),
    ...(top?.description !== undefined && !arg.includes('.') && { description: e(top.description, 4000) }),
  }
}

function targetOf(parts: TargetPart[], noun: string): Target {
  return { words: parts.map(part => part.words).join(' · '), short: parts.map(part => part.words).join(' '), parts, noun }
}

// ---- Mapped roots

const isTrue = (value: unknown) => value === true || value === 'true'
const isFalse = (value: unknown) => value === false || value === 'false'

/** The card of an argument the table reads. */
function cardFor(arg: ArgIR | undefined, name: string, meaning: string, value: unknown, extra: Partial<ChangeCard> = {}): ChangeCard {
  return {
    arg: e(name, 200),
    ...(arg?.type !== undefined && { type: e(arg.type, 200) }),
    ...(arg?.description !== undefined && { description: e(arg.description, 4000) }),
    meaning,
    ...(value !== undefined && { raw: rawOf(value) }),
    ...extra,
  }
}

/** Rows for Jira's opaque `fields` JSON: one per field, a rich-text one as a body. */
function jiraFieldRows(arg: ArgIR, skip: readonly string[] = []): ChangeRow[] {
  const value = jsonOf(arg.value)
  if (!isRecord(value)) return [{ sign: '+', label: flatText(arg.name, 120), text: shortValue(arg.value), card: cardFor(arg, arg.name, 'fields as the call sets them; Jira expects an object of field names to values', arg.value) }]
  return Object.entries(value)
    .filter(([key]) => !skip.includes(key))
    .map(([key, one]) => {
      // Laid flat: a key with a newline in it would draw rows the planner does not count.
      const label = flatText(key, 120)
      // Set through `fields`, a list is replaced whole (`update`'s add and remove change it in place).
      const replaces = REPLACED_LISTS.has(key) ? '; setting it here replaces the whole list' : ''
      const meaning = `sets ${label}: ${own(JIRA_FIELDS, key) ?? 'a field of the issue'}${replaces}${key.startsWith('customfield_') ? ' (a custom field: its name is in the issue’s field names, which are not read)' : ''}`
      const card = cardFor(arg, arg.name, meaning, one, { path: flatText(`${arg.name}.${key}`, 200), isJson: true })
      if (isAdf(one) || (typeof one === 'string' && one.includes('\n'))) return bodyRow(label, one, isAdf(one) ? 'adf' : 'text', card, '+', `fields.${key}`)
      return { sign: '+' as const, label, text: shortValue(one), card, back: { path: `fields.${key}`, value: one } }
    })
}

/** Jira's list fields: set through `fields`, the list is replaced whole. */
const REPLACED_LISTS = new Set(['labels', 'components', 'fixVersions', 'versions'])

const UPDATE_OPS: Record<string, { sign: Sign; words: string }> = {
  add: { sign: '+', words: 'adds' },
  remove: { sign: '-', words: 'removes' },
  set: { sign: '+', words: 'replaces it with' },
  edit: { sign: '±', words: 'edits it in place to' },
  copy: { sign: '+', words: 'copies in' },
}

/** Rows for Jira's opaque `update` JSON: `{ labels: [{ add: "x" }, { remove: "y" }] }` reads `+ labels x`, `- labels y`. */
function jiraUpdateRows(arg: ArgIR): ChangeRow[] {
  const value = jsonOf(arg.value)
  if (!isRecord(value)) return [{ sign: '±', label: flatText(arg.name, 120), text: shortValue(arg.value), card: cardFor(arg, arg.name, 'operations as the call sets them; Jira expects an object of field names to lists of add, remove, set or edit', arg.value) }]
  const rows: ChangeRow[] = []
  for (const [key, ops] of Object.entries(value)) {
    const label = flatText(key, 120)
    for (const op of Array.isArray(ops) ? ops : [ops]) {
      const entries = isRecord(op) ? Object.entries(op) : [['edit', op] as const]
      for (const [verb, operand] of entries) {
        const known = own(UPDATE_OPS, verb) ?? { sign: '±' as const, words: `applies ${flatText(verb, 40)} with` }
        const what = own(JIRA_FIELDS, key) ?? 'a field of the issue'
        const card = cardFor(arg, arg.name, `${known.words} ${label === 'comment' ? 'a comment' : `${label} (${what})`}: one of Jira's update operations, which change a field without replacing the rest of it`, operand, { path: flatText(`${arg.name}.${key}`, 200), isJson: true })
        // A comment added through update is a body: `{ add: { body: <ADF> } }`.
        const body = isRecord(operand) && operand.body !== undefined ? operand.body : undefined
        if (body !== undefined) rows.push(bodyRow(label, body, isAdf(body) ? 'adf' : 'text', card, known.sign))
        else rows.push({ sign: known.sign, label, text: shortValue(operand), card })
      }
    }
  }
  return rows
}

/** The row for a Jira transition (`transition: { id: "31" }`): the id, since Jira knows each step of a workflow by it. */
function transitionRow(arg: ArgIR): ChangeRow {
  const value = jsonOf(arg.value)
  const id = isRecord(value) ? value.id : value
  const named = isRecord(value) && typeof value.name === 'string' ? ` The call also names it "${flatText(value.name, 120)}"; Jira acts on the id alone.` : ''
  const text = id === undefined || id === null ? '(no id given)' : shortValue(id)
  return {
    sign: '+',
    label: 'transition',
    text,
    card: cardFor(arg, arg.name, `moves the issue through transition ${text}: Jira knows each step of a workflow by its id, and the status it leads to is not read.${named}`, arg.value, { path: e(`${arg.name}.id`, 200), isJson: true }),
  }
}

/** The row for an assignee: an account id, or `-1` (Jira's automatic assignee) and null (unassigned) as words. */
function assigneeRow(arg: ArgIR): ChangeRow {
  const value = arg.value
  const text = value === null ? 'unassigned' : value === '-1' || value === -1 ? 'automatic' : shortValue(value)
  const meaning =
    value === null
      ? 'nobody: the issue becomes unassigned'
      : value === '-1' || value === -1
        ? "Jira's automatic assignee: the project's default"
        : `the account the issue is assigned to, by its ${arg.name === 'accountId' ? 'account id' : `user ${e(arg.name, 40)}`}; the account's name is not read`
  return { sign: '+', label: 'assignee', text, card: cardFor(arg, arg.name, meaning, value) }
}

/** The row for a Slack reaction: its emoji and its name. */
function reactionRow(arg: ArgIR, sign: '+' | '-'): ChangeRow {
  const name = typeof arg.value === 'string' ? arg.value.replace(/^:|:$/g, '') : shortValue(arg.value)
  const code = `:${flatText(name, 120)}:`
  const glyph = emojify(code)
  return { sign, label: 'reaction', text: glyph === code ? code : `${glyph} ${code}`, card: cardFor(arg, arg.name, `${sign === '+' ? 'adds' : 'removes'} the ${code} reaction, as you`, arg.value) }
}

/** The format a body is in: the table's, or the one its format argument names (Confluence's `bodyRepresentation`); Slack text with `mrkdwn: false` is plain. */
function formatOf(root: FieldIR, reading: Extract<ArgReading, { as: 'body' }>): BodyFormat {
  if (reading.formatArg !== undefined) return confluenceFormat(valueAt(root, reading.formatArg))
  if (reading.format === 'mrkdwn' && isFalse(valueAt(root, 'mrkdwn'))) return 'text'
  return reading.format
}

function mappedRows(root: FieldIR, mapping: Mapping): ChangeRow[] {
  const rows: ChangeRow[] = []
  for (const arg of root.args) {
    const reading: ArgReading = own(mapping.args, arg.name) ?? { as: 'value', meaning: `sets ${e(arg.name, 120)}` }
    if (!isSet(arg.value)) continue
    switch (reading.as) {
      case 'target':
      case 'skip':
        break
      case 'value': {
        const label = reading.label ?? flatText(arg.name, 120)
        const text = shortValue(arg.value)
        const isRestated = reading.restatedWhen !== undefined && arg.value === reading.restatedWhen
        const meaning = `${reading.meaning}${typeof arg.value === 'boolean' ? ` (the call sets ${String(arg.value)})` : ''}`
        rows.push({ sign: isRestated ? ' ' : '+', label, text, ...(isRestated && { isDim: true }), card: cardFor(arg, arg.name, meaning, arg.value), ...(reading.back !== undefined && { back: { path: reading.back, value: arg.value } }) })
        break
      }
      case 'body':
        rows.push(bodyRow(reading.label ?? flatText(arg.name, 120), arg.value, formatOf(root, reading), cardFor(arg, arg.name, reading.meaning, undefined), '+', reading.back))
        break
      case 'jira-fields':
        rows.push(...jiraFieldRows(arg, reading.skip))
        break
      case 'jira-update':
        rows.push(...jiraUpdateRows(arg))
        break
      case 'transition':
        rows.push(transitionRow(arg))
        break
      case 'assignee':
        rows.push(assigneeRow(arg))
        break
      case 'reaction':
        rows.push(reactionRow(arg, reading.sign))
        break
    }
  }
  // The transition leads: it is the change, the screen's fields ride on it.
  return [...rows.filter(row => row.label === 'transition'), ...rows.filter(row => row.label !== 'transition')]
}

/** The words a delete's row says for what goes. */
function deleteRow(target: Target, card: ChangeCard): ChangeRow {
  const id = target.parts.find(part => part.role === 'id')
  return { sign: '-', label: flatText(target.noun, 60), text: id?.value ?? '(no id given)', card }
}

/** Flags a Slack text or its blocks raise: the broadcasts it addresses. */
function broadcastFlags(root: FieldIR, isPost: boolean): PreviewFlag[] {
  const found = new Set<Broadcast>()
  for (const arg of root.args) {
    if (arg.name === 'text' || arg.name === 'attachments') for (const one of broadcastsIn(typeof arg.value === 'string' ? arg.value : stringOf(arg.value))) found.add(one)
    if (arg.name === 'blocks' || arg.name === 'attachments') for (const one of broadcastsInBlocks(arg.value)) found.add(one)
  }
  const said: Record<Broadcast, { text: string; who: string }> = {
    channel: { text: '@channel notifies the channel', who: 'every member of the channel, wherever they are' },
    here: { text: '@here notifies who is active', who: 'every member of the channel who is active now' },
    everyone: { text: '@everyone notifies the workspace', who: 'every member of the workspace' },
  }
  return [...found].map(one => ({
    text: said[one].text,
    detail: isPost ? `the text holds <!${one}>: Slack notifies ${said[one].who}` : `the new text holds <!${one}>, which addresses ${said[one].who}`,
    tone: 'write' as const,
  }))
}

function mappedFlags(root: FieldIR, mapping: Mapping, target: Target): PreviewFlag[] {
  const flags: PreviewFlag[] = []
  const at = (name: string) => valueAt(root, name)
  if (mapping.removal?.isPermanent === true) flags.push({ text: 'cannot be undone', detail: `${mapping.removal.words}${target.words === '' ? '' : ` (${target.short})`}`, tone: 'write' })
  if (mapping.root === 'jira_deleteIssue' && isTrue(at('deleteSubtasks'))) flags.push({ text: 'also deletes its subtasks', detail: 'deleteSubtasks is true: every subtask of the issue is deleted with it', tone: 'write' })
  if (root.name.startsWith('slack_')) {
    flags.push(...broadcastFlags(root, mapping.kind === 'create'))
    if (isTrue(at('replyBroadcast')) && isSet(at('threadTs'))) flags.push({ text: 'also posts to the channel', detail: 'replyBroadcast is true: the reply shows in the channel as well as in its thread', tone: 'warn' })
    const as = [at('username'), at('iconEmoji'), at('iconUrl')].filter(value => typeof value === 'string' && value !== '')
    if (as.length > 0) flags.push({ text: 'posts under another name or icon', detail: `username or icon set (${as.map(value => shortValue(value)).join(', ')}): the message shows a sender other than you`, tone: 'warn' })
  }
  if (isFalse(at('notifyUsers'))) flags.push({ text: 'watchers are not told', detail: "notifyUsers is false: Jira emails none of the issue's watchers about this change (it takes admin rights)", tone: 'warn' })
  for (const name of ['overrideScreenSecurity', 'overrideEditableFlag']) {
    if (isTrue(at(name))) flags.push({ text: `admin override: ${name}`, detail: `${name} is true: an admin override that lets the change through where the ${name === 'overrideScreenSecurity' ? 'screen hides a field' : 'issue is not editable in its status'}`, tone: 'write' })
  }
  return flags
}

/**
 * A value the call wrote, as a phrase holds it: ` · ` inside it reads `, `,
 * since the transcript line is split at ` · ` and colors a piece that opens
 * with ✓ or ⚑ (src/view/notice.ts quotes any such piece it did not make).
 */
export const inPhrase = (text: string) => text.replace(/\s+·\s+/g, ', ')

/** `{issueIdOrKey} → transition {row:transition}` with the call's values, the target and the rows. */
function phraseOf(template: string, root: FieldIR, target: Target, rows: readonly ChangeRow[]): string {
  const changed = rows.filter(row => row.isDim !== true)
  const labels = [...new Set(changed.map(row => row.label))]
  // Four are named; past that, three and a count: `+1 more` says less than the name it stands for.
  const shown = labels.length > 4 ? `${labels.slice(0, 3).join(', ')} +${labels.length - 3} more` : labels.join(', ')
  const out = template.replace(/\{([^{}]+)\}/g, (_, token: string) => {
    if (token === 'target') return target.short === '' ? '?' : inPhrase(target.short)
    if (token === 'labels') return inPhrase(shown)
    if (token.startsWith('row:')) {
      const row = rows.find(one => one.label === token.slice(4))
      return row === undefined ? '?' : inPhrase(row.text)
    }
    const value = valueAt(root, token)
    return value === undefined || value === null ? '?' : inPhrase(shortValue(value))
  })
  return out.replace(/:\s*$/, '').replace(/\s+/g, ' ').trim()
}

function mappedBlock(root: FieldIR, mapping: Mapping): ChangeBlock {
  const spec = mapping.target
  const ids = (spec.id ?? []).flatMap(arg => partOf(root, arg, 'id', spec.noun) ?? []).slice(0, 1)
  const wheres = (spec.where ?? []).flatMap(where => partOf(root, where.arg, 'where', where.words) ?? [])
  // A create's noun is in its section (`NEW COMMENT`); its target is where it goes.
  const target = targetOf([...ids, ...wheres], spec.noun)
  const all = mappedRows(root, mapping)
  const removal = mapping.kind === 'delete' ? deleteRow(target, { arg: e(spec.id?.[0] ?? '', 200), meaning: mapping.removal?.words ?? `deletes the ${spec.noun}`, ...(ids[0]?.type !== undefined && { type: ids[0].type }), ...(ids[0]?.description !== undefined && { description: ids[0].description }) }) : undefined
  const rows = [...(removal === undefined ? [] : [removal]), ...all]
  const section = mapping.sectionWhen !== undefined && isSet(valueAt(root, mapping.sectionWhen.arg)) ? mapping.sectionWhen.section : mapping.section
  const template = mapping.phraseWhen !== undefined && isSet(valueAt(root, mapping.phraseWhen.arg)) ? mapping.phraseWhen.phrase : mapping.phrase
  const notes = [
    ...(mapping.kind === 'create' ? [] : [mapping.kind === 'delete' ? DELETE_NOT_READ : NOT_READ]),
    ...(mapping.removal !== undefined && !mapping.removal.isPermanent ? [mapping.removal.words] : []),
    ...(mapping.keeps !== undefined ? [mapping.keeps] : []),
  ]
  // How it was read, in the reader's words: which arguments name the target, then where each row's meaning is.
  const idArgs = (spec.id ?? []).map(name => e(name, 80))
  const whereArgs = (spec.where ?? []).map(where => e(where.arg, 80))
  const naming = [idArgs.length > 0 ? `${idArgs.join(' or ')} names the ${spec.noun}` : '', whereArgs.length > 0 ? `${whereArgs.join(' or ')} ${idArgs.length > 0 ? 'says where it is' : 'says where it goes'}` : ''].filter(Boolean)
  const read = mapping.readWhen !== undefined && isSet(valueAt(root, mapping.readWhen.arg)) ? mapping.readWhen.read : mapping.read
  return {
    path: root.path,
    root: e(root.name, 200),
    kind: mapping.kind,
    section,
    target,
    rows: rows.slice(0, MAX_ROWS),
    more: Math.max(0, rows.length - MAX_ROWS),
    notes,
    flags: mappedFlags(root, mapping, target),
    source: 'mapped',
    how: `Read with a built-in mapping for ${e(root.name, 200)}: ${naming.length === 0 ? '' : `${naming.join(', ')}; `}each row's card says what its argument means.`,
    current: mapping.kind === 'create' ? 'none' : 'not-read',
    phrase: e(phraseOf(template, root, target, rows), 600),
    ...(read !== undefined && { read }),
  }
}

// ---- Any other mutation: read generically

/** Words that qualify a verb rather than being one (`bulkDelete`, `doTransition`). */
const MODIFIERS = new Set(['bulk', 'submit', 'partially', 'partial', 'fully', 'admin', 'do', 'batch', 'async'])
const CREATES = new Set(['create', 'add', 'send', 'post', 'schedule', 'insert', 'upload', 'new', 'invite', 'start', 'open', 'duplicate', 'copy', 'save', 'log', 'append', 'register', 'import'])
const DELETES = new Set(['delete', 'remove', 'archive', 'revoke', 'trash', 'destroy', 'purge', 'drop', 'wipe', 'erase', 'kick'])
const CHANGES = new Set(['update', 'edit', 'set', 'rename', 'transition', 'assign', 'move', 'patch', 'put', 'upsert', 'pin', 'unpin', 'resolve', 'merge', 'reset', 'restore', 'enable', 'disable', 'toggle', 'rank', 'swap', 'mark', 'close', 'reopen', 'approve', 'reject', 'change', 'modify', 'publish', 'unarchive', 'join', 'leave', 'cancel', 'stop', 'snooze', 'acknowledge', 'escalate', 'trigger', 'redact', 'estimate', 'link', 'unlink', 'invoke', 'run', 'clear'])
const isVerb = (word: string) => CREATES.has(word) || DELETES.has(word) || CHANGES.has(word)

/** A mutation's verb and the noun it acts on, from its name's words (`editIncident` → edit, incident; `openingUpdate` → update, opening). */
export function verbOf(name: string): { verb: string; noun: string; kind: ChangeKind } {
  const words = wordsOf(name.slice(name.indexOf('_') + 1)).filter((word, index, all) => !(MODIFIERS.has(word) && all.slice(index + 1).some(isVerb)))
  const at = words.findIndex(isVerb)
  const verb = at < 0 ? 'change' : (words[at] ?? 'change')
  const nounWords = at < 0 ? words : at === 0 ? words.slice(1) : words.slice(0, at)
  const kind: ChangeKind = CREATES.has(verb) ? 'create' : DELETES.has(verb) ? 'delete' : 'update'
  return { verb, noun: nounWords.join(' ') || 'record', kind }
}

/** An argument that names a record by id: `id`, `ts`, `channel`, `*Id`, `*IdOrKey`, `*Key`, `*Ts` (never an idempotency key), of an id-like type. */
const ID_NAME = /^(id|ts|timestamp|key|channel|uuid|guid)$|(?:Id|IdOrKey|Key|Ts|Guid|Uuid|_id|_key)$/
const PLUMBING = /^(idempotencyKey|clientMutationId|expand|limit|offset|total|returnIssue|historyMetadata)$/i
const ID_TYPES = /^(ID|String|Int|Long|BigInt)!?$/

const isIdArg = (arg: ArgIR) => ID_NAME.test(arg.name) && !PLUMBING.test(arg.name) && (arg.type === undefined || ID_TYPES.test(arg.type.replace(/\s+/g, ''))) && (typeof arg.value === 'string' || typeof arg.value === 'number')

/** What an id argument names: `incidentId` → incident; a bare `id` → the noun the root acts on. */
function nounOfId(name: string, noun: string): string {
  const stripped = name.replace(/(IdOrKey|Id|Key|Ts|Guid|Uuid|_id|_key)$/, '')
  if (stripped === '' || ['id', 'ts', 'timestamp', 'key', 'uuid', 'guid'].includes(name)) return noun.split(' ')[0] ?? 'record'
  return wordsOf(stripped).join(' ')
}

/** `update` → `updates`, `set` → `sets`, `reply` → `replies`. */
function thirdPerson(verb: string): string {
  if (/(s|sh|ch|x|z)$/.test(verb)) return `${verb}es`
  if (/[^aeiou]y$/.test(verb)) return `${verb.slice(0, -1)}ies`
  return `${verb}s`
}

/** Rows for one argument read generically: an object one or two levels in (an input object's fields), a long text as a body, else a value. */
function genericRows(arg: ArgIR): ChangeRow[] {
  const value = jsonOf(arg.value)
  const isInput = isRecord(value) && (/^input$/i.test(arg.name) || /Input!?$/.test(arg.type ?? ''))
  const named = /JSON!?$/.test(arg.type ?? '') ? { isJson: true } : {}
  const inputType = isInput && arg.type !== undefined ? { inputType: e(arg.type.replace(/!$/, ''), 200) } : {}
  const rowOf = (label: string, path: string, one: unknown): ChangeRow => {
    const meaning = path === arg.name ? `sets ${e(arg.name, 120)}` : `sets ${label}: a field inside ${isInput ? 'the input object' : 'the argument'} ${e(arg.name, 120)}`
    const card = cardFor(path === arg.name ? arg : undefined, arg.name, meaning, one, { ...(path !== arg.name && { path: flatText(path, 200) }), ...named, ...inputType })
    if (path === arg.name && arg.type !== undefined) card.type = e(arg.type, 200)
    if (typeof one === 'string' && (one.includes('\n') || one.length > 400)) return bodyRow(label, one, 'text', card)
    return { sign: '+', label, text: shortValue(one), card, back: { path: path.split('.').slice(isInput ? 1 : 0).join('.') || path, value: one } }
  }
  if (!isRecord(value)) return [rowOf(flatText(arg.name, 120), arg.name, arg.value)]
  const rows: ChangeRow[] = []
  // An input's own name says nothing (`input.title` reads `title`); another object's fields keep it (`filter.name`).
  const lead = isInput ? '' : `${arg.name}.`
  for (const [key, one] of Object.entries(value)) {
    const inner = jsonOf(one)
    if (isRecord(inner) && Object.keys(inner).length <= 12) {
      for (const [sub, two] of Object.entries(inner)) rows.push(rowOf(flatText(`${lead}${key}.${sub}`, 200), `${arg.name}.${key}.${sub}`, two))
    } else rows.push(rowOf(flatText(`${lead}${key}`, 200), `${arg.name}.${key}`, one))
  }
  return rows
}

/**
 * Switches that steer how a write is made rather than what it changes:
 * `notify…` and `override…` booleans. Not a change (as the table reads
 * Jira's `notifyUsers` and overrides): the form keeps them as rows of their
 * own, and one set to tell no one or to override is a flag.
 */
const isSteering = (arg: ArgIR) => /^(notify|override)/i.test(arg.name) && (typeof arg.value === 'boolean' || arg.value === 'true' || arg.value === 'false')

/** Who a notify switch tells, by its name only: `notifyIncidentChannel` the incident channel, `notifyUsers` the users; undefined for a bare `notify`. */
function toldOf(name: string): string | undefined {
  const words = wordsOf(name.replace(/^notify/i, ''))
  return words.length === 0 ? undefined : words.join(' ')
}

function genericFlags(root: FieldIR): PreviewFlag[] {
  const flags: PreviewFlag[] = []
  for (const arg of root.args) {
    if (/^notify/i.test(arg.name) && isFalse(arg.value)) {
      // Only what the name and the schema say: who is not told, never that no one is.
      const who = toldOf(arg.name)
      const name = e(arg.name, 60)
      const text = who === undefined ? `${name} false: no notification is sent` : `${name} false: the ${e(who, 60)} ${/s$/.test(who) ? 'are' : 'is'} not told`
      flags.push({ text, detail: `${e(arg.name, 120)} is false${arg.description === undefined ? '' : `: the schema says "${flatText(arg.description, 300)}"`}`, tone: 'warn' })
    }
    if (/^override/i.test(arg.name) && isTrue(arg.value)) flags.push({ text: `admin override: ${e(arg.name, 60)}`, detail: `${e(arg.name, 120)} is true: an override that lets the change through where the service would not`, tone: 'write' })
  }
  if (root.name.startsWith('slack_')) flags.push(...broadcastFlags(root, verbOf(root.name).kind === 'create'))
  return flags
}

function genericBlock(root: FieldIR): ChangeBlock {
  const { verb, noun, kind } = verbOf(root.name)
  const set = root.args.filter(arg => isSet(arg.value) && !PLUMBING.test(arg.name))
  const idArgs = set.filter(isIdArg)
  // The required ids name the record; with none required, the ones set do.
  const required = idArgs.filter(arg => arg.type?.trim().endsWith('!') === true)
  const naming = required.length > 0 ? required : idArgs
  const parts = naming.slice(0, 3).flatMap((arg, index) => {
    const words = kind === 'create' ? `on ${nounOfId(arg.name, noun)}` : nounOfId(arg.name, noun)
    return partOf(root, arg.name, kind === 'create' || index > 0 ? 'where' : 'id', words) ?? []
  })
  const target = targetOf(parts, kind === 'create' ? noun : (nounOfId(naming[0]?.name ?? 'id', noun) || noun))
  // A switch that steers the write (notify…, override…) is not a new value: the form shows it, the flags say what it does.
  const rest = set.filter(arg => !naming.slice(0, 3).includes(arg) && !isSteering(arg))
  const changes = rest.flatMap(genericRows)
  const removal = kind === 'delete' ? deleteRow(target, { arg: e(naming[0]?.name ?? '', 200), meaning: `deletes the ${e(target.noun, 120)}: whether it can be restored is the service's to say`, ...(parts[0]?.type !== undefined && { type: parts[0].type }) }) : undefined
  const rows = [...(removal === undefined ? [] : [removal]), ...changes]
  const section = kind === 'create' ? (noun.length <= 16 && noun !== 'record' ? `NEW ${noun.toUpperCase()}` : 'CREATES') : 'CHANGES'
  const named = naming.slice(0, 3).map(arg => e(arg.name, 80))
  const phrase = kind === 'create' ? `${thirdPerson(verb)} ${noun}${target.short === '' ? '' : ` ${inPhrase(target.short)}`}` : `${thirdPerson(verb)} ${target.short === '' ? noun : inPhrase(target.short)}`
  return {
    path: root.path,
    root: e(root.name, 200),
    kind,
    section,
    target,
    rows: rows.slice(0, MAX_ROWS),
    more: Math.max(0, rows.length - MAX_ROWS),
    notes: kind === 'create' ? [] : [kind === 'delete' ? DELETE_NOT_READ : NOT_READ],
    flags: genericFlags(root),
    source: 'schema',
    how: `Read from the call and the schema: ${named.length === 0 ? 'no argument names a record by id' : `${named.join(', ')} ${named.length === 1 ? 'names' : 'name'} ${kind === 'create' ? 'where it goes' : `the ${e(target.noun, 120)}`}`}; every other argument the call sets is a new value, and each row's card says what the schema says of it.`,
    current: kind === 'create' ? 'none' : 'not-read',
    phrase: e(phrase, 600),
  }
}

// ---- The preview

/**
 * A write root whose arguments could not be read (a reading threw): a block
 * that says so and a flag, so the pane never shows a write with no word of
 * what it changes.
 */
function unreadBlock(root: FieldIR): ChangeBlock {
  let kind: ChangeKind = 'update'
  try {
    kind = verbOf(root.name).kind
  } catch {
    // An update, as said.
  }
  const name = e(root.name, 200)
  return {
    path: root.path,
    root: name,
    kind,
    section: 'CHANGES',
    target: { words: '', short: '', parts: [], noun: 'record' },
    rows: [],
    more: 0,
    notes: [UNREAD],
    flags: [{ text: 'change not read', detail: `the pane could not read what ${name} changes from its arguments: the form shows them as the call sets them`, tone: 'warn' }],
    source: 'unread',
    how: `The pane could not read what ${name} changes from its arguments; the form below shows them as the call sets them.`,
    current: 'not-read',
    phrase: 'change not read',
  }
}

/** One write root's block: the table's reading, else the generic one; a reading that throws is a block that says so. */
function blockOf(root: FieldIR): ChangeBlock {
  try {
    const mapping = mappingOf(root.name)
    return mapping === undefined ? genericBlock(root) : mappedBlock(root, mapping)
  } catch {
    return unreadBlock(root)
  }
}

const MEMO = new WeakMap<readonly FieldIR[], { state: string; preview: WritePreview | undefined }>()

/**
 * The CHANGES a mutation's roots will make, from the call alone; undefined
 * for a query or a subscription, or a call that did not parse. Every root
 * gets a block (`all`); the first MAX_BLOCKS are drawn, the last of them
 * noting how many more there are. Memoized on the IR's roots, so the pane,
 * the flags line and the transcript line read one model.
 */
export function previewOf(ir: CallIR): WritePreview | undefined {
  if (ir.opType !== 'mutation' || ir.state === 'unparseable' || ir.roots.length === 0) return undefined
  const known = MEMO.get(ir.roots)
  if (known !== undefined && known.state === ir.state) return known.preview
  let preview: WritePreview | undefined
  try {
    const all = ir.roots.map(blockOf)
    const blocks = all.slice(0, MAX_BLOCKS)
    const more = all.length - blocks.length
    const last = blocks[blocks.length - 1]
    if (more > 0 && last !== undefined) blocks[blocks.length - 1] = { ...last, notes: [...last.notes, moreWrites(more)] }
    preview = { blocks, all }
  } catch {
    preview = undefined
  }
  MEMO.set(ir.roots, { state: ir.state, preview })
  return preview
}

/** The flags the preview raises, every root's (drawn or not), each once. */
export function previewFlags(ir: CallIR): PreviewFlag[] {
  const seen = new Set<string>()
  return (previewOf(ir)?.all ?? []).flatMap(block => block.flags).filter(flag => !seen.has(flag.text) && (seen.add(flag.text), true))
}

/** The change in a few words, every drawn block's ` · ` apart and `+N more` for the rest, for the transcript line; undefined for no write. */
export function changePhrase(ir: CallIR): string | undefined {
  const preview = previewOf(ir)
  const blocks = preview?.blocks ?? []
  if (preview === undefined || blocks.length === 0) return undefined
  const more = preview.all.length - blocks.length
  return [...blocks.map(block => block.phrase), ...(more > 0 ? [`+${more} more`] : [])].join(' · ')
}
