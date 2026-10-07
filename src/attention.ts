// What deserves a quiet mark, decided by the mod and never by the model. Pure: no $.
//
// Exactly three triggers: personal-data field names, policy mask or deny, and
// a root that writes (a mutation, or a destructive-sounding name). Reasons are
// short, fixed words, with the field's one classification after them. A root
// whose CHANGES block says what it writes keeps its marker and no words: the
// block says it.

import type { CallIR, CallOutcome, FieldIR } from './ir.ts'
import { classifiedOf, isPersonalField } from './view/personal.ts'
import { isDestructiveName } from './risk.ts'
import { previewOf } from './preview/changes.ts'

export type Attention = {
  /** The field's coordinate (a root's or a nested field's). */
  coordinate: string
  /** Short: a fixed word, then the field's one classification when it has one (`denied · pii.contact`). */
  reason: string
}

/**
 * The field's one classification: the schema's own (`pii.contact`), else
 * the one Agent Services gave a denial once the call has settled (`pii-high`).
 */
export function classificationOf(field: FieldIR, outcome?: CallOutcome): string | undefined {
  if (classifiedOf(field) !== undefined) return classifiedOf(field)
  if (field.policy !== 'deny') return undefined
  return (
    outcome?.errors.find(error => error.isDenied === true && error.field === field.name && error.classification !== undefined)?.classification ??
    outcome?.preview?.flatMap(list => list.items.flatMap(item => item.denied ?? [])).find(one => one.field === field.name && one.classification !== undefined)?.classification
  )
}

/** The reason a personal-data field is marked, before its classification. */
export const PERSONAL_DATA = 'personal data'

function fieldReason(field: FieldIR, outcome?: CallOutcome): string | undefined {
  const word = field.policy === 'deny' ? 'denied' : field.policy === 'mask' ? 'masked' : isPersonalField(field) ? PERSONAL_DATA : undefined
  if (word === undefined) return undefined
  const classification = classificationOf(field, outcome)
  return classification === undefined ? word : `${word} · ${classification}`
}

/** Why a root is marked; empty (the marker alone) for one whose CHANGES block says what it writes. */
function rootReason(ir: CallIR, root: FieldIR, hasChanges: boolean): string | undefined {
  if (isDestructiveName(root.name)) return hasChanges ? '' : 'destructive name'
  if (ir.opType === 'mutation') return hasChanges ? '' : 'writes data'
  return undefined
}

/** The nodes to mark, in document order, one per coordinate (the first reason wins). */
export function attentionOf(ir: CallIR, outcome?: CallOutcome): Attention[] {
  const marks = new Map<string, string>()
  const visit = (field: FieldIR, reason: string | undefined) => {
    if (reason !== undefined && !marks.has(field.coordinate)) marks.set(field.coordinate, reason)
    for (const child of field.children) visit(child, fieldReason(child, outcome))
  }
  const changed = new Set(previewOf(ir)?.all.map(block => block.path) ?? [])
  for (const root of ir.roots) visit(root, rootReason(ir, root, changed.has(root.path)) ?? fieldReason(root, outcome))
  return [...marks].map(([coordinate, reason]) => ({ coordinate, reason }))
}
