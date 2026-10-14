// Retained inspection evidence, shared by the compact Checks preview and inline details.
// These are observer checks; they do not grant permission or describe execution results.
import type { CheckContext, CheckOutcome, InspectedCall, LookupCount } from '../../types'
import { normalizeCheckContext } from '../checks.ts'
import { leafPolicyCounts } from '../annotate.ts'
import { esc } from './kit.ts'

const LABEL = { schema: 'Schema discovery', validation: 'Schema validation', policy: 'Access check' } as const
const OUTCOME: Record<CheckOutcome, string> = { ok: 'answered', 'not-allowed': 'inspection permission unavailable', failed: 'inspection failed', skipped: 'not checked' }

function targetText(target: CheckContext['target']): string {
  switch (target.kind) {
    case 'call': return ''
    case 'scope': return ` · ${esc(target.scope)}${target.opType === undefined ? '' : ` ${target.opType}`}`
    case 'request': return ` · ${esc(target.scope)} request ${target.index + 1}`
    case 'root': return ` · ${esc(target.path)}`
  }
}

function contextText(context: CheckContext): string {
  const purpose = context.tool === 'search' ? 'service discovery' : context.tool === 'introspect' ? 'type discovery' : context.tool === 'validate' ? 'schema validation' : context.tool === 'dry_run' ? 'access verification' : 'inspection'
  const prefix = `${LABEL[context.check]}${targetText(context.target)}${context.tool === undefined ? '' : ` · ${purpose} (${context.tool})`}`
  switch (context.outcome) {
    case 'ok': return `${prefix}: ${context.operationDenied ? 'this check reported a refusal' : context.check === 'schema' ? 'schema information available' : 'answered'}.`
    case 'not-allowed': {
      if (context.ceiling === 'deny') return `${prefix}: your organization’s permission rules block this read-only inspection request.`
      if (context.ceiling === 'ask') return `${prefix}: your organization requires approval for this read-only inspection request, so the Inspector did not run it.`
      if (context.decision === 'ask') return `${prefix}: this read-only inspection request needed approval, so the Inspector did not run it.`
      if (context.decision === 'deny') return `${prefix}: permission rules did not allow the Inspector to run this read-only request.`
      return `${prefix}: usable inspection permission evidence was unavailable.`
    }
    case 'failed': {
      const reasons = { 'request-failed': 'the inspection request failed', 'missing-data': 'the answer did not supply usable evidence', 'analysis-timeout': 'inspection exceeded its time limit', 'bundle-changed': 'the schema bundle changed during inspection' } as const
      return `${prefix}: ${reasons[context.reason]}.${context.message === undefined ? '' : ` ${esc(context.message)}`}`
    }
    case 'skipped': {
      const reasons = { 'unclaimed-service': 'no service claimed this operation', 'operation-unavailable': 'the operation needed for the check was unavailable', 'not-applicable': 'this check does not apply to this tool' } as const
      return `${prefix}: ${reasons[context.reason]}.`
    }
  }
}

/** Complete locally retained evidence. Legacy records never acquire a guessed failure cause. */
export function checkFacts(call: InspectedCall): string[] {
  const checks = call.ir.checks
  if (checks === undefined) return [call.status === 'pending' && call.ir.state === 'analyzing' ? 'Inspection is still gathering schema and access evidence.' : 'Original inspection evidence is unavailable for this call.', 'An unavailable check does not establish whether the operation is permitted or valid. Execution results are shown separately.']
  const { context, contextOmitted } = normalizeCheckContext(checks)
  const validation = checks.validation === 'ok' ? call.ir.validation === undefined ? 'answer unavailable' : call.ir.validation.valid ? 'valid against the schema' : 'invalid against the schema' : OUTCOME[checks.validation]
  return [
    `${LABEL.schema}: ${checks.schema === 'ok' ? 'schema information available' : OUTCOME[checks.schema]}.`,
    `${LABEL.validation}: ${validation}.`,
    `${LABEL.policy}: ${checks.policy === 'ok' && call.ir.isOperationDenied ? 'a check reported a refusal' : OUTCOME[checks.policy]}.`,
    ...(checks.policy === 'ok' && leafPolicyCounts(call.ir.roots).unknown > 0 ? ['Some selected fields have no access decision in the available evidence.'] : []),
    'Inspection evidence is separate from permission to execute and from the response of an operation that ran.',
    ...context.map(contextText),
    ...(checks.error !== undefined ? [`Inspection diagnostic: ${esc(checks.error)}`] : []),
    ...(call.ir.validation?.diagnostics ?? []).map(one => `Validation: ${esc(one, Infinity)}`),
    ...(contextOmitted > 0 ? [`${contextOmitted} additional inspection details were not retained.`] : []),
  ]
}

/** Hover is a preview; the dedicated details address always keeps the complete retained facts. */
export function checkPreview(call: InspectedCall): string[] {
  const { context } = normalizeCheckContext(call.ir.checks)
  const gap = context.find(one => one.outcome !== 'ok' && !(one.outcome === 'skipped' && one.reason === 'not-applicable'))
  if (gap !== undefined) return [contextText(gap), 'This limits the Inspector’s explanation; it does not change the original call’s permissions or prove that it failed.']
  return checkFacts(call).slice(0, 3)
}

/** The observed count remains distinct from locally retained/displayed definitions. */
export function searchCountOf(call: InspectedCall): LookupCount | undefined {
  const catalog = (call.input?.terms ?? []).length === 0
  const found = call.found
  const measured = catalog ? found?.counts?.scopes : found?.counts?.hits
  if (measured !== undefined) return measured
  const value = catalog ? found?.scopes?.length : found?.hits
  if (value === undefined) return undefined
  return { kind: found?.completeness === 'partial' ? 'at-least' : 'exact', value }
}

/** A returned request error is evidence of failure, not a successful access decision. */
export function dryRunEvidenceOf(call: InspectedCall) {
  const missing = call.ir.checks?.context?.filter(one => one.outcome === 'failed' && one.reason === 'missing-data' && one.target.kind === 'request').map(one => one.target.kind === 'request' ? one.target.index : -1) ?? []
  const requests = (call.found?.requests ?? []).filter((_, index) => !missing.includes(index))
  const failed = requests.filter(one => one.error !== undefined).length
  const refused = requests.filter(one => one.error === undefined && one.isDenied === true).length
  const incomplete = requests.length === 0 || requests.length < (call.input?.scopes?.length ?? 0) || call.found?.completeness === 'partial' || call.found?.completeness === 'unavailable'
  return { requests, failed, refused, incomplete }
}

export const countText = (count: LookupCount | undefined, noun: string): string => count === undefined || count.kind === 'unknown' ? `${noun} count unavailable` : `${count.kind === 'at-least' ? 'at least ' : ''}${count.value} ${noun}${count.value === 1 ? '' : /(?:ch|sh|s|x|z)$/.test(noun) ? 'es' : 's'}`

/** Missing facts are shared across pane and transcript, without interpreting absence as failure. */
export function lookupMissingEvidence(call: InspectedCall): string {
  if (call.tool === 'search') return (call.input?.terms ?? []).length === 0 ? 'The available service count is unknown.' : 'The search answer is incomplete; its match count is unavailable.'
  if (call.tool === 'introspect') return call.found?.typeKind === 'absent' ? `No ${esc(call.input?.type ?? 'requested')} type is visible in this complete response.` : `The ${esc(call.input?.type ?? 'requested')} declaration is unavailable; absence is not confirmed.`
  if (call.tool === 'validate') return 'The schema-validation result is unavailable.'
  return 'Request-check outcomes are unavailable.'
}
