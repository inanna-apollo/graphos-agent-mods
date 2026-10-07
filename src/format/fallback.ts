// Plain-text rendering of any value. Used when a renderer cannot parse its input.
import { escapeText } from '../escape.ts'
import { seg } from './types.ts'
import type { Rendered, Segment } from './types.ts'

const COMPACT_LINES = 2
const COMPACT_WIDTH = 140

/** Strings as-is, everything else as JSON. */
export function fallbackText(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    try {
      return String(value)
    } catch {
      return '[unprintable value]'
    }
  }
}

/**
 * Where `line` breaks into pieces of at most `width` characters, never inside
 * a word: each piece ends at the last space at or before the width (the space
 * left between pieces, so the next starts on a word), and is cut hard only
 * inside a run with no space. A surrogate pair is never split. Each piece is
 * a `[start, end)` range of `line`.
 */
export function chunkRanges(line: string, width: number): [number, number][] {
  const w = Math.max(1, Math.floor(width))
  const out: [number, number][] = []
  let at = 0
  while (line.length - at > w) {
    const space = line.lastIndexOf(' ', at + w)
    if (space >= at) {
      // The piece ends before the run of spaces the break falls in; a run at its start ends nothing and is passed over.
      let end = space
      while (end > at && line.charAt(end - 1) === ' ') end -= 1
      if (end > at) out.push([at, end])
      at = space + 1
      continue
    }
    let end = at + w
    if (/[\ud800-\udbff]/.test(line.charAt(end - 1))) end -= 1
    // A width of one cannot hold a surrogate pair: it goes whole.
    if (end <= at) end = at + 2
    out.push([at, end])
    at = end
  }
  out.push([at, line.length])
  return out
}

/** `line` in the pieces chunkRanges says. */
export const chunk = (line: string, width: number): string[] => chunkRanges(line, width).map(([start, end]) => line.slice(start, end))

/**
 * Compact form: the first two pieces of about 140 characters (chunkRanges),
 * those of one source line drawn as one line the surface wraps at its spaces;
 * the pieces past them are counted (`more`, said `N more lines` under them,
 * never a `…`), and `isTruncated` when there were any or escaping cut the value.
 */
export function renderFallback(value: unknown): Rendered {
  const escaped = escapeText(fallbackText(value))
  const pieces = escaped.text.split('\n').flatMap((line, index) => chunkRanges(line, COMPACT_WIDTH).map(([start, end]) => ({ index, line, start, end })))
  const shown = pieces.slice(0, COMPACT_LINES)
  const more = pieces.length - shown.length
  const isTruncated = escaped.isTruncated || more > 0
  // Pieces of one source line join back up: a row break mid-sentence would read as the value's own.
  const joined: { index: number; line: string; start: number; end: number }[] = []
  for (const piece of shown) {
    const last = joined[joined.length - 1]
    if (last !== undefined && last.index === piece.index) last.end = piece.end
    else joined.push({ ...piece })
  }
  const lines: Segment[][] = joined.map(piece => [seg(piece.line.slice(piece.start, piece.end), 'value')])
  if (lines.length === 0) lines.push([seg('', 'value')])
  return { lines, isFallback: true, isTruncated, ...(more > 0 && { more }) }
}

/** Full form: escaped, one line per source line, cut only at escapeText's cap. */
export function full(value: unknown): Rendered {
  const escaped = escapeText(fallbackText(value))
  const lines = escaped.text.split('\n').map(line => [seg(line, 'value')])
  return { lines, isFallback: true, isTruncated: escaped.isTruncated }
}
