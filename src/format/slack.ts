// Slack search syntax: modifiers on their own lines, free text grouped, order kept.
import { escapeText } from '../escape.ts'
import { renderFallback } from './fallback.ts'
import { isTooLong, seg } from './types.ts'
import type { Rendered, Segment } from './types.ts'

const MODIFIER = /^(-?(?:in|from|to|after|before|on|during|has|is):)([\s\S]*)$/i

/** Splits on whitespace outside double quotes; undefined when a quote is unbalanced. */
function words(input: string): string[] | undefined {
  const out: string[] = []
  let current = ''
  let inQuote = false
  for (const c of input) {
    if (c === '"') inQuote = !inQuote
    if (!inQuote && /\s/.test(c)) {
      if (current !== '') out.push(current)
      current = ''
    } else current += c
  }
  if (inQuote) return undefined
  if (current !== '') out.push(current)
  return out
}

export function renderSlack(value: unknown): Rendered {
  if (typeof value !== 'string' || isTooLong(value)) return renderFallback(value)
  const split = words(escapeText(value).text)
  if (split === undefined || split.length === 0) return renderFallback(value)

  const lines: Segment[][] = []
  let free: string[] = []
  const flush = () => {
    if (free.length > 0) lines.push([seg(free.join(' '), 'value')])
    free = []
  }
  for (const word of split) {
    const match = MODIFIER.exec(word)
    if (match === null) {
      free.push(word)
      continue
    }
    flush()
    const line = [seg(match[1] ?? '', 'key')]
    if (match[2] !== undefined && match[2] !== '') line.push(seg(match[2], 'value'))
    lines.push(line)
  }
  flush()
  return { lines, isFallback: false }
}
