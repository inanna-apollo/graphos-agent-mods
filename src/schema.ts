// SDL strings from Agent Services → a field index. Pure: no $.
//
// Agent Services hands back SDL per type (introspect) and `type Query { field }`
// snippets (search). Both are untrusted schema text: descriptions are kept
// as data, never interpreted, and unknown directives are kept by name.

import { Kind, parse, print } from './vendor/graphql.js'
import type { DirectiveNode, StringValueNode, TypeNode } from './vendor/graphql.js'

export type FieldDef = {
  name: string
  /** As SDL writes it: `[Confluence_SearchResultItem!]`. */
  type: string
  /** The named type under any list and non-null wrappers. */
  namedType: string
  isList: boolean
  description?: string
  deprecated?: string
  /** Directive names other than @deprecated. */
  tags: string[]
  /** The description says the field comes back only (or in full) with an `include` value. */
  requiresInclude?: { arg: 'include'; value: string; mode: 'only' | 'full' }
  /** The value is opaque JSON: no sub-selection. */
  isOpaque?: boolean
  /** The outer type is non-null (`T!`, `[T]!`). */
  isNonNull: boolean
  /** A list whose items are non-null (`[T!]`). */
  isListItemNonNull: boolean
  /** A list that is itself non-null (`[T]!`). */
  isListNonNull: boolean
  /** Argument name → its type as SDL writes it. */
  args: Record<string, string>
  /** Argument name → everything the SDL says about it, in declaration order. */
  argDefs: Record<string, ArgDef>
}

export type ArgDef = {
  name: string
  type: string
  namedType: string
  /** The printed literal: `10`, `EQUALS`, `"and"`. */
  defaultValue?: string
  /** Untrusted schema text. */
  description?: string
}

/** Type name → field name → definition. Snippets of the same type merge. */
export type SchemaIndex = Map<string, Map<string, FieldDef>>

const ENUMS = new WeakMap<SchemaIndex, Map<string, string[]>>()

/** Enum type name → its values, for every enum `indexSdl` saw into this index. */
export function enumsOf(index: SchemaIndex): Map<string, string[]> {
  let found = ENUMS.get(index)
  if (found === undefined) {
    found = new Map()
    ENUMS.set(index, found)
  }
  return found
}

function typeFacts(type: TypeNode): { isNonNull: boolean; isListItemNonNull: boolean; isListNonNull: boolean } {
  const isNonNull = type.kind === Kind.NON_NULL_TYPE
  const inner = type.kind === Kind.NON_NULL_TYPE ? type.type : type
  const isListType = inner.kind === Kind.LIST_TYPE
  return {
    isNonNull,
    isListNonNull: isNonNull && isListType,
    isListItemNonNull: isListType && inner.type.kind === Kind.NON_NULL_TYPE,
  }
}

const HINT_MAX = 80
const clean = (text: string): string => text.replace(/[\u0000-\u001f\u007f`]+/g, ' ').replace(/\s+/g, ' ').trim()

const MAX_PHRASE = /\b(?:maximum|max)(?:\s+(?:of|is|value(?:\s+of)?))?\s+`?(\d[\d,_]*)`?/gi
// What may stand before the phrase when it describes the value itself:
// "Maximum of 100", "It returns max 5000 issues", "(max 50)".
const OWN_MAX_LEAD = /^(?:\(\s*|(?:(?:it|this)\s+)?(?:(?:returns?|is|has|allows?|accepts?|supports?)\s+)?(?:(?:an?|the)\s+)?)$/i

/** A "max N" that directly describes the value, not another clause or field ("orderBy can contain a maximum of 7 fields"). */
function maxOf(description: string): string | undefined {
  for (const clause of description.split(/[.;,](?:\s|$)|\n/)) {
    for (const match of clause.matchAll(MAX_PHRASE)) {
      const lead = clause.slice(0, match.index).replace(/[\s`]+$/, ' ').trimStart()
      if (OWN_MAX_LEAD.test(lead) || lead.trimEnd().endsWith('(')) return match[1]!.replace(/[,_]/g, '')
    }
  }
  return undefined
}

/**
 * Short normalized hints from a description, by a small conservative pattern
 * set: a max, a default, a timezone, one-of values, a "requires a ..."
 * restriction. Untrusted text, each at most 80 characters; the full
 * description stays alongside.
 */
