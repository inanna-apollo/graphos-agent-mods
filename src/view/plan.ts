// How many rows each block of the pane gets, so the pane never scrolls when
// it can help it. Pure: no $, no JSX. Modelled on the code-modernization
// pane's planOf: fixed costs first, then a `shed` ladder that gives rows
// back in a fixed order until the estimate fits `rows`.
//
// Priorities (docs/pane-design.md): what / where / how much, the notes strip,
// the inputs, RETURNS, requirements, provenance. The badge, counts, status,
// the destructive / denied / will-fail notes and each root's name are never
// shed. Anything cut is counted, so the view can say `+N more`.
//
// Row counts follow the surface's wrapping (wrapLines): words wrap at the
// width the view gives each block (the value column, the note glyph column,
// RESULT's indents, the pane's blank last column), read from the same tokens
// the components use. From the same counts the plan says on which rows each
// hover trigger is drawn (Plan.anchors), so the view pops its card up beside it.

import { full, renderArg } from '../format/index.ts'
import type { Segment } from '../format/index.ts'
import type { CallAgent, CallIR, CallOutcome, FieldIR, TrustFit } from '../ir.ts'
import type { PaneUi } from './kit.ts'
import { POLICY_WORDS, TOKEN_NOTE, UNTYPED_JSON, esc, fallbackLine, summaryOfDescription, tagsOf, hintLines, rangeHint, governedList, humanPlural, humanType, limitOf, omittedLines, policyMark, refParts, walk } from './kit.ts'
import { listNames, notesOf } from './notes.ts'
import { classTag } from './personal.ts'
import type { Note } from './notes.ts'
import type { FieldTag } from './kit.ts'
import { annotationIndex, noteText as pinnedText } from './annotations.ts'
import type { AnnotationIndex, AnnotationLevel, Pinned } from './annotations.ts'
import { leafPolicyCounts } from '../annotate.ts'
import { encode } from '../links.ts'
import type { Link, LinkConfig } from '../links.ts'
import { FIRST_PAGE, grouped, isAllAllowed, isWriteAllowed, ownerOf, ranValid, resultLines, rootOfKey, shownScalars } from './outcome.ts'
import type { ResultLine } from './outcome.ts'
import { pagingNote } from './paging.ts'
import { flagsOf, flagsText, productOf, requestDraft } from './flags.ts'
import type { Nav } from '../queue.ts'
import { isDestructiveName } from '../risk.ts'
import { allowedShown, countsCells, isMeterShown, writeAllowedShown } from './meter.ts'
import type { Flag } from './flags.ts'
import { agentLineOf } from './agent.ts'
import type { AgentLine } from './agent.ts'
import { trustLineOf } from './trust.ts'
import type { TrustLine } from './trust.ts'
import { PREVIEW_SHOWN } from '../result.ts'
import { CHIP_WORD, DRAWER_GUTTER, DRAWER_INDENT, GLYPH, GUTTER, MARK, MAX_DOTS, METER_CELLS, NOTE_GLYPH, RIGHT_PAD, TREE, VALUE_MAX, badgeCells } from './ui/theme.ts'
import { own } from '../guards.ts'
import { previewOf } from '../preview/changes.ts'
import type { ChangeBlock, ChangeRow, WritePreview } from '../preview/changes.ts'
import type { Line } from '../preview/flatten.ts'

// ---- Text rows

/**
 * BMP characters a terminal draws as emoji, two cells wide, with no variation
 * selector (Emoji_Presentation): `⌚ ⏩ ☔ ⚡ ✅ ✨ ❌ ❓ ➕ ⬛ ⭐`. The pane's own
 * glyphs (`✓ ✕ ◐ ◆ ⚑ ↗`) are not among them.
 */
const BMP_EMOJI: readonly [number, number][] = [
  [0x231a, 0x231b], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615],
  [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be],
  [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5],
  [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c],
  [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
]
const BMP_EMOJI_CODES = new Set(BMP_EMOJI.flatMap(([from, to]) => Array.from({ length: to - from + 1 }, (_, at) => from + at)))

/**
 * Cells one character takes: two for East Asian wide and emoji, else one.
 * The emoji variation selector (U+FE0F) counts one: it widens the narrow
 * character before it (`✔️`, `⚠️`) to the two cells a terminal draws.
 */
export function cellsOf(char: string): number {
  const code = char.codePointAt(0) ?? 0
  if (code === 0xfe0f) return 1
  if ((code >= 0xfe00 && code <= 0xfe0e) || code === 0x200d) return 0
  const isWide =
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd) ||
    BMP_EMOJI_CODES.has(code)
  return isWide ? 2 : 1
}

export function cellWidth(text: string): number {
  let cells = 0
  for (const char of text) cells += cellsOf(char)
  return cells
}

/** The longest prefix of `text` within `width` cells. */
function takeCells(text: string, width: number): string {
  let used = 0
  let out = ''
  for (const char of text) {
    if (used + cellsOf(char) > width) break
    used += cellsOf(char)
    out += char
  }
  return out
}

/**
 * The rows `text` wraps to at `width` cells, as the surface lays a wrapping
 * Text out (src/snapshot/text.ts wrapRows): a word moves with the spaces
 * before it, so a run of spaces (`mem_leo  ✕ email`) counts at its real
 * length; a word longer than the line is broken across rows; each `\n`
 * starts a row. Breaks at ASCII spaces only: a non-breaking space keeps its
 * words together, as the terminal draws them.
 */
export function wrapLines(text: string, width: number): string[] {
  const w = Math.max(1, Math.floor(width))
  const rows: string[] = []
  const trimEnd = (line: string) => line.replace(/[ \t\r]+$/, '')
  for (const paragraph of text.split('\n')) {
    let line = ''
    let used = 0
    for (const token of paragraph.match(/[ \t\r]*[^ \t\r]+/g) ?? []) {
      let rest = token
      let cells = cellWidth(rest)
      if (line !== '' && used + cells > w) {
        rows.push(trimEnd(line))
        line = ''
        used = 0
        rest = rest.replace(/^[ \t\r]+/, '')
        cells = cellWidth(rest)
      }
      while (used + cells > w) {
        const head = takeCells(rest, w - used) || (line === '' ? ([...rest][0] ?? '') : '')
        rows.push(trimEnd(line + head))
        line = ''
        used = 0
        rest = rest.slice(head.length)
        cells = cellWidth(rest)
      }
      line += rest
      used += cells
    }
    rows.push(trimEnd(line))
  }
  return rows
}

/** Rows `text` takes at `width` cells (wrapLines). Never less than 1. */
export function textRows(text: string, width: number): number {
  return wrapLines(text, width).length
}

/** `text` in rows of `width` cells, broken anywhere (a URL): no character is lost. */
export function cellRows(text: string, width: number): string[] {
  const w = Math.max(1, Math.floor(width))
  const rows: string[] = []
  let rest = text
  while (cellWidth(rest) > w) {
    const head = takeCells(rest, w) || ([...rest][0] ?? '')
    rows.push(head)
    rest = rest.slice(head.length)
  }
  return [...rows, rest]
}

/**
 * A name (an identifier, a coordinate, a dotted path) in rows of at most
 * `width` cells, never cut: one row when it fits; else each row breaks after
 * `_ . - /` or before a capital (`listOrganization` / `Members`) where one
 * falls in the row's second half, else at the width. The view draws the rows
 * the plan counts, so a name reads whole and wraps as its words do.
 */
export function nameRows(name: string, width: number): string[] {
  const w = Math.max(1, Math.floor(width))
  const rows: string[] = []
  let rest = name
  while (cellWidth(rest) > w) {
    const head = takeCells(rest, w) || ([...rest][0] ?? '')
    let at = head.length
    for (let i = head.length - 1; i > head.length / 2; i--) {
      const before = rest[i - 1] ?? ''
      if (/[_.\-/]/.test(before) || (/[A-Z]/.test(rest[i] ?? '') && /[a-z0-9]/.test(before))) {
        at = i
        break
      }
    }
    rows.push(rest.slice(0, at))
    rest = rest.slice(at)
  }
  return [...rows, rest]
}

/**
 * A name broken into rows of at most `width` cells at its seams only (after
 * `_ . - /`, or before a capital): undefined when it fits, or when one of its
 * breaks would have to fall inside a word.
 */
export function seamRows(name: string, width: number): string[] | undefined {
  const rows = nameRows(name, width)
  if (rows.length < 2) return undefined
  const isSeam = (before: string, after: string) => /[_.\-/]$/.test(before) || (/^[A-Z]/.test(after) && /[a-z0-9]$/.test(before))
  return rows.every((row, index) => index === rows.length - 1 || isSeam(row, rows[index + 1] ?? '')) ? rows : undefined
}

/**
 * One Text in a wrapping flex row; `name` when it is a field's name (its
 * path), which breaks into rows rather than wrapping (nameRows); `card`
 * when it lights a hover card (cardId).
 */
export type FlowItem = string | { text: string; name?: string; card?: string }

/** Where a Text of a wrapping flex row lands: the row its line of the flow starts on, and that line's rows. */
export type FlowPlace = { row: number; rows: number }

/** An item of a wrapping flex row as laid out: the cells before it on its line, its width, and a name's rows where it breaks. */
export type FlowSpot = { x: number; cells: number; rows?: string[] }

/**
 * How a wrapping flex row (`flexWrap: wrap`) lays out its Texts at `width`,
 * as the surface does: each keeps its place in the flow and moves whole to
 * the next row when it does not fit beside what is there; one wider than
 * the row then wraps inside itself. A name wider than the row breaks
 * (nameRows) into a column of rows instead: beside what is on its line where
 * at least half the row is left, else from the next row's start. The Texts of
 * one line share its place; `used` is the cells taken on the last line's
 * first row.
 */
export function flowLayout(items: readonly FlowItem[], width: number): { places: FlowPlace[]; spots: FlowSpot[]; used: number } {
  const w = Math.max(1, Math.floor(width))
  let line: FlowPlace = { row: 0, rows: 0 }
  let used = 0
  // Whether a name already sits on the current line: one that moved whole would leave what is before it (an alias, a mark) alone on its row.
  let hasName = false
  const places: FlowPlace[] = []
  const spots: FlowSpot[] = []
  for (const item of items) {
    const text = typeof item === 'string' ? item : item.text
    if (text === '') {
      places.push(line)
      spots.push({ x: used, cells: 0 })
      continue
    }
    const isName = typeof item !== 'string' && item.name !== undefined
    const room = w - used
    const isBeside = used > 0 && room * 2 >= w
    // A name that fits the row but not beside the lead-in before it breaks at a seam into the room left, rather than leaving the lead-in alone (`members: acme_customer_data_` / `listOrganizationMembers`).
    const atSeam = isName && !hasName && isBeside && cellWidth(text) <= w && cellWidth(text) > room ? seamRows(text, room) : undefined
    const broken = atSeam ?? (isName && cellWidth(text) > w ? nameRows(text, isBeside ? room : w) : undefined)
    const cells = broken === undefined ? Math.min(cellWidth(text), w) : Math.max(...broken.map(cellWidth))
    if (used > 0 && used + cells > w) {
      line = { row: line.row + line.rows, rows: 0 }
      used = 0
      hasName = false
    }
    if (isName) hasName = true
    spots.push({ x: used, cells, ...(broken !== undefined && { rows: broken }) })
    used += cells
    line.rows = Math.max(line.rows, broken?.length ?? (isName ? 1 : textRows(text, cells)))
    places.push(line)
  }
  return { places, spots, used }
}

/** Where each Text of a wrapping flex row lands at `width` (flowLayout). */
export function flowPlaces(items: readonly FlowItem[], width: number): FlowPlace[] {
  return flowLayout(items, width).places
}

/** Rows a wrapping flex row takes at `width` (flowPlaces). Never less than 1. */
export function flowRows(items: readonly FlowItem[], width: number): number {
  const last = flowPlaces(items, width).at(-1)
  return Math.max(1, (last?.row ?? 0) + (last?.rows ?? 0))
}

/** A name's breaks by the field's path, where it breaks into rows at `width` (flowLayout); undefined when none does. */
export function nameBreaks(items: readonly FlowItem[], width: number): Record<string, string[]> | undefined {
  const { spots } = flowLayout(items, width)
  const breaks = Object.fromEntries(items.flatMap((item, index) => (typeof item === 'object' && item.name !== undefined && spots[index]?.rows !== undefined ? [[item.name, spots[index]?.rows ?? []] as const] : [])))
  return Object.keys(breaks).length > 0 ? breaks : undefined
}

/**
 * Where `text` breaks into lines at `width` cells, as textRows counts them:
 * greedy at spaces, a word longer than the line broken across lines. Each
 * line is a `[start, end)` range of `text` with its edge spaces left out.
 */
export function wrapRanges(text: string, width: number): [number, number][] {
  const w = Math.max(1, Math.floor(width))
  const lines: [number, number][] = []
  let start = -1
  let end = -1
  let used = 0
  for (const match of text.matchAll(/[^ \t\r\n]+/g)) {
    let at = match.index ?? 0
    let word = match[0]
    let cells = cellWidth(word)
    if (start >= 0 && used + 1 + cells <= w) {
      end = at + word.length
      used += 1 + cells
      continue
    }
    if (start >= 0) lines.push([start, end])
    // A word wider than the line: whole lines of it, then the rest starts the next.
    while (cells > w) {
      let take = 0
      let taken = 0
      for (const char of word) {
        if (taken + cellsOf(char) > w) break
        taken += cellsOf(char)
        take += char.length
      }
      lines.push([at, at + take])
      at += take
      word = word.slice(take)
      cells = cellWidth(word)
    }
    start = at
    end = at + word.length
    used = cells
  }
  if (start >= 0) lines.push([start, end])
  return lines.length === 0 ? [[0, 0]] : lines
}

// ---- Argument values

/**
 * CQL and JQL come laid out against a keyword column, the first clause
 * indented under a blank keyword cell. Here every argument's value starts at
 * one column, so that layout whitespace collapses to single spaces. The
 * form draws these lines and the plan counts them.
 */
