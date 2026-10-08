// What an Agent Services response cost Claude's context, and which fields cost it. Pure: no $.
//
// Everything is computed from the parsed response and the call's IR, never
// from model text, and measured on the response's JSON written compactly
// (what `JSON.stringify` writes: no spaces), in UTF-8 bytes. A service that
// pretty-prints its text cost the context a little more than this says; the
// measure does not move with a service's whitespace, so two calls compare.
//
// A field's cost is its path's, all the rows of a list at once: list indices
// are dropped (`issues.fields.description`, as the error grouping in
// result.ts writes a path), and every member written under that path adds its
// key and its value. A parent's bytes include its children's, so the paths
// form a tree.
//
// Select fields accounting for at least MIN_SHARE of the response. Descend
// into a parent's qualifying children when their combined share reaches MOST;
// otherwise retain the parent. Keep at most MAX_HEAVY entries, heaviest first.
//
// Bounds, since the result is kept in $.state and a response can be 2 MB:
// MAX_PATHS distinct paths are tracked (a map-like object keyed by ids would
// otherwise make thousands); deeper than MAX_DEPTH fields, or past the path
// cap, a value's bytes stay in the field above it; names are cut at generous
// lengths. The total is always exact.

import { isRecord } from './guards.ts'
import type { CallIR, CallWeight, FieldIR, WeightField } from './ir.ts'

/** A field is named when it holds at least this share of the response. */
export const MIN_SHARE = 0.1
/** The named fields below a parent replace it only when together they hold at least this share of it. */
export const MOST = 0.5
/** Most fields kept. */
export const MAX_HEAVY = 5
/** Most distinct field paths tracked in one response. */
export const MAX_PATHS = 2_000
/** Deepest field level tracked (a root is level 1). */
export const MAX_DEPTH = 10
/** The longest key kept in a path, in characters; a path is generous at four of them. */
export const MAX_SEGMENT = 120
const MAX_PATH = 4 * MAX_SEGMENT
/** Rough JSON token estimate, not a measurement from the model's tokenizer. */
export const BYTES_PER_TOKEN = 4

// ---- Measuring

/** Bytes of `text` in UTF-8; a lone surrogate is U+FFFD (three), as an encoder writes it. */
export function utf8Bytes(text: string): number {
  let bytes = 0
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && text.charCodeAt(at + 1) >= 0xdc00 && text.charCodeAt(at + 1) <= 0xdfff) {
      bytes += 4
      at += 1
    } else bytes += 3
  }
  return bytes
}

/** Bytes of a string as JSON writes it, quotes and escapes included (a lone surrogate is escaped, as `JSON.stringify` does since ES2019). */
function stringBytes(text: string): number {
  let bytes = 2
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at)
    if (code === 0x22 || code === 0x5c) bytes += 2
    else if (code < 0x20) bytes += code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 2 : 6
    else if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(at + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        at += 1
      } else bytes += 6
    } else if (code >= 0xdc00 && code <= 0xdfff) bytes += 6
    else bytes += 3
  }
  return bytes
}

/** One tracked field path while a response is walked. */
type Node = {
  key: string
  parent: Node | undefined
  /** A member of the response beside `data`, or under one. */
  isMeta: boolean
  /** Bytes of every member at this path, key included. */
  bytes: number
  /** Items of every list written at this path, all together. */
  items: number
  children: Map<string, Node>
}

type Walk = { paths: number; isCapped: boolean }

const nodeOf = (key: string, parent: Node | undefined, isMeta: boolean): Node => ({ key, parent, isMeta, bytes: 0, items: 0, children: new Map() })

/** The tracked node for `key` under `node`, made when there is room; undefined where nothing is tracked (too deep, past the path cap, or inside an untracked field). */
function childOf(node: Node | undefined, key: string, depth: number, walk: Walk): Node | undefined {
  if (node === undefined || depth > MAX_DEPTH) return undefined
  const found = node.children.get(key)
  if (found !== undefined) return found
  if (walk.paths >= MAX_PATHS) {
    walk.isCapped = true
    return undefined
  }
  walk.paths += 1
  const made = nodeOf(key, node, node.isMeta)
  node.children.set(key, made)
  return made
}

/**
 * Bytes of `value` as compact JSON, adding each member written under `node`
 * to its child's tally. A list's items are written at the list's own node
 * (indices collapse), so an item's fields are the list's children.
 */
