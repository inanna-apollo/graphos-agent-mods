// What the spinner says while an Agent Services call runs: its headline, or with none yet,
// `Agent Services · <operation name>`. One line of plain words, escaped and bounded: the
// headline is Haiku's, the operation name is a model's, and both are untrusted.
// Pure: no $.

import type { CallIR } from '../ir.ts'
import { esc, refParts } from './kit.ts'

/** Safety bounds well past a real value: a headline is kept near 90 characters, an operation name is a word or three. */
const HEADLINE_MAX = 400
const NAME_MAX = 200

/**
 * The spinner's text for a call: Haiku's headline as one line (its field refs
 * as bare names, the closing full stop dropped since the spinner ends in an
 * ellipsis), else `Agent Services · SearchPages`, the operation's name (or its root
 * fields' when it has none).
 */
export function spinnerTextOf(ir: CallIR): string {
  const headline = ir.summary === undefined ? '' : refParts(ir.summary.headline).map(part => part.text).join('').replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim()
  if (headline !== '') return esc(headline, HEADLINE_MAX)
  const name = (ir.opName ?? ir.roots.map(root => root.name).join(', ')).replace(/\s+/g, ' ').trim()
  return name === '' ? 'Agent Services' : `Agent Services · ${esc(name, NAME_MAX)}`
}