export function compact(lines: Segment[][]): Segment[][] {
  return lines.map(line => {
    const out: Segment[] = []
    for (const segment of line) {
      const isLayout = segment.tone === 'dim' && /^ +$/.test(segment.text)
      if (isLayout) {
        if (out.length > 0) out.push({ text: ' ', tone: 'dim' })
      } else out.push(segment)
    }
    return out
  })
}

// ---- RETURNS lines (the form draws exactly these)

/**
 * One RETURNS row. `prefix` is its dim tree guide (`│ ├ `), so every level
 * of the selection is a level on screen; `head` is an object field, `fields`
 * a run of leaf fields of one object (joined by ` · `), `onType` the inline
 * fragment the run or object was selected under.
 */
export type ReturnLine = {
  prefix: string
  head?: FieldIR
  fields: FieldIR[]
  note?: string
  /** `… N fields`: the object on this row folded; its fields are on the fold's hover card. After the note. */
  fold?: string
  onType?: string
  /** A semantic note pinned to this row's one node (head, or a lone leaf); drawn dim after it. */
  annotation?: Pinned
  /** Dim tags after names, by field path (`untyped JSON`, `only with include=…`). Escaped. */
  tags?: Record<string, FieldTag[]>
  /** Rows the line takes at the plan's width (set by the plan), so the guide can repeat down every wrapped row. */
  rows?: number
  /** Names wider than the line broken into rows (set by the plan; nameRows), by the field's path. */
  breaks?: Record<string, string[]>
}

/** The guide for a wrapped row under a line: a branch carries on as `│`, the last branch as blank; levels above are unchanged. */
export function continuationOf(prefix: string): string {
  if (prefix.endsWith(TREE.branch)) return `${prefix.slice(0, -TREE.branch.length)}${TREE.through}`
  if (prefix.endsWith(TREE.last)) return `${prefix.slice(0, -TREE.last.length)}${TREE.blank}`
  return prefix
}

/** A note pinned to a field, looked up by the field; undefined when it has none. */
export type AnnotationOf = (field: FieldIR) => Pinned | undefined

const isObject = (field: FieldIR) => field.children.length > 0
const leafCount = (field: FieldIR) => walk(field.children).filter(child => !isObject(child)).length

/**
 * `asks for 10 search result items`, or `list of …` with no limit; the type
 * said humanly. A service may return more than it is asked for, so this says
 * what the call asks, never what comes back: that is the flags line's
 * (`Jira returned 50 (asked 3)`).
 */
function listNote(sdl: string, limit: number | undefined, scope?: string): string {
  const items = esc(humanPlural(humanType(sdl, scope), limit), 120)
  return limit === undefined ? `list of ${items}` : `asks for ${limit} ${items}`
}

type Entry = { kind: 'run'; fields: FieldIR[]; onType?: string } | { kind: 'object'; field: FieldIR }

/**
 * One object's children in selection order: consecutive leaves (same
 * fragment) share a run. An annotated leaf breaks out into a run of its
 * own, so its note can follow it; the leaves around it stay joined.
 */
function entriesOf(fields: readonly FieldIR[], annotationOf?: AnnotationOf, isTagged?: (field: FieldIR) => boolean): Entry[] {
  const entries: Entry[] = []
  let isLastAlone = false
  for (const field of fields) {
    const last = entries[entries.length - 1]
    const isAlone = annotationOf?.(field) !== undefined || isTagged?.(field) === true
    if (isObject(field)) entries.push({ kind: 'object', field })
    else if (isAlone) entries.push({ kind: 'run', fields: [field], ...(field.onType !== undefined && { onType: field.onType }) })
    else if (last?.kind === 'run' && !isLastAlone && last.onType === field.onType) last.fields.push(field)
    else entries.push({ kind: 'run', fields: [field], ...(field.onType !== undefined && { onType: field.onType }) })
    isLastAlone = !isObject(field) && isAlone
  }
  return entries
}

/**
 * What comes back, as the selection is written: straight from the FieldIR
 * tree, never re-derived. Each object is a level with dim guides; its leaf
 * fields share a line; an object holding only leaves reads `content: id ·
 * type`; every list says so, with its scale (the root's limit applies to
 * the root, or to the one list child it governs, connection style). Past `maxDepth`
 * levels an object folds to `… N fields`; `isCollapsed` folds at the first.
 * Given `width`, a folded object whose fields are all leaves draws them
 * inline instead (`severity { name · rank }`) when that still takes one row:
 * a fold only where the fields really do not fit.
 */
export function returnLines(root: FieldIR, isCollapsed = false, maxDepth = Infinity, annotationOf?: AnnotationOf, scope?: string, width?: number): ReturnLine[] {
  const limit = limitOf(root)
  const depthCap = isCollapsed ? 1 : maxDepth
  const lines: ReturnLine[] = []
  const rootList = root.schema?.isList === true
  if (rootList) lines.push({ prefix: '', fields: [], note: listNote(root.schema?.type ?? '', limit, scope) })
  // The limit belongs to the one list it governs, not to every list below the root.
  const governed = governedList(root)
  const listOf = (field: FieldIR) => (field.schema?.isList === true ? listNote(field.schema.type, field === governed && !rootList ? limit : undefined, scope) : undefined)

  const level = (fields: readonly FieldIR[], depth: number, lead: string) => {
    const entries = entriesOf(fields, annotationOf, field => tagsOf(root, field).length > 0)
    entries.forEach((entry, index) => {
      const isLast = index === entries.length - 1
      const prefix = `${lead}${isLast ? TREE.last : TREE.branch}`
      const childLead = `${lead}${isLast ? TREE.blank : TREE.through}`
      if (entry.kind === 'run') {
        const only = entry.fields.length === 1 ? entry.fields[0] : undefined
        const annotation = only === undefined ? undefined : annotationOf?.(only)
        lines.push({ prefix, fields: entry.fields, ...(entry.onType !== undefined && { onType: entry.onType }), ...(annotation !== undefined && { annotation }) })
        return
      }
      const { field } = entry
      const list = listOf(field)
      const annotation = annotationOf?.(field)
      // An annotated object keeps its children below it, so the note has its head row to itself.
      const on = { ...(field.onType !== undefined && { onType: field.onType }), ...(annotation !== undefined && { annotation }) }
      if (depth + 1 >= depthCap) {
        const isFlat = field.children.every(child => !isObject(child) && child.onType === undefined && annotationOf?.(child) === undefined)
        const inline: ReturnLine = { prefix, head: field, fields: field.children, ...(list !== undefined && { note: list }), ...on }
        const withTags = (line: ReturnLine): ReturnLine => {
          const tags = Object.fromEntries([field, ...field.children].map(one => [one.path, tagsOf(root, one)] as const).filter(([, found]) => found.length > 0))
          return Object.keys(tags).length > 0 ? { ...line, tags } : line
        }
        if (width !== undefined && isFlat && returnLineRows(withTags(inline), Math.max(1, width - prefix.length)) === 1) {
          lines.push(inline)
        } else {
          const folded = `${GLYPH.checking} ${leafCount(field)} field${leafCount(field) === 1 ? '' : 's'}`
          lines.push({ prefix, head: field, fields: [], ...(list !== undefined && { note: list }), fold: folded, ...on })
        }
      } else if (
        list === undefined &&
        annotation === undefined &&
        field.children.every(child => !isObject(child) && child.onType === undefined && annotationOf?.(child) === undefined)
      ) {
        lines.push({ prefix, head: field, fields: field.children, ...on })
      } else {
        lines.push({ prefix, head: field, fields: [], ...(list !== undefined && { note: list }), ...on })
        level(field.children, depth + 1, childLead)
      }
    })
  }
  level(root.children, 0, '')

  if (lines.length === 0 && root.schema !== undefined) lines.push({ prefix: '', fields: [], note: esc(humanType(root.schema.type, scope), 200) })
  for (const line of lines) {
    const tags: Record<string, FieldTag[]> = {}
    for (const field of [...(line.head === undefined ? [] : [line.head]), ...line.fields]) {
      const found = tagsOf(root, field)
      if (found.length > 0) tags[field.path] = found
    }
    if (Object.keys(tags).length > 0) line.tags = tags
  }
  return lines
}

/** The one node a line's annotation is pinned to: its head, or a lone leaf. */
export const lineNode = (line: ReturnLine): FieldIR | undefined => line.head ?? (line.fields.length === 1 ? line.fields[0] : undefined)

/**
 * Whether the attention marker draws before a node: only when the node has
 * no policy mark of its own, since `✕ email` already says look here.
 */
export const isAttentionShown = (annotation: Pinned | undefined, node: FieldIR | undefined) =>
  annotation?.isAttention === true && (node === undefined || policyMark(node) === undefined)

/** The marker a pinned note draws before its node: `◆` for personal data (the notes strip's glyph), `▴` for a root that writes. */
export const attentionMarker = (pinned: Pinned) => (pinned.isPersonal ? GLYPH.personal : GLYPH.attention)

/**
 * The schema's classification after a name in the tree (`  pii.contact`),
 * unless the note pinned to that name already says it (`denied ·
 * pii.contact`): one classification per name.
 */
export const classAfter = (field: FieldIR, line: Pick<ReturnLine, 'annotation' | 'head' | 'fields'>) =>
  line.annotation !== undefined && field === lineNode(line as ReturnLine) ? '' : classTag(field)

/** A field's name as drawn, escaped; the one whose drawer is `open` says so (`issues ▾`). */
export const nameLabel = (field: FieldIR, open?: FieldIR) => `${esc(field.name, 120)}${field === open ? ` ${GLYPH.open}` : ''}`

/**
 * A return-tree line as the form lays it out (src/view/names.tsx NameLine),
 * guide excluded: each Text of its wrapping row, in order. A name moves whole
 * or breaks into rows, never cut (flowLayout).
 */
function returnLineItems(line: ReturnLine, open?: FieldIR): FlowItem[] {
  const isNamed = line.head !== undefined || line.fields.length > 0
  const named = (field: FieldIR): FlowItem[] => [
    policyMark(field) === undefined ? '' : `${policyMark(field)} `,
    { text: nameLabel(field, open), name: field.path, card: cardId.field(field.path) },
    classAfter(field, line),
    ...(line.tags?.[field.path] ?? []).map(tag => tag.text),
  ]
  return [
    line.annotation !== undefined && isAttentionShown(line.annotation, lineNode(line)) ? `${attentionMarker(line.annotation)} ` : '',
    line.onType === undefined ? '' : `on ${esc(line.onType, 120)} `,
    ...(line.head === undefined ? [] : [...named(line.head), line.fields.length > 0 ? ' { ' : '']),
    ...line.fields.flatMap((field, index) => [index > 0 ? GLYPH.separator : '', ...named(field)]),
    line.head !== undefined && line.fields.length > 0 ? ' }' : '',
    line.note === undefined ? '' : `${isNamed ? '  ' : ''}${line.note}`,
    line.fold === undefined
      ? ''
      : { text: `${line.note !== undefined ? GLYPH.separator : isNamed ? '  ' : ''}${line.fold}`, ...(line.head !== undefined && { card: cardId.fold(line.head.path) }) },
    line.annotation === undefined ? '' : pinnedText(line.annotation),
  ]
}

/** Rows a return-tree line takes at `width`: its Texts flow, each moving whole to the next row when it does not fit (flowRows). */
function returnLineRows(line: ReturnLine, width: number, open?: FieldIR): number {
  return flowRows(returnLineItems(line, open), width)
}

// ---- Hover cards

/**
 * Each hover card's id, by what lights it: a kind letter and a key
 * (`r:open`, `a:open.jql`). The card's hover scope is hashed from it
 * (src/view/ui/hover.tsx hoverScope), and the plan says by it where the
 * card's trigger is drawn (Plan.anchors).
 */
export const cardId = {
  /** A field name, in a return tree or a root's header row, by its path. */
  field: (path: string) => `f:${path}`,
  /** An argument name, by its root's path. */
  arg: (rootPath: string, name: string) => `a:${rootPath}.${name}`,
  /** A root's verb. */
  root: (path: string) => `r:${path}`,
  /** The policy meter, or `✓ all N allowed` in its place. */
  meter: () => 'm:meter',
  /** A folded object's `… N fields`, by the object's path. */
  fold: (path: string) => `o:${path}`,
  /** The flags line. */
  flags: () => 'g:flags',
  /** The trust line under it: ran without asking, or why it asked. */
  trust: () => 'u:trust',
  /** The line under that, for a call a subagent made: which one. */
  agent: () => 'p:agent',
  /** A deep link, by its place in the list. */
  link: (index: number) => `l:link:${index}`,
  /** A RESULT row, by its list (listKey) and place in it. */
  row: (list: string, index: number) => `f:preview:${list}:${index}`,
  /** A RESULT row's `▸`, by its list (listKey) and place in it. */
  toggle: (list: string, index: number) => `t:${list}:${index}`,
  /** A RESULT rows or value line (`open  5 issues`, `total  412`), by its place among RESULT's lines. */
  line: (index: number) => `h:line:${index}`,
  /** RESULT's context line (the receipt: how much of Claude's context the response used, and which fields). */
  weight: () => 'k:weight',
  /** The verb badge (READ, WRITE, WATCH). */
  badge: () => 'b:badge',
  /** The services on the header's first row. */
  services: () => 's:services',
  /** The operation name. */
  op: () => 'n:op',
  /** The status word (`✓ ran`, `1 of 3`). */
  status: () => 'w:status',
  /** The `summary · Haiku` eyebrow. */
  credit: () => 'c:credit',
  /** A CHANGES section's label (and its dim notes), by its root's path. */
  section: (path: string) => `x:${path}`,
  /** A CHANGES section's target (`issue DEV-634`), by its root's path. */
  target: (path: string) => `y:${path}`,
  /** A CHANGES row, a body's lines with it, by its root's path and place. */
  change: (path: string, index: number) => `z:${path}:${index}`,
  /** RESULT's confirmation line: what the response said back of a write's new values. */
  confirm: () => 'v:confirm',
}

