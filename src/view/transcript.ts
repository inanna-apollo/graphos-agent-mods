// An Agent Services call's RESULT as the transcript can hold it: under the call's own row,
// a few lines saying what came back (`5 issues · first page`) and the first
// records with their keys as links. The pane's RESULT is the whole of it; this
// is the part that helps where the pane is not (too narrow to dock, scrollback).
// Built from the same lines the pane draws (src/view/outcome.ts resultLines),
// so every string in it is already escaped response content. Pure: no $.

import type { CallIR, CallOutcome } from '../ir.ts'
import { configOf } from '../links.ts'
import type { LinkConfig } from '../links.ts'
import type { ResultLine } from './outcome.ts'
import { resultLines } from './outcome.ts'
import { confirmLineText, previewLead, rowsLineText, shownLabel } from './plan.ts'
import { receiptOf } from './receipt.ts'

/** What a settled call's block says. */
export type ResultBlock = {
  /** The rows and value lines as the pane's RESULT draws them (`open  5 issues · first page`), the first few. */
  heads: string[]
  /** The first list's first rows: the key as drawn (bracketed when it is a link), what follows it, and where a press opens it (a configured https host only). */
  items: { key: string; text: string; url?: string }[]
  /** Rows of that list not shown here. */
  more: number
  /** The response's size, which the first line carries (`58 KB`; `58 KB saved to a file` for a result Claude Code kept out of the context): src/view/receipt.ts. */
  size?: string
}

/** Few lines: the transcript is not the pane. */
export const MAX_HEADS = 3
export const MAX_ITEMS = 3

/**
 * The block for a call that ran and whose response was read: undefined when
 * there is nothing to say (no outcome yet, an unreadable or oversized response,
 * a response with no rows or values). Errors, denials and auth links are the
 * verdict line's and the pane's, not this block's.
 */
export function resultBlockOf(outcome: CallOutcome | undefined, ir: CallIR, links: LinkConfig = configOf(undefined)): ResultBlock | undefined {
  if (outcome === undefined || outcome.isUnreadable === true || outcome.isTooLarge === true) return undefined
  const lines = resultLines(outcome, ir, links)
  // A write's confirmation leads: what came back of what it set.
  const heads = lines.flatMap(line => (line.kind === 'confirm' ? [confirmLineText(line)] : line.kind === 'rows' || line.kind === 'scalar' ? [rowsLineText(line)] : [])).slice(0, MAX_HEADS)
  const list = lines.find((line): line is Extract<ResultLine, { kind: 'preview' }> => line.kind === 'preview')
  const items = (list?.items ?? []).slice(0, MAX_ITEMS).map(item => ({ key: shownLabel(item), text: previewLead(item), ...(item.url !== undefined && { url: item.url }) }))
  if (heads.length === 0 && items.length === 0) return undefined
  // The size rides on the first line only where there is a line to carry it.
  const size = receiptOf(outcome, ir)?.size
  return { heads, items, more: list === undefined ? 0 : list.more + Math.max(0, list.items.length - MAX_ITEMS), ...(size !== undefined && size !== '' && { size }) }
}
