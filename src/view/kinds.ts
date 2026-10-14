// What sets one kind of Agent Services call apart in the pane: its badge,
// what the header names it by, its status word, its headline, the notes only
// it has, and which of the pane's blocks it draws (its Profile). Everything
// else (the form, the trees, the cards, the planner) is shared. Pure: no $.
//
// execute keeps the pane as it always was. A lookup (search, introspect,
// validate, dry_run) reads the schema or checks an operation without running
// it: its badge is quiet, it has no RESULT, CHANGES, trust line or links, and
// its headline is computed from the call and its answer.

import type { InspectedCall, LookupTool } from '../../types'
import { leafPolicyCounts } from '../annotate.ts'
import { countText, dryRunEvidenceOf, lookupMissingEvidence, searchCountOf } from './checks.ts'
export { dryRunEvidenceOf, searchCountOf } from './checks.ts'
import { isExecute } from '../queue.ts'
import { sizeText, tokensText } from '../weight.ts'
import { productOf } from './flags.ts'
import { esc } from './kit.ts'
import type { Note } from './notes.ts'
import { BADGE, BADGE_HUE, COLOR, GLYPH, QUIET } from './ui/theme.ts'
import { statusOf } from './ui/index.tsx'
import { EXECUTE_PROFILE } from './profile.ts'
import type { Profile } from './profile.ts'

export { EXECUTE_PROFILE }
export type { Profile }

const PROFILES: Record<LookupTool, Profile> = {
  search: { isLookup: true, flags: false, policyNotes: false, limitNotes: false, isDeclared: true, returnsLabel: 'return type', policyFacts: false },
  introspect: { isLookup: true, flags: false, policyNotes: false, limitNotes: false, isDeclared: true, returnsLabel: 'fields', verb: 'TYPE', policyFacts: false },
  validate: { isLookup: true, flags: true, policyNotes: false, limitNotes: false, isDeclared: false, returnsLabel: 'return type', policyFacts: false },
  dry_run: { isLookup: true, flags: true, policyNotes: true, limitNotes: false, isDeclared: false, returnsLabel: 'return type', policyFacts: true },
}

export const profileOf = (call: InspectedCall | null | undefined): Profile => {
  if (call?.tool === undefined) return EXECUTE_PROFILE
  const profile = PROFILES[call.tool]
  return call.tool === 'introspect' && ['scalar', 'enum', 'input', 'union'].includes(call.found?.typeKind ?? '') ? { ...profile, hasFieldTree: false } : profile
}

/** The badge word for each lookup: the tool's own name, so it matches what the dialog and the transcript call it. */
export const LOOKUP_BADGE: Record<LookupTool, string> = { search: 'SEARCH', introspect: 'INTROSPECT', validate: 'VALIDATE', dry_run: 'DRY RUN' }

/** A lookup's badge is quiet: it reads the schema or checks an operation, and never runs one. */
export const LOOKUP_HUE = QUIET

export type Badge = { word: string; hue: string }

export function badgeOf(call: InspectedCall): Badge {
  if (call.tool !== undefined) return { word: LOOKUP_BADGE[call.tool], hue: LOOKUP_HUE }
  const opType = call.ir.opType
  return { word: opType === undefined ? '?' : BADGE[opType], hue: BADGE_HUE[opType ?? 'unknown'] }
}

/** What the badge's card says a lookup is. */
export const LOOKUP_FACTS: Record<LookupTool, { title: string; lines: string[] }> = {
  search: {
    title: 'SEARCH · find operations',
    lines: [
      "search finds operations in the graph by name and description, and returns each one's arguments and return type as the schema declares them.",
      'It reads the schema, not data: nothing in any service is read or changed.',
      'Without a scope it searches every service you can reach; results are ranked by how well they match the terms.',
    ],
  },
  introspect: {
    title: 'INTROSPECT · read a type',
    lines: [
      "introspect returns one type's definition from a service's schema, and the types it references to the depth asked, filtered to what you are allowed to see.",
      'It reads the schema, not data: nothing in any service is read or changed.',
    ],
  },
  validate: {
    title: 'VALIDATE · check an operation',
    lines: [
      "validate compiles an operation against a service's schema without running it, and reports each problem the compiler finds.",
      'It checks shape, not access: dry_run says what policy allows. Nothing is read or changed.',
    ],
  },
  dry_run: {
    title: 'DRY RUN · check access',
    lines: [
      "dry_run asks Agent Services' policy, field by field, what an operation could read: allowed, masked or denied. It does not run the operation.",
      'execute enforces the same policy; a denied field there carries the token an access request takes. Nothing is read or changed.',
    ],
  },
}