/** A RESULT list's key: its root's response key and its field, so two roots' lists that share a field name keep their own rows and cards. */
export const listKey = (line: { field: string; root?: string }) => (line.root === undefined ? line.field : `${line.root}:${line.field}`)

/** Where a hover card's trigger is drawn, in rows from the pane's top: its first row and the rows it spans. */
export type Anchor = { row: number; rows: number }

// ---- The header

/** Panes narrower than this say the history position as `7/8`, not as dots. */
const DOTS_MIN_COLUMNS = 60
/** Cells `r: raw ↗` takes. */
const RAW_CELLS = 8
/** The operation name on rows of its own sits under the badge's word. */
export const OP_INDENT = 1

/** Where the shown call stands in its history: dots (one per call) with room, else `7/8`. */
export function positionText(nav: Nav, columns: number): string {
  if (nav.count > MAX_DOTS || columns < DOTS_MIN_COLUMNS) return `${nav.position}/${nav.count}`
  return Array.from({ length: nav.count }, (_, index) => (index + 1 === nav.position ? GLYPH.dotOn : GLYPH.dotOff)).join('')
}

/** The services a call touches, by the names the flags line uses (`Jira`, `incident.io`), escaped. */
export function serviceNames(ir: CallIR): string[] {
  return (ir.services !== undefined && ir.services.length > 1 ? ir.services : ir.service === undefined ? [] : [ir.service]).flatMap(one => productOf(one) ?? [])
}

/**
 * The header's two rows fitted to the pane (header.tsx Header). Row one: the
 * badge, `!`, the services, the operation name, and the status on the right,
 * which never goes. The services become `N services` first, then the
 * operation name takes rows of its own under row one (broken, never cut).
 * Row two: the policy on the left, the history and `r: raw ↗` on the right;
 * where they do not fit, the counts beside the meter go first, then `✓ all N
 * allowed` says `✓ N`, then the `earlier call` words go, then the history's
 * position; on a pane too narrow even then, the controls take a row of their
 * own under the policy.
 */
export type HeaderPlan = {
  /** Row one's services: every product, `N services`, or none where the status needs the room. */
  services: string
  /** The operation name broken into rows of its own, when it does not fit on row one. */
  opRows?: string[]
  /** Row two is drawn: a policy to show, controls to press, or a history position. */
  hasRowTwo: boolean
  /** The terse counts beside the meter. */
  hasCounts: boolean
  /** `✓ all N allowed` in words; else `✓ N`. */
  isAllowedLong: boolean
  /** The `earlier call` words before the history controls (a past call). */
  hasEarlier: boolean
  /** The history position (dots, or `7/8`). */
  hasPosition: boolean
  /** The history and `r: raw ↗` on a row of their own under the policy: the last resort. */
  isControlsBelow: boolean
  rows: number
}

/** Cells the history controls take (header.tsx NavControls): `earlier call`, `p: ◂`, the position, `n: ▸`, one apart. */
function navCellsOf(nav: Nav | undefined, columns: number, hasControls: boolean, hasEarlier: boolean, hasPosition: boolean): number {
  if (nav === undefined) return 0
  const position = hasPosition ? cellWidth(positionText(nav, columns)) : 0
  if (!hasControls) return nav.position > 0 ? position : 0
  const items = [hasEarlier ? cellWidth('earlier call') : 0, nav.older !== undefined ? 4 : 0, position, nav.newer !== undefined ? 4 : 0].filter(cells => cells > 0)
  return items.reduce((sum, cells) => sum + cells, 0) + Math.max(0, items.length - 1)
}

export function headerPlan(ir: CallIR, o: { columns: number; status: string; nav?: Nav | undefined; isHistorical: boolean; hasControls: boolean; outcome?: CallOutcome | undefined }): HeaderPlan {
  const w = Math.max(1, o.columns)
  // Row one.
  const names = serviceNames(ir)
  const op = ir.opName === undefined ? '' : esc(ir.opName, 200)
  const fixed = badgeCells(ir.opType) + (ir.roots.some(root => isDestructiveName(root.name)) ? 2 : 0) + (o.status === '' ? 0 : 2 + cellWidth(o.status))
  const fits = (services: string, name: string) => fixed + (services === '' ? 0 : 2 + cellWidth(services)) + (name === '' ? 0 : 2 + cellWidth(name)) <= w
  const full = names.join(' · ')
  const short = names.length > 1 ? `${names.length} services` : full
  const beside = [full, short].find(services => fits(services, op))
  const services = beside ?? [full, short].find(one => fits(one, '')) ?? ''
  const opRows = beside === undefined && op !== '' ? nameRows(op, w - OP_INDENT) : undefined
  // Row two.
  const counts = leafPolicyCounts(ir.roots)
  // A write Agent Services allows says so (`✓ write allowed`); counts and the meter only where something it returns is masked or denied.
  const isWrite = isWriteAllowed(ir, o.outcome)
  const hasPolicy = counts.allow + counts.mask + counts.deny > 0 || isWrite
  const hasMeter = hasPolicy && !isWrite && isMeterShown(counts)
  // Once the call ran, what the response denied counts against saying every field was allowed (as the header draws it).
  const isAll = isAllAllowed(ir, o.outcome)
  const left = (hasCounts: boolean, isLong: boolean) => (!hasPolicy ? 0 : hasMeter ? METER_CELLS + (hasCounts ? 2 + countsCells(counts) : 0) : cellWidth(isWrite ? writeAllowedShown(isLong) : allowedShown(counts, isAll, isLong)))
  const right = (hasEarlier: boolean, hasPosition: boolean) => {
    const nav = navCellsOf(o.nav, w, o.hasControls, hasEarlier && o.isHistorical, hasPosition)
    return nav + (o.hasControls ? (nav > 0 ? 2 : 0) + RAW_CELLS : 0)
  }
  const steps: [boolean, boolean, boolean, boolean][] = [
    [true, true, true, true],
    [false, true, true, true],
    [false, false, true, true],
    [false, false, false, true],
    [false, false, false, false],
  ]
  // The spacer between the sides keeps a cell, two where both have something.
  const fitsTwo = ([hasCounts, isLong, hasEarlier, hasPosition]: [boolean, boolean, boolean, boolean]) => {
    const l = left(hasCounts, isLong)
    const r = right(hasEarlier, hasPosition)
    return l + (l > 0 && r > 0 ? 2 : 1) + r <= w
  }
  const fitting = steps.find(fitsTwo)
  // Too narrow even so: the controls go under the policy, each side keeping what fits on its own row.
  const isControlsBelow = fitting === undefined && hasPolicy && right(true, true) > 0
  const below = steps.find(([hasCounts, isLong, hasEarlier, hasPosition]) => left(hasCounts, isLong) + 1 <= w && right(hasEarlier, hasPosition) + 1 <= w)
  const [hasCounts, isAllowedLong, hasEarlier, hasPosition] = (isControlsBelow ? below : fitting) ?? [false, false, false, false]
  const hasRowTwo = hasPolicy || o.hasControls || navCellsOf(o.nav, w, o.hasControls, o.isHistorical, true) > 0
  return {
    services,
    ...(opRows !== undefined && { opRows }),
    hasRowTwo,
    hasCounts: hasMeter && hasCounts,
    isAllowedLong,
    hasEarlier: hasEarlier && o.isHistorical,
    hasPosition,
    isControlsBelow,
    rows: 1 + (opRows?.length ?? 0) + (hasRowTwo ? 1 : 0) + (isControlsBelow ? 1 : 0),
  }
}

// ---- The plan

/** The credit, an eyebrow: a dim label row directly above the summary box, at its left edge. */
export function creditOf(): string {
  return 'summary · Haiku'
}

/**
 * The pane's one value column: every label gutter of the form (root verbs,
 * arguments, `return type`, `access`) is this wide, so every value starts at
 * it, and RESULT's row text starts at it where the key leaves room. Wide
 * enough for the longest argument name that fits (an indent, the name, two
 * spaces), never under GUTTER or the `return type` row, never over
 * VALUE_MAX; a longer name stacks its value on the next row.
 */
export function valueColumn(ir: CallIR): number {
  const names = ir.roots.flatMap(root => [...root.args.map(arg => arg.name), ...(root.omittedArgs ?? []).filter(arg => arg.default !== undefined).slice(0, MAX_DEFAULTS).map(arg => arg.name)])
  const fitting = names.map(name => MARK + cellWidth(esc(name, 100)) + 2).filter(cells => cells <= VALUE_MAX)
  return Math.min(VALUE_MAX, Math.max(GUTTER, MARK + SUB_LABEL + 2, ...fitting))
}

/** What the last scope drawn says after it for the ones the `access-needs` step left out: `  +2`. */
export const moreText = (more: number) => (more > 0 ? `  +${more}` : '')

/** The label of the row that says what a root returns: its type, then the tree. */
export const RETURN_LABEL = 'return type'
/** The longest sub-row label of a root's form. */
const SUB_LABEL = RETURN_LABEL.length
/** What a root's `return type` row says while its schema is not read: dim words, never a blank row. */
export const TYPE_NOT_READ = 'type not read'
const typeNotRead = (ir: CallIR) => (ir.state === 'analyzing' ? `${TYPE_NOT_READ} yet` : TYPE_NOT_READ)

/** The label of the row that names a write's arguments CHANGES already shows. */
export const IN_CHANGES = 'in CHANGES'

/**
 * The arguments of a root whose values its CHANGES block already shows (each
 * row's `card.arg`): the form lists them by name on one `in CHANGES` row
 * rather than repeating them. Those that name the target stay rows of their
 * own (an issue key, a page id), as do arguments CHANGES does not show
 * (`notifyUsers`, `bodyRepresentation`, the overrides): they steer the change.
 */
export function changedArgs(block: ChangeBlock | undefined): Set<string> {
  if (block === undefined) return new Set()
  const targets = new Set(block.target.parts.map(part => part.arg))
  return new Set(block.rows.map(row => row.card.arg).filter(name => !targets.has(name)))
}

/**
 * The row under an argument's value: `N more lines` (dim) for the lines left
 * out, or, where it can be pressed (`isButton`), the Button that says it, or
 * `full value ▸` / `less ▾`. Undefined when there is none.
 */
export function argCutText(hidden: number, isButton: boolean, isFull: boolean): string | undefined {
  const count = hidden > 0 ? restText(hidden) : undefined
  if (!isButton) return count
  return isFull ? `less ${GLYPH.open}` : `${count ?? 'full value'} ${GLYPH.closed}`
}

/** Whether an argument's name is too long for the value column: its value goes on the next row. */
export const isStacked = (name: string, column: number) => MARK + cellWidth(name) + 2 > column

export type PlanOptions = {
  /** Body rows the pane has: `e.props.scroll.bodyRows`. Infinity sheds nothing. */
  rows: number
  /** `e.props.bodyColumns`, as viewOf takes it (the blank last column comes off here). */
  columns: number
  isPending: boolean
  /** The pane's drawer state. Drawers count only once the call has settled. */
  open: PaneUi
  /** $.clock time the call arrived, for relative dates in arguments. */
  now?: number
  /** Extra rows between sections (off the terminal). */
  sectionGap?: number
  /** What the settled call returned (src/result.ts); drawn as RESULT. */
  outcome?: CallOutcome
  /** Native deep links for the call (src/links.ts); drawn under the form. */
  links?: readonly Link[]
  /** The links.toml rules (src/links.ts), for RESULT's record links. */
  linkConfig?: LinkConfig
  /** The call's id, for the RESULT row opened out (PaneUi.row). */
  callId?: string
  /** Which field values draw as links when a row is opened out (configured https hosts). */
  isLink?: (value: string | undefined) => boolean
  /** The kit has a Link element; without it a URL is drawn as dim text. */
  hasLinkElement?: boolean
  /** Presses can arrive: the header's second row carries the history and raw controls. */
  hasControls?: boolean
  /** The status word the header's first row ends in (`✓ ran`, `1 of 3`); empty for none. */
  status?: string
  /** Where the pane stands in its history (src/queue.ts navOf), for the header's second row. */
  nav?: Nav
  /** How the call fared against the person's trust rules (src/trust.ts), when they have any. */
  trust?: TrustFit
  /** The subagent that made the call, when one did. */
  agent?: CallAgent
  /** The call as the model sent it, and why its input could not be read: an unparseable call draws these in place of the form. */
  sent?: { operation: string; variables: string; inputError?: string }
}

/** The shed ladder, in order. The first eight are the design's; the rest are last resorts. */
export const SHED_ORDER = [
  // What fills spare room goes first: descriptions, hints, defaults, the paging line, the preview.
  'root-description',
  'arg-hints',
  'result-preview',
  'default-args',
  'paging-line',
  // The eyebrow over the box goes before anything else near the summary; the headline itself never does.
  'summary-credit',
  // The context line closes RESULT: one dim row, the first of what RESULT says to go.
  'result-weight',
  'returns-collapse',
  'access-needs',
  'arg-lines',
  'soft-notes',
  // A body's first lines under its CHANGES row, fewer: the count line still says how many.
  'change-lines',
  // Last resorts, once the design's ladder is spent. The blank rows between
  // blocks and between roots are the pane's structure: they hold out until
  // RETURNS is cut to a line.
  'arg-first-line',
  'soft-notes-all',
  'note-rows',
  'returns-lines',
  'change-lines-all',
  'links',
  'section-gaps',
  // RESULT's rows line goes last of all; its errors and auth links never go.
  // Notes Haiku marked for attention stay until the last resort.
  'attention-annotations',
  'result-rows',
] as const

export type ShedKind = (typeof SHED_ORDER)[number]

/**
 * The ladder for a call: pending, as SHED_ORDER (no rows yet). Settled, the
 * rows that came back are what the pane is for and the form is the record of
 * what was asked: the form is cut to its bones and RESULT never is. What
 * still does not fit scrolls.
 */
