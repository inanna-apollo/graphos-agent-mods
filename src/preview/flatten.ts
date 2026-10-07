// Rich text a write sends, as plain lines a diff can be read in: Jira's ADF
// (JSON), Confluence's storage format (XHTML), Slack's mrkdwn and its blocks.
// Pure: no $. Bounded and never throwing: input past a bound is cut there
// and said (`isCapped`), a shape the walk does not know becomes a `[type]`
// placeholder, and anything that fails to parse is shown as its own text.
// Every line comes out escaped (src/escape.ts), so the view only draws it.
//
// The text is the model's (a write's arguments), so nothing here is trusted:
// hrefs and mentions are kept as data for the card, never followed.

import { decodeEntities } from '../entities.ts'
import { emojify } from '../emoji.ts'
import { escapeText } from '../escape.ts'
import { isRecord } from '../guards.ts'

/** What a line is, so the view can tone a heading and a diff can still compare text alone. */
export type LineKind = 'heading' | 'item' | 'code' | 'quote' | 'row' | 'para' | 'media' | 'rule'

export type Line = { text: string; kind: LineKind }

/** A body as lines. `total` counts every line the walk produced, kept or not. */
export type Flat = {
  /** At most MAX_LINES lines, escaped. */
  lines: Line[]
  /** Lines the body has in all (past MAX_LINES they are counted, not kept). */
  total: number
  /** The input was past a bound (its size, node count or depth): what is here is its start. */
  isCapped: boolean
  /** Link targets the text carries (an ADF link mark, a mrkdwn `<url|label>`, a storage `href`), escaped, at most MAX_REFS: for the card. */
  links: string[]
  /** People and channels it names by id (`U02ABC123`, `C0123`), escaped, at most MAX_REFS: for the card. */
  mentions: string[]
  /** The text did not parse as the format it claims (an ADF string that is not JSON): it is shown as written. */
  isRaw?: boolean
}

/** Text a side may hold before it is cut: 256 KB of characters. */
export const MAX_INPUT = 256 * 1024
/** ADF nodes walked, and how deep. */
export const MAX_NODES = 20_000
export const MAX_DEPTH = 64
/** Lines kept per side; past it they are counted only. */
export const MAX_LINES = 5_000
/** One line's characters: a paragraph, wrapped when drawn. A generous bound, not a display cut. */
export const LINE_MAX = 4_000
/** Links and mentions kept for the card. */
export const MAX_REFS = 20
/** Tags and text runs a storage walk reads. */
const MAX_TOKENS = 200_000

const EMPTY: Flat = { lines: [], total: 0, isCapped: false, links: [], mentions: [] }

/** Collects lines under the bounds. */
class Sink {
  lines: Line[] = []
  total = 0
  isCapped = false
  links: string[] = []
  mentions: string[] = []
  nodes = 0
  push(text: string, kind: LineKind, isCode = false) {
    this.total += 1
    if (this.lines.length >= MAX_LINES) return
    const escaped = escapeText(trimEnd(text), LINE_MAX).text
    this.lines.push({ text: isCode ? escaped : emojify(escaped), kind })
  }
  link(url: string) {
    if (this.links.length < MAX_REFS && url !== '' && !this.links.includes(url)) this.links.push(escapeText(url, 400).text)
  }
  mention(id: string) {
    if (this.mentions.length < MAX_REFS && id !== '' && !this.mentions.includes(id)) this.mentions.push(escapeText(id, 120).text)
  }
  done(extra: Partial<Flat> = {}): Flat {
    return { lines: this.lines, total: this.total, isCapped: this.isCapped, links: this.links, mentions: this.mentions, ...extra }
  }
}

/** `text` without its trailing spaces, tabs and carriage returns: a loop, since a regex anchored at the end retries from every space of a long run (quadratic). */
function trimEnd(text: string): string {
  let end = text.length
  while (end > 0) {
    const code = text.charCodeAt(end - 1)
    if (code !== 0x20 && code !== 0x09 && code !== 0x0d) break
    end -= 1
  }
  return end === text.length ? text : text.slice(0, end)
}

/** `text` held to MAX_INPUT, and whether it was cut. */
function bounded(text: string): { text: string; isCut: boolean } {
  return text.length <= MAX_INPUT ? { text, isCut: false } : { text: text.slice(0, MAX_INPUT), isCut: true }
}

/** Plain text as lines: one a line, as written. */
export function textLines(value: unknown): Flat {
  try {
    const sink = new Sink()
    const { text, isCut } = bounded(typeof value === 'string' ? value : stringOf(value))
    sink.isCapped = isCut
    for (const line of text.split('\n')) sink.push(line, 'para')
    return sink.done()
  } catch {
    return EMPTY
  }
}

/** Any value as text: a string as is, anything else as compact JSON. */
export function stringOf(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return '[unprintable value]'
  }
}

