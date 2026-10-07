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
export function validationOf(value: Record<string, unknown>): Validation {
  const errors = Array.isArray(value.errors) ? value.errors.filter((one): one is string => typeof one === 'string') : []
  const diagnostics = errors.flatMap(text => text.split(/^(?=Error: )/m).map(one => one.trimEnd())).filter(one => one !== '')
  return { valid: value.valid === true, diagnostics }
}

export type Decision = 'allow' | 'mask' | 'deny'
export type FieldDecision = { decision: Decision; denialContext?: string }
export type Access = { denyOperation: boolean; fields: Map<string, FieldDecision> }

const DECISIONS = new Set<string>(['allow', 'mask', 'deny'])

/** One `dry_run` result: per response path (`confluence_search.results.title`). */
export function accessOf(result: unknown): Access | undefined {
  if (!isRecord(result) || !Array.isArray(result.fields)) return undefined
  const fields = new Map<string, FieldDecision>()
  for (const field of result.fields) {
    if (!isRecord(field) || typeof field.path !== 'string' || typeof field.decision !== 'string') continue
    if (!DECISIONS.has(field.decision)) continue
    const denialContext = typeof field.denialContext === 'string' ? field.denialContext : undefined
    fields.set(field.path, { decision: field.decision as Decision, ...(denialContext !== undefined && { denialContext }) })
  }
  return { denyOperation: result.denyOperation === true, fields }
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
