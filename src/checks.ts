// Check evidence is session data. Unknown legacy shapes never establish a cause.
import { isRecord } from './guards.ts'
import type { CheckContext, Checks, CheckTarget, LookupTool } from './ir.ts'

export const CHECK_CONTEXT_MAX = 128
const TOOLS = ['search', 'introspect', 'validate', 'dry_run'] as const
const CHECKS = ['policy', 'validation', 'schema'] as const
const DECISIONS = ['allow', 'ask', 'deny'] as const
const OPS = ['query', 'mutation', 'subscription'] as const
const identity = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max
const includes = (values: readonly string[], value: unknown): value is string => typeof value === 'string' && values.includes(value)

function targetOf(raw: unknown): CheckTarget | undefined {
  if (!isRecord(raw)) return undefined
  if (raw.kind === 'call') return { kind: 'call' }
  if (raw.kind === 'root' && identity(raw.path, 256)) return { kind: 'root', path: raw.path }
  if (!identity(raw.scope, 128)) return undefined
  if (raw.kind === 'request' && typeof raw.index === 'number' && Number.isSafeInteger(raw.index) && raw.index >= 0) return { kind: 'request', scope: raw.scope, index: raw.index }
  if (raw.kind === 'scope' && (raw.opType === undefined || includes(OPS, raw.opType))) return { kind: 'scope', scope: raw.scope, ...(raw.opType !== undefined && { opType: raw.opType as 'query' | 'mutation' | 'subscription' }) }
  return undefined
}

function contextOf(raw: unknown): CheckContext | undefined {
  if (!isRecord(raw) || !includes(CHECKS, raw.check) || !includes(['enrichment', 'tool-response'], raw.source)) return undefined
  if (raw.tool !== undefined && !includes(TOOLS, raw.tool)) return undefined
  const target = targetOf(raw.target)
  if (target === undefined) return undefined
  const base = { check: raw.check as CheckContext['check'], target, source: raw.source as CheckContext['source'], ...(raw.tool !== undefined && { tool: raw.tool as LookupTool }) }
  if (raw.outcome === 'ok' && (raw.operationDenied === undefined || typeof raw.operationDenied === 'boolean')) return { ...base, outcome: 'ok', ...(raw.operationDenied !== undefined && { operationDenied: raw.operationDenied }) }
  if (raw.outcome === 'not-allowed' && includes(DECISIONS, raw.decision) && (raw.ceiling === undefined || includes(DECISIONS, raw.ceiling))) return { ...base, outcome: 'not-allowed', decision: raw.decision as 'allow' | 'ask' | 'deny', ...(raw.ceiling !== undefined && { ceiling: raw.ceiling as 'allow' | 'ask' | 'deny' }) }
  if (raw.outcome === 'skipped' && includes(['unclaimed-service', 'operation-unavailable', 'not-applicable'], raw.reason)) return { ...base, outcome: 'skipped', reason: raw.reason as 'unclaimed-service' | 'operation-unavailable' | 'not-applicable' }
  if (raw.outcome === 'failed' && includes(['request-failed', 'missing-data', 'analysis-timeout', 'bundle-changed'], raw.reason) && (raw.message === undefined || typeof raw.message === 'string')) return { ...base, outcome: 'failed', reason: raw.reason as 'request-failed' | 'missing-data' | 'analysis-timeout' | 'bundle-changed', ...(typeof raw.message === 'string' && { message: raw.message.slice(0, 300) }) }
  return undefined
}

/** Accepts a Checks object, not its array. Exact oversized identities are omitted, never shortened into matches. */
export function normalizeCheckContext(raw: unknown): { context: CheckContext[]; contextOmitted: number } {
  if (!isRecord(raw)) return { context: [], contextOmitted: 0 }
  const entries = Array.isArray(raw.context) ? raw.context : []
  let contextOmitted = typeof raw.contextOmitted === 'number' && Number.isSafeInteger(raw.contextOmitted) && raw.contextOmitted >= 0 ? raw.contextOmitted : 0
  const context: CheckContext[] = []
  for (const entry of entries) {
    if (context.length >= CHECK_CONTEXT_MAX) { contextOmitted += 1; continue }
    const kept = contextOf(entry)
    if (kept === undefined) contextOmitted += 1
    else context.push(kept)
  }
  return { context, contextOmitted: Math.min(Number.MAX_SAFE_INTEGER, contextOmitted) }
}

export function appendCheckContext(checks: Checks, entries: readonly CheckContext[]): Checks {
  const previous = normalizeCheckContext(checks)
  const bounded = normalizeCheckContext({ context: [...previous.context, ...entries], contextOmitted: previous.contextOmitted })
  return { ...checks, context: bounded.context, ...(bounded.contextOmitted > 0 ? { contextOmitted: bounded.contextOmitted } : {}) }
}

/** Structured causes from our boundaries, never permission guesses from diagnostic prose. */
export function checkFailureContext(check: CheckContext['check'], target: CheckTarget, error: unknown, source: CheckContext['source'] = 'enrichment', tool?: LookupTool): CheckContext {
  const reported = isRecord(error) ? error : undefined
  const actualTool = includes(TOOLS, reported?.tool) ? reported!.tool as LookupTool : tool
  const base = { check, target, source, ...(actualTool !== undefined && { tool: actualTool }) }
  if (reported?.checkCause === 'not-allowed' && includes(DECISIONS, reported.decision) && (reported.ceiling === undefined || includes(DECISIONS, reported.ceiling))) return { ...base, outcome: 'not-allowed', decision: reported.decision as 'allow' | 'ask' | 'deny', ...(reported.ceiling !== undefined && { ceiling: reported.ceiling as 'allow' | 'ask' | 'deny' }) }
  const reason = includes(['missing-data', 'analysis-timeout', 'bundle-changed'], reported?.checkCause) ? reported!.checkCause as 'missing-data' | 'analysis-timeout' | 'bundle-changed' : 'request-failed'
  return { ...base, outcome: 'failed', reason, message: String(error instanceof Error ? error.message : error).slice(0, 300) }
}