export function shedOrder(isSettled: boolean): readonly ShedKind[] {
  return isSettled ? SHED_ORDER.filter(kind => kind !== 'result-preview' && kind !== 'result-rows') : SHED_ORDER
}

export type NotePlan = {
  /** Index into notesOf(ir). */
  index: number
  rows: number
  /** How many of the note's names to list before `+N`. */
  names: number
  hasHint: boolean
  /** Notes cut from the strip, said after this (the last shown) note as `+N more`. */
  more?: number
}

export type ArgPlan = {
  name: string
  /** Renderer lines in all. */
  lines: number
  /** Renderer lines drawn; the rest are `… N more lines`. */
  maxLines: number
  /** Lines the planner cut. */
  more: number
  /** Lines the renderer itself left out (the compact fallback's `more`): with `more`, said `N more lines` under the value. */
  hidden: number
  /** Dim words after the last drawn line, when they fit on it (`· max 100`), escaped. */
  hint?: string
  /** The arg name as drawn, escaped. */
  label: string
  /** The name is wider than the value column: it takes a row, and its value starts on the next. */
  isStacked: boolean
  /** A stacked name's rows: broken (nameRows) where it is wider than the pane, never cut. */
  labelRows?: string[]
  /** CHANGES shows its value: the form names it on the `in CHANGES` row, not as a row of its own (0 rows here). */
  isInChanges?: true
  rows: number
}

export type ReturnsPlan = {
  isCollapsed: boolean
  /** `first page · more via hasMoreResults`, drawn under the lines. */
  paging?: string
  /**
   * The tree always starts on the row after `return type`: the label row says
   * the root's shape when the first line does not (a list's `list of members`
   * is that line), else this: the root's type in words, or nothing. Escaped.
   */
  lead?: string
  /** The first line sits on the label row (a list's note); otherwise the label row is its own. */
  isLeadLine: boolean
  /** The lead says the schema is not read (`type not read`): dim, not the italic of a type. */
  isLeadUnread?: true
  /** The lines to draw, already collapsed and cut. */
  lines: ReturnLine[]
  /** Lines cut: `… N more`. */
  more: number
  rows: number
}

/**
 * A root's `access` row: drawn only when it says something, its scopes or
 * `not checked` (when other roots were). With no scope anywhere the policy
 * card says so; masks and denials are on the names.
 */
export type AccessPlan = {
  /** Every scope the root needs, escaped. */
  scopes: string[]
  /** The same scopes as the schema wrote them, to find Haiku's notes on them. */
  rawScopes: string[]
  /** Scopes drawn, one per line; the rest are `+N` on the last. */
  needs: number
  more: number
  /** No scope to list, but something to say: `not checked`. */
  empty?: string
  /** The roots share one ACCESS section, drawn after the last one: this root draws none. */
  isMerged?: boolean
  rows: number
}

export type RootPlan = {
  path: string
  rootRows: number
  /** The root's name (and `▾` while its drawer is open) broken into rows, where it is wider than its header row. */
  nameRows?: string[]
  /** Cells of the rule the header row runs out in (several roots), on its last row; 0 for none. */
  rule: number
  /** Dim words after the root's name (its schema hints), when they fit beside it. Escaped. */
  hint?: string
  /** The root's description as a quoted dim row, only when it fits whole on it. Escaped, without the quotes. */
  description?: { text: string; rows: number }
  args: ArgPlan[]
  /** The `in CHANGES` row under the arguments: the names of those CHANGES shows (escaped, each lighting its argument's card), and the rows they wrap to. */
  inChanges?: { names: { name: string; label: string }[]; rows: number }
  /** Arguments the call left out that have a default, drawn dim under the set ones; a name too long for the value column has its own `rows` above its value. */
  defaults: { name: string; text: string; rows?: string[] }[]
  returns: ReturnsPlan
  access: AccessPlan
  rows: number
}

export type Plan = {
  /** The rows asked for, and the estimate of what the plan draws. */
  rows: number
  total: number
  fits: boolean
  /** The header's rows (headerPlan), and how it fits them. */
  header: number
  head: HeaderPlan
  rule: number
  /** Blank rows above the notes strip, above the form and between roots. */
  gap: number
  /** The pane's value column (valueColumn). */
  column: number
  summary: {
    /** Lines the headline takes inside its box: all of them, never cut. */
    lines: number
    /** The `summary · Haiku` eyebrow row above the box (Haiku wrote the headline, and the row was not shed). */
    hasCredit: boolean
    /** The eyebrow, the box's lines and its two border rows; 0 with nothing to say. */
    rows: number
  }
  /** The flags line under the box (src/view/flags.ts): never cut, it wraps. */
  /** `draft`: what the access-request button puts in the prompt box, when the pane draws one. */
  flags: { all: Flag[]; rows: number; draft?: string }
  /** The trust line under the flags (src/view/trust.ts): never cut, it wraps. */
  trust: { line?: TrustLine; rows: number }
  /** The line under the trust line for a call a subagent made (src/view/agent.ts): never cut, it wraps. */
  agent: { line?: AgentLine; rows: number }
  /** A write's CHANGES, one block per root (src/preview/changes.ts), each with the gap above it: first for a write, above RESULT and the form. */
  changes: ChangesPlan
  notes: { all: Note[]; shown: NotePlan[]; more: number; rows: number }
  roots: RootPlan[]
  /** A settled call's RESULT lines, in the order drawn; `more` were shed. */
  result: { lines: ResultLine[]; more: number; rows: number }
  /** Deep links under the form. */
  links: { shown: Link[]; rows: number }
  /** Which of Haiku's notes are drawn (the view indexes them at this level). */
  annotations: AnnotationLevel
  /**
   * Where each drawn hover trigger is, by the card it lights (cardId), so the
   * view places the card beside it: a name's or a link's row, the flags line
   * with its button row, a root's header row. A RESULT row's card is placed
   * by its whole list, head line to last row, so it never covers its siblings.
   * A card whose trigger is not drawn has none.
   */
  anchors: ReadonlyMap<string, Anchor>
  /** The steps applied, in the order they were (one entry per step). */
  shed: ShedKind[]
}

/** What the ladder turns. Infinity means uncut. */
type Knobs = {
  resultRows: boolean
  /** RESULT's closing context line. */
  weight: boolean
  /** Preview items kept per list. */
  preview: number
  description: boolean
  hints: boolean
  defaults: boolean
  paging: boolean
  links: boolean
  annotations: AnnotationLevel
  /** Blank rows between blocks and between roots. */
  gaps: boolean
  /** The summary's eyebrow row. */
  credit: boolean
  collapsed: boolean[]
  needs: number[]
  argMax: number[][]
  softKeep: number
  noteRows: number
  returnsMax: number[]
  /** Rows a CHANGES body's first lines may take (BODY_ROWS). */
  bodyRows: number
}

/** Arguments left out that have a default, shown dim under the set ones. */
const MAX_DEFAULTS = 3

/** Whether `extra` joins the last line of `base` without taking a row. */
const fitsBeside = (base: string, extra: string, width: number) => extra !== '' && textRows(`${base}${extra}`, width) <= textRows(base, width)

const NEVER_SHED_GLYPHS: readonly string[] = [GLYPH.failed, GLYPH.deny]
const SOFT_GLYPHS: readonly string[] = [GLYPH.personal, GLYPH.limit]
/** Notes take one or two rows. */
const NOTE_ROWS = 2
const SHOWN_NAMES = 6
const ARG_LINES = 3
/** The headline box's border and paddingX, across. */
export const SUMMARY_FRAME = 4

export const isNeverShed = (note: Note) => NEVER_SHED_GLYPHS.includes(note.glyph)
export const isSoft = (note: Note) => SOFT_GLYPHS.includes(note.glyph)

function noteText(note: Note, names: number, hasHint: boolean, more: number): string {
  const listed = `${note.names === undefined ? '' : ` ${listNames(note.names, names)}`}${note.detail === undefined ? '' : `  ${note.detail}`}`
  const hint = hasHint && note.hint !== undefined ? ` · ${note.hint}` : ''
  return `${note.text}${listed}${hint}${more > 0 ? ` +${more} more` : ''}`
}

/** A field drawer's title, `▾` and the field's coordinate broken into rows (nameRows) after it, `width` cells wide. */
export const drawerTitleRows = (field: FieldIR, width: number) => nameRows(esc(field.coordinate, 240), Math.max(1, width - 2))

/**
 * A field's drawer, as FieldDrawer draws it `width` cells wide: the gap
 * above it, its title (drawerTitleRows), the description under the title,
 * then each labelled row's value beside its gutter.
 */
function fieldDrawerRows(field: FieldIR, width: number, gap: number): number {
  const inner = Math.max(1, width - DRAWER_INDENT)
  const value = Math.max(1, inner - DRAWER_GUTTER)
  const { schema } = field
  const policy = POLICY_WORDS[field.policy]
  // A restricted policy is its chip (` MASKED `), the others their glyph.
  const mark = field.policy === 'mask' || field.policy === 'deny' ? ` ${CHIP_WORD[field.policy]} ` : policy.glyph
  const values = [
    schema === undefined ? 'unknown (schema not loaded)' : esc(schema.type, 200),
    `${mark} ${policy.text}${field.denialContext === undefined ? '' : TOKEN_NOTE}`,
    ...(hintLines(field).length > 0 ? [hintLines(field).join(' · ')] : []),
    ...omittedLines(field),
    ...(schema?.scopes ?? []).map(scope => esc(scope, 200)),
    ...(schema?.deprecated === undefined ? [] : [esc(schema.deprecated, 400)]),
    ...((schema?.tags.length ?? 0) > 0 ? [(schema?.tags ?? []).map(tag => `@${esc(tag, 80)}`).join(' ')] : []),
  ]
  const description = schema?.description === undefined ? 0 : textRows(`“${esc(schema.description.trim(), 800)}”`, inner)
  return gap + drawerTitleRows(field, width).length + description + values.reduce((sum, text) => sum + textRows(text, value), 0)
}

function codeRows(source: string, width: number): number {
  return source.split('\n').reduce((sum, line) => sum + textRows(line, width), 0)
}

/** A RESULT rows or scalar line as drawn, for counting rows: `open  5 issues · first page`. */
export function rowsLineText(line: Extract<ResultLine, { kind: 'rows' | 'scalar' }>): string {
  const note = line.kind === 'rows' && line.note !== undefined ? `${GLYPH.separator}${line.note}` : ''
  return `${line.field}${line.field === '' ? '' : '  '}${line.text}${note}`
}

/** RESULT's confirmation line as drawn: each part ` · ` apart. */
export const confirmLineText = (line: Extract<ResultLine, { kind: 'confirm' }>) => line.parts.map(part => part.text).join(GLYPH.separator)

/** Whether a settled auth link's host fits whole beside its label in `width` cells (the note column's): else it gives way, never cut mid-name. */
export const isHostBeside = (label: string, host: string | undefined, width: number) => host !== undefined && cellWidth(`[${label}]`) + 2 + cellWidth(host) <= width

/** RESULT's indents: its lines sit under the label, a list's rows under their head. */
export const RESULT_INDENT = 2
export const ROW_INDENT = 4
/** `┃ RESULT  `: the cells the label row takes before a line riding on it. */
export const RESULT_LABEL = cellWidth(`${GLYPH.section} RESULT  `)

/** The first line rides on RESULT's label row: one list or one value, nothing before it. */
export function isResultInline(lines: readonly ResultLine[]): boolean {
  const first = lines[0]
  return first !== undefined && (first.kind === 'rows' || first.kind === 'scalar') && lines.filter(line => line.kind === 'rows' || line.kind === 'scalar').length === 1
}

type PreviewRow = Extract<ResultLine, { kind: 'preview' }>['items'][number]

/** A preview row's key as drawn: bracketed when it is a link, as links are written. */
/** The press under a requestable denial: drafts the access request for its field. */
export const REQUEST_LABEL = 'request access'

/**
 * The rows a requestable denial's second line takes: its classification and
 * the press on one row where both fit, else the classification wrapped and
 * the press on a row of its own. The view draws by the same answer.
 */
export function requestRows(facts: string | undefined, width: number): { isOneRow: boolean; rows: number } {
  const lead = facts === undefined || facts === '' ? '' : `${facts} · `
  if (cellWidth(lead) + cellWidth(REQUEST_LABEL) <= width) return { isOneRow: true, rows: 1 }
  // On a row of its own the press wraps like any label on a narrow pane.
  return { isOneRow: false, rows: (lead === '' ? 0 : textRows(facts ?? '', width)) + textRows(REQUEST_LABEL, width) }
}

export const shownLabel = (item: PreviewRow) => (item.url === undefined ? item.label : `[${item.label}]`)

/**
 * The common key column of a preview group: its longest key, held to under
 * half the row; null when no row says anything after its label (a list of
 * titles), so each label wraps across the whole row instead of being cut.
 */
export function labelColumn(items: readonly PreviewRow[], width: number): number | null {
  if (items.every(item => previewRest(item) === '')) return null
  return Math.min(Math.max(0, ...items.map(item => cellWidth(shownLabel(item)))), Math.max(6, Math.floor(width * 0.45)))
}

/** What a preview row says before its denial tags: the second field and the extra. */
export const previewLead = (item: PreviewRow) => [item.text ?? '', item.extra ?? ''].filter(Boolean).join('  ')

/**
 * What a preview row says after its key, as drawn: the second field, the
 * extra, each denied field (`✕ email`). With `tagAt`, the tags start that many
 * cells in, so a group's tags form a column.
 */
export function previewRest(item: PreviewRow, tagAt?: number): string {
  const lead = previewLead(item)
  const tags = (item.denied ?? []).map(one => `${GLYPH.deny} ${one.field}`)
  if (tags.length === 0) return lead
  const before = `${lead}${' '.repeat(tagAt === undefined ? 0 : Math.max(0, tagAt - cellWidth(lead)))}`
  return `${before}${before === '' ? '' : '  '}${tags.join('  ')}`
}

