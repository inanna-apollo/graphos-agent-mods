// A text layout engine for the plain-data element tree viewOf returns, so a
// pane can be written to a file without a terminal. Pure. It is a rough
// flexbox (rows, columns, grow spacers, wrap and truncate), enough to read
// the pane the way the terminal draws it; colors and bold are dropped.

type El = { type: string; props: Record<string, any>; children: Node[] }
type Node = string | El

const STILL = '✻'

// ---- Display width

/** BMP emoji drawn two cells wide with no selector (src/view/plan.ts BMP_EMOJI). */
const BMP_EMOJI: readonly [number, number][] = [
  [0x231a, 0x231b], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615],
  [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be],
  [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5],
  [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c],
  [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
]
const BMP_EMOJI_CODES = new Set(BMP_EMOJI.flatMap(([from, to]) => Array.from({ length: to - from + 1 }, (_, at) => from + at)))

function cellsOf(code: number): number {
  // The emoji selector widens the narrow character before it to two cells.
  if (code === 0xfe0f) return 1
  if (code === 0 || code === 0x200d || (code >= 0xfe00 && code <= 0xfe0e)) return 0
  if ((code >= 0x300 && code <= 0x36f) || (code >= 0x1ab0 && code <= 0x1aff) || (code >= 0x1dc0 && code <= 0x1dff) || (code >= 0x20d0 && code <= 0x20ff) || (code >= 0xfe20 && code <= 0xfe2f)) return 0
  if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return 0
  const isWide =
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f000 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd) ||
    BMP_EMOJI_CODES.has(code)
  return isWide ? 2 : 1
}

/** Terminal cells `text` takes: wide CJK and emoji two, combining marks none. */
export function displayWidth(text: string): number {
  let cells = 0
  for (const char of text) cells += cellsOf(char.codePointAt(0) ?? 0)
  return cells
}

const cellsOfChar = (char: string) => cellsOf(char.codePointAt(0) ?? 0)

/** The longest prefix of `text` within `width` cells. */
function takeCells(text: string, width: number): string {
  let used = 0
  let out = ''
  for (const char of text) {
    const w = cellsOfChar(char)
    if (used + w > width) break
    used += w
    out += char
  }
  return out
}

/** The longest suffix of `text` within `width` cells. */
function takeEndCells(text: string, width: number): string {
  let used = 0
  let out = ''
  for (const char of [...text].reverse()) {
    const w = cellsOfChar(char)
    if (used + w > width) break
    used += w
    out = char + out
  }
  return out
}

const pad = (text: string, width: number) => text + ' '.repeat(Math.max(0, width - displayWidth(text)))

// ---- Tree

function flatten(raw: unknown): Node[] {
  if (raw === null || raw === undefined || typeof raw === 'boolean' || raw === '') return []
  if (Array.isArray(raw)) return raw.flatMap(flatten)
  if (typeof raw === 'string') return [raw]
  if (typeof raw === 'number') return [String(raw)]
  if (typeof raw === 'object') {
    const el = raw as { type?: unknown; props?: Record<string, any>; children?: unknown }
    if (typeof el.type !== 'string') return []
    const props = el.props ?? {}
    if (props.display === 'none' || props.position === 'absolute') return []
    return [{ type: el.type, props, children: flatten(el.children ?? props.children) }]
  }
  return []
}

/**
 * The element table to hand viewOf: string-tag constructors that build plain
 * `{ type, props, children }` (JSX's `h` calls a function tag with its props,
 * children among them, so no engine is needed).
 */
export function stubKit() {
  const make = (type: string) => (props: Record<string, any> | null | undefined) => {
    const p = props ?? {}
    return { type, props: p, children: flatten(p.children) } as never
  }
  return {
    Box: make('Box'),
    Text: make('Text'),
    Code: make('Code'),
    Button: make('Button'),
    Link: make('Link'),
    Client: make('Client'),
  } as any
}

/** Inline text of a node: nested Text, a Link's children, a Button's label, a Client's still line. */
function inline(node: Node): string {
  if (typeof node === 'string') return node
  const { type, props } = node
  if (type === 'Button') {
    const label = typeof props.label === 'string' ? props.label : node.children.map(inline).join('')
    return (props.hotkey ? `${props.hotkey}: ` : '') + label
  }
  if (type === 'Link') {
    const own = node.children.map(inline).join('')
    return own !== '' ? own : String(props.label ?? props.href ?? '')
  }
  if (type === 'Client') return `${STILL} ${String(props.props?.text ?? props.text ?? '')}`
  if (type === 'Code') return String(props.source ?? '')
  return node.children.map(inline).join('')
}

// ---- Text rows

// Word breaks are ASCII whitespace only: `\s` would also split at U+00A0, which keeps a credit together.
const trimEndAscii = (text: string) => text.replace(/[ \t\r\n]+$/, '')
const trimStartAscii = (text: string) => text.replace(/^[ \t\r\n]+/, '')