/** `A, B and C`. */
export function listed(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`

/** The terms of a search as one quoted phrase, escaped. */
export const termsOf = (call: InspectedCall) => `“${esc((call.input?.terms ?? []).join(' '), 300)}”`

/** What the header names a lookup by, where an execute shows its operation name: the terms, the type, or nothing (validate and dry_run have their operation's own name). */
export function subjectOf(call: InspectedCall): string | undefined {
  if (call.tool === 'search') return (call.input?.terms ?? []).length === 0 ? 'the catalog' : termsOf(call)
  if (call.tool === 'introspect') return call.input?.type === undefined ? undefined : esc(call.input.type)
  return undefined
}

const whereOf = (scope: string | undefined) => scope === undefined || scope === '' ? 'every service' : productOf(scope) ?? esc(scope)

/** Deterministic fallback from reported facts; the model's summary adds schema meaning separately. */
export function headlineOf(call: InspectedCall): string | undefined {
  const tool = call.tool
  if (tool === undefined) return undefined
  const found = call.found
  const waiting = call.status === 'pending'
  if (call.status === 'denied') return `The ${tool} call was refused before it ran.`
  if (call.status === 'interrupted') return `The ${tool} call was interrupted before it answered.`
  if (call.status === 'errored') return found?.error === undefined ? `The ${tool} call failed.` : `The ${tool} call failed: ${esc(found.error)}`
  if (found?.unreadable !== undefined) return call.ir.checks?.context?.some(one => one.outcome === 'failed' && one.reason === 'missing-data') ? lookupMissingEvidence(call) : `Agent Services' answer could not be read: ${esc(found.unreadable)}`
  if (tool === 'search') {
    const catalog = (call.input?.terms ?? []).length === 0
    if (catalog && waiting) return 'Listing the services this graph reaches.'
    if (waiting) return `Searching ${whereOf(call.input?.scope)} for ${termsOf(call)}.`
    const count = searchCountOf(call)
    if (count === undefined || count.kind === 'unknown') return lookupMissingEvidence(call)
    if (!catalog && count.kind === 'exact' && count.value === 0) return 'This search found no matching operation definitions.'
    return catalog ? `Lists ${countText(count, 'available service')}.` : `Found ${countText(count, 'matching operation')}.`
  }
  if (tool === 'introspect') {
    const type = esc(call.input?.type ?? 'a type')
    if (waiting) return `Reading the ${type} declaration in ${whereOf(call.input?.scope)}.`
    if (found?.typeKind === 'unavailable' || found?.typeKind === undefined || found.typeKind === 'absent') return lookupMissingEvidence(call)
    return `Read the ${type} declaration: ${found.typeKind === 'input' ? 'input object' : found.typeKind}.`
  }
  const name = esc(call.ir.opName ?? 'the operation')
  if (tool === 'validate') {
    if (waiting) return `Checking ${name} against the schema.`
    if (call.ir.validation === undefined) return lookupMissingEvidence(call)
    return call.ir.validation.valid ? `${name} is valid against the schema.` : `${name} fails schema validation${(found?.problems ?? 0) > 0 ? `: ${plural(found?.problems ?? 0, 'reported problem')}` : ''}.`
  }
  if (waiting) return `Checking what policy allows for ${name}.`
  const { requests, failed, refused, incomplete } = dryRunEvidenceOf(call)
  const counts = leafPolicyCounts(call.ir.roots)
  const parts = [counts.allow > 0 ? `${counts.allow} fields allowed` : '', counts.mask > 0 ? `${counts.mask} masked` : '', counts.deny > 0 ? `${counts.deny} denied` : '', counts.unknown > 0 ? `${counts.unknown} unknown` : '', refused > 0 ? `${refused} operations refused whole` : '', failed > 0 ? `${failed} requests failed` : '', incomplete && requests.length > 0 ? 'some request outcomes unavailable' : ''].filter(Boolean)
  return requests.length === 0 ? lookupMissingEvidence(call) : `Checked access${parts.length === 0 ? '.' : `: ${parts.join('; ')}.`}`
}

export type Status = { glyph: string; word: string; color: string }

