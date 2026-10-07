// What the pane pins beside nodes, indexed by node. Pure: no $.
//
// Attention is the mod's own (src/attention.ts): a quiet marker before a field with
// its short reason, dim like a note. Pins whose node is not on screen are
// simply not drawn.

import { PERSONAL_DATA, attentionOf } from '../attention.ts'
import type { CallIR, CallOutcome } from '../ir.ts'
import { esc } from './kit.ts'

/** A note pinned to a node; `isPersonal` when it marks personal data (drawn `◆`, as the notes strip draws it). */
export type Pinned = { note: string; isAttention: boolean; isPersonal: boolean }

/** Which pins the plan keeps: the attention ones, or none. */
export type AnnotationLevel = 'attention' | 'none'

export type AnnotationIndex = {
  field: (coordinate: string) => Pinned | undefined
}

/** Attention reasons are short. */
const NOTE = 80

export function annotationIndex(ir: CallIR | undefined, level: AnnotationLevel = 'attention', outcome?: CallOutcome): AnnotationIndex {
  const fields = new Map<string, Pinned>()
  if (ir !== undefined && level !== 'none') {
    for (const { coordinate, reason } of attentionOf(ir, outcome)) fields.set(coordinate, { note: esc(reason, NOTE), isAttention: true, isPersonal: reason.split(' · ')[0] === PERSONAL_DATA })
  }
  return {
    field: coordinate => fields.get(coordinate),
  }
}

/** The note as drawn after its node, two cells after it: `denied · pii.contact`; nothing for a marker with no words (a write CHANGES says). */
export const noteText = (pinned: Pinned) => (pinned.note === '' ? '' : `  ${pinned.note}`)