/**
 * How a preview group is laid out across `rowWidth` (the cells right of
 * ROW_INDENT): the key column (null for a list of titles), the cells between
 * the key and its text, and where the denial tags start. The text starts at
 * the pane's value column (`valueColumn`) when the key leaves two cells before
 * it, else two cells after the key. The tags line up past the group's widest
 * text, unless that would wrap a row that fits without it.
 */
export type PreviewLayout = { column: number | null; gap: number; tagAt?: number }

export function previewLayout(items: readonly PreviewRow[], rowWidth: number, valueColumn: number): PreviewLayout {
  const column = labelColumn(items, rowWidth)
  if (column === null) return { column, gap: 0 }
  // Two cells at least, as everywhere a name meets its value: one reads as a run-on (`Incident 0 Oct 1`).
  const gap = ROW_INDENT + column + 2 <= valueColumn ? valueColumn - ROW_INDENT - column : 2
  const width = Math.max(1, rowWidth - column - gap)
  const tagged = items.filter(item => (item.denied?.length ?? 0) > 0)
  const tagAt = Math.max(0, ...tagged.map(item => cellWidth(previewLead(item))))
  const isAligned = tagged.length > 1 && tagAt > 0 && tagged.every(item => textRows(previewRest(item, tagAt), width) <= textRows(previewRest(item), width))
  return { column, gap, ...(isAligned && { tagAt }) }
}

/** A RESULT row's address while it is opened out (PaneUi.row): the call, the list and the row. */
export const rowKey = (callId: string, list: string, index: number) => `${callId}:${list}:${index}`

/** A RESULT list opened out past its first rows: `<call id>:<list>` (PaneUi.more). */
export const moreKey = (callId: string, list: string) => `${callId}:${list}`

/** The toggle row under a list: `… 3 more` (a press opens it out where `expand` is `more`), or, opened, `show fewer` after any rows not kept. */
export function moreLabel(line: { more: number; expand?: 'more' | 'less' }): string {
  if (line.expand === 'less') return `${line.more > 0 ? `${GLYPH.checking} ${grouped(line.more)} more · ` : ''}show fewer`
  return `${GLYPH.checking} ${grouped(line.more)} more`
}

/** The rows the toggle row takes at `width` (none when there is nothing more and nothing to fold). */
export const moreRows = (line: { more: number; expand?: 'more' | 'less' }, width: number) => (line.more > 0 || line.expand === 'less' ? textRows(moreLabel(line), width) : 0)

/** The fields a row opens out to: all it kept but those the row already says (its key, its summary); denied ones always. */
export function openedFields(item: PreviewRow): NonNullable<PreviewRow['fields']> {
  return (item.fields ?? []).filter(one => one.denial !== undefined || (one.value !== item.label && one.value !== item.text))
}

/** The cells an opened row's field names take: the longest, held to a third of the width. */
export function fieldNameColumn(item: PreviewRow, width: number): number {
  return Math.min(Math.max(0, ...openedFields(item).map(one => cellWidth(one.name))), Math.max(6, Math.floor(width / 3)))
}

/** An opened row's value as drawn: a denied field says so; a link is bracketed. */
export function fieldValueText(field: NonNullable<PreviewRow['fields']>[number], isLink: boolean): string {
  if (field.denial !== undefined) return [`${GLYPH.deny} denied`, field.denial.classification ?? ''].filter(Boolean).join(' · ')
  return isLink ? `[${field.value ?? ''}]` : (field.value ?? '')
}

/**
 * Rows a RESULT row opened out takes under itself: one field a row, or as
 * many as its name (broken in its column, nameRows) or its value wraps to,
 * names in one column, `width` the cells from the opened block's indent.
 * `isLink` says which values draw as links.
 */
export function openedRows(item: PreviewRow, width: number, isLink: (value: string | undefined) => boolean): number {
  const names = fieldNameColumn(item, width)
  return openedFields(item).reduce((sum, field) => sum + Math.max(1, nameRows(field.name, names).length, textRows(fieldValueText(field, isLink(field.value)), Math.max(1, width - names - 2))), 0)
}

/** Where an opened row's fields start, past the row's toggle. */
export const OPENED_INDENT = ROW_INDENT + 2

/** Rows a closed RESULT row's key or text takes at most; the rest waits for the row to open (`▸`). */
export const ROW_LINES = 3

/** `text` cut at a word (a long word by characters) and ended in `…`, the most of it `fits` takes; whole when it fits. */
function cutToFit(text: string, fits: (shown: string) => boolean): string {
  if (fits(text)) return text
  const words = text.split(' ')
  let kept = 0
  while (kept < words.length && fits(`${words.slice(0, kept + 1).join(' ')}…`)) kept += 1
  if (kept > 0) return `${words.slice(0, kept).join(' ')}…`
  const chars = [...text]
  let at = 0
  while (at < chars.length && fits(`${chars.slice(0, at + 1).join('')}…`)) at += 1
  return `${chars.slice(0, at).join('')}…`
}

/**
 * A RESULT row as drawn while closed: its key and its text (the summary)
 * each held to ROW_LINES rows, the last cut at a word with `…`, so the `▸`
 * reads as more; the extra and the denial tags stay whole. Opened, the row
 * shows all of it. `isCut` when anything was cut.
 */
export function closedItem(item: PreviewRow, rowWidth: number, layout: PreviewLayout): { item: PreviewRow; isCut: boolean } {
  const keyWidth = layout.column ?? rowWidth
  const label = cutToFit(item.label, shown => textRows(shownLabel({ ...item, label: shown }), keyWidth) <= ROW_LINES)
  const textWidth = Math.max(1, rowWidth - (layout.column ?? 0) - layout.gap)
  const text = layout.column === null || item.text === undefined ? item.text : cutToFit(item.text, shown => textRows(previewRest({ ...item, text: shown }, layout.tagAt), textWidth) <= ROW_LINES)
  if (label === item.label && text === item.text) return { item, isCut: false }
  return { item: { ...item, label, ...(text !== undefined && { text }) }, isCut: true }
}

/** Rows a preview row takes: its key wraps in its column and what follows wraps beside it, the taller of the two; with no key column, the key wraps across the row. Never cut here: a closed row is cut first (closedItem). */
export function previewItemRows(item: PreviewRow, rowWidth: number, layout: PreviewLayout): number {
  if (layout.column === null) return Math.max(1, textRows(shownLabel(item), rowWidth))
  return Math.max(1, textRows(shownLabel(item), Math.max(1, layout.column)), textRows(previewRest(item, layout.tagAt), Math.max(1, rowWidth - layout.column - layout.gap)))
}

/**
 * A rows line whose note would wrap is told shorter rather than orphaned: `more
 * available` becomes `more`, then `first page` goes, then the whole note.
 */
export function fitRowsNote(line: Extract<ResultLine, { kind: 'rows' }>, width: number): ResultLine {
  const bare = textRows(rowsLineText({ ...line, note: undefined }), width)
  if (line.note === undefined || textRows(rowsLineText(line), width) <= bare) return line
  const parts = line.note.split(GLYPH.separator).map(part => (part === 'more available' ? 'more' : part))
  for (const kept of [parts, parts.filter(part => part !== FIRST_PAGE)]) {
    const note = kept.join(GLYPH.separator)
    if (note !== '' && textRows(rowsLineText({ ...line, note }), width) <= bare) return { ...line, note }
  }
  const { note: _dropped, ...rest } = line
  return rest
}

/**
 * What a deep link is about, from the link and the call alone: the product
 * (`Open in Jira` → Jira), the first root whose string argument the URL
 * carries, and that argument's value (raw; escaped when drawn).
 */
export function linkFacts(link: Link, ir: CallIR): { product: string; root: FieldIR | undefined; query: string | undefined } {
  const product = link.label.replace(/^Open in /, '')
  for (const root of ir.roots) {
    for (const arg of root.args) {
      if (typeof arg.value === 'string' && arg.value !== '' && link.url.includes(encode(arg.value))) return { product, root, query: arg.value }
    }
  }
  return { product, root: undefined, query: undefined }
}

/** Response fields that say how many a search finds in all. */
const TOTAL_NAMES = ['count', 'total', 'totalcount', 'totalsize']

/** What a product's search finds, when the root does not say (a count). */
const PRODUCT_NOUN: Record<string, string> = { Jira: 'issues', Confluence: 'pages', Slack: 'messages' }

/** The host of a URL, for display; empty when it does not parse. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/**
 * What a deep link opens, in words: `this search in Jira`, followed by the
 * root's alias when the pane has several links, and once settled the size of
 * what it finds when the response said (`412 issues in Jira`). Escaped.
 */
export function linkLabel(link: Link, ir: CallIR, outcome: CallOutcome | undefined, isOneOfMany: boolean): string {
  const { root, product: name } = linkFacts(link, ir)
  const product = esc(name, 40)
  // This root's own list and count (by response key: two aliases of one field are two roots), and only a field that says how many exist, never an echoed `startAt: 0`.
  const row = root === undefined ? undefined : outcome?.rows.find(one => ownerOf([root], one) !== undefined)
  const count =
    root === undefined || outcome === undefined
      ? undefined
      : shownScalars(outcome, ir).find(one => rootOfKey(ir.roots, one.root) === root && typeof one.value === 'number' && TOTAL_NAMES.includes(one.field.toLowerCase()))?.value
  const total = row?.total ?? (typeof count === 'number' ? count : undefined)
  const list = root?.children.find(child => child.schema?.isList === true)
  const noun = list === undefined ? (own(PRODUCT_NOUN, name) ?? 'results') : esc(humanPlural(humanType(list.schema?.type ?? list.name, root?.service ?? ir.service), total), 40)
  const what = total === undefined ? `this search in ${product}` : `${total.toLocaleString('en-US')} ${noun} in ${product}`
  // With several links, the root each one belongs to follows it: `this search in Jira · open`.
  const who = isOneOfMany && root !== undefined ? ` · ${esc(root.alias ?? root.name, 40)}` : ''
  return `${what}${who}`
}

// ---- CHANGES (a write's new values, src/preview/changes.ts)

/** Where a CHANGES row's sign sits (the form's mark column), and where its label and a body's text start after it. */
export const SIGN_AT = MARK
export const CHANGE_INDENT = MARK + 2
/** Where a body's lines start: two cells in from the labels, so they read as their row's. */
export const BODY_INDENT = CHANGE_INDENT + 2
/** The widest CHANGES column: a label longer than it leaves stacks its value on the next row. */
export const CHANGE_MAX = VALUE_MAX + CHANGE_INDENT
/** Rows a body's first lines may take under its row, by step of the shed ladder: the count line says the rest. */
export const BODY_ROWS = [8, 3, 0] as const

export type ChangeRowPlan = {
  row: ChangeRow
  /** The label on rows of its own above the value (too long for the column), broken where it is wider than the row (nameRows). */
  labelRows?: string[]
  /** Rows the value takes at the column. */
  valueRows: number
  /** A body's lines drawn under it, each with the rows it wraps to, and the lines left to its count. */
  lines: Line[]
  lineRows: number[]
  rest: number
  rows: number
}

export type ChangeBlockPlan = {
  block: ChangeBlock
  /** Cells the section's label takes on its header row (`┃ CHANGES  `). */
  labelCells: number
  /** Rows the header takes: the target wraps beside the label. */
  headRows: number
  rows: ChangeRowPlan[]
  /** `3 more` when the block has more rows than it keeps: its rows. */
  moreRows: number
  notes: { text: string; rows: number }[]
  /** Rows of the whole block. */
  total: number
}

export type ChangesPlan = {
  blocks: ChangeBlockPlan[]
  /** The CHANGES value column. */
  column: number
  /** Every block's rows with the gap above each. */
  rows: number
}

/** A CHANGES section's label row as drawn: the bar, the label and two cells. */
export const sectionCells = (section: string) => cellWidth(`${GLYPH.section} ${section}`) + 2

/**
 * The CHANGES value column: wide enough for the longest label that fits
 * (the sign column, the label, two cells), never under the form's value
 * column, never over CHANGE_MAX, and at most half a narrow pane.
 */
export function changeColumn(preview: WritePreview | undefined, inner: number, column: number): number {
  const labels = (preview?.blocks ?? []).flatMap(block => block.rows.map(row => CHANGE_INDENT + cellWidth(row.label) + 2)).filter(cells => cells <= CHANGE_MAX)
  return Math.max(CHANGE_INDENT + 1, Math.min(CHANGE_MAX, Math.max(column, ...labels), Math.max(CHANGE_INDENT + 2, Math.floor(inner / 2))))
}

/** Whether a row's label stacks above its value: wider than the column leaves it. */
export const isLabelStacked = (label: string, column: number) => CHANGE_INDENT + cellWidth(label) + 2 > column

/** The words a body's count line says for the lines not drawn: `44 more lines`. */
export const restText = (rest: number) => `${rest.toLocaleString('en-US')} more line${rest === 1 ? '' : 's'}`

/** A body line as drawn: a blank one keeps its row. */
export const lineText = (line: Line) => (line.text === '' ? ' ' : line.text)

/**
 * Rows of each CHANGES block at `inner` cells: the header (the target wraps
 * beside the label), each row (a stacked label's rows, then the value at the
 * column), a body's first lines up to `bodyRows` rows (at least one when any)
 * and a count line for the rest, `N more` for rows past the block's bound,
 * and the dim notes. `gap` is the space above each block.
 */
