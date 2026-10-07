// The notes strip: one short line per unusual fact, from the IR alone (never
// from the summary). Pure: no $. No note is ever reassurance; with nothing
// unusual the strip is absent.

import type { CallIR, FieldIR } from '../ir.ts'
import { LIMIT_ARGS, PLACE_ARGS, esc, limitOf, missingInclude, returnsList, walk } from './kit.ts'
import { classifiedOf, personalPlaces } from './personal.ts'
import type { PersonalPlace } from './personal.ts'
import { COLOR, GLYPH } from './ui/theme.ts'
import type { SemanticColor } from './ui/theme.ts'

export type Note = {
  glyph: string
  /** Escaped. */
  text: string
  /** Real names the note is about, escaped; the first few are listed after `text`. */
  names?: string[]
  /** A semantic color for the glyph and text, or none. */
  color?: SemanticColor
  /** Dim words after the note. */
  hint?: string
  /** Dim words two cells after `text` (`denied · pii.contact`), never shed. Escaped. */
  detail?: string
  isDim?: boolean
}

const LARGE = 100
const MAX_DIAGNOSTICS = 3

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? '' : 's'}`
const unique = (names: string[]) => [...new Set(names)]
const named = (fields: readonly FieldIR[]) => unique(fields.map(field => esc(field.name, 120)))

// Arguments that cut a list: a size or a place in it (the same lists limitOf reads).
const LIMIT_LIKE = [...LIMIT_ARGS, ...PLACE_ARGS]

/** The root declares a limit or paging argument the call left unset; a root that takes none cannot be limited. */
export function hasUnsetLimit(root: FieldIR): boolean {
  return (root.omittedArgs ?? []).some(arg => LIMIT_LIKE.includes(arg.name.toLowerCase()))
}

/**
 * The notes, in order. `isShown` says which restricted or personal fields
 * the pane already draws with their mark (a return tree, a root line): they
 * have a home there, so the strip leaves them out.
 */
export function notesOf(ir: CallIR, isShown: (field: FieldIR) => boolean = () => false, isSettled = false, hasRunValid = false): Note[] {
  const notes: Note[] = []
  const fields = walk(ir.roots)

  // A prediction the call itself answered (it ran, and validated) is not said again.
  if (ir.state === 'invalid' && !hasRunValid) {
    const diagnostics = ir.validation?.diagnostics ?? []
    for (const diagnostic of diagnostics.slice(0, MAX_DIAGNOSTICS)) {
      const first = (diagnostic.trim().split('\n')[0] ?? '').replace(/^Error:\s*/, '')
      notes.push({ glyph: GLYPH.failed, text: `will fail: ${esc(first, 300)}`, color: COLOR.deny })
    }
    if (diagnostics.length > MAX_DIAGNOSTICS) notes.push({ glyph: GLYPH.failed, text: `and ${diagnostics.length - MAX_DIAGNOSTICS} more problems`, color: COLOR.deny })
    if (diagnostics.length === 0) notes.push({ glyph: GLYPH.failed, text: 'will fail validation', color: COLOR.deny })
  }
  // The operation-wide denial, writes and destructive names are flags (src/view/flags.ts), not notes.
  notes.push(...fieldNotes(ir.roots, isShown))

  for (const root of ir.roots) {
    const limit = limitOf(root)
    const where = ir.roots.length > 1 ? ` on ${esc(root.name, 120)}` : ''
    if (limit === undefined && returnsList(root) && hasUnsetLimit(root)) {
      notes.push({ glyph: GLYPH.limit, text: `no limit${where}`, hint: 'the server default page size may cut results' })
    } else if (limit !== undefined && limit > LARGE) {
      notes.push({ glyph: GLYPH.limit, text: `large: limit ${limit}${where}` })
    }
  }

  // Fields that depend on an `include` value the call did not give: absent (`only`), or just a reference (`full`).
  const absent = new Map<string, { only: string[]; full: string[] }>()
  for (const root of ir.roots) {
    for (const field of walk([root])) {
      const gap = missingInclude(root, field)
      if (gap === undefined) continue
      const found = absent.get(gap.value) ?? { only: [], full: [] }
      const names = found[gap.mode]
      const name = esc(field.name, 120)
      if (!names.includes(name)) names.push(name)
      absent.set(gap.value, found)
    }
  }
  for (const [value, { only, full }] of absent) {
    const set = `set include=${esc(value, 120)}`
    if (only.length > 0) notes.push({ glyph: GLYPH.limit, text: `${listNames(only)} won't be returned: ${set}` })
    if (full.length > 0) notes.push({ glyph: GLYPH.limit, text: `${listNames(full)} ${full.length === 1 ? 'is a reference' : 'are references'} only: ${set} for the full object` })
  }

  const deprecated = fields.filter(field => field.schema?.deprecated !== undefined)
  // One deprecated field carries its @deprecated reason inline; several are listed by name.
  const only = deprecated.length === 1 ? deprecated[0] : undefined
  if (only !== undefined) {
    const reason = only.schema?.deprecated
    const why = reason === undefined || reason === 'deprecated' ? '' : ` · ${esc(reason.replace(/\s+/g, ' ').trim(), 120)}`
    notes.push({ glyph: GLYPH.deprecated, text: `deprecated: ${esc(only.name, 120)}${why}` })
  } else if (deprecated.length > 1) {
    notes.push({ glyph: GLYPH.deprecated, text: 'deprecated:', names: named(deprecated) })
  }

  if (ir.state === 'analyzing') {
    // A call that already ran is past its policy: its checks may still land (a call trust rules let through runs at once), but RESULT says what came back.
    if (!isSettled) notes.push({ glyph: GLYPH.checking, text: 'checking policy…', isDim: true })
  } else {
    const unknown = fields.filter(field => field.policy === 'unknown')
    if (unknown.length > 0 && unknown.length === fields.length) {
      // Our own enrichment falling short is grey, never red (mod-builder design.md). A failed check is a flag.
      if (ir.checks?.policy !== 'failed') notes.push(uncheckedNote(ir))
    } else if (unknown.length > 0) {
      notes.push({ glyph: GLYPH.unknown, text: `access unknown for ${plural(unknown.length, 'field')}:`, names: named(unknown), isDim: true })
    }
    // That no scope is needed is the policy card's to say (src/view/card-facts.ts scopesNote), not the strip's.
  }
  return notes
}