// ---- ADF (Atlassian Document Format): Jira descriptions and comments, Confluence's atlas_doc_format

type Run = { text: string }

/** A parsed ADF document from a value: the object itself, or a JSON string that holds one. */
function adfRoot(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined
  return JSON.parse(bounded(trimmed).isCut ? '' : trimmed)
}

/** Whether a value is an ADF document (`{ type: 'doc', content: [...] }`) or one as a JSON string. */
export function isAdf(value: unknown): boolean {
  try {
    const root = adfRoot(value)
    return isRecord(root) && root.type === 'doc' && Array.isArray(root.content)
  } catch {
    return false
  }
}

/**
 * ADF as lines: a paragraph a line, `#` before a heading's text, `• ` or
 * `1. ` before a list item (two cells deeper per level), a code block's
 * lines as they are, `│ ` before a quote's lines and `▌ ` before a panel's,
 * `───` for a rule, `│ a │ b │` for a table row. Inline: text (code in
 * backticks, a link's label with its href kept for the card), `@name` for a
 * mention, an emoji's own text, a card's URL, `[STATUS]`, a date. A node it
 * does not know is `[type]`, its content walked when it has some.
 */
export function adfLines(value: unknown): Flat {
  const sink = new Sink()
  try {
    let root: unknown
    try {
      root = adfRoot(value)
    } catch {
      root = undefined
    }
    // Not a document at all (a string that is not JSON, a number, an object with no node type): shown as written.
    const isNode = Array.isArray(root) || (isRecord(root) && (typeof root.type === 'string' || Array.isArray(root.content)))
    if (!isNode) return { ...textLines(stringOf(value)), isRaw: true }
    if (typeof value === 'string' && value.length > MAX_INPUT) sink.isCapped = true
    const top = Array.isArray(root) ? root : isRecord(root) && Array.isArray(root.content) ? root.content : [root]
    blocks(top, sink, { depth: 0, prefix: '' })
    return sink.done()
  } catch {
    return sink.done({ isCapped: true })
  }
}

type At = { depth: number; prefix: string }

const isBounded = (sink: Sink, at: At) => {
  if (at.depth > MAX_DEPTH || sink.nodes >= MAX_NODES) {
    sink.isCapped = true
    return false
  }
  sink.nodes += 1
  return true
}

/** The text of a node's inline content, as one string (a hard break as `\n`). */
function inline(nodes: unknown, sink: Sink, at: At): string {
  if (!Array.isArray(nodes)) return ''
  const runs: Run[] = []
  for (const node of nodes) {
    if (!isRecord(node) || !isBounded(sink, at)) continue
    const attrs = isRecord(node.attrs) ? node.attrs : {}
    switch (node.type) {
      case 'text': {
        const text = typeof node.text === 'string' ? node.text : ''
        const marks = Array.isArray(node.marks) ? node.marks.filter(isRecord) : []
        for (const mark of marks) {
          const href = isRecord(mark.attrs) && typeof mark.attrs.href === 'string' ? mark.attrs.href : undefined
          if (mark.type === 'link' && href !== undefined) sink.link(href)
        }
        runs.push({ text: marks.some(mark => mark.type === 'code') ? `\`${text}\`` : text })
        break
      }
      case 'hardBreak':
        runs.push({ text: '\n' })
        break
      case 'mention': {
        const name = typeof attrs.text === 'string' && attrs.text !== '' ? attrs.text : typeof attrs.id === 'string' ? attrs.id : 'someone'
        if (typeof attrs.id === 'string') sink.mention(attrs.id)
        runs.push({ text: name.startsWith('@') ? name : `@${name}` })
        break
      }
      case 'emoji':
        runs.push({ text: typeof attrs.text === 'string' && attrs.text !== '' ? attrs.text : typeof attrs.shortName === 'string' ? attrs.shortName : '' })
        break
      case 'inlineCard':
      case 'blockCard':
      case 'embedCard': {
        const url = typeof attrs.url === 'string' ? attrs.url : ''
        sink.link(url)
        runs.push({ text: url === '' ? `[${node.type}]` : url })
        break
      }
      case 'status':
        runs.push({ text: `[${typeof attrs.text === 'string' ? attrs.text.toUpperCase() : 'STATUS'}]` })
        break
      case 'date': {
        const ms = Number(attrs.timestamp)
        runs.push({ text: Number.isFinite(ms) && Math.abs(ms) < 8.64e15 ? new Date(ms).toISOString().slice(0, 10) : '[date]' })
        break
      }
      case 'mediaInline':
        runs.push({ text: '[media]' })
        break
      default:
        runs.push({ text: Array.isArray(node.content) ? inline(node.content, sink, { ...at, depth: at.depth + 1 }) : `[${typeof node.type === 'string' ? node.type : 'node'}]` })
    }
  }
  return runs.map(run => run.text).join('')
}

