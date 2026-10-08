// Field annotations indexed by schema coordinate. Pure: no $.
// src/attention.ts computes the marker and reason. The view draws annotations
// beside visible fields and omits annotations for hidden fields.

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
