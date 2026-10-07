// The context receipt: how much of Claude's context a settled call's response
// used, and which fields used it, said for the pane (RESULT's last line and its
// card), the flags line and the transcript. Pure: no $, no JSX. The numbers
// are src/weight.ts's, computed from the response; the words here are ours.
// Every name in it came from the response or the schema: escaped.

import type { CallIR, CallOutcome, FieldIR, WeightField } from '../ir.ts'
import { bytesWithout, percentText, sizeText, tokensText } from '../weight.ts'
import { esc, walk } from './kit.ts'

/** A result of at least this many bytes (16 KB) is heavy enough to flag; it is flagged when one field is over half of it. */
export const FLAG_BYTES = 16 * 1024
export const FLAG_SHARE = 0.5
/** RESULT's line names the heaviest field when it holds this much of a response this big: a small one has nothing worth a name. */
const LEAD_SHARE = 0.3
const LEAD_BYTES = 1024
const NBSP = '\u00a0'

/** A phrase whose words stay together where a line breaks. */
export const held = (text: string) => text.replace(/ /g, NBSP)

/** One field the receipt names, said. */
export type ReceiptField = {
  entry: WeightField
  /** The field by real names as the pane writes them, escaped: `issues.fields.description`; with several roots the root's alias (else its name) leads. */
  label: string
  /** What RESULT's line calls it: its last real name (`description`, `denial_context`). */
  short: string
  /** For a member of the response beside the data, what it is in plain words (`denial tokens`), for cards beside the real name. */
  gloss?: string
  size: string
  /** `71%`. */
  share: string
  /** What a row of its list costs on average, `about 840 B`; absent where no list is on its path. */
  each?: string
  /** The response without the field: what it would weigh. */
  without: { bytes: number; size: string; tokens: string }
  /** What the card says of the field: the schema's, or why there is none. */
  home: { kind: 'selected'; field: FieldIR } | { kind: 'json' } | { kind: 'response' }
}

export type Receipt = {
  /** RESULT's dim line: `8 KB · about 2k tokens · description 41%`; without the field when the flags line names it (`dominant`). */
  line: string
  /** The size alone, as the transcript carries it: `58 KB` (`58 KB saved to a file` for a result kept out of the context). */
  size: string
  /** Claude saw only a short preview and a file path: Claude Code saved the response to a file. */
  isKeptOut: boolean
  /** The size is Claude Code's own figure for the stand-in, not the mod's reading of the response. */
  isApproximate: boolean
  /** Bytes of the response, when known. */
  bytes: number | undefined
  /** The fields that explain most of it, heaviest first. Empty when the response was not read. */
  fields: ReceiptField[]
  isCapped: boolean
  /** The field RESULT's line names, when one stands out. */
  lead?: ReceiptField
  /** The field the flags line calls out: over half of a response over 16 KB. */
  dominant?: ReceiptField
}

/** A field that is the whole of a call's one root says nothing: every response is its root. */
const isWhole = (entry: WeightField, ir: CallIR | undefined) => entry.name === '' && entry.isMeta !== true && (ir?.roots.length ?? 1) <= 1

function labelOf(entry: WeightField, ir: CallIR | undefined): string {
  if (entry.isMeta === true) return esc(entry.name, 600)
  const rootKey = entry.path.split('.')[0] ?? ''
  const root = ir?.roots.find(one => one.path === rootKey)
  const head = root?.alias ?? root?.name ?? rootKey
  if (entry.name === '') return esc(head, 600)
  return esc(ir !== undefined && ir.roots.length === 1 ? entry.name : `${head}.${entry.name}`, 600)
}

/**
 * A member of the response beside the data, in plain words for RESULT's line
 * (`errors.extensions.denial_context` → `denial tokens`); the card keeps the
 * path. One the table does not know reads by its part of the response.
 */
export function metaWords(path: string): string {
  const at = path.toLowerCase().split('.')
  const [head, second, third] = at
  if (head === 'errors') {
    if (second === undefined) return 'errors'
    if (second === 'message') return 'error messages'
    if (second === 'path') return 'error paths'
    if (second === 'locations') return 'error locations'
    if (second === 'extensions') {
      if (third === 'denial_context') return 'denial tokens'
      if (third === 'code') return 'error codes'
      if (third === 'visibility' || third === 'reason') return 'denial details'
      return 'error details'
    }
    return 'errors'
  }
  return 'response extensions'
}

function fieldOf(entry: WeightField, total: number, ir: CallIR | undefined): ReceiptField {
  const label = labelOf(entry, ir)
  const without = bytesWithout({ bytes: total, fields: [] }, entry)
  const selected = entry.isMeta === true || ir === undefined ? undefined : walk(ir.roots).find(one => one.path === entry.path)
  return {
    entry,
    label,
    // The real name on the line; a member beside the data gets its plain words as a gloss for the cards.
    short: label.split('.').pop() ?? label,
    ...(entry.isMeta === true && { gloss: metaWords(entry.name) }),
    size: sizeText(entry.bytes),
    share: percentText(entry.share),
    ...(entry.rows !== undefined && entry.rows > 0 && { each: `about ${sizeText(entry.bytes / entry.rows)}` }),
    without: { bytes: without, size: sizeText(without), tokens: tokensText(without) },
    home: entry.isMeta === true ? { kind: 'response' } : selected === undefined ? { kind: 'json' } : { kind: 'selected', field: selected },
  }
}

