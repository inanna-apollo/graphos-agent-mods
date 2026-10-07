import { renderFallback } from './fallback.ts'
import { isTooLong, seg } from './types.ts'
import type { Rendered } from './types.ts'

/** An identifier on one line, emphasized. */
export function renderId(value: unknown): Rendered {
  const text = typeof value === 'number' || typeof value === 'bigint' ? String(value) : value
  if (typeof text !== 'string' || text === '' || /[\r\n]/.test(text) || isTooLong(text)) return renderFallback(value)
  return { lines: [[seg(text, 'emph')]], isFallback: false }
}