export function hintsFrom(description: string | undefined): string[] {
  if (description === undefined) return []
  const found: string[] = []
  const add = (hint: string) => {
    const text = clean(hint)
    if (text.length > 0 && text.length <= HINT_MAX && !found.includes(text)) found.push(text)
  }
  // Vendor semantic annotations (`x-data-classification: pii.contact`), a small allowlist.
  for (const match of description.matchAll(/\bx-(data-classification|sensitivity|pii|retention)\s*[:=]\s*`?([A-Za-z0-9][\w.-]{0,30})/gi)) {
    const value = match[2]!.replace(/[.-]+$/, '')
    const kind = match[1]!.toLowerCase()
    if (value !== '') add(`${kind === 'data-classification' ? 'classified' : kind} ${value}`)
  }
  const max = maxOf(description)
  if (max !== undefined) add(`max ${max}`)
  const dflt = /\bdefaults?\s+(?:to|is|=)\s+(?:`([^`]{1,40})`|"([^"]{1,40})"|(\w[\w.-]{0,30}))/i.exec(description)
  if (dflt) add(`default ${dflt[1] ?? dflt[2] ?? dflt[3]}`)
  const zone =
    /\b(Pacific|Eastern|Central|Mountain|Atlantic|Alaska|Hawaii)(?:-Aleutian)?\s+(?:Standard\s+|Daylight\s+)?Time\b/.exec(description) ??
    /\b(UTC|GMT)\b/.exec(description)
  if (zone) add(`timezone ${zone[0]}`)
  const oneOf = /\(\s*one of\s+([^)]{1,70})\)/i.exec(description)
  if (oneOf) {
    const values = oneOf[1]!.split(/\s*(?:\||,|\/|\sor\s)\s*/i).map(clean).filter(Boolean)
    if (values.length > 1) add(`one of ${values.join('|')}`)
  }
  const restriction = /\b(requires?\s+an?\s+[^.,;:()]{3,50}?)(?=[.,;:()]|\s*$)/i.exec(description)
  if (restriction && !/\bscopes?\b/i.test(restriction[1]!)) add(restriction[1]!.toLowerCase())
  // Annotations come first, so the cut never drops them.
  return found.slice(0, 6)
}

function unwrap(type: TypeNode): { namedType: string; isList: boolean } {
  let isList = false
  let node = type
  while (node.kind !== Kind.NAMED_TYPE) {
    if (node.kind === Kind.LIST_TYPE) isList = true
    node = node.type
  }
  return { namedType: node.name.value, isList }
}

function deprecationOf(directives: readonly DirectiveNode[] | undefined): string | undefined {
  const directive = directives?.find(one => one.name.value === 'deprecated')
  if (directive === undefined) return undefined
  const reason = directive.arguments?.find(arg => arg.name.value === 'reason')?.value
  return reason?.kind === Kind.STRING ? (reason as StringValueNode).value : 'deprecated'
}

/** Indexes every object and interface type in `sdls`; a string that does not parse is skipped. */
export function indexSdl(sdls: readonly string[], into: SchemaIndex = new Map()): SchemaIndex {
  for (const sdl of sdls) {
    let document
    try {
      document = parse(sdl, { noLocation: true })
    } catch {
      continue
    }
    for (const definition of document.definitions) {
      if (definition.kind === Kind.ENUM_TYPE_DEFINITION || definition.kind === Kind.ENUM_TYPE_EXTENSION) {
        const enums = enumsOf(into)
        const values = enums.get(definition.name.value) ?? []
        for (const value of definition.values ?? []) if (!values.includes(value.name.value)) values.push(value.name.value)
        enums.set(definition.name.value, values)
        continue
      }
      const isObject =
        definition.kind === Kind.OBJECT_TYPE_DEFINITION ||
        definition.kind === Kind.OBJECT_TYPE_EXTENSION ||
        definition.kind === Kind.INTERFACE_TYPE_DEFINITION ||
        definition.kind === Kind.INTERFACE_TYPE_EXTENSION
      if (!isObject) continue
      const fields = into.get(definition.name.value) ?? new Map<string, FieldDef>()
      for (const field of definition.fields ?? []) {
        const { namedType, isList } = unwrap(field.type)
        const deprecated = deprecationOf(field.directives)
        const args: Record<string, string> = Object.create(null)
        const argDefs: Record<string, ArgDef> = Object.create(null)
        for (const arg of field.arguments ?? []) {
          args[arg.name.value] = print(arg.type)
          argDefs[arg.name.value] = {
            name: arg.name.value,
            type: print(arg.type),
            namedType: unwrap(arg.type).namedType,
            ...(arg.defaultValue !== undefined && { defaultValue: print(arg.defaultValue) }),
            ...(arg.description !== undefined && { description: arg.description.value }),
          }
        }
        fields.set(field.name.value, {
          name: field.name.value,
          type: print(field.type),
          namedType,
          isList,
          ...typeFacts(field.type),
          ...(field.description !== undefined && { description: field.description.value }),
          ...(deprecated !== undefined && { deprecated }),
          tags: (field.directives ?? []).map(one => one.name.value).filter(name => name !== 'deprecated'),
          ...(requiresIncludeFrom(field.description?.value) !== undefined && { requiresInclude: requiresIncludeFrom(field.description?.value) }),
          ...(isOpaqueJson(namedType, field.description?.value) && { isOpaque: true }),
          args,
          argDefs,
        })
      }
      into.set(definition.name.value, fields)
    }
  }
  return into
}

const SCOPE = /^[A-Za-z][\w-]*(?::[\w.-]+)+$/
/** Dotted scope names (`incidents.read`), accepted only after an explicit scope marker. */
const LOOSE_SCOPE = /^[A-Za-z][\w-]*(?:\.[\w-]+)+$/

/**
 * Scopes a description names, the way Agent Services writes them: "Requires the
 * search:confluence and read:confluence-content.summary scopes."
 */
export function scopesFrom(description: string | undefined): string[] {
  if (description === undefined) return []
  const found = new Set<string>()
  // One match per "requires" clause, consuming up to the sentence end (a '.'
  // followed by whitespace or end of input). A '.' inside a token, as in
  // read:confluence-content.summary, does not end it. Branches are disjoint,
  // so each clause is scanned once and matching is linear.
  for (const match of description.matchAll(/\brequires?\s+((?:[^.]|\.(?!\s|$))*)/gi)) {
    const clause = match[1] ?? ''
    // "Requires scope `x`." lists after the word; "Requires the x and y scopes" before it.
    const lead = /^(?:the\s+)?scopes?\b/i.exec(clause)
    const word = lead ?? /(?<=\s)scopes?\b/i.exec(clause)
    if (!word) continue
    const list = lead ? clause.slice(lead[0].length) : clause.slice(0, word.index)
    for (const token of list.split(/[\s,]+/)) {
      const scope = token.replace(/^[`'"]+|[`'"]+$/g, '').replace(/\.$/, '')
      if (SCOPE.test(scope)) found.add(scope)
    }
  }
  // Other phrasings: "Scoped OAuth requires: `incidents.read`", "OAuth scope(s): x",
  // "Required scopes: x, y". The list after the marker runs to the end of the
  // line or sentence, split on commas and "and"; dotted names (no colon) count here.
  for (const match of description.matchAll(/\b(?:scoped\s+oauth\s+requires?|oauth\s+scopes?|required\s+scopes?)\s*:?\s*((?:[^.\n]|\.(?!\s|$))*)/gi)) {
    for (const part of (match[1] ?? '').split(/\s*,\s*|\s+(?:and|or)\s+/i)) {
      const token = part.trim()
      const ticked = /^[`'"]+([\w:.-]+)[`'"]+$/.exec(token)
      const scope = (ticked?.[1] ?? token.replace(/^[`'"]+|[`'"]+$/g, '')).replace(/\.$/, '')
      if (SCOPE.test(scope) || LOOSE_SCOPE.test(scope) || (ticked !== null && /^[\w:.-]+$/.test(scope))) found.add(scope)
    }
  }
  return [...found]
}

/** The `include` value a conditional field needs, from "Only returned if the `include[]=body` query parameter is provided". */
export function requiresIncludeFrom(description: string | undefined): { arg: 'include'; value: string; mode: 'only' | 'full' } | undefined {
  if (description === undefined) return undefined
  const only = /\bonly\s+returned\s+if\s+the\s+`?include(?:\[\])?=([\w.-]{1,40})`?\s+query\s+parameter\s+is\s+provided/i.exec(description)
  if (only !== null) return { arg: 'include', value: only[1] as string, mode: 'only' }
  const full = /\bif\s+the\s+`?include(?:\[\])?=([\w.-]{1,40})`?\s+query\s+parameter\s+is\s+provided,?\s+the\s+full\b/i.exec(description)
  if (full !== null) return { arg: 'include', value: full[1] as string, mode: 'full' }
  return undefined
}

/** A field whose value is opaque JSON: a scalar named `JSON` / `*_JSON`, or a description that says so. */
export function isOpaqueJson(namedType: string, description: string | undefined): boolean {
  return /(?:^|_)JSON$/i.test(namedType) || /\bopaque\s+json\b/i.test(description ?? '') || /\bpolymorphic\s+schema\b[^]{0,80}\bnot\s+yet\s+modeled\b/i.test(description ?? '')
}