/**
 * The receipt for a call that ran, or undefined when its response was not
 * read (nothing to size) and Claude Code did not keep it out of the context.
 * A result Claude Code saved to a file is said as that: sized from the file
 * when the mod read it back (the outcome's weight is `isPersisted`), else by
 * the figure Claude Code gave.
 */
export function receiptOf(outcome: CallOutcome | undefined, ir?: CallIR): Receipt | undefined {
  const weight = outcome?.weight
  const isKeptOut = weight?.isPersisted === true || outcome?.isTooLarge === true
  if (outcome === undefined || (weight === undefined && !isKeptOut)) return undefined
  const bytes = weight?.bytes ?? outcome.size
  const isApproximate = weight === undefined
  const fields = weight === undefined ? [] : weight.fields.map(entry => fieldOf(entry, weight.bytes, ir))
  const top = fields[0]
  const big = (weight?.bytes ?? 0) >= LEAD_BYTES
  const lead = top !== undefined && big && top.entry.share >= LEAD_SHARE && !isWhole(top.entry, ir) ? top : undefined
  const dominant = top !== undefined && (weight?.bytes ?? 0) >= FLAG_BYTES && top.entry.share > FLAG_SHARE && !isWhole(top.entry, ir) ? top : undefined
  const sized = bytes === undefined ? undefined : held(`${isApproximate ? 'about ' : ''}${sizeText(bytes)}`)
  const size = isKeptOut ? [sized, 'saved to a file'].filter(Boolean).join(' ') : (sized ?? '')
  const parts = isKeptOut
    ? [size, 'Claude saw only a short preview and its path']
    : [size, held(tokensText(bytes ?? 0))]
  // The heaviest field and its share, unless the flags line already says them (the dominant field is the lead).
  if (lead !== undefined && dominant === undefined) parts.push(`${lead.short}${NBSP}${lead.share}`)
  return {
    line: parts.join(' · '),
    size,
    isKeptOut,
    isApproximate,
    bytes,
    fields,
    isCapped: weight?.isCapped === true,
    ...(lead !== undefined && { lead }),
    ...(dominant !== undefined && { dominant }),
  }
}

/** What the receipt's hover card says, as plain strings: its title, paragraphs (the first leads, the rest are dim), and each named field's facts. */
export type ReceiptCard = {
  title: string
  paragraphs: string[]
  fields: { label: string; takes: string; without: string; home: ReceiptField['home'] }[]
}

const rowsWords = (rows: number) => `${rows.toLocaleString('en-US')} row${rows === 1 ? '' : 's'}`

export function cardOf(receipt: Receipt): ReceiptCard {
  const bytes = receipt.bytes ?? 0
  // A size and its unit, and a token estimate, stay together where a line breaks.
  const read = held(`${receipt.isApproximate ? 'about ' : ''}${sizeText(bytes)}`)
  const tokens = held(tokensText(bytes))
  const lead = receipt.isKeptOut
    ? `Claude Code kept this response out of Claude's context: it saved the whole response${receipt.bytes === undefined ? '' : ` (${read})`} to a file, and Claude saw only a short preview and the file's path.${
        receipt.isApproximate ? ' The pane did not read the file, so it cannot say which fields took the room.' : ` Read in full, it would take ${tokens}.`
      }`
    : `Claude read this whole response: ${read}, or ${tokens}.${receipt.fields.length > 0 ? ' The fields below took most of it.' : ''}`
  const how = `Sizes are the response's JSON written compactly, in UTF-8 bytes (1 KB is 1,024 bytes). Tokens are an estimate at about 4 characters each, not a count.${
    receipt.isCapped ? ' The response had more fields than the pane tracks, so some detail is counted in the field above it.' : ''
  }`
  return {
    title: `context · ${receipt.isKeptOut ? receipt.size : `${receipt.size} · ${tokens}`}`,
    paragraphs: [lead, how],
    fields: receipt.fields.map(one => ({
      label: one.label,
      takes: [held(one.size), `${one.share} of the response`, one.entry.rows === undefined ? '' : `${rowsWords(one.entry.rows)}${one.each === undefined ? '' : `, ${held(one.each)} each`}`].filter(Boolean).join(' · '),
      without: `Without ${one.label} ${receipt.isKeptOut ? 'the saved file' : 'this result'} would be about ${held(one.without.size)} (${held(one.without.tokens)}).`,
      home: one.home,
    })),
  }
}