export function wrapRows(text: string, width: number): string[] {
  const w = Math.max(1, width)
  const rows: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const token of paragraph.match(/[ \t\r]*[^ \t\r]+/g) ?? []) {
      let t = token
      if (line !== '' && displayWidth(line + t) > w) {
        rows.push(trimEndAscii(line))
        line = ''
        t = trimStartAscii(t)
      }
      // A word longer than the line is broken across rows.
      while (displayWidth(line + t) > w) {
        const head = takeCells(t, w - displayWidth(line)) || (line === '' ? [...t][0] ?? '' : '')
        if (head === '') {
          rows.push(trimEndAscii(line))
          line = ''
          continue
        }
        rows.push(trimEndAscii(line + head))
        line = ''
        t = t.slice(head.length)
      }
      line += t
    }
    rows.push(trimEndAscii(line))
  }
  return rows
}

function truncateRow(text: string, width: number, mode: string): string {
  if (displayWidth(text) <= width) return text
  if (width <= 1) return takeCells('…', width)
  if (mode === 'truncate-start') return '…' + takeEndCells(text, width - 1)
  if (mode === 'truncate-middle') {
    const left = Math.ceil((width - 1) / 2)
    return takeCells(text, left) + '…' + takeEndCells(text, width - 1 - left)
  }
  return takeCells(text, width - 1) + '…'
}

function textRows(text: string, width: number, wrap: unknown): string[] {
  if (typeof wrap === 'string' && wrap.startsWith('truncate')) return text.split('\n').map(line => truncateRow(line, width, wrap))
  return wrapRows(text, width)
}

// ---- Measure

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0)

function spacing(props: Record<string, any>, kind: 'padding' | 'margin') {
  const all = num(props[kind])
  const x = props[`${kind}X`] !== undefined ? num(props[`${kind}X`]) : all
  const y = props[`${kind}Y`] !== undefined ? num(props[`${kind}Y`]) : all
  const side = (name: string, fallback: number) => (props[`${kind}${name}`] !== undefined ? num(props[`${kind}${name}`]) : fallback)
  return { left: side('Left', x), right: side('Right', x), top: side('Top', y), bottom: side('Bottom', y) }
}

const isBox = (n: Node): boolean => typeof n !== 'string' && !['Text', 'Button', 'Link', 'Client', 'Code'].includes(n.type)
const gapOf = (props: Record<string, any>, axis: 'column' | 'row') => num(props[axis === 'column' ? 'columnGap' : 'rowGap'] ?? props.gap)
const isRowBox = (props: Record<string, any>) => props.flexDirection === 'row' || props.flexDirection === 'row-reverse'

function natural(node: Node): number {
  if (typeof node === 'string') return Math.max(0, ...node.split('\n').map(displayWidth))
  if (!isBox(node)) {
    const m = spacing(node.props, 'margin')
    return Math.max(0, ...inline(node).split('\n').map(displayWidth)) + m.left + m.right
  }
  const p = node.props
  const pd = spacing(p, 'padding')
  const mg = spacing(p, 'margin')
  if (typeof p.width === 'number') return num(p.width) + mg.left + mg.right
  const kids = node.children.map(natural)
  const content = isRowBox(p) ? kids.reduce((a, b) => a + b, 0) + gapOf(p, 'column') * Math.max(0, kids.length - 1) : Math.max(0, ...kids)
  return Math.max(content, num(p.minWidth)) + pd.left + pd.right + mg.left + mg.right
}

// ---- Layout

function render(node: Node, width: number): string[] {
  const w = Math.max(1, width)
  if (typeof node === 'string') return textRows(node, w, 'wrap')
  const { type, props } = node
  // A Client's still line as the spinner lays it out: the glyph in a two-cell column, the text wrapping after it.
  if (type === 'Client') return wrapRows(String(props.props?.text ?? props.text ?? ''), Math.max(1, w - 2)).map((row, index) => `${index === 0 ? STILL : ' '} ${row}`)
  if (type === 'Code') {
    return String(props.source ?? '')
      .split('\n')
      .flatMap(row => (props.wrap === 'wrap' ? wrapRows(row, w) : [truncateRow(row, w, 'truncate-end')]))
  }
  if (!isBox(node)) {
    const m = spacing(props, 'margin')
    const rows = textRows(inline(node), Math.max(1, w - m.left - m.right), props.wrap).map(row => ' '.repeat(m.left) + row)
    return [...Array<string>(m.top).fill(''), ...rows, ...Array<string>(m.bottom).fill('')]
  }

  const pd = spacing(props, 'padding')
  const mg = spacing(props, 'margin')
  const outer = typeof props.width === 'number' ? Math.min(w, num(props.width) + mg.left + mg.right) : w
  const inner = Math.max(1, outer - mg.left - mg.right - pd.left - pd.right)
  let rows = isRowBox(props) ? layoutRow(node, inner) : layoutColumn(node, inner)

  rows = [...Array<string>(pd.top).fill(''), ...rows, ...Array<string>(pd.bottom).fill('')]
  if (typeof props.height === 'number') {
    const h = num(props.height)
    rows = rows.length >= h ? rows.slice(0, h) : [...rows, ...Array<string>(h - rows.length).fill('')]
  }
  const left = ' '.repeat(mg.left + pd.left)
  rows = rows.map(row => (row === '' ? '' : left + row))
  return [...Array<string>(mg.top).fill(''), ...rows, ...Array<string>(mg.bottom).fill('')]
}