/** Pushes `text` as lines, each after `prefix` (the first after `lead`, when given). */
function pushText(sink: Sink, text: string, kind: LineKind, prefix: string, lead?: string) {
  text.split('\n').forEach((line, index) => sink.push(`${index === 0 && lead !== undefined ? lead : prefix}${line}`, kind))
}

const LIST_INDENT = '  '

function blocks(nodes: readonly unknown[], sink: Sink, at: At): void {
  for (const node of nodes) {
    if (!isRecord(node) || !isBounded(sink, at)) continue
    const content = Array.isArray(node.content) ? node.content : []
    const attrs = isRecord(node.attrs) ? node.attrs : {}
    const deeper = { ...at, depth: at.depth + 1 }
    switch (node.type) {
      case 'doc':
        blocks(content, sink, deeper)
        break
      case 'paragraph':
        pushText(sink, inline(content, sink, deeper), 'para', at.prefix)
        break
      case 'heading': {
        const level = Math.min(6, Math.max(1, Math.trunc(Number(attrs.level) || 1)))
        pushText(sink, `${'#'.repeat(level)} ${inline(content, sink, deeper)}`, 'heading', at.prefix)
        break
      }
      case 'bulletList':
      case 'orderedList': {
        const start = Math.trunc(Number(attrs.order) || 1)
        content.forEach((item, index) => {
          const bullet = node.type === 'bulletList' ? '• ' : `${start + index}. `
          listItem(item, sink, deeper, bullet)
        })
        break
      }
      case 'taskList':
        for (const item of content) listItem(item, sink, deeper, isRecord(item) && isRecord(item.attrs) && item.attrs.state === 'DONE' ? '☑ ' : '☐ ')
        break
      case 'decisionList':
        for (const item of content) listItem(item, sink, deeper, '◇ ')
        break
      case 'codeBlock': {
        const text = content.map(child => (isRecord(child) && typeof child.text === 'string' ? child.text : '')).join('')
        for (const line of text.split('\n')) {
          sink.push(`${at.prefix}${line}`, 'code', true)
        }
        break
      }
      case 'blockquote':
        blocks(content, sink, { ...deeper, prefix: `${at.prefix}│ ` })
        break
      case 'panel':
        blocks(content, sink, { ...deeper, prefix: `${at.prefix}▌ ` })
        break
      case 'rule':
        sink.push(`${at.prefix}───`, 'rule')
        break
      case 'table':
        for (const row of content) {
          if (!isRecord(row) || !isBounded(sink, deeper)) continue
          const cells = (Array.isArray(row.content) ? row.content : []).map(cell => (isRecord(cell) ? cellText(cell, sink, deeper) : ''))
          sink.push(`${at.prefix}│ ${cells.join(' │ ')} │`, 'row')
        }
        break
      case 'mediaSingle':
      case 'mediaGroup':
      case 'media':
        sink.push(`${at.prefix}[media]`, 'media')
        break
      case 'expand':
      case 'nestedExpand':
        if (typeof attrs.title === 'string' && attrs.title !== '') sink.push(`${at.prefix}▸ ${attrs.title}`, 'heading')
        blocks(content, sink, deeper)
        break
      case 'text':
      case 'mention':
      case 'emoji':
      case 'hardBreak':
      case 'inlineCard':
      case 'status':
      case 'date':
        // Inline content where a block belongs: one line of it.
        pushText(sink, inline([node], sink, deeper), 'para', at.prefix)
        break
      default: {
        const type = typeof node.type === 'string' ? node.type : 'node'
        if (content.length > 0) blocks(content, sink, deeper)
        else sink.push(`${at.prefix}[${type}]`, 'media')
      }
    }
  }
}

/** A list item: its first paragraph after the bullet, the rest of it indented under, nested lists one level deeper. */
function listItem(item: unknown, sink: Sink, at: At, bullet: string): void {
  if (!isRecord(item) || !isBounded(sink, at)) return
  const content = Array.isArray(item.content) ? item.content : []
  const under = `${at.prefix}${' '.repeat(bullet.length)}`
  let isFirst = true
  // A task or decision item holds its text inline, with no paragraph.
  const isInline = content.length > 0 && content.every(child => isRecord(child) && (child.type === 'text' || child.type === 'mention' || child.type === 'emoji' || child.type === 'hardBreak' || child.type === 'status' || child.type === 'date' || child.type === 'inlineCard'))
  if (isInline) {
    pushText(sink, inline(content, sink, at), 'item', under, `${at.prefix}${bullet}`)
    return
  }
  for (const child of content) {
    if (!isRecord(child)) continue
    if (isFirst && child.type === 'paragraph') {
      pushText(sink, inline(Array.isArray(child.content) ? child.content : [], sink, at), 'item', under, `${at.prefix}${bullet}`)
      isFirst = false
      continue
    }
    isFirst = false
    const nested = child.type === 'bulletList' || child.type === 'orderedList' || child.type === 'taskList'
    blocks([child], sink, { ...at, prefix: nested ? `${at.prefix}${LIST_INDENT}` : under })
  }
  if (isFirst) sink.push(`${at.prefix}${bullet.trimEnd()}`, 'item')
}