/** The header's status word: an execute's from what came back (ui/index.tsx statusOf), a lookup's from its answer. */
export function callStatusOf(call: InspectedCall, waiting: number): Status | undefined {
  const plain = statusOf(call.status, waiting, call.outcome)
  if (isExecute(call) || call.status !== 'ran') return plain
  if (call.found === undefined) return { glyph: GLYPH.unknown, word: 'unavailable', color: COLOR.mask }
  const found = call.found
  if (found.unreadable !== undefined) return call.ir.checks?.context?.some(one => one.outcome === 'failed' && one.reason === 'missing-data') ? { glyph: GLYPH.unknown, word: 'unavailable', color: COLOR.mask } : { glyph: GLYPH.failed, word: 'errors', color: COLOR.fail }
  if (call.tool === 'search') {
    const catalog = (call.input?.terms ?? []).length === 0
    const count = searchCountOf(call)
    if (count === undefined || count.kind === 'unknown') return { glyph: GLYPH.unknown, word: 'unavailable', color: COLOR.mask }
    return { glyph: GLYPH.ran, word: countText(count, catalog ? 'service' : 'match'), color: found.completeness === 'partial' ? COLOR.mask : COLOR.allow }
  }
  if (call.tool === 'introspect') {
    if (found.typeKind === 'unavailable' || found.typeKind === undefined) return { glyph: GLYPH.unknown, word: 'unavailable', color: COLOR.mask }
    if (found.typeKind === 'absent') return { glyph: GLYPH.failed, word: 'not found', color: COLOR.mask }
    const count = found.members === undefined ? found.counts?.fields : found.counts?.members
    if (count !== undefined && count.kind !== 'unknown' && count.value > 0) return { glyph: GLYPH.ran, word: countText(count, found.members === undefined ? 'field' : 'member'), color: found.completeness === 'partial' ? COLOR.mask : COLOR.allow }
    return { glyph: GLYPH.ran, word: found.typeKind === 'input' ? 'input object' : found.typeKind, color: COLOR.allow }
  }
  if (call.tool === 'validate') return call.ir.validation === undefined ? { glyph: GLYPH.unknown, word: 'unavailable', color: COLOR.mask } : call.ir.validation.valid ? { glyph: GLYPH.allow, word: 'valid', color: COLOR.allow } : { glyph: GLYPH.deny, word: 'invalid', color: COLOR.fail }
  const { requests, failed, refused, incomplete } = dryRunEvidenceOf(call)
  if (requests.length === 0) return { glyph: GLYPH.unknown, word: 'unavailable', color: COLOR.mask }
  if (failed > 0) return { glyph: GLYPH.failed, word: `checked · ${failed} failed`, color: COLOR.mask }
  if (incomplete) return { glyph: GLYPH.unknown, word: 'partly checked', color: COLOR.mask }
  if (refused > 0) return { glyph: GLYPH.deny, word: 'checked · refused', color: COLOR.mask }
  return { glyph: GLYPH.ran, word: 'checked', color: COLOR.allow }
}

/** What a lookup's status word means, for its card. */
export function lookupStatusFacts(call: InspectedCall, word: string): string[] | undefined {
  if (isExecute(call) || call.status !== 'ran') return undefined
  if (word === 'unavailable') return ['The response does not establish the requested fact. Missing or unreadable evidence remains unknown.']
  if (word === 'errors') return ["Agent Services answered, but not with JSON the pane could read: the headline quotes what it said."]
  if (call.tool === 'search') return [headlineOf(call) ?? 'Search evidence is unavailable.', 'The pane initially shows up to five retained definitions, in Agent Services rank order. Purpose, required inputs and return types remain visible; expand for more retained definitions.']
  if (call.tool === 'introspect') {
    if (word === 'not found') return ['The complete answer declares no visible type by that name. This does not establish what exists outside the schema you can see.']
    if (call.found?.typeKind === 'scalar') return ['The schema declares this scalar type. Scalars have no selectable fields.']
    if (call.found?.typeKind === 'union') return ['The schema declares a union of the object types listed below.']
    if (call.found?.typeKind === 'enum') return ["The enum's declared values; each visible value has a card with its description and deprecation, when provided."]
    if (call.found?.typeKind === 'input') return ["The input's declared fields, with their types and defaults; each visible field has its own card."]
    return ["The type's fields as the schema declares them; each field's card says its type and description."]
  }
  if (call.tool === 'validate') return word === 'valid' ? ['The operation compiles against the schema: an execute of it would not fail on its shape. Access is a separate check.'] : ['The compiler found problems: an execute of this operation would fail. The notes quote each one.']
  return [headlineOf(call) ?? 'Access-check evidence is unavailable.', 'These are policy check outcomes, not permission to execute. Field marks describe the evidence that is available.']
}

/** The notes only a lookup has, first in the notes strip: what came back besides the schema. Escaped. */
export function lookupNotes(call: InspectedCall): Note[] {
  const found = call.found
  if (call.tool === undefined || found === undefined) return []
  const notes: Note[] = []
  if (call.tool === 'dry_run') {
    for (const [index, request] of (found.requests ?? []).entries()) {
      const where = `${esc(productOf(request.scope) ?? request.scope, 80)}${(found.requests?.length ?? 0) > 1 ? ` request ${index + 1}` : ''}`
      if (request.error !== undefined) notes.push({ glyph: GLYPH.failed, text: `${where}: ${esc(request.error.replace(/\s+/g, ' '), 300)}`, color: COLOR.deny })
      else if (request.isDenied === true) notes.push({ glyph: GLYPH.deny, text: `${where}: policy refuses the whole operation`, color: COLOR.deny })
    }
  }
  // What the answer cost in Claude's context: the receipt line an execute's RESULT ends in.
  if (found.isPersisted !== true && found.bytes > 0) notes.push({ glyph: GLYPH.bullet, text: `${sizeText(found.bytes)} · ${tokensText(found.bytes)} of Claude's context`, isDim: true })
  if (call.tool !== 'search' && call.tool !== 'introspect' && found.omissions !== undefined) for (const omission of found.omissions) notes.push({ glyph: GLYPH.unknown, text: esc(omission), isDim: true })
  if (found.isTrimmed === true) notes.push({ glyph: GLYPH.unknown, text: 'some descriptions not kept', hint: 'the answer was too large to keep them all', isDim: true })
  if (found.isPersisted === true) notes.push({ glyph: GLYPH.unknown, text: 'Claude Code saved this answer to a file', hint: 'Claude read only a preview of it', isDim: true })
  return notes
}