export function changesPlanOf(preview: WritePreview | undefined, inner: number, column: number, bodyRows: number, gap: number): ChangesPlan {
  const valueWidth = Math.max(1, inner - column)
  const lineWidth = Math.max(1, inner - CHANGE_INDENT)
  const bodyWidth = Math.max(1, inner - BODY_INDENT)
  const noteWidth = Math.max(1, inner - SIGN_AT)
  const blocks = (preview?.blocks ?? []).map((block): ChangeBlockPlan => {
    const labelCells = sectionCells(block.section)
    const headRows = block.target.words === '' ? 1 : textRows(block.target.words, Math.max(1, inner - labelCells))
    const rows = block.rows.map((row): ChangeRowPlan => {
      const isStacked = isLabelStacked(row.label, column)
      const labelRows = isStacked ? nameRows(row.label, lineWidth) : undefined
      const valueRows = textRows(row.text, valueWidth)
      const all = row.body !== undefined && row.body.total > 1 ? row.body.lines : []
      // The first lines while they fit the budget, at least one when there is any budget.
      const lines: Line[] = []
      const lineRows: number[] = []
      let used = 0
      for (const line of all) {
        const one = textRows(lineText(line), bodyWidth)
        if (bodyRows <= 0 || (lines.length > 0 && used + one > bodyRows)) break
        lines.push(line)
        lineRows.push(one)
        used += one
      }
      // One line left that takes one row: it, rather than a count that takes the same row.
      const last = all[lines.length]
      if (bodyRows > 0 && lines.length === all.length - 1 && (row.body?.total ?? 0) === all.length && last !== undefined && textRows(lineText(last), bodyWidth) === 1) {
        lines.push(last)
        lineRows.push(1)
        used += 1
      }
      // With no lines drawn, the row's own `8 lines` is the count.
      const rest = all.length === 0 || lines.length === 0 ? 0 : (row.body?.total ?? 0) - lines.length
      const restRows = rest > 0 ? textRows(restText(rest), bodyWidth) : 0
      return { row, ...(labelRows !== undefined && { labelRows }), valueRows, lines, lineRows, rest, rows: (labelRows?.length ?? 0) + valueRows + used + restRows }
    })
    const moreRows = block.more > 0 ? textRows(`${block.more} more`, lineWidth) : 0
    const notes = block.notes.map(text => ({ text, rows: textRows(text, noteWidth) }))
    const total = headRows + rows.reduce((sum, row) => sum + row.rows, 0) + moreRows + notes.reduce((sum, note) => sum + note.rows, 0)
    return { block, labelCells, headRows, rows, moreRows, notes, total }
  })
  return { blocks, column, rows: blocks.reduce((sum, block) => sum + gap + block.total, 0) }
}

