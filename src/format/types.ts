// Shared output shape for the argument renderers: plain data the view turns
// into elements. Every segment's text has been through `escapeText`.
import { escapeText } from '../escape.ts'

export type Tone = 'key' | 'op' | 'value' | 'dim' | 'emph' | 'warn'
/** `url` makes the text a link (src/format/record-links.ts); only canonical https built from the configured host. */
export type Segment = { text: string; tone?: Tone; url?: string }
export type Rendered = {
  lines: Segment[][]
  isFallback: boolean
  /** Set by the fallback when it cut the value short. */
  isTruncated?: boolean
  /** Lines the compact fallback leaves out, counted: the view says `N more lines` under the ones it drew. */
  more?: number
}

/** The only way renderers make a segment: escapes the text. */
export function seg(text: string, tone?: Tone): Segment {
  const { text: escaped } = escapeText(text)
  return tone === undefined ? { text: escaped } : { text: escaped, tone }
}

/** Whether escaping would have to cut `value`; structured renderers then fall back. */
export function isTooLong(value: string): boolean {
  return escapeText(value).isTruncated
}