function measure(value: unknown, node: Node | undefined, depth: number, walk: Walk): number {
  if (typeof value === 'string') return stringBytes(value)
  if (typeof value === 'number') return Number.isFinite(value) ? String(value).length : 4
  if (typeof value === 'boolean') return value ? 4 : 5
  if (Array.isArray(value)) {
    if (node !== undefined) node.items += value.length
    let bytes = 2 + Math.max(0, value.length - 1)
    for (const item of value) bytes += measure(item, node, depth, walk)
    return bytes
  }
  if (isRecord(value)) {
    const keys = Object.keys(value)
    let bytes = 2 + Math.max(0, keys.length - 1)
    for (const key of keys) {
      const child = childOf(node, key, depth, walk)
      const member = stringBytes(key) + 1 + measure(value[key], child, depth + 1, walk)
      if (child !== undefined) child.bytes += member
      bytes += member
    }
    return bytes
  }
  // null, and anything JSON cannot hold (written as null).
  return 4
}

// ---- Choosing

/**
 * The fields under `node` that explain it: those holding at least `floor`
 * bytes, when together they hold most of the node, each explained in turn;
 * else the node itself.
 */
function explain(node: Node, floor: number): Node[] {
  const big = [...node.children.values()].filter(child => child.bytes >= floor)
  const held = big.reduce((sum, child) => sum + child.bytes, 0)
  return big.length === 0 || held < node.bytes * MOST ? [node] : big.flatMap(child => explain(child, floor))
}

/** `text` cut to `max` characters, never between the halves of a surrogate pair. A safety bound for what is kept, not a way to shorten a name for display. */
function bounded(text: string, max: number): string {
  if (text.length <= max) return text
  const end = text.charCodeAt(max - 1) >= 0xd800 && text.charCodeAt(max - 1) <= 0xdbff ? max - 1 : max
  return text.slice(0, end)
}

/** The keys from the response's member down to `node`. */
function keysOf(node: Node): string[] {
  const keys: string[] = []
  for (let at: Node | undefined = node; at !== undefined && at.parent !== undefined; at = at.parent) keys.unshift(at.key)
  return keys
}

/**
 * The names below the root for the response keys `keys` (`[root, ...below]`):
 * each by the real field name the IR has at that path, so an alias reads as
 * the field it is; a key the IR has no field for (inside untyped JSON) stays
 * as the response wrote it.
 */
function namesBelow(ir: Pick<CallIR, 'roots'>, keys: readonly string[]): string[] {
  let field: FieldIR | undefined = ir.roots.find(root => root.path === keys[0])
  return keys.slice(1).map(key => {
    const parent: FieldIR | undefined = field
    field = parent === undefined ? undefined : parent.children.find(child => child.path === `${parent.path}.${key}`)
    return field?.name ?? key
  })
}

/** The rows of the nearest list on `node`'s path, itself included. */
function rowsOf(node: Node): number | undefined {
  for (let at: Node | undefined = node; at !== undefined; at = at.parent) if (at.items > 0) return at.items
  return undefined
}

const round4 = (share: number) => Math.round(share * 10_000) / 10_000

/** A response walked: its bytes, the tracked fields at its top (the roots, then the response's own members), and whether the path cap was met. */
type Measured = { bytes: number; top: Node[]; isCapped: boolean }

function measured(response: Record<string, unknown>): Measured {
  const walk: Walk = { paths: 0, isCapped: false }
  // `data` holds the roots; every other member of the response (`errors`, `extensions`) is a top-level field of its own, marked as the response's.
  const data = nodeOf('data', undefined, false)
  const beside = nodeOf('', undefined, true)
  const metas: Node[] = []
  const keys = Object.keys(response)
  let bytes = 2 + Math.max(0, keys.length - 1)
  for (const key of keys) {
    const value = response[key]
    if (key === 'data') {
      // A `data` that is null (the roots failed) is its own few bytes, not a field.
      bytes += stringBytes(key) + 1 + measure(value, isRecord(value) ? data : undefined, 1, walk)
      continue
    }
    const meta = nodeOf(key, beside, true)
    walk.paths += 1
    const member = stringBytes(key) + 1 + measure(value, meta, 2, walk)
    meta.bytes = member
    metas.push(meta)
    bytes += member
  }
  return { bytes, top: [...data.children.values(), ...metas], isCapped: walk.isCapped }
}

/** A tracked field as it is kept: its path by response keys and by real names, its bytes, share and rows. */
function entryOf(ir: Pick<CallIR, 'roots'>, node: Node, total: number): WeightField {
  const path = keysOf(node)
  const name = node.isMeta ? path : namesBelow(ir, path)
  const rows = rowsOf(node)
  return {
    path: bounded(path.map(key => bounded(key, MAX_SEGMENT)).join('.'), MAX_PATH),
    name: bounded(name.map(key => bounded(key, MAX_SEGMENT)).join('.'), MAX_PATH),
    bytes: node.bytes,
    share: round4(node.bytes / total),
    ...(rows !== undefined && { rows }),
    ...(node.isMeta && { isMeta: true as const }),
  }
}