/** Shares `opts.rows` between the pane's blocks; see the file comment. */
export function planOf(ir: CallIR, opts: PlanOptions): Plan {
  const inner = Math.max(1, Math.floor(opts.columns) - RIGHT_PAD)
  const hasForm = ir.state !== 'unparseable' && ir.opType !== undefined
  const column = hasForm ? valueColumn(ir) : GUTTER
  const value = Math.max(1, inner - column)
  const gap = opts.sectionGap ?? 0
  const isSettled = !opts.isPending
  const open = opts.open
  const now = opts.now ?? 0

  const summaryParts = ir.summary === undefined ? undefined : refParts(ir.summary.headline)
  // While Haiku is still reading, the scale (or a stand-in) shimmers on one line.
  const isShimmering = ir.summary === undefined && ir.isSummarizing === true && opts.isPending
  const summaryText = (summaryParts?.map(part => part.text).join('') ?? fallbackLine(ir)).replace(/\s+/g, ' ').trim()
  const result = hasForm && isSettled ? resultLines(opts.outcome, ir, opts.linkConfig) : []
  const flags = hasForm ? flagsOf(ir, isSettled ? opts.outcome : undefined, isSettled) : []
  // Settled with presses, a requestable denial gets its own button row under the line (`a: draft access request`).
  const draft = isSettled && opts.hasControls === true ? requestDraft(flags, ir.opName) : undefined
  const flagRows = flags.length === 0 ? 0 : textRows(flagsText(flags, draft !== undefined), inner - NOTE_GLYPH) + (draft === undefined ? 0 : 1)
  // Under the flags: the trust rules' word on the call, wrapped, never cut.
  const trust = hasForm ? trustLineOf(opts.trust) : undefined
  const trustRows = trust === undefined ? 0 : textRows(trust.text, inner - NOTE_GLYPH)
  // Under that, for a call a subagent made, which one: wrapped too.
  const agent = hasForm ? agentLineOf(opts.agent) : undefined
  const agentRows = agent === undefined ? 0 : textRows(agent.text, inner - NOTE_GLYPH)
  const policyRow = hasForm && ((({ allow, mask, deny }) => allow + mask + deny > 0)(leafPolicyCounts(ir.roots)) || isWriteAllowed(ir, isSettled ? opts.outcome : undefined))
  // A write's CHANGES: computed from the call alone, its rows counted at the CHANGES column.
  const preview = hasForm ? previewOf(ir) : undefined
  const changeCol = changeColumn(preview, inner, column)
  const head = headerPlan(ir, { columns: inner, status: opts.status ?? '', nav: opts.nav, isHistorical: isSettled && opts.nav !== undefined && !opts.nav.isLive, hasControls: opts.hasControls === true, outcome: opts.outcome })
  const header = head.rows
  const links = hasForm ? (opts.links ?? []) : []
  // A root says `not checked` only when other roots were checked: when none was, the notes strip says it once.
  const isAllUnknown = walk(ir.roots).every(field => field.policy === 'unknown')

  // Per root: what never changes with the knobs.
  const rootFacts = (hasForm ? ir.roots : []).map(root => {
    // A write's arguments its CHANGES block already shows: named on one row, not repeated.
    const changed = changedArgs(preview?.blocks.find(block => block.path === root.path))
    const args = root.args.map(arg => {
      const id = `${root.path}(${arg.name})`
      const isFull = isSettled && open.arg === id
      const rendered = isFull ? full(arg.value) : renderArg(arg, root.name, now)
      // As the form draws them: a query's layout spaces collapsed.
      const texts = (rendered.isFallback ? rendered.lines : compact(rendered.lines)).map(line => line.map(segment => segment.text).join(''))
      const lineRows = texts.map(text => textRows(text, value))
      return { name: arg.name, isFull, isTruncated: rendered.isTruncated === true, hidden: isFull ? 0 : (rendered.more ?? 0), lineRows, lastText: texts[texts.length - 1] ?? '', isStacked: isStacked(esc(arg.name, 100), column), isInChanges: changed.has(arg.name) }
    })
    const rawScopes = [...new Set(walk([root]).flatMap(field => field.schema?.scopes ?? []))]
    const scopes = rawScopes.map(scope => esc(scope, 200))
    const fields = walk([root])
    const openField = isSettled ? fields.find(field => field.path === open.field) : undefined
    // Value ranges stay inline; constraints (`requires a bounded query`, timezones, `one of`) are for the hover card.
    const hintText = (all: readonly string[] | undefined) => {
      const hints = (all ?? []).filter(rangeHint)
      return hints.length === 0 ? '' : `  ${GLYPH.separator.trim()} ${hints.slice(0, 2).map(hint => esc(hint, 80)).join(GLYPH.separator)}`
    }
    const rootHint = hintText(root.schema?.hints)
    const argHints = root.args.map(arg => hintText(arg.hints))
    const description = summaryOfDescription(root.schema?.description)
    const defaults = (root.omittedArgs ?? [])
      .filter(arg => arg.default !== undefined)
      .slice(0, MAX_DEFAULTS)
      .map(arg => ({ name: esc(arg.name, 100), text: `${esc(arg.default ?? '', 60)}  (default)` }))
      // A name too long for the value column has its own rows, broken there rather than cut.
      .map(one => ({ ...one, ...(isStacked(one.name, column) && { rows: nameRows(one.name, inner - MARK) }) }))
    const paged = root.paging === undefined ? undefined : pagingNote(root.paging)
    // Settled with a rows line that already says `first page`: RESULT carries it.
    const isPagedInResult = root.paging?.isFirstPage === true && result.some(line => line.kind === 'rows' && line.note?.startsWith(FIRST_PAGE) === true)
    const isUnchecked = !isAllUnknown && ir.state !== 'analyzing' && fields.every(field => field.policy === 'unknown')
    // The type in words for the `return type` row, when the tree does not start with the list's own note.
    // An opaque JSON root (by its type's name, or as the schema says) is `untyped JSON`, as the trees and cards call it; a root whose schema is not read says so, so the row is never blank.
    const lead = root.schema === undefined ? typeNotRead(ir) : root.schema.isList ? undefined : root.schema.isOpaque === true ? UNTYPED_JSON : esc(humanType(root.schema.type, root.service ?? ir.service), 80)
    return { root, args, argHints, rootHint, description, defaults, paged, isPagedInResult, isUnchecked, scopes, rawScopes, openField, lead }
  })

  // Roots on one service share ACCESS: one row after the last root, the union of their scopes.
  const serviceOf = (root: FieldIR) => (root.name.includes('_') ? root.name.slice(0, root.name.indexOf('_')) : ir.service)
  const services = new Set(rootFacts.map(facts => serviceOf(facts.root)))
  const isAccessMerged = rootFacts.length > 1 && services.size === 1 && !services.has(undefined)
  const mergedRaw = [...new Set(rootFacts.flatMap(facts => facts.rawScopes))]
  const mergedScopes = mergedRaw.map(scope => esc(scope, 200))

  const knobs: Knobs = {
    resultRows: true,
    weight: true,
    preview: Infinity,
    description: true,
    hints: true,
    defaults: true,
    paging: true,
    links: true,
    annotations: 'attention',
    gaps: true,
    credit: true,
    collapsed: rootFacts.map(() => false),
    needs: rootFacts.map(() => Infinity),
    argMax: rootFacts.map(facts => facts.args.map(() => Infinity)),
    softKeep: Infinity,
    noteRows: NOTE_ROWS,
    returnsMax: rootFacts.map(() => Infinity),
    bodyRows: BODY_ROWS[0],
  }

  // The ladder tries a notch, undoes it when it gives back no row, and tries
  // it again once another step has moved something; with many roots that is
  // thousands of tries. So each part of the plan is worked out once for each
  // setting of the knobs it reads (a root by its own knobs), and a try plans
  // only the part its notch changed.
  const memo = <T>(cache: Map<string, T>, key: string, make: () => T): T => {
    const found = cache.get(key)
    if (found !== undefined) return found
    const made = make()
    cache.set(key, made)
    return made
  }
  const pinsCache = new Map<string, AnnotationIndex>()
  const pinsOf = (level: AnnotationLevel) => memo(pinsCache, level, () => annotationIndex(ir, level, opts.outcome))

  // The headline sits in a box drawn by hand: a border and one cell of padding each side; the credit is an eyebrow row above it.
  // A shimmering line wraps after its glyph column, as the still line and the spinner draw it.
  const summaryLines = summaryText === '' ? 0 : isShimmering ? textRows(summaryText, Math.max(1, inner - SUMMARY_FRAME - NOTE_GLYPH)) : wrapRanges(summaryText, Math.max(1, inner - SUMMARY_FRAME)).length

  const changesCache = new Map<string, ChangesPlan>()
  const changesAt = (bodyRows: number, space: number) => memo(changesCache, `${bodyRows}|${space}`, () => changesPlanOf(preview, inner, changeCol, bodyRows, space))

  // RESULT is response data: its lines take the pane's width under the label, not the value column.
  const lineWidth = Math.max(1, inner - RESULT_INDENT)
  const rowWidth = Math.max(1, inner - ROW_INDENT)
  // A glyph column, then text that wraps under itself (Note).
  const noteWidth = Math.max(1, lineWidth - NOTE_GLYPH)
  type ResultPart = { shown: ResultLine[]; rows: number; rowsOf: (line: ResultLine, index: number) => number }
  const resultCache = new Map<string, ResultPart>()
  const resultAt = (k: Knobs): ResultPart =>
    memo(resultCache, `${k.weight}|${k.resultRows}|${k.preview}`, () => {
      // RESULT: every error and link; the rows, preview and scalar lines unless shed.
      const keptResult = result.filter(line => (line.kind === 'weight' ? k.weight : (line.kind !== 'rows' && line.kind !== 'scalar' && line.kind !== 'preview') || k.resultRows))
      const isInline = isResultInline(keptResult)
      const widthAt = (index: number) => (index === 0 && isInline ? Math.max(1, inner - RESULT_LABEL) : lineWidth)
      const shownResult = keptResult
        .flatMap((line, index): ResultLine[] => {
          if (line.kind === 'rows') return [fitRowsNote(line, widthAt(index))]
          if (line.kind !== 'preview') return [line]
          // The first rows, or every kept row once the person opened the list out (a press, so only where presses are drawn).
          const key = opts.callId === undefined ? undefined : moreKey(opts.callId, listKey(line))
          const canPress = isSettled && opts.hasControls === true && key !== undefined
          const isOpen = canPress && (open.more ?? null) === key
          const items = line.items.slice(0, Math.min(k.preview, isOpen ? Infinity : PREVIEW_SHOWN))
          if (items.length === 0) return []
          const hidden = line.items.length - items.length
          const expand = isOpen && line.items.length > PREVIEW_SHOWN ? ('less' as const) : canPress && hidden > 0 && k.preview === Infinity ? ('more' as const) : undefined
          return [{ ...line, items, more: line.more + hidden, ...(expand !== undefined && { expand }) }]
        })
      const rowsOf = (line: ResultLine, index: number) => {
        if (line.kind === 'rows' || line.kind === 'scalar') return textRows(rowsLineText(line), widthAt(index))
        if (line.kind === 'preview') {
          const layout = previewLayout(line.items, rowWidth, column)
          // The one row opened out adds its fields under itself.
          const opened = (index: number) => opts.callId !== undefined && open.row === rowKey(opts.callId, listKey(line), index)
          // Closed, a row's key and text hold to ROW_LINES rows; opened, all of it, then its fields.
          return line.items.reduce((sum, item, n) => sum + previewItemRows(opened(n) ? item : closedItem(item, rowWidth, layout).item, rowWidth, layout) + (opened(n) ? openedRows(item, Math.max(1, inner - OPENED_INDENT), opts.isLink ?? (() => false)) : 0), 0) + moreRows(line, rowWidth)
        }
        // A requestable denial, settled and pressable: its words, then `require-approval · [request access]` on a line of its own.
        if (line.kind === 'error') return line.request !== undefined && isSettled && opts.hasControls === true ? textRows(line.head ?? line.text, noteWidth) + requestRows(line.facts, noteWidth).rows : textRows(line.text, noteWidth)
        // The context line is dim text under the label at RESULT's indent, wrapping across the row.
        if (line.kind === 'weight') return textRows(line.text, widthAt(index))
        // The confirmation line: its parts ` · ` apart, wrapping across the row.
        if (line.kind === 'confirm') return textRows(confirmLineText(line), widthAt(index))
        // Settled, an auth link is a Button, its host beside it only where it fits whole (isHostBeside). Else the label wraps with the host (and, with no Link, the URL).
        if (line.url !== null && opts.hasControls === true) return textRows(`[${line.text}]`, noteWidth)
        return textRows(`${line.text}${line.host === undefined ? '' : `  ${line.host}`}${line.url !== null && opts.hasLinkElement !== true ? ` ${line.url}` : ''}`, noteWidth)
      }
      // The label row is a row of its own unless the first line rides on it.
      const rows = shownResult.length === 0 ? 0 : (isResultInline(shownResult) ? 0 : 1) + shownResult.reduce((sum, line, index) => sum + rowsOf(line, index), 0)
      return { shown: shownResult, rows, rowsOf }
    })

  /**
   * A root as the knobs stand: its plan; its hover triggers, in rows from the
   * root's top (placed on the pane once the blocks above are counted); and
   * the fields it draws with a policy mark or a pinned note, which have their
   * home there, so the notes strip leaves them out.
   */
  type RootPart = { plan: RootPlan; triggers: [string, Anchor][]; homed: FieldIR[]; homeKey: string }
  const fieldIndex = new Map(walk(ir.roots).map((field, index) => [field, index] as const))
  const planRoot = (r: number, k: Knobs): RootPart => {
    const facts = rootFacts[r] as (typeof rootFacts)[number]
    const { root } = facts
    const pins = pinsOf(k.annotations)
    // The root's drawer takes the root's width; a tree name's, the value column's.
    const drawerAt = (list: readonly (FieldIR | undefined)[], width = value) =>
      facts.openField !== undefined && list.includes(facts.openField) ? fieldDrawerRows(facts.openField, width, gap) : 0
    const rootNote = pins.field(root.coordinate)
    // The root's header row as the form lays it out (src/view/form.tsx RootForm): its Texts flow, the name cut to the row after its alias.
    const alias = root.alias === undefined ? '' : esc(root.alias, 40).replace(/\s+/g, ' ')
    const rootItems = (hint: string): FlowItem[] => [
      rootNote !== undefined && isAttentionShown(rootNote, root) ? `${attentionMarker(rootNote)} ` : '',
      policyMark(root) === undefined ? '' : `${policyMark(root)} `,
      alias === '' ? '' : `${alias}: `,
      // An open drawer's name says so (`… ▾`).
      { text: nameLabel(root, facts.openField), name: root.path },
      hint,
      rootNote === undefined ? '' : pinnedText(rootNote),
    ]
    // A hint rides beside the name only where it costs no row.
    const rootHint = k.hints && facts.rootHint !== '' && flowRows(rootItems(facts.rootHint), value) <= flowRows(rootItems(''), value) ? facts.rootHint : ''
    // The description fills spare room under the name: whole on one row, quotes and all, or not at all (the root's card has every word).
    const descriptionText = k.description ? facts.description : undefined
    const description = descriptionText !== undefined && textRows(`\u201c${descriptionText}\u201d`, value) === 1 ? { text: descriptionText, rows: 1 } : undefined
    // The root's name has the whole row after its verb; one too long for it moves to the next row, or breaks into rows (nameRows), never cut.
    const header = flowLayout(rootItems(rootHint), value)
    const headerRows = flowRows(rootItems(rootHint), value)
    const nameSpot = header.spots[3]
    // With several roots the header runs out in a rule: in the cells its last row leaves, one spare; after a name that breaks, on the name's last row.
    const isNameLast = rootItems(rootHint).slice(4).every(item => item === '')
    const ruleRoom = isNameLast && nameSpot?.rows !== undefined ? value - nameSpot.x - cellWidth(nameSpot.rows.at(-1) ?? '') - 2 : nameSpot?.rows !== undefined ? 0 : value - header.used - 2
    const rule = ir.roots.length > 1 && ruleRoom >= 3 ? ruleRoom : 0
    const rootRows = headerRows + (description?.rows ?? 0) + drawerAt([root], inner)

    const args: ArgPlan[] = facts.args.map((arg, a) => {
      if (arg.isInChanges) return { name: arg.name, label: esc(arg.name, 100), isStacked: false, lines: arg.lineRows.length, maxLines: 0, more: 0, hidden: arg.hidden, isInChanges: true, rows: 0 }
      const cap = arg.isFull ? Infinity : (k.argMax[r]?.[a] ?? Infinity)
      const maxLines = Math.min(arg.lineRows.length, cap)
      const cut = arg.lineRows.length - maxLines
      // Schema hints (`· max 100`) follow the last line of the value, only where they cost no row.
      const hintText = k.hints && cut === 0 ? (rootFacts[r]?.argHints[a] ?? '') : ''
      const hint = fitsBeside(arg.lastText, hintText, value) ? hintText : ''
      const drawn = arg.lineRows.slice(0, maxLines).reduce((sum, rows) => sum + rows, 0)
      // `N more lines` (the planner's cut and the renderer's own count), or the Button that says it, `full value ▸` or `less ▾` once settled: as many rows as its words wrap to (argCutText).
      const below = argCutText(cut + arg.hidden, isSettled && (cut + arg.hidden > 0 || arg.isTruncated || arg.isFull), arg.isFull)
      const button = below === undefined ? 0 : textRows(below, value)
      return {
        name: arg.name,
        label: esc(arg.name, 100),
        ...(arg.isStacked && { labelRows: nameRows(esc(arg.name, 100), inner - MARK) }),
        isStacked: arg.isStacked,
        lines: arg.lineRows.length,
        maxLines,
        more: cut,
        hidden: arg.hidden,
        ...(hint !== '' && { hint }),
        rows: Math.max(1, drawn) + button + (arg.isStacked ? nameRows(esc(arg.name, 100), inner - MARK).length : 0),
      }
    })
    // The arguments CHANGES shows, by name, ` · ` apart: each name a Text of a wrapping row that lights its own card.
    const changedNames = facts.args.filter(arg => arg.isInChanges).map(arg => ({ name: arg.name, label: esc(arg.name, 100) }))
    const changedItems: FlowItem[] = changedNames.flatMap((one, index) => [index > 0 ? GLYPH.separator : '', { text: one.label, card: cardId.arg(root.path, one.name) }])
    const inChanges = changedNames.length === 0 ? undefined : { names: changedNames, rows: flowRows(changedItems, value) }
    const defaults = k.defaults ? facts.defaults : []
    const defaultRows = defaults.reduce((sum, one) => sum + textRows(one.text, value) + (one.rows?.length ?? 0), 0)

    const isCollapsed = k.collapsed[r] === true
    const all = returnLines(root, isCollapsed, Infinity, field => pins.field(field.coordinate), root.service ?? ir.service, value)
    const keep = Math.min(all.length, k.returnsMax[r] ?? Infinity)
    const drawnLines = all.slice(0, keep).map(line => {
      const breaks = nameBreaks(returnLineItems(line, facts.openField), value - line.prefix.length)
      return { ...line, rows: returnLineRows(line, value - line.prefix.length, facts.openField), ...(breaks !== undefined && { breaks }) }
    })
    const returnsMore = all.length - keep
    const paging = k.paging && facts.paged !== undefined && !facts.isPagedInResult && all.length > 0 ? facts.paged : undefined
    // A list's own note sits on the `return type` row; any other tree starts on the row after it, the type in words wrapping there.
    const isLeadLine = drawnLines[0]?.prefix === ''
    const leadRows = isLeadLine ? 0 : textRows(facts.lead ?? ' ', value)
    const returnsRows =
      all.length === 0
        ? 0
        : leadRows +
          drawnLines.reduce((sum, line) => sum + line.rows + drawerAt([line.head, ...line.fields]), 0) +
          (returnsMore > 0 ? 1 : 0) +
          (paging === undefined ? 0 : textRows(paging, value))
    const returns: ReturnsPlan = {
      isCollapsed,
      ...(paging !== undefined && { paging }),
      ...(!isLeadLine && facts.lead !== undefined && { lead: facts.lead }),
      isLeadLine,
      ...(!isLeadLine && root.schema === undefined && { isLeadUnread: true as const }),
      lines: drawnLines,
      more: returnsMore,
      rows: returnsRows,
    }

    // Roots on one service: the last draws one `access` row with every scope, the rest draw none.
    const isMerged = isAccessMerged && r < rootFacts.length - 1
    const scopesAll = isAccessMerged ? mergedScopes : facts.scopes
    const isUnchecked = isAccessMerged ? rootFacts.every(one => one.isUnchecked) : facts.isUnchecked
    const needs = Math.min(scopesAll.length, k.needs[r] ?? Infinity)
    const empty = scopesAll.length === 0 && isUnchecked ? 'not checked' : undefined
    const access: AccessPlan = {
      scopes: scopesAll,
      rawScopes: isAccessMerged ? mergedRaw : facts.rawScopes,
      needs,
      more: scopesAll.length - needs,
      ...(empty !== undefined && { empty }),
      ...(isMerged && { isMerged }),
      // Each scope wraps; the last shown carries `+N` for the rest.
      rows: isMerged ? 0 : scopesAll.length === 0 ? (empty === undefined ? 0 : 1) : scopesAll.slice(0, needs).reduce((sum, scope, index) => sum + textRows(`${scope}${index === needs - 1 ? moreText(scopesAll.length - needs) : ''}`, value), 0),
    }

    // The verb and the name share the header row; an argument's name is its first row; a tree's names and folds sit where their line's flow puts them.
    const triggers: [string, Anchor][] = [
      [cardId.root(root.path), { row: 0, rows: headerRows }],
      [cardId.field(root.path), { row: 0, rows: headerRows }],
    ]
    let y = rootRows
    for (const arg of args) {
      if (arg.isInChanges === true) continue
      triggers.push([cardId.arg(root.path, arg.name), { row: y, rows: arg.labelRows?.length ?? 1 }])
      y += arg.rows
    }
    // Each name on the `in CHANGES` row lights its argument's card where the row's flow puts it.
    if (inChanges !== undefined) {
      flowPlaces(changedItems, value).forEach((place, i) => {
        const item = changedItems[i]
        if (typeof item === 'object' && item.card !== undefined) triggers.push([item.card, { row: y + place.row, rows: place.rows }])
      })
      y += inChanges.rows
    }
    // An argument left to its default: its name's row (or rows, where it stacks).
    for (const one of defaults) {
      triggers.push([cardId.arg(root.path, one.name), { row: y, rows: one.rows?.length ?? 1 }])
      y += textRows(one.text, value) + (one.rows?.length ?? 0)
    }
    y += drawnLines.length > 0 ? leadRows : 0
    for (const line of drawnLines) {
      const items = returnLineItems(line, facts.openField)
      flowPlaces(items, value - line.prefix.length).forEach((place, i) => {
        const item = items[i]
        if (typeof item === 'object' && item.card !== undefined) triggers.push([item.card, { row: y + place.row, rows: place.rows }])
      })
      y += line.rows + drawerAt([line.head, ...line.fields])
    }

    const rows = rootRows + args.reduce((sum, arg) => sum + arg.rows, 0) + (inChanges?.rows ?? 0) + defaultRows + returns.rows + access.rows
    const plan: RootPlan = {
      path: root.path,
      rootRows,
      ...(nameSpot?.rows !== undefined && { nameRows: nameSpot.rows }),
      rule,
      ...(rootHint !== '' && { hint: rootHint }),
      ...(description !== undefined && { description }),
      args,
      ...(inChanges !== undefined && { inChanges }),
      defaults,
      returns,
      access,
      rows,
    }
    const homed = [root, ...drawnLines.flatMap(line => [...(line.head === undefined ? [] : [line.head]), ...line.fields])].filter(field => policyMark(field) !== undefined || pins.field(field.coordinate) !== undefined)
    return { plan, triggers, homed, homeKey: homed.map(field => fieldIndex.get(field)).join(',') }
  }
  // A try turns one root's knobs, or one knob the roots share. Each root keeps the
  // knobs it was last planned with and that part, so a root the try left alone
  // costs a few comparisons; one it changed is looked up by its knobs, or planned.
  const rootCaches = rootFacts.map(() => new Map<string, RootPart>())
  const rootSeen: ({ read: readonly unknown[]; caps: readonly number[]; part: RootPart } | undefined)[] = rootFacts.map(() => undefined)
  const rootAt = (r: number, k: Knobs): RootPart => {
    const read = [k.hints, k.description, k.defaults, k.paging, k.annotations, k.collapsed[r], k.returnsMax[r], k.needs[r]]
    const caps = k.argMax[r] ?? []
    const seen = rootSeen[r]
    if (seen !== undefined && seen.read.every((one, i) => one === read[i]) && seen.caps.length === caps.length && seen.caps.every((cap, a) => cap === caps[a])) return seen.part
    const part = memo(rootCaches[r] as Map<string, RootPart>, `${read.join('|')}|${caps.join(',')}`, () => planRoot(r, k))
    rootSeen[r] = { read, caps: [...caps], part }
    return part
  }

  // Notes, once the roots are planned: a restricted or personal field the
  // form draws with its mark (a tree line, a root line) has its home there,
  // so the strip leaves it out. Soft ones past `softKeep` go; the rest are
  // kept, each held to `noteRows` by listing fewer names. The notes change
  // only with the fields that have a home on the form.
  const notesCache = new Map<string, Note[]>()
  let notesSeen: { keys: readonly string[]; all: Note[] } | undefined
  const notesFor = (parts: readonly RootPart[]): Note[] => {
    const seen = notesSeen
    if (seen !== undefined && seen.keys.length === parts.length && parts.every((part, r) => part.homeKey === seen.keys[r])) return seen.all
    const keys = parts.map(part => part.homeKey)
    const all = memo(notesCache, keys.join(';'), () => {
      const homed = new Set(parts.flatMap(part => part.homed))
      return hasForm ? notesOf(ir, field => homed.has(field), isSettled, ranValid(opts.outcome)) : []
    })
    notesSeen = { keys, all }
    return all
  }
  type StripPart = { shown: NotePlan[]; more: number; rows: number }
  const stripCaches = new Map<readonly Note[], Map<string, StripPart>>()
  const stripAt = (k: Knobs, notes: readonly Note[], space: number): StripPart => {
    const cache = stripCaches.get(notes) ?? new Map<string, StripPart>()
    stripCaches.set(notes, cache)
    return memo(cache, `${k.softKeep}|${k.noteRows}|${space}`, () => {
      const softIndexes = notes.flatMap((note, index) => (isSoft(note) ? [index] : []))
      const keptSoft = new Set(softIndexes.slice(0, k.softKeep))
      const kept = notes.flatMap((note, index) => (!isSoft(note) || keptSoft.has(index) ? [index] : []))
      const more = notes.length - kept.length
      const shown: NotePlan[] = kept.map((index, at) => {
        const note = notes[index] as Note
        const tail = at === kept.length - 1 ? more : 0
        let names = Math.min(SHOWN_NAMES, note.names?.length ?? 0)
        let hasHint = note.hint !== undefined
        const rowsOf = () => textRows(noteText(note, names, hasHint, tail), inner - NOTE_GLYPH)
        while (rowsOf() > k.noteRows) {
          if (hasHint) hasHint = false
          else if (names > 1) names -= 1
          else break
        }
        return { index, rows: rowsOf(), names, hasHint, ...(tail > 0 && { more: tail }) }
      })
      return { shown, more, rows: shown.length === 0 ? 0 : space + shown.reduce((sum, note) => sum + note.rows, 0) }
    })
  }

  // Deep links, one row each under the form, with the host beside the label.
  // A Link or a Button is one row (the host gives way first); with neither the URL wraps under its label.
  // A label wider than its row wraps (the host and `o: open` give way first).
  const linkRowsOf = (link: Link) => (opts.hasLinkElement === true || opts.hasControls === true ? textRows(`[${linkLabel(link, ir, opts.outcome, links.length > 1)}]`, inner - NOTE_GLYPH) : textRows(`${linkLabel(link, ir, opts.outcome, links.length > 1)} ${link.url}`, inner - NOTE_GLYPH))
  const allLinkRows = links.reduce((sum, link) => sum + linkRowsOf(link), 0)

  // The plan as the knobs stand. Where each hover trigger is drawn is worked out only for the plan returned, not for each try.
  const build = (k: Knobs, hasAnchors = true): Plan => {
    const space = k.gaps ? 1 + gap : 0
    const hasCredit = k.credit && ir.summary !== undefined && summaryLines > 0
    const summary = { lines: summaryLines, hasCredit, rows: summaryLines === 0 ? 0 : summaryLines + 2 + (hasCredit ? 1 : 0) }
    const changes = changesAt(k.bodyRows, space)
    const { shown: shownResult, rows: resultRows, rowsOf: resultRowsOf } = resultAt(k)
    const parts = rootFacts.map((_, r) => rootAt(r, k))
    const roots = parts.map(part => part.plan)
    const notes = notesFor(parts)
    const { shown, more, rows: noteRows } = stripAt(k, notes, space)
    const shownLinks = k.links ? [...links] : []
    const linkRows = k.links ? allLinkRows : 0

    const body = hasForm
      ? summary.rows +
        flagRows +
        trustRows +
        agentRows +
        changes.rows +
        (resultRows === 0 ? 0 : space + resultRows) +
        noteRows +
        (roots.length === 0 ? 0 : space + roots.reduce((sum, root) => sum + root.rows, 0) + (roots.length - 1) * space) +
        (linkRows === 0 ? 0 : space + linkRows)
      : // Unparseable: the note, then the operation and its variables as sent (src/view.tsx Unparseable), nothing to shed.
        textRows(`Could not read this operation (${esc(ir.failure ?? opts.sent?.inputError ?? 'unknown reason', 300)}). Showing it as sent:`, inner) +
        codeRows(esc(opts.sent?.operation ?? ''), inner) +
        (opts.sent === undefined || opts.sent.variables === '' ? 0 : codeRows(esc(opts.sent.variables), inner))
    const total = header + 1 + body

    // Each hover trigger's rows on the pane, top down as the view stacks the blocks.
    const anchors = new Map<string, Anchor>()
    if (hasAnchors) {
      const anchor = (id: string, row: number, rows: number) => {
        // A name drawn twice lights one card, placed by the first.
        if (!anchors.has(id)) anchors.set(id, { row, rows })
      }
      // Row one: the badge, the services, the operation name (or its own rows under it), the status. The meter, or the words in its place, opens row two.
      if (hasForm) {
        anchor(cardId.badge(), 0, 1)
        if (head.services !== '') anchor(cardId.services(), 0, 1)
        if (ir.opName !== undefined) anchor(cardId.op(), head.opRows === undefined ? 0 : 1, head.opRows?.length ?? 1)
        if ((opts.status ?? '') !== '') anchor(cardId.status(), 0, 1)
      }
      if (policyRow) anchor(cardId.meter(), 1 + (head.opRows?.length ?? 0), 1)
      // The eyebrow over the summary box, the first row under the header's rule.
      if (summary.hasCredit) anchor(cardId.credit(), header + 1, 1)
      let top = header + 1 + summary.rows
      // The flags line with its button row, so a card below it leaves the button bare.
      if (flags.length > 0) anchor(cardId.flags(), top, flagRows)
      top += flagRows
      if (trust !== undefined) anchor(cardId.trust(), top, trustRows)
      top += trustRows
      if (agent !== undefined) anchor(cardId.agent(), top, agentRows)
      top += agentRows
      // Each CHANGES block: its label and target on the header, each row (a body's lines with it) on its own rows.
      for (const one of changes.blocks) {
        top += space
        const path = one.block.path
        anchor(cardId.section(path), top, 1)
        if (one.block.target.words !== '') anchor(cardId.target(path), top, one.headRows)
        let y = top + one.headRows
        one.rows.forEach((row, index) => {
          anchor(cardId.change(path, index), y, row.rows)
          y += row.rows
        })
        top += one.total
      }
      if (resultRows > 0) {
        top += space
        // A row's card is placed by its whole list, from the head line (or the label row it rides on) to the last row: it never covers the rows beside it.
        let at = top + (isResultInline(shownResult) ? 0 : 1)
        let headAt = at
        shownResult.forEach((line, index) => {
          const rows = resultRowsOf(line, index)
          if (line.kind === 'rows') headAt = at
          // A rows or value line lights the card that says what it means.
          if (line.kind === 'rows' || line.kind === 'scalar') anchor(cardId.line(index), at, rows)
          // The context line lights the receipt's card.
          if (line.kind === 'weight') anchor(cardId.weight(), at, rows)
          // The confirmation line lights the card saying what was sent and what came back.
          if (line.kind === 'confirm') anchor(cardId.confirm(), at, rows)
          if (line.kind === 'preview') {
            const head = shownResult[index - 1]?.kind === 'rows' ? headAt : at
            const layout = previewLayout(line.items, rowWidth, column)
            line.items.forEach((item, n) => {
              anchor(cardId.row(listKey(line), n), head, at + rows - head)
              // A row's `▸`, drawn once presses can arrive and the row has more to show: its card is placed by the whole list too, so it covers no sibling.
              if (opts.hasControls === true && opts.callId !== undefined && (openedFields(item).length > 0 || closedItem(item, rowWidth, layout).isCut)) anchor(cardId.toggle(listKey(line), n), head, at + rows - head)
            })
          }
          at += rows
        })
        top += resultRows
      }
      top += noteRows
      roots.forEach((root, r) => {
        // The form's gap above the first root, and the gap between roots.
        top += space
        for (const [id, place] of parts[r]?.triggers ?? []) anchor(id, top + place.row, place.rows)
        top += root.rows
      })
      if (linkRows > 0) {
        top += space
        shownLinks.forEach((link, index) => {
          anchor(cardId.link(index), top, linkRowsOf(link))
          top += linkRowsOf(link)
        })
      }
    }

    return {
      rows: opts.rows,
      total,
      fits: total <= opts.rows,
      header,
      head,
      rule: 1,
      gap: space,
      column,
      summary,
      flags: { all: flags, rows: flagRows, ...(draft !== undefined && { draft }) },
      trust: { rows: trustRows, ...(trust !== undefined && { line: trust }) },
      agent: { rows: agentRows, ...(agent !== undefined && { line: agent }) },
      changes,
      notes: { all: notes, shown, more, rows: noteRows },
      result: { lines: shownResult, more: result.length - shownResult.length, rows: resultRows === 0 ? 0 : space + resultRows },
      links: { shown: shownLinks, rows: linkRows === 0 ? 0 : space + linkRows },
      roots,
      annotations: k.annotations,
      anchors,
      shed: [],
    }
  }

  // Each step turns one knob a notch, the cheapest loss first; a notch that
  // gives back no row is undone and the next is tried. `current` is the total
  // as the knobs stand: an undo puts the knob back exactly as it was.
  let current = build(knobs, false).total
  const tryStep = (apply: () => void, undo: () => void): boolean => {
    apply()
    const after = build(knobs, false).total
    if (after < current) {
      current = after
      return true
    }
    undo()
    return false
  }
  const lastFirst = (count: number) => Array.from({ length: count }, (_, i) => count - 1 - i)
  // The soft notes in the strip as the knobs stand: which fields have a home elsewhere moves with RETURNS.
  const softCount = () => build(knobs, false).notes.all.filter(isSoft).length
  // Only the arguments drawn as rows: those named on the `in CHANGES` row have no lines to cut.
  const argSlots = () => lastFirst(rootFacts.length).flatMap(r => lastFirst(rootFacts[r]?.args.length ?? 0).filter(a => rootFacts[r]?.args[a]?.isInChanges !== true).map(a => [r, a] as const))
  const capArgs = (cap: number) => () =>
    argSlots().some(([r, a]) => {
      const row = knobs.argMax[r] as number[]
      const was = row[a] as number
      return was > cap && tryStep(() => (row[a] = cap), () => (row[a] = was))
    })

  const steps: Record<ShedKind, () => boolean> = {
    'root-description': () => knobs.description && tryStep(() => (knobs.description = false), () => (knobs.description = true)),
    'arg-hints': () => knobs.hints && tryStep(() => (knobs.hints = false), () => (knobs.hints = true)),
    'result-preview': () => knobs.preview > 0 && tryStep(() => (knobs.preview = 0), () => (knobs.preview = Infinity)),
    'default-args': () => knobs.defaults && tryStep(() => (knobs.defaults = false), () => (knobs.defaults = true)),
    'paging-line': () => knobs.paging && tryStep(() => (knobs.paging = false), () => (knobs.paging = true)),
    'summary-credit': () => knobs.credit && tryStep(() => (knobs.credit = false), () => (knobs.credit = true)),
    links: () => knobs.links && tryStep(() => (knobs.links = false), () => (knobs.links = true)),
    'returns-collapse': () =>
      lastFirst(rootFacts.length).some(
        r => !knobs.collapsed[r] && tryStep(() => (knobs.collapsed[r] = true), () => (knobs.collapsed[r] = false)),
      ),
    'access-needs': () =>
      lastFirst(rootFacts.length).some(r => {
        const was = knobs.needs[r] as number
        return was > 1 && tryStep(() => (knobs.needs[r] = 1), () => (knobs.needs[r] = was))
      }),
    'arg-lines': capArgs(ARG_LINES),
    'soft-notes': () => {
      const was = knobs.softKeep
      const next = Math.min(was, softCount()) - 1
      return next >= 2 && tryStep(() => (knobs.softKeep = next), () => (knobs.softKeep = was))
    },
    'section-gaps': () => knobs.gaps && tryStep(() => (knobs.gaps = false), () => (knobs.gaps = true)),
    'arg-first-line': capArgs(1),
    'soft-notes-all': () => {
      const was = knobs.softKeep
      const next = Math.min(was, softCount()) - 1
      return next >= 0 && tryStep(() => (knobs.softKeep = next), () => (knobs.softKeep = was))
    },
    'note-rows': () => knobs.noteRows > 1 && tryStep(() => (knobs.noteRows = 1), () => (knobs.noteRows = NOTE_ROWS)),
    'returns-lines': () =>
      lastFirst(rootFacts.length).some(r => {
        const was = knobs.returnsMax[r] as number
        return was > 1 && tryStep(() => (knobs.returnsMax[r] = 1), () => (knobs.returnsMax[r] = was))
      }),
    'result-weight': () => knobs.weight && tryStep(() => (knobs.weight = false), () => (knobs.weight = true)),
    'change-lines': () => {
      const was = knobs.bodyRows
      return was > BODY_ROWS[1] && tryStep(() => (knobs.bodyRows = BODY_ROWS[1]), () => (knobs.bodyRows = was))
    },
    'change-lines-all': () => {
      const was = knobs.bodyRows
      return was > BODY_ROWS[2] && tryStep(() => (knobs.bodyRows = BODY_ROWS[2]), () => (knobs.bodyRows = was))
    },
    'result-rows': () => knobs.resultRows && tryStep(() => (knobs.resultRows = false), () => (knobs.resultRows = true)),
    'attention-annotations': () =>
      knobs.annotations === 'attention' && tryStep(() => (knobs.annotations = 'none'), () => (knobs.annotations = 'attention')),
  }

  const shed: ShedKind[] = []
  const order = shedOrder(!opts.isPending)
  for (let guard = 0; guard < 500 && current > opts.rows; guard += 1) {
    const kind = order.find(one => steps[one]())
    if (kind === undefined) break
    shed.push(kind)
  }
  return { ...build(knobs), shed }
}
