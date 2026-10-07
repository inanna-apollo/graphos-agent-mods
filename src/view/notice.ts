// The one line the inspector adds under an Agent Services call's own row in the
// transcript, right above the approval dialog while it is open: the pane's
// verdict where the person decides, and the whole of it where the pane is not
// placed (a narrow terminal). It stays as the record of what was approved.
// Computed only (the change a write makes, the flags, the policy counts, the
// products the call reads), never Haiku's words: next to the dialog a guess
// would cost most. Pure: no $.

import { leafPolicyCounts } from '../annotate.ts'
import type { CallIR, CallOutcome } from '../ir.ts'
import { isDestructiveName, isWriteName } from '../risk.ts'
import { changePhrase } from '../preview/changes.ts'
import { WRITES_DATA, flagsOf, flagsText, productOf, servicesOf } from './flags.ts'
import { isAllAllowed } from './outcome.ts'

const VERB = { query: 'reads', mutation: 'writes', subscription: 'watches' } as const

/** The mark before a write's change in a few words. */
export const CHANGE_MARK = '✎'

/** What the line's pieces are split at, as the transcript splits them (hooks/register.tsx verdictLines). */
const SEP = ' · '

/**
 * The transcript colors a piece of the line that opens with ✓ or ⚑. Only the
 * verdict's own glyph is ours: any other piece that opens with one (a value
 * the call wrote, a key a response wrote) is quoted, so it draws as text.
 */
export function quotedGlyphs(text: string): string {
  return text
    .split(SEP)
    .map(piece => (/^[✓⚑]/.test(piece) ? `\u201c${piece}\u201d` : piece))
    .join(SEP)
}

/**
 * `⚑ members.email denied · access request can be filed · reads Jira, customer data`,
 * or `✓ all 7 fields allowed · reads Jira`; undefined until the policy is known.
 * A write leads with its change in a few words, from the call alone and so
 * from the first moment: `✎ DEV-634 → transition 31 · writes Jira` (no
 * `writes data`, no root name, and no `✓ … allowed`: the change leads, the
 * line ends in what it writes, and only a flag comes between).
 * Policy is said for a write only as a flag: a field it returns masked or
 * denied.
 * Given the outcome of a call that ran, the flags are the settled ones (`email
 * denied for 4 members`, `Jira returned 50 (asked 3)`). All allowed is said
 * only when nothing is denied or masked, in the policy check or the response,
 * the call will not fail validation and the operation is not refused. The
 * line is drawn wrapped: nothing in it is cut.
 */
export function noticeOf(ir: CallIR, outcome?: CallOutcome): string | undefined {
  if (ir.state === 'unparseable' || ir.opType === undefined) return undefined
  const phrase = changePhrase(ir)
  const lead = phrase === undefined ? undefined : `${CHANGE_MARK} ${quotedGlyphs(phrase)}`
  // A read says nothing until its policy is known; a write says its change at once.
  if (ir.state === 'analyzing' && lead === undefined) return undefined
  // Every service the call touches, by the names the header uses: one root's service is not the others'.
  const products = [...new Set(servicesOf(ir).flatMap(service => productOf(service) ?? []))]
  // A query whose root is named for a change is not said to read.
  const verb = ir.opType === 'query' && ir.roots.some(root => isWriteName(root.name) || isDestructiveName(root.name)) ? 'calls' : VERB[ir.opType]
  const where = products.length === 0 ? undefined : quotedGlyphs(`${verb} ${products.join(', ')}`)
  if (ir.state === 'analyzing') return [lead, where].filter(part => part !== undefined).join(' · ')
  // With the change leading and `writes …` ending the line, the generic flag would say it a third time.
  const flags = flagsOf(ir, outcome, outcome !== undefined).filter(flag => lead === undefined || flag.text !== WRITES_DATA)
  const { allow } = leafPolicyCounts(ir.roots)
  // A write's line says nothing of its policy when nothing it returns is masked or denied: the change leads, what it writes ends it.
  const verdict = flags.length > 0 ? `⚑ ${quotedGlyphs(flagsText(flags))}` : ir.opType !== 'mutation' && isAllAllowed(ir, outcome) ? (allow === 1 ? `✓ 1 field allowed` : `✓ all ${allow} fields allowed`) : undefined
  const parts = [lead, verdict, where].filter(part => part !== undefined)
  return parts.length === 0 ? undefined : parts.join(' · ')
}