/**
 * What the response weighed and which fields explain it. `response` is the
 * parsed GraphQL response (`{ data, errors, extensions }`). Undefined when it
 * is not an object, or too deeply nested to walk.
 */
export function weightOf(ir: Pick<CallIR, 'roots'>, response: unknown): CallWeight | undefined {
  if (!isRecord(response)) return undefined
  try {
    const { bytes, top, isCapped } = measured(response)
    const floor = bytes * MIN_SHARE
    const significant = top.filter(node => node.bytes >= floor)
    const heaviest = top.reduce<Node | undefined>((best, node) => (best === undefined || node.bytes > best.bytes ? node : best), undefined)
    const chosen = (significant.length > 0 ? significant.flatMap(node => explain(node, floor)) : heaviest === undefined ? [] : [heaviest])
      .map((node, order) => ({ node, order }))
      .sort((a, b) => b.node.bytes - a.node.bytes || a.order - b.order)
      .slice(0, MAX_HEAVY)
    return { bytes, fields: chosen.map(one => entryOf(ir, one.node, bytes)), ...(isCapped && { isCapped: true as const }) }
  } catch {
    // Nested past what the stack walks: no receipt, and nothing else lost.
    return undefined
  }
}

/**
 * Every field path the walk tracked, in the order the response wrote them (a
 * field before the fields under it), each with its bytes, share and rows: the
 * table `weightOf` chooses from. At most MAX_PATHS of them; not kept anywhere.
 */
export function fieldsOf(ir: Pick<CallIR, 'roots'>, response: unknown): { bytes: number; fields: WeightField[] } | undefined {
  if (!isRecord(response)) return undefined
  try {
    const { bytes, top } = measured(response)
    const all = (nodes: Iterable<Node>): Node[] => [...nodes].flatMap(node => [node, ...all(node.children.values())])
    return { bytes, fields: all(top).map(node => entryOf(ir, node, bytes)) }
  } catch {
    return undefined
  }
}

/** The weight of a response Claude Code kept out of the context: sized from the file it saved, which the mod read back. */
export function persistedWeight(weight: CallWeight): CallWeight {
  return { ...weight, isPersisted: true }
}

/** What the response would weigh without `field`: its bytes less the field's. */
export const bytesWithout = (weight: CallWeight, field: WeightField): number => Math.max(0, weight.bytes - field.bytes)

// ---- Saying it

const trimmed = (text: string) => text.replace(/\.0$/, '')

/** Bytes as people read them: `812 B`, `4.2 KB`, `58 KB`, `1.4 MB` (a KB is 1,024 bytes, as Claude Code counts them). */
export function sizeText(bytes: number): string {
  const n = Math.max(0, Math.round(bytes))
  if (n < 1024) return `${n} B`
  const kb = n / 1024
  if (kb < 10) return `${trimmed(kb.toFixed(1))} KB`
  if (Math.round(kb) < 1024) return `${Math.round(kb)} KB`
  const mb = n / 1_048_576
  return mb < 10 ? `${trimmed(mb.toFixed(1))} MB` : `${Math.round(mb)} MB`
}

/** A compact rounded count: `85`, `850`, `1.4k`, `14k`, `1.2M`. */
function compactCount(count: number): string {
  if (count < 100) return String(count)
  if (count < 1000) {
    const near = Math.round(count / 10) * 10
    return near < 1000 ? String(near) : '1k'
  }
  if (count < 10_000) {
    const k = Math.round(count / 100) / 10
    return k < 10 ? `${k}k` : '10k'
  }
  if (count < 1_000_000) {
    const k = Math.round(count / 1000)
    return k < 1000 ? `${k}k` : '1M'
  }
  const m = count / 1_000_000
  return m < 10 ? `${trimmed(m.toFixed(1))}M` : `${Math.round(m)}M`
}

/** Approximate tokens from compact JSON bytes; content and tokenizer affect the actual count. */
export const tokensOf = (bytes: number): number => Math.round(Math.max(0, bytes) / BYTES_PER_TOKEN)

/** Format the estimate with an explicit qualifier: `about 14k tokens`. */
export function tokensText(bytes: number): string {
  const tokens = tokensOf(bytes)
  return `about ${compactCount(tokens)} token${tokens === 1 ? '' : 's'}`
}

/** A share as a percent: `71%`, `<1%` for a trace. */
export function percentText(share: number): string {
  const percent = share * 100
  return percent > 0 && percent < 1 ? '<1%' : `${Math.round(percent)}%`
}