/** A table cell's text on one line. */
function cellText(cell: Record<string, unknown>, sink: Sink, at: At): string {
  const inner = new Sink()
  inner.nodes = sink.nodes
  blocks(Array.isArray(cell.content) ? cell.content : [], inner, at)
  sink.nodes = inner.nodes
  if (inner.isCapped) sink.isCapped = true
  for (const link of inner.links) sink.link(link)
  for (const mention of inner.mentions) sink.mention(mention)
  // Escaped already: escaping it again with the row changes nothing (an escape is printable text).
  return inner.lines.map(line => line.text).join(' ')
}

// ---- Confluence storage format (XHTML with ac: and ri: elements)

/** Elements that start a line of their own. */
const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr', 'pre', 'blockquote', 'div', 'ac:task', 'ac:structured-macro', 'ac:layout-section', 'ac:layout-cell', 'table', 'ul', 'ol', 'hr', 'ac:task-list', 'ac:rich-text-body', 'ac:plain-text-body'])
/** Elements whose text is not content: a macro's parameters, a task's id and status. */
const SILENT_TAGS = new Set(['ac:parameter', 'ac:task-id', 'ac:task-uuid', 'ac:task-status', 'ac:placeholder', 'style', 'script'])

const attrOf = (tag: string, name: string): string | undefined => {
  const match = new RegExp(`\\s${name.replace(/[:.]/g, '\\$&')}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag)
  return match === null ? undefined : decodeEntities(match[2] ?? match[3] ?? '')
}

type Frame = { tag: string; list?: { ordered: boolean; count: number }; cells?: string[] }

/**
 * Storage format as lines, by a tolerant tag walk (it is not always
 * well-formed, so this is no XML parser): block elements start a line, `<br>`
 * breaks one, headings take `#`, list items `• ` or `1. ` (deeper by nesting),
 * a table row `│ a │ b │`, a page link `[Title]`, a user `@user`, an image
 * `[image: name]`, a code or noformat macro its body as code lines and any
 * other macro `[macro: name]` before its body, a task `☐` or `☑`. Entities are
 * decoded and every other tag dropped.
 */
export function storageLines(value: unknown): Flat {
  const sink = new Sink()
  try {
    if (typeof value !== 'string') return textLines(stringOf(value))
    const { text: source, isCut } = bounded(value)
    sink.isCapped = isCut
    const stack: Frame[] = []
    let line = ''
    let lead = ''
    let kind: LineKind = 'para'
    let silent = 0
    let code = false
    let taskDone = false
    let linkBody = false
    let pendingLink: string | undefined
    // Lists and rows nest at most MAX_DEPTH deep: one opened past it is counted, not kept, and its close takes the count down (an unbounded stack made every item's walk of it, and its indent, grow with the nesting).
    const over = new Map<string, number>()
    const open = (frame: Frame) => {
      if (stack.length < MAX_DEPTH) stack.push(frame)
      else {
        over.set(frame.tag, (over.get(frame.tag) ?? 0) + 1)
        sink.isCapped = true
      }
    }
    /** The frame a close ends, taken off the stack with any opened after it; undefined for one counted past the cap or never opened. */
    const close = (tag: string): Frame | undefined => {
      const extra = over.get(tag) ?? 0
      if (extra > 0) {
        over.set(tag, extra - 1)
        return undefined
      }
      const at = stack.map(frame => frame.tag).lastIndexOf(tag)
      const frame = at >= 0 ? stack[at] : undefined
      if (at >= 0) stack.splice(at)
      return frame
    }
    const lists = () => stack.filter(frame => frame.list !== undefined)
    const row = () => [...stack].reverse().find(frame => frame.cells !== undefined)
    const flush = () => {
      const text = line.replace(/\s+/g, ' ').trim()
      if (text !== '' || lead.trim() !== '') sink.push(`${lead}${text}`, kind)
      line = ''
      lead = ''
      kind = 'para'
    }
    const add = (text: string) => {
      if (silent > 0) return
      const cellRow = row()
      if (cellRow?.cells !== undefined && cellRow.cells.length > 0) cellRow.cells[cellRow.cells.length - 1] += text
      else line += text
    }
    let tokens = 0
    // A tag's attributes never hold a raw `<` (XML forbids it in an attribute value), so a tag that does not close stops at the next `<`: the scan is linear, where letting attributes run over `<` retried the rest of the input from every `<` (quadratic on `<a <a <a …`).
    const pattern = /<!\[CDATA\[([\s\S]*?)(?:\]\]>|$)|<!--[\s\S]*?(?:-->|$)|<\/?([a-zA-Z][\w:.-]*)((?:[^<>"']|"[^"<]*"|'[^'<]*')*)>|([^<]+)|</g
    for (const match of source.matchAll(pattern)) {
      if (++tokens > MAX_TOKENS) {
        sink.isCapped = true
        break
      }
      const [whole, cdata, rawName, , text] = match
      if (cdata !== undefined) {
        if (code) {
          flush()
          for (const codeLine of cdata.split('\n')) sink.push(codeLine, 'code', true)
        } else add(cdata)
        continue
      }
      if (text !== undefined) {
        if (silent === 0 && /\S/.test(text)) add(decodeEntities(text))
        else if (silent === 0 && text !== '' && line !== '') add(' ')
        continue
      }
      if (rawName === undefined) {
        if (whole === '<') add('<')
        continue
      }
      const name = rawName.toLowerCase()
      const isClose = whole.startsWith('</')
      const isSelf = whole.endsWith('/>')
      if (SILENT_TAGS.has(name)) {
        if (name === 'ac:task-status' && !isClose) {
          const status = /^<ac:task-status[^>]*>\s*([a-z]+)/i.exec(source.slice(match.index ?? 0, (match.index ?? 0) + 80))
          taskDone = status?.[1]?.toLowerCase() === 'complete'
        }
        if (isSelf) continue
        silent = Math.max(0, silent + (isClose ? -1 : 1))
        continue
      }
      if (silent > 0) continue
      if (name === 'br') {
        flush()
        continue
      }
      if (name === 'hr') {
        flush()
        sink.push('───', 'rule')
        continue
      }
      if (name === 'ri:page' || name === 'ri:blog-post' || name === 'ri:space') {
        pendingLink = attrOf(whole, 'ri:content-title') ?? attrOf(whole, 'ri:space-key') ?? 'page'
        continue
      }
      if (name === 'ri:user') {
        const id = attrOf(whole, 'ri:account-id') ?? attrOf(whole, 'ri:userkey') ?? attrOf(whole, 'ri:username')
        if (id !== undefined) sink.mention(id)
        if (!linkBody) add('@user')
        continue
      }
      if (name === 'ri:attachment' || name === 'ri:url') {
        const target = attrOf(whole, 'ri:filename') ?? attrOf(whole, 'ri:value') ?? ''
        if (name === 'ri:url') sink.link(target)
        pendingLink = target
        continue
      }
      if (name === 'ac:image') {
        if (isClose) {
          add(`[image${pendingLink === undefined || pendingLink === '' ? '' : `: ${pendingLink}`}]`)
          pendingLink = undefined
        } else if (isSelf) add('[image]')
        continue
      }
      if (name === 'ac:emoticon') {
        add(`:${attrOf(whole, 'ac:name') ?? 'emoticon'}:`)
        continue
      }
      if (name === 'time') {
        add(attrOf(whole, 'datetime') ?? '')
        continue
      }
      if (name === 'ac:link') {
        if (isClose) {
          if (!linkBody && pendingLink !== undefined) add(`[${pendingLink}]`)
          pendingLink = undefined
          linkBody = false
        }
        continue
      }
      if (name === 'ac:link-body' || name === 'ac:plain-text-link-body') {
        if (!isClose) linkBody = true
        continue
      }
      if (name === 'a') {
        const href = attrOf(whole, 'href')
        if (href !== undefined && !isClose) sink.link(href)
        continue
      }
      if (name === 'ac:structured-macro' || name === 'ac:macro') {
        if (isClose) {
          code = false
          flush()
          continue
        }
        flush()
        const macro = (attrOf(whole, 'ac:name') ?? 'macro').toLowerCase()
        if (macro === 'code' || macro === 'noformat') code = !isSelf
        else sink.push(`[macro: ${macro}]`, 'media')
        continue
      }
      if (name === 'ul' || name === 'ol') {
        flush()
        if (isClose) close(name)
        else if (!isSelf) open({ tag: name, list: { ordered: name === 'ol', count: 0 } })
        continue
      }
      if (name === 'li') {
        flush()
        if (isClose || isSelf) continue
        const all = lists()
        const list = all[all.length - 1]?.list
        const depth = Math.max(0, all.length - 1)
        if (list !== undefined) list.count += 1
        lead = `${LIST_INDENT.repeat(depth)}${list?.ordered === true ? `${list.count}. ` : '• '}`
        kind = 'item'
        continue
      }
      if (name === 'ac:task') {
        flush()
        if (!isClose) taskDone = false
        continue
      }
      if (name === 'ac:task-body') {
        if (!isClose) {
          lead = taskDone ? '☑ ' : '☐ '
          kind = 'item'
        } else flush()
        continue
      }
      if (name === 'tr') {
        flush()
        if (isClose) {
          const frame = close('tr')
          if (frame?.cells !== undefined) sink.push(`│ ${frame.cells.map(cell => cell.replace(/\s+/g, ' ').trim()).join(' │ ')} │`, 'row')
        } else if (!isSelf) open({ tag: 'tr', cells: [] })
        continue
      }
      if (name === 'td' || name === 'th') {
        const frame = row()
        if (!isClose && frame?.cells !== undefined) frame.cells.push('')
        else if (!isClose) add(' ')
        continue
      }
      const heading = /^h([1-6])$/.exec(name)
      if (heading !== null) {
        flush()
        if (!isClose) {
          lead = `${'#'.repeat(Number(heading[1]))} `
          kind = 'heading'
        }
        continue
      }
      if (name === 'blockquote') {
        flush()
        continue
      }
      if (name === 'pre') {
        flush()
        if (!isClose) kind = 'code'
        continue
      }
      if (BLOCK_TAGS.has(name)) {
        // A paragraph inside a list item continues the item's line.
        if (name === 'p' && lead !== '' && line === '' && !isClose) continue
        flush()
        continue
      }
      // Any other tag (strong, em, span, code, ac:inline-comment-marker): its text only.
    }
    flush()
    return sink.done()
  } catch {
    return sink.done({ isCapped: true })
  }
}

// ---- Slack mrkdwn, blocks and attachments

/** What Slack's `<!…>` broadcasts address. */
export type Broadcast = 'channel' | 'here' | 'everyone'

/** `<@U123>` `<#C123|name>` `<!here>` `<url|label>`: one of Slack's angle-bracket entities, as words. */
function slackEntity(inner: string, sink: Sink): string {
  const bar = inner.indexOf('|')
  const target = bar < 0 ? inner : inner.slice(0, bar)
  const label = bar < 0 ? undefined : inner.slice(bar + 1)
  if (target.startsWith('@')) {
    sink.mention(target.slice(1))
    return `@${label ?? target.slice(1)}`
  }
  if (target.startsWith('#')) {
    sink.mention(target.slice(1))
    return `#${label ?? target.slice(1)}`
  }
  if (target.startsWith('!')) {
    const word = target.slice(1).split('^')[0] ?? ''
    if (word === 'here' || word === 'channel' || word === 'everyone') return `@${word}`
    if (word === 'subteam') return label ?? '@team'
    if (word === 'date') return label ?? '[date]'
    return label ?? `[${word}]`
  }
  sink.link(target)
  return label === undefined ? target : `${label} ↗`
}

/**
 * Slack's mrkdwn as lines: `<@U123>` as `@U123` (`@name` where it gives one),
 * `<#C123|ops>` as `#ops`, `<url|label>` as `label ↗` with the URL kept for the
 * card, `<!here>` `<!channel>` `<!everyone>` as the words, `&amp; &lt; &gt;`
 * decoded, `:shortcode:` as its emoji, `*bold*` `_it_` `~s~` as written, a
 * ``` fence's lines as code, a line a `\n` apart.
 */
export function mrkdwnLines(value: unknown): Flat {
  const sink = new Sink()
  try {
    const { text, isCut } = bounded(typeof value === 'string' ? value : stringOf(value))
    sink.isCapped = isCut
    mrkdwnInto(text, sink)
    return sink.done()
  } catch {
    return sink.done({ isCapped: true })
  }
}

function mrkdwnInto(text: string, sink: Sink, lead = '') {
  let isFence = false
  for (const raw of text.split('\n')) {
    const fences = raw.split('```')
    if (fences.length > 1) {
      // A fence opens or closes on this line: text before and after it belongs to either side.
      fences.forEach((part, index) => {
        if (index > 0) isFence = !isFence
        if (part.trim() === '') return
        if (isFence) sink.push(part, 'code', true)
        else sink.push(`${lead}${said(part.trim(), sink)}`, 'para')
      })
      continue
    }
    if (isFence) {
      sink.push(raw, 'code', true)
      continue
    }
    const words = said(raw, sink)
    const kind: LineKind = /^\s*(?:[•◦▪-]|\d+\.)\s/.test(words) ? 'item' : words.startsWith('>') ? 'quote' : 'para'
    sink.push(`${lead}${words}`, kind)
  }
}

/** One mrkdwn line's entities as words, then its entities decoded. */
function said(line: string, sink: Sink): string {
  return decodeEntities(line.replace(/<([^<>\n]{1,2000})>/g, (_, inner: string) => slackEntity(inner, sink)))
}

/** The broadcasts a Slack text addresses: `<!channel>`, `<!here>`, `<!everyone>` (with or without a label). */
export function broadcastsIn(text: unknown): Broadcast[] {
  if (typeof text !== 'string') return []
  const found = new Set<Broadcast>()
  // A label never holds `<`: one that does not close stops at the next entity, so the scan is linear (`[^>]*` retried the rest from every `<!channel|`).
  for (const match of bounded(text).text.matchAll(/<!(channel|here|everyone)(?:\|[^<>]*)?>/g)) found.add(match[1] as Broadcast)
  return [...found]
}

/** Blocks or attachments as a parsed list: the value itself, JSON, or URL-encoded JSON (as Agent Services' Slack arguments take them). */
export function slackJson(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string') return isRecord(value) ? [value] : undefined
  const { text, isCut } = bounded(value.trim())
  if (isCut) return undefined
  const tries = [text]
  if (/%[0-9a-f]{2}/i.test(text)) {
    try {
      tries.push(decodeURIComponent(text))
    } catch {
      // Not URL-encoded after all.
    }
  }
  for (const one of tries) {
    try {
      const parsed: unknown = JSON.parse(one)
      if (Array.isArray(parsed)) return parsed
      if (isRecord(parsed)) return Array.isArray(parsed.blocks) ? parsed.blocks : [parsed]
    } catch {
      // The next form.
    }
  }
  return undefined
}

/** The broadcasts a blocks list addresses: a rich text `broadcast` element, or `<!here>` in a section's mrkdwn. */
export function broadcastsInBlocks(value: unknown): Broadcast[] {
  const found = new Set<Broadcast>()
  let nodes = 0
  const visit = (node: unknown, depth: number) => {
    if (depth > MAX_DEPTH || ++nodes > MAX_NODES) return
    if (Array.isArray(node)) {
      for (const one of node) visit(one, depth + 1)
      return
    }
    if (!isRecord(node)) return
    if (node.type === 'broadcast' && (node.range === 'channel' || node.range === 'here' || node.range === 'everyone')) found.add(node.range)
    if (typeof node.text === 'string') for (const one of broadcastsIn(node.text)) found.add(one)
    for (const child of Object.values(node)) if (typeof child === 'object' && child !== null) visit(child, depth + 1)
  }
  try {
    visit(slackJson(value) ?? [], 0)
  } catch {
    // What was found so far.
  }
  return [...found]
}

const textOf = (value: unknown): string => (isRecord(value) && typeof value.text === 'string' ? value.text : typeof value === 'string' ? value : '')

/**
 * Slack blocks as lines: a section's text and fields, a header as a heading,
 * a context line, `───` for a divider, `[image: alt]`, `[button: label]` for
 * each action, rich text as its runs (lists, quotes and preformatted text as
 * such), any other block `[block: type]`. Blocks that do not parse are shown
 * as written.
 */
export function blocksLines(value: unknown): Flat {
  const sink = new Sink()
  try {
    const list = slackJson(value)
    if (list === undefined) return { ...textLines(value), isRaw: true }
    let nodes = 0
    for (const block of list) {
      if (++nodes > MAX_NODES) {
        sink.isCapped = true
        break
      }
      if (!isRecord(block)) continue
      switch (block.type) {
        case 'section':
          if (block.text !== undefined) mrkdwnInto(textOf(block.text), sink)
          for (const field of Array.isArray(block.fields) ? block.fields : []) mrkdwnInto(textOf(field), sink)
          break
        case 'header':
          sink.push(`# ${textOf(block.text)}`, 'heading')
          break
        case 'context':
          sink.push((Array.isArray(block.elements) ? block.elements : []).map(element => (isRecord(element) && element.type === 'image' ? `[image${typeof element.alt_text === 'string' ? `: ${element.alt_text}` : ''}]` : said(textOf(element), sink))).join(' '), 'quote')
          break
        case 'divider':
          sink.push('───', 'rule')
          break
        case 'image':
          sink.push(`[image${typeof block.alt_text === 'string' && block.alt_text !== '' ? `: ${block.alt_text}` : ''}]`, 'media')
          break
        case 'actions':
          sink.push((Array.isArray(block.elements) ? block.elements : []).map(element => `[button: ${textOf(isRecord(element) ? element.text : '') || (isRecord(element) && typeof element.type === 'string' ? element.type : 'action')}]`).join(' '), 'media')
          break
        case 'rich_text':
          for (const element of Array.isArray(block.elements) ? block.elements : []) richText(element, sink, '', 0)
          break
        default:
          sink.push(`[block: ${typeof block.type === 'string' ? block.type : 'unknown'}]`, 'media')
      }
    }
    return sink.done()
  } catch {
    return sink.done({ isCapped: true })
  }
}

/** A rich text element's runs: text, links, users, channels, emoji and broadcasts, as one string. */
function richRuns(elements: unknown, sink: Sink): string {
  if (!Array.isArray(elements)) return ''
  return elements
    .map(element => {
      if (!isRecord(element)) return ''
      switch (element.type) {
        case 'text':
          return typeof element.text === 'string' ? element.text : ''
        case 'link': {
          const url = typeof element.url === 'string' ? element.url : ''
          sink.link(url)
          return typeof element.text === 'string' && element.text !== '' ? `${element.text} ↗` : url
        }
        case 'user':
          if (typeof element.user_id === 'string') sink.mention(element.user_id)
          return `@${typeof element.user_id === 'string' ? element.user_id : 'user'}`
        case 'channel':
          if (typeof element.channel_id === 'string') sink.mention(element.channel_id)
          return `#${typeof element.channel_id === 'string' ? element.channel_id : 'channel'}`
        case 'usergroup':
          return '@team'
        case 'emoji':
          return typeof element.name === 'string' ? `:${element.name}:` : ''
        case 'broadcast':
          return `@${typeof element.range === 'string' ? element.range : 'here'}`
        default:
          return `[${typeof element.type === 'string' ? element.type : 'element'}]`
      }
    })
    .join('')
}

function richText(element: unknown, sink: Sink, lead: string, depth: number): void {
  if (!isRecord(element) || depth > MAX_DEPTH) return
  switch (element.type) {
    case 'rich_text_section':
      pushText(sink, richRuns(element.elements, sink), 'para', lead)
      break
    case 'rich_text_list': {
      const indent = Math.max(0, Math.trunc(Number(element.indent) || 0))
      const isOrdered = element.style === 'ordered'
      ;(Array.isArray(element.elements) ? element.elements : []).forEach((item, index) => {
        const bullet = `${LIST_INDENT.repeat(indent)}${isOrdered ? `${index + 1}. ` : '• '}`
        pushText(sink, isRecord(item) ? richRuns(item.elements, sink) : '', 'item', `${lead}${' '.repeat(bullet.length)}`, `${lead}${bullet}`)
      })
      break
    }
    case 'rich_text_preformatted':
      for (const line of richRuns(element.elements, sink).split('\n')) sink.push(line, 'code', true)
      break
    case 'rich_text_quote':
      pushText(sink, richRuns(element.elements, sink), 'quote', `${lead}│ `)
      break
    default:
      sink.push(`[${typeof element.type === 'string' ? element.type : 'element'}]`, 'media')
  }
}

/** Legacy attachments as lines: each one's pretext, title, text and fields, through mrkdwn. */
export function attachmentLines(value: unknown): Flat {
  const sink = new Sink()
  try {
    const list = slackJson(value)
    if (list === undefined) return { ...textLines(value), isRaw: true }
    for (const one of list.slice(0, 100)) {
      if (!isRecord(one)) continue
      for (const key of ['pretext', 'title', 'text']) if (typeof one[key] === 'string' && one[key] !== '') mrkdwnInto(one[key] as string, sink)
      for (const field of Array.isArray(one.fields) ? one.fields.slice(0, 50) : []) {
        if (isRecord(field)) sink.push(`${typeof field.title === 'string' ? `${field.title}: ` : ''}${typeof field.value === 'string' ? said(field.value, sink) : ''}`, 'row')
      }
      if (typeof one.fallback === 'string' && !['pretext', 'title', 'text'].some(key => typeof one[key] === 'string')) mrkdwnInto(one.fallback, sink)
    }
    return sink.done()
  } catch {
    return sink.done({ isCapped: true })
  }
}

/** Confluence wiki markup (write only): its own lines, as written. */
export const wikiLines = (value: unknown): Flat => textLines(value)

/** A body's format, by what the call says it is. */
export type BodyFormat = 'adf' | 'storage' | 'wiki' | 'mrkdwn' | 'blocks' | 'attachments' | 'text'

/** The flattener for a format. */
export function flatten(value: unknown, format: BodyFormat): Flat {
  switch (format) {
    case 'adf':
      return adfLines(value)
    case 'storage':
      return storageLines(value)
    case 'wiki':
      return wikiLines(value)
    case 'mrkdwn':
      return mrkdwnLines(value)
    case 'blocks':
      return blocksLines(value)
    case 'attachments':
      return attachmentLines(value)
    default:
      return textLines(value)
  }
}

/** A Confluence `bodyRepresentation` as the format its value is in. */
export function confluenceFormat(representation: unknown): BodyFormat {
  const said = typeof representation === 'string' ? representation.toLowerCase() : ''
  if (said === 'storage' || said === 'editor' || said === 'view' || said === 'export_view') return 'storage'
  if (said === 'atlas_doc_format' || said === 'adf') return 'adf'
  if (said === 'wiki') return 'wiki'
  return 'text'
}

/** A format in words, for a card and a body's count line. */
export const FORMAT_WORDS: Record<BodyFormat, string> = {
  adf: 'Atlassian rich text (ADF)',
  storage: 'Confluence storage format',
  wiki: 'wiki markup',
  mrkdwn: 'Slack mrkdwn',
  blocks: 'Slack blocks',
  attachments: 'Slack attachments',
  text: 'plain text',
}
