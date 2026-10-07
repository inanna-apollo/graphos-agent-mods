// HTML character references drawn as the characters they name. Pure: no $.
//
// Some services hand back text already escaped for a web page: Confluence
// titles (`&quot;Gotchas&quot;`, `&rsquo;`) and Slack messages (`&amp;`,
// `&lt;`). The pane is not a web page, so it shows `"Gotchas"`. Decode before
// escaping for the terminal (escape.ts): a reference to a control character
// (`&#27;`) then comes out as a visible escape, never as the control itself.

const NAMED: Readonly<Record<string, string>> = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  times: '×',
  rarr: '→',
  larr: '←',
})

/** `&quot;` `&#39;` `&#x2019;`: a name this table knows, or a number for a real code point; anything else is left as written. */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(/&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{2,8});/g, (whole, ref: string) => {
    if (ref.startsWith('#')) {
      const code = ref[1] === 'x' || ref[1] === 'X' ? Number.parseInt(ref.slice(2), 16) : Number(ref.slice(1))
      // A code point, never a lone surrogate.
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : whole
    }
    return Object.hasOwn(NAMED, ref) ? (NAMED[ref] as string) : whole
  })
}
