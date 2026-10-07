// Make model- and schema-written strings safe to draw. Pure: no $.
//
// Terminal control sequences, other C0/C1 controls, bidi overrides and
// invisible characters are shown as visible escapes rather than
// interpreted, so a hostile argument cannot recolor the pane, move the
// cursor, reorder what you read or hide text in plain sight.

// An unterminated OSC stops at the line's end rather than eating the rest.
const SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b\n]*(?:\x07|\x1b\\)?|\x1b[@-_]?/g
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g
// Bidi overrides and isolates, zero-width characters, line separators.
const INVISIBLE_RANGES: [number, number][] = [
  [0x061c, 0x061c],
  [0x200b, 0x200f],
  [0x2028, 0x2029],
  [0x202a, 0x202e],
  [0x2060, 0x2060],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
]
// Built from code points so the source itself holds no invisible characters.
const point = (code: number) => `\\u{${code.toString(16)}}`
const INVISIBLE = new RegExp(`[${INVISIBLE_RANGES.map(([from, to]) => `${point(from)}-${point(to)}`).join('')}]`, 'gu')

const hex = (char: string, width: number) => char.codePointAt(0)!.toString(16).padStart(width, '0')

export type Escaped = { text: string; isTruncated: boolean }

/** Escapes `value` and caps it at `max` characters (10,000 is a `Text` child's limit). */
export function escapeText(value: string, max = 9_000): Escaped {
  const text = value
    .replace(SEQUENCE, match => `\\x1b${JSON.stringify(match.slice(1)).slice(1, -1)}`)
    .replace(CONTROL, char => `\\x${hex(char, 2)}`)
    .replace(INVISIBLE, char => `\\u{${hex(char, 4)}}`)
    .replace(/\t/g, '  ')
  if (text.length <= max) return { text, isTruncated: false }
  // Never cut a surrogate pair in half.
  const isHighSurrogate = /[\ud800-\udbff]/.test(text.charAt(max - 1))
  return { text: `${text.slice(0, isHighSurrogate ? max - 1 : max)}…`, isTruncated: true }
}