function layoutColumn(box: El, inner: number): string[] {
  const gap = gapOf(box.props, 'row')
  const align = box.props.alignItems
  const rows: string[] = []
  box.children.forEach((kid, index) => {
    if (index > 0) for (let g = 0; g < gap; g++) rows.push('')
    const own = render(kid, inner)
    if (align === 'center' || align === 'flex-end') {
      const used = Math.min(inner, Math.max(0, ...own.map(displayWidth)))
      const offset = align === 'center' ? Math.floor((inner - used) / 2) : inner - used
      rows.push(...own.map(row => (row === '' ? '' : ' '.repeat(offset) + row)))
    } else rows.push(...own)
  })
  return rows
}

function layoutRow(box: El, inner: number): string[] {
  const p = box.props
  const kids = box.children
  const gap = gapOf(p, 'column')
  if (kids.length === 0) return []

  if (p.flexWrap === 'wrap') {
    const lines: Node[][] = [[]]
    let used = 0
    for (const kid of kids) {
      const wd = Math.min(natural(kid), inner)
      if (used > 0 && used + gap + wd > inner) {
        lines.push([])
        used = 0
      }
      lines[lines.length - 1]?.push(kid)
      used += (used > 0 ? gap : 0) + wd
    }
    const out: string[] = []
    lines.forEach((items, i) => {
      if (i > 0) for (let g = 0; g < gapOf(p, 'row'); g++) out.push('')
      const widths = items.map(kid => Math.min(natural(kid), inner))
      out.push(...joinCells(widths, items.map((kid, k) => render(kid, widths[k] ?? 1)), gap, inner, p.justifyContent))
    })
    return out
  }

  const grow = kids.map(kid => (typeof kid === 'string' ? 0 : Number(kid.props.flexGrow) || 0))
  const shrink = kids.map(kid => (typeof kid === 'string' || kid.props.flexShrink === undefined ? 1 : Number(kid.props.flexShrink) || 0))
  const minW = kids.map(kid => (typeof kid === 'string' ? 0 : num(kid.props.minWidth)))
  const widths = kids.map((kid, i) => Math.max(minW[i] ?? 0, Math.min(natural(kid), inner)))
  const total = widths.reduce((a, b) => a + b, 0) + gap * (kids.length - 1)
  const growers = grow.map((g, i) => (g > 0 ? i : -1)).filter(i => i >= 0)
  if (total < inner && growers.length > 0) {
    const sum = growers.reduce((a, i) => a + (grow[i] ?? 0), 0)
    const spare = inner - total
    let given = 0
    growers.forEach((i, k) => {
      const share = k === growers.length - 1 ? spare - given : Math.floor((spare * (grow[i] ?? 0)) / sum)
      widths[i] = (widths[i] ?? 0) + share
      given += share
    })
  } else if (total > inner) {
    // Shrink the shrinkable children, widest first, never below their minWidth (or 1).
    for (let over = total - inner; over > 0; over--) {
      const target = widths
        .map((_, i) => i)
        .filter(i => (shrink[i] ?? 0) > 0 && (widths[i] ?? 0) > Math.max(1, minW[i] ?? 0))
        .sort((a, b) => (widths[b] ?? 0) - (widths[a] ?? 0))[0]
      if (target === undefined) break
      widths[target] = (widths[target] ?? 0) - 1
    }
  }
  return joinCells(widths, kids.map((kid, i) => render(kid, widths[i] ?? 1)), gap, inner, p.justifyContent)
}

function joinCells(widths: number[], cells: string[][], gap: number, inner: number, justify: unknown): string[] {
  const height = Math.max(0, ...cells.map(c => c.length))
  const used = widths.reduce((a, b) => a + b, 0) + gap * Math.max(0, widths.length - 1)
  let between = gap
  let lead = 0
  if (justify === 'space-between' && widths.length > 1) between = gap + Math.floor((inner - used) / (widths.length - 1))
  if (justify === 'flex-end') lead = Math.max(0, inner - used)
  if (justify === 'center') lead = Math.max(0, Math.floor((inner - used) / 2))
  const out: string[] = []
  for (let r = 0; r < height; r++) {
    const row = cells.map((cell, i) => pad(cell[r] ?? '', widths[i] ?? 0)).join(' '.repeat(between))
    out.push((' '.repeat(lead) + row).trimEnd())
  }
  return out
}

/**
 * The tree as text, `columns` cells wide at most. Styling is dropped; a
 * Client draws its still line (`✻ text`), a Button as `hotkey: label`.
 */
export function renderText(tree: unknown, columns: number): string {
  const width = Math.max(1, Math.floor(columns))
  const rows = flatten(tree).flatMap(node => render(node, width))
  return rows
    .map(row => {
      const trimmed = row.trimEnd()
      return displayWidth(trimmed) > width ? takeCells(trimmed, width) : trimmed
    })
    .join('\n')
    .replace(/\n+$/, '')
}
