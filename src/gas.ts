// Agent Services tool results → plain records. Pure: no $.
//
// Every Agent Services tool answers one text block of JSON carrying `bundleDigest`.
// Shapes seen live (README "Shapes the code relies on"); anything else is
// reported as unreadable rather than guessed at. All strings in here are
// untrusted (they quote the model's operation and the schema), so they are
// escaped where drawn, never here.

import type { McpToolResult } from 'claude-code'
import { isRecord } from './guards.ts'

export type Payload = { ok: true; value: Record<string, unknown>; bundleDigest?: string } | { ok: false; error: string }


export function payloadOf(result: McpToolResult): Payload {
  const text = result.content.find(block => block.type === 'text')
  if (text === undefined || !('text' in text) || typeof text.text !== 'string') {
    return { ok: false, error: 'no text content' }
  }
  let value: unknown
  try {
    value = JSON.parse(text.text)
  } catch {
    return { ok: false, error: result.isError ? text.text.slice(0, 500) : 'content is not JSON' }
  }
  if (!isRecord(value)) return { ok: false, error: 'content is not a JSON object' }
  const digest = typeof value.bundleDigest === 'string' ? value.bundleDigest : undefined
  return { ok: true, value, bundleDigest: digest }
}

export type Validation = { valid: boolean; diagnostics: string[] }

/** `{ valid, errors?: string[] }`; one string may hold several `Error:` blocks. */
export function validationOf(value: Record<string, unknown>): Validation | undefined {
  if (typeof value.valid !== 'boolean') return undefined
  if (value.errors !== undefined && (!Array.isArray(value.errors) || value.errors.some(one => typeof one !== 'string'))) return undefined
  const errors = Array.isArray(value.errors) ? value.errors.filter((one): one is string => typeof one === 'string') : []
  const diagnostics = errors.flatMap(text => text.split(/^(?=Error: )/m).map(one => one.trimEnd())).filter(one => one !== '')
  return { valid: value.valid === true, diagnostics }
}

export type Decision = 'allow' | 'mask' | 'deny'
export type FieldDecision = { decision: Decision; denialContext?: string }
export type Access = { denyOperation: boolean; fields: Map<string, FieldDecision> }

const DECISIONS = new Set<string>(['allow', 'mask', 'deny'])

function readAccess(result: unknown): { access?: Access; hasConflicts: boolean } {
  if (!isRecord(result) || !Array.isArray(result.fields)) return { hasConflicts: false }
  const fields = new Map<string, FieldDecision>()
  const conflicts = new Set<string>()
  for (const field of result.fields) {
    if (!isRecord(field) || typeof field.path !== 'string' || typeof field.decision !== 'string') continue
    if (!DECISIONS.has(field.decision)) continue
    if (conflicts.has(field.path)) continue
    const previous = fields.get(field.path)
    if (previous !== undefined) {
      if (previous.decision !== field.decision) {
        // Neither order nor a repeated later claim establishes authority.
        fields.delete(field.path)
        conflicts.add(field.path)
      }
      continue
    }
    const denialContext = typeof field.denialContext === 'string' ? field.denialContext : undefined
    fields.set(field.path, { decision: field.decision as Decision, ...(denialContext !== undefined && { denialContext }) })
  }
  return { access: { denyOperation: result.denyOperation === true, fields }, hasConflicts: conflicts.size > 0 }
}

/** One `dry_run` result: conflicting decisions at a path leave its policy unknown. */
export function accessOf(result: unknown): Access | undefined {
  return readAccess(result).access
}

/** Lookup errors are evidence of a request gap; validation diagnostics are parsed separately. */
export function requestErrorOf(value: Record<string, unknown>): { reason: 'missing-data' | 'request-failed'; issue: string } | undefined {
  if (value.errors === undefined || (Array.isArray(value.errors) && value.errors.length === 0)) return undefined
  if (!Array.isArray(value.errors)) return { reason: 'missing-data', issue: 'error details were not reported as a list' }
  const first: unknown = value.errors[0]
  if (typeof first === 'string') return { reason: 'request-failed', issue: first }
  if (isRecord(first) && typeof first.message === 'string') return { reason: 'request-failed', issue: first.message }
  return { reason: 'missing-data', issue: 'an unreadable error was reported' }
}

/** A readable access excerpt and any gap, shared by explicit checks and Inspector enrichment. */
export function accessEvidenceOf(result: unknown): { access?: Access; reason?: 'missing-data' | 'request-failed'; issue?: string } {
  const { access, hasConflicts } = readAccess(result)
  if (!isRecord(result)) return { reason: 'missing-data', issue: 'no readable answer for this request' }
  const error = requestErrorOf(result)
  if (error !== undefined) return { ...(access !== undefined && { access }), ...error }
  if (access === undefined) return { reason: 'missing-data', issue: 'field decisions were not reported' }
  if (typeof result.denyOperation !== 'boolean') return { access, reason: 'missing-data', issue: 'whole-operation decision was not reported' }
  if (hasConflicts) return { access, reason: 'missing-data', issue: 'conflicting field decisions were reported for the same response path' }
  if (result.denyOperation === false && access.fields.size === 0) return { access, reason: 'missing-data', issue: 'no readable field decisions were reported' }
  if ((result.fields as unknown[]).some(field => !isRecord(field) || typeof field.path !== 'string' || !DECISIONS.has(String(field.decision)))) return { access, reason: 'missing-data', issue: 'some field decisions could not be read' }
  return { access }
}

/** `introspect`'s SDL strings for the type asked and the ones it references. */
export function sdlOf(value: Record<string, unknown>): string[] {
  return Array.isArray(value.types) ? value.types.filter((one): one is string => typeof one === 'string') : []
}

/**
 * The service scope a root field belongs to: Agent Services prefixes root fields with
 * the scope (`confluence_search` → `confluence`), and scopes may hold `-`
 * where field names hold `_` (`acme-customer-data`). The longest match
 * wins; no match means the caller falls back to `search`.
 */
export function scopeFor(rootField: string, scopes: readonly string[]): string | undefined {
  let best: string | undefined
  for (const scope of scopes) {
    const prefix = `${scope.replace(/-/g, '_')}_`
    if (rootField.startsWith(prefix) && (best === undefined || scope.length > best.length)) best = scope
  }
  return best
}
