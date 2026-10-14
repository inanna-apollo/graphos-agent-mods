// Inspector permission evidence, distinct from a call's execution outcome.
// Computed by the matcher, never by Haiku. Pure: no $.

import type { CallStatus, TrustFit } from '../../types/index.d.ts'
import { esc } from './kit.ts'

/** Where the rules live, as the card names it. */
export const TRUST_FILE = '~/.claude/graphos-agent-mods/trust.graphql'

export type TrustLine = {
  /** The Inspector's permission decision, independent of execution. */
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
 * Only a completed call can say it ran. A match on a pending, stopped or
 * failed call records the permission decision without inventing execution.
 */
export function trustLineOf(fit: TrustFit | undefined, status: CallStatus = 'pending'): TrustLine | undefined {
  if (fit === undefined) return undefined
  if (fit.isAllowed) return { tone: 'allow', text: esc(`${status === 'ran' ? 'ran without asking' : 'permitted'} · ${ruleWords(rulesOf(fit))}`, 2_000), fit }
  return { tone: 'asked', text: 'no Inspector trust rule fits', fit }
}

/** The transcript's word for a call that ran under trust rules; nothing for one that was asked (the dialog said so). */
export function trustVerdictOf(fit: TrustFit | undefined, status: CallStatus = 'pending'): string | undefined {
  const line = trustLineOf(fit, status)
  return fit?.isAllowed === true && line !== undefined ? `${status === 'ran' ? '✓ ' : ''}${line.text}` : undefined
}

/** Permission evidence and matching reasons, without claiming the tool completed. */
export function trustFacts(fit: TrustFit | undefined, status: CallStatus = 'pending'): string[] {
  if (fit === undefined) return []
  return [
    ...(fit.isAllowed ? [
      status === 'ran' ? 'The call ran under an Inspector trust rule without an additional permission prompt.' : 'Inspector trust rules permitted this call without an additional permission prompt. This is a permission decision, not an execution result.',
      ...fit.fits.flatMap(one => [`${esc(one.root, Infinity)}: ${esc(one.rule, Infinity)}`, ...one.reasons.map(reason => esc(reason, Infinity))]),
    ] : ['No Inspector trust rule matched this call.', esc(fit.reason, Infinity)]),
    'Inspector rules can allow a call that would otherwise ask. They cannot override a denial or an organization restriction; Claude Code’s own permission settings still apply.',
    ...(status === 'interrupted' ? ['The Inspector stopped waiting; whether execution completed is unknown.'] : []),
    `Rules: ${TRUST_FILE}; /gas trust reloads them.`,
  ]
}
