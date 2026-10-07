// The policy meter: one cell per tenth of the fields, allowed first. Pure.

import { CHIP_WORD, GLYPH, METER_CELLS } from './ui/theme.ts'

export type MeterCells = { allow: number; mask: number; deny: number; unknown: number }

/** The meter is for a policy that restricts something: shown only when a field is masked or denied. */
export const isMeterShown = (counts: { mask: number; deny: number }) => counts.mask + counts.deny > 0

/**
 * Without the meter: `all 9 allowed` only when `isAll` (src/view/outcome.ts
 * isAllAllowed: nothing denied or masked in the policy check or the response,
 * the call valid, the operation not refused) and every field was checked; else
 * the count alone, `3 allowed`.
 */
export function allowedText(counts: { allow: number; unknown?: number }, isAll = true): string {
  return isAll && (counts.unknown ?? 0) === 0 && counts.allow > 1 ? `all ${counts.allow} allowed` : `${counts.allow} allowed`
}

/** The policy row's words in the meter's place as drawn (ui/index.tsx AllAllowed): `✓ all 9 allowed`, `✓ 9` where the row is short of room, or `3 allowed`. */
export function allowedShown(counts: { allow: number; unknown?: number }, isAll = true, isLong = true): string {
  const isChecked = isAll && (counts.unknown ?? 0) === 0
  return isChecked ? `${GLYPH.allow} ${isLong ? allowedText(counts, isAll) : counts.allow}` : allowedText(counts, isAll)
}

/** A write Agent Services allows, in the meter's place (src/view/outcome.ts isWriteAllowed): `✓ write allowed`, `✓ allowed` where the row is short of room. */
export const writeAllowedShown = (isLong = true): string => `${GLYPH.allow} ${isLong ? 'write allowed' : 'allowed'}`

/** Cells the terse counts beside the meter take (ui/index.tsx Counts), for the header's second row. */
export function countsCells(counts: { allow: number; mask: number; deny: number; unknown?: number }): number {
  const parts = [counts.allow > 0 ? 2 + String(counts.allow).length : 0, counts.mask > 0 ? 2 + String(counts.mask).length : 0, counts.deny > 0 ? CHIP_WORD.deny.length + 3 + String(counts.deny).length : 0].filter(n => n > 0)
  return parts.reduce((sum, n) => sum + n, 0) + Math.max(0, parts.length - 1)
}

/**
 * `counts` scaled to `cells` cells by largest remainder; every state that
 * occurs keeps at least one cell, so a lone masked field among nine is seen.
 * Empty when nothing is known (all unknown or no fields): the meter is then
 * left out.
 */
export function meterOf(counts: { allow: number; mask: number; deny: number; unknown: number }, cells = METER_CELLS): MeterCells | undefined {
  const known = counts.allow + counts.mask + counts.deny
  const total = known + counts.unknown
  if (known === 0 || total === 0) return undefined
  const keys = ['allow', 'mask', 'deny', 'unknown'] as const
  const out: MeterCells = { allow: 0, mask: 0, deny: 0, unknown: 0 }
  const rest: [(typeof keys)[number], number][] = []
  let used = 0
  for (const key of keys) {
    const exact = (counts[key] / total) * cells
    out[key] = counts[key] > 0 ? Math.max(1, Math.floor(exact)) : 0
    used += out[key]
    rest.push([key, exact - Math.floor(exact)])
  }
  rest.sort((a, b) => b[1] - a[1])
  for (let i = 0; used < cells; i = (i + 1) % rest.length) {
    const [key] = rest[i] as [(typeof keys)[number], number]
    if (counts[key] === 0) continue
    out[key] += 1
    used += 1
  }
  // Minimums can overshoot: take back from the largest.
  while (used > cells) {
    const largest = keys.reduce((a, b) => (out[b] > out[a] ? b : a))
    out[largest] -= 1
    used -= 1
  }
  return out
}