/** Per kind, the fields with a line of their own; the rest share one. */
const FIELD_LINES = 3

/**
 * One line per restricted or personal field name, policy first: `✕ email  denied ·
 * pii.contact`, `◐ excerpt  masked`, `◆ email  personal data · pii.contact · creator.user`.
 * A name listed under several parents says where once. Past FIELD_LINES of a kind, one line
 * lists the rest. Only fields with no other home: one `isShown` says the pane draws with its
 * mark is left out.
 */
function fieldNotes(roots: readonly FieldIR[], isShown: (field: FieldIR) => boolean): Note[] {
  type Entry = { name: string; classes: string[]; where: string[] }
  const kinds: Record<'deny' | 'mask' | 'personal', Map<string, Entry>> = { deny: new Map(), mask: new Map(), personal: new Map() }
  const places = new Map(personalPlaces(roots).map(place => [place.field, place.where] as const))
  for (const field of walk(roots)) {
    if (field.children.length > 0 || isShown(field)) continue
    const kind = field.policy === 'deny' ? 'deny' : field.policy === 'mask' ? 'mask' : places.has(field) ? 'personal' : undefined
    if (kind === undefined) continue
    const entry = kinds[kind].get(field.name) ?? { name: esc(field.name, 120), classes: [], where: [] }
    const classified = classifiedOf(field)
    if (classified !== undefined && !entry.classes.includes(esc(classified, 120))) entry.classes.push(esc(classified, 120))
    const where = (places.get(field) ?? []).map(part => esc(part, 120)).join('.')
    if (where !== '' && !entry.where.includes(where)) entry.where.push(where)
    kinds[kind].set(field.name, entry)
  }
  const notes: Note[] = []
  const WORD = { deny: 'denied', mask: 'masked', personal: 'personal data' } as const
  const GLYPHS = { deny: GLYPH.deny, mask: GLYPH.mask, personal: GLYPH.personal } as const
  for (const kind of ['deny', 'mask', 'personal'] as const) {
    const entries = [...kinds[kind].values()]
    const color = kind === 'deny' ? { color: COLOR.deny } : kind === 'mask' ? { color: COLOR.mask } : {}
    for (const entry of entries.slice(0, FIELD_LINES)) {
      const detail = [WORD[kind], ...entry.classes, ...(kind === 'personal' ? entry.where.slice(0, 2) : [])].join(' \u00b7 ')
      notes.push({ glyph: GLYPHS[kind], text: entry.name, detail, ...color })
    }
    const rest = entries.slice(FIELD_LINES)
    if (rest.length > 0) notes.push({ glyph: GLYPHS[kind], text: `${rest.length} more ${WORD[kind]}:`, names: rest.map(entry => entry.name), ...color })
  }
  return notes
}

const SHOWN_NAMES = 6
const PERSONAL_MAX = 50

/**
 * `email (creator.user, assignee), phone`: each field name once, with the short parent paths
 * it occurs under (and the schema's classification first), cut to about 50 cells. Escaped.
 */
export function personalNames(places: readonly PersonalPlace[]): string {
  const byName = new Map<string, { classes: string[]; where: string[] }>()
  for (const { field, where } of places) {
    const entry = byName.get(field.name) ?? { classes: [], where: [] }
    const classified = classifiedOf(field)
    if (classified !== undefined && !entry.classes.includes(esc(classified, 120))) entry.classes.push(esc(classified, 120))
    const path = where.map(part => esc(part, 120)).join('.')
    if (path !== '' && !entry.where.includes(path)) entry.where.push(path)
    byName.set(field.name, entry)
  }
  const text = [...byName].map(([name, { classes, where }]) => {
    const inside = [...classes, ...where]
    return inside.length === 0 ? esc(name, 120) : `${esc(name, 120)} (${classes.join(', ')}${classes.length > 0 && where.length > 0 ? ' \u00b7 ' : ''}${where.join(', ')})`
  }).join(', ')
  const cells = [...text]
  return cells.length > PERSONAL_MAX ? `${cells.slice(0, PERSONAL_MAX - 1).join('').trimEnd()}\u2026` : text
}

/** Why no field has a policy: what the policy check said, in the reader's words. */
function uncheckedNote(ir: CallIR): Note {
  const policy = ir.checks?.policy
  if (policy === 'skipped') return { glyph: GLYPH.unknown, text: 'access not checked', hint: 'no service in Agent Services claims it', isDim: true }
  return { glyph: GLYPH.unknown, text: 'access not checked', hint: 'allow Agent Services dry_run to check', isDim: true }
}

/** `names` joined, the first few only, then `+N` for the rest; the Note wraps what is left. */
export function listNames(names: readonly string[], count = SHOWN_NAMES): string {
  const shown = names.slice(0, count).join(', ')
  return names.length > count ? `${shown} +${names.length - count}` : shown
}
