// Which selected fields look like personal data, by their real names' words.
// Pure: no $. A hint for the reader, not a classification.

import { escapeText } from '../escape.ts'
import type { FieldIR } from '../ir.ts'
import { wordsOf } from '../risk.ts'

// Each term as the words a name splits into (`displayName` → display, name).
const TERMS: readonly (readonly string[])[] = [
  ['email'], ['phone'], ['address'], ['display', 'name'], ['full', 'name'], ['first', 'name'],
  ['last', 'name'], ['birth'], ['birthday'], ['ssn'], ['salary'], ['account', 'id'],
  // Fields that name or identify a person: message authors, issue people.
  ['username'], ['user', 'name'], ['author'], ['assignee'], ['reporter'], ['creator'],
]

// Names that are a person only on their own (`user`, not `userAgent`).
const WHOLE: ReadonlySet<string> = new Set(['user', 'owner', 'sender', 'recipient'])

/** Whether `name`'s words contain one of the terms as consecutive whole words. */
export function isPersonalName(name: string): boolean {
  const words = wordsOf(name)
  if (words.length === 1 && WHOLE.has(words[0] ?? '')) return true
  return TERMS.some(term => words.some((_, at) => term.every((word, offset) => words[at + offset] === word)))
}

/** What the schema classifies a field as (`pii.contact`, from `x-data-classification`), if it says. */
export function classifiedOf(field: FieldIR): string | undefined {
  for (const hint of field.schema?.hints ?? []) {
    const match = /^classified (\S{1,40})$/.exec(hint)
    if (match !== null) return match[1]
  }
  return undefined
}

// Object fields that are a person: marked once with a quiet `person` tag, not ◆.
const PERSON_NAMES: ReadonlySet<string> = new Set(['creator', 'user', 'assignee', 'author', 'owner', 'reporter', 'sender', 'recipient', 'member'])
const PERSON_TYPE = /(?:User|Person|Member|Actor|UserSlim)$/

/** The named type under list and non-null wrappers: `[IncidentIO_UserSlim!]` is `IncidentIO_UserSlim`. */
const namedType = (type: string) => type.replace(/[[\]!\s]/g, '')

/** An object field that is a person: by its name, or by its type's name (`...User`, `...Person`, `...Member`, `...Actor`). */
export function isPersonObject(field: FieldIR): boolean {
  if (field.children.length === 0) return false
  if (PERSON_NAMES.has(field.name.toLowerCase())) return true
  const type = field.schema === undefined ? '' : namedType(field.schema.type)
  return PERSON_TYPE.test(type)
}

/**
 * Personal by the schema's own classification (`pii.*`) or, failing that, by its name's words.
 * Only a leaf by name: an object that is a person carries the `person` tag instead.
 */
export function isPersonalField(field: FieldIR): boolean {
  const classified = classifiedOf(field)
  if (classified !== undefined && /^pii(?:[.-]|$)/i.test(classified)) return true
  return field.children.length === 0 && isPersonalName(field.name)
}

/** A personal field and the short parent path it sits under (`creator.user`), empty at the top. */
export type PersonalPlace = { field: FieldIR; where: string[] }

/**
 * The selected fields (anywhere below and including `fields`) that look personal, each with
 * its short parent path: the run of person objects just above it, else its direct parent
 * (never the root itself).
 */
export function personalPlaces(fields: readonly FieldIR[]): PersonalPlace[] {
  const found: PersonalPlace[] = []
  const visit = (field: FieldIR, ancestors: readonly FieldIR[]) => {
    if (isPersonalField(field)) {
      const people: string[] = []
      for (let at = ancestors.length - 1; at >= 1 && isPersonObject(ancestors[at] as FieldIR); at--) people.unshift((ancestors[at] as FieldIR).name)
      const parent = ancestors.length > 1 ? (ancestors[ancestors.length - 1] as FieldIR).name : undefined
      found.push({ field, where: people.length > 0 ? people : parent === undefined ? [] : [parent] })
    }
    for (const child of field.children) visit(child, [...ancestors, field])
  }
  for (const field of fields) visit(field, [])
  return found
}

/** The selected fields (anywhere below and including `fields`) that look personal. */
export function personalFields(fields: readonly FieldIR[]): FieldIR[] {
  return personalPlaces(fields).map(place => place.field)
}

/** The dim tag after a field's name in RETURNS: `  pii.contact`, or nothing. Escaped. */
export function classTag(field: FieldIR): string {
  const classified = classifiedOf(field)
  return classified === undefined ? '' : `  ${escapeText(classified, 40).text}`
}
