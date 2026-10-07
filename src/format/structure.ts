// Object and list argument values as a small key/value tree: dim keys, values
// as plain text. Segments are escaped by `seg`, as in every renderer.
import { isRecord } from '../guards.ts'
import { seg } from './types.ts'
import type { Rendered, Segment } from './types.ts'

const MAX_ROWS = 6
const MAX_DEPTH = 3
const MAX_ITEMS = 20
const SEPARATOR = ' · '

type Scalar = string | number | boolean | null
type Row = { depth: number; marker: boolean; hang?: boolean; key?: string; text?: string }

const isScalar = (value: unknown): value is Scalar =>
  value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'

const scalarText = (value: Scalar): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : String(value))

/** Whether `value` is an object or list the structured form draws. */
export const isStructured = (value: unknown): boolean => Array.isArray(value) || isRecord(value)

/** The one scalar an object holds, when it holds exactly one field and it is a scalar. */
function soleScalar(value: unknown): Scalar | undefined {
  if (!isRecord(value)) return undefined
  const entries = Object.values(value)
  const [only] = entries
  return entries.length === 1 && isScalar(only) ? only : undefined
}

/** A list that reads on one line: scalars, or objects that each hold a single scalar. */
function inlineList(list: readonly unknown[]): string | undefined {
  const parts: string[] = []
  for (const item of list) {
    const scalar = isScalar(item) ? item : soleScalar(item)
    if (scalar === undefined) return undefined
    parts.push(scalarText(scalar))
  }
  const shown = parts.slice(0, MAX_ITEMS).join(SEPARATOR)
  return parts.length > MAX_ITEMS ? `${shown}${SEPARATOR}… ${parts.length - MAX_ITEMS} more` : shown
}

function rowsOfObject(value: Record<string, unknown>, depth: number, marker: boolean, out: Row[]): void {
  const start = out.length
  let isFirst = true
  for (const [key, child] of Object.entries(value)) {
    rowsOfValue(child, depth, marker && isFirst, out, key)
    isFirst = false
  }
  // Rows of a list element after its marker hang under it.
  if (marker) for (const row of out.slice(start + 1)) row.hang = true
}

function rowsOfValue(value: unknown, depth: number, marker: boolean, out: Row[], key?: string): void {
  const row = (text: string | undefined): Row => ({ depth, marker, ...(key !== undefined && { key }), ...(text !== undefined && { text }) })
  if (isScalar(value)) return void out.push(row(scalarText(value)))
  if (Array.isArray(value)) {
    if (value.length === 0) return void out.push(row('none'))
    const inline = inlineList(value)
    if (inline !== undefined) return void out.push(row(inline))
    if (depth >= MAX_DEPTH) return void out.push(row(JSON.stringify(value) ?? ''))
    if (key !== undefined) out.push(row(undefined))
    const nested = key !== undefined ? depth + 1 : depth
    const isMany = value.length > 1
    for (const item of value.slice(0, MAX_ITEMS)) {
      if (isRecord(item)) rowsOfObject(item, nested, isMany, out)
      else rowsOfValue(item, nested, isMany, out)
    }
    return
  }
  if (isRecord(value)) {
    if (Object.keys(value).length === 0) return void out.push(row('empty'))
    if (depth >= MAX_DEPTH) return void out.push(row(JSON.stringify(value) ?? ''))
    if (key !== undefined) {
      out.push(row(undefined))
      rowsOfObject(value, depth + 1, false, out)
    } else rowsOfObject(value, depth, marker, out)
    return
  }
  // Not plain data (a function, a symbol, a bigint): the caller falls back.
  throw new TypeError('not plain data')
}

/** An object or list as rows: `fieldName type` / `values page · document`, up to 6, then `… N more`. */
export function renderStructure(value: unknown): Rendered {
  // A bare list of scalars is one line.
  if (Array.isArray(value)) {
    const inline = value.length > 0 ? inlineList(value) : undefined
    if (inline !== undefined) return { lines: [[seg(inline, 'value')]], isFallback: false }
  }
  const rows: Row[] = []
  rowsOfValue(value, 0, false, rows)
  const shown = rows.slice(0, MAX_ROWS)
  const lines: Segment[][] = shown.map(row => {
    const line: Segment[] = []
    // Indent and list markers carry no tone, so the form's layout collapsing leaves them alone.
    const pad = '  '.repeat(row.depth) + (row.hang === true ? '  ' : '')
    if (row.marker) line.push(seg(`${pad}- `, 'value'))
    else if (pad.length > 0) line.push(seg(pad, 'value'))
    if (row.key !== undefined) line.push(seg(row.key, 'dim'))
    if (row.key !== undefined && row.text !== undefined) line.push(seg(' ', 'value'))
    if (row.text !== undefined) line.push(seg(row.text, 'value'))
    return line
  })
  const cut = rows.length - shown.length
  if (cut > 0) lines.push([seg(`… ${cut} more`, 'dim')])
  return { lines, isFallback: false, ...(cut > 0 && { isTruncated: true }) }
}
