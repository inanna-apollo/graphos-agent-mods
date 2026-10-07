// What the pane and the transcript say about a call and the person's trust
// rules (src/trust.ts): that it ran without a permission dialog and under
// which rules, or, when rules exist and none fit, the first reason it was
// asked. Computed by the matcher, never by Haiku. Pure: no $.

import type { TrustFit } from '../ir.ts'
import { esc } from './kit.ts'

/** Where the rules live, as the card names it. */
export const TRUST_FILE = '~/.claude/graphos-agent-mods/trust.graphql'

export type TrustLine = {
  /** `allow`: ran without a dialog; `asked`: rules exist and none fit. */
  tone: 'allow' | 'asked'
  /** Escaped: the line under the flags. */
  text: string
  fit: TrustFit
}

/** The rules a call ran under, each once, in the order its roots fit them. */
export function rulesOf(fit: TrustFit): string[] {
  return fit.isAllowed ? [...new Set(fit.fits.map(one => one.rule))] : []
}

const ruleWords = (rules: readonly string[]) => `trust rule${rules.length === 1 ? '' : 's'} ${rules.join(', ')}`

/**
 * `ran without asking · trust rule JiraTriage`, or, when none fit, the short
 * `asked · no trust rule fits`: the pane's room is for the call, so why it
 * asked is its card's to say in full (TrustCard).
 */
export function trustLineOf(fit: TrustFit | undefined): TrustLine | undefined {
  if (fit === undefined) return undefined
  if (fit.isAllowed) return { tone: 'allow', text: esc(`ran without asking · ${ruleWords(rulesOf(fit))}`, 2_000), fit }
  return { tone: 'asked', text: 'asked · no trust rule fits', fit }
}

/** The transcript's word for a call that ran under trust rules; nothing for one that was asked (the dialog said so). */
export function trustVerdictOf(fit: TrustFit | undefined): string | undefined {
  return fit?.isAllowed === true ? esc(`✓ ran without asking · ${ruleWords(rulesOf(fit))}`, 2_000) : undefined
}
