// After a write ran: what its response says back of the values the call set.
// Pure: no $. The mod cannot add fields to the model's selection, so this
// confirms only what the response happens to carry: a Confluence page's
// title and version, a Jira comment's body, a Slack message's text, the
// record a create made. Each value the call set is compared with the one the
// response returns at the same place (./changes.ts `back`), a body line by
// line once both are flattened. Kept small on the outcome: a few labels and
// short values, escaped, never the response itself.

import type { CallIR, CallOutcome, FieldIR } from '../ir.ts'
import { escapeText } from '../escape.ts'
import { isRecord } from '../guards.ts'
import { previewOf, shortValue } from './changes.ts'
import type { ChangeBlock } from './changes.ts'
import { flatten } from './flatten.ts'

export type Confirm = NonNullable<CallOutcome['confirms']>[number]

/** Confirmations kept per call, and a value's characters. */
export const MAX_CONFIRMS = 12
const VALUE_MAX = 120
/** A value short enough to say beside its label (`version 13`, `status Done`); a longer one is its label alone. */
const SAID_MAX = 32

const e = (text: string, max = VALUE_MAX) => escapeText(text, max).text.replace(/\s+/g, ' ').trim()

/**
 * The response keys of a path of real field names below a root (`version.number`
 * as the model aliased it), or undefined when the call did not select it. Inside
 * opaque JSON (a field with no selection) the keys are the response's own.
 */
function keysOf(root: FieldIR, path: string): string[] | undefined {
  const keys: string[] = []
  let node: FieldIR | undefined = root
  for (const name of path.split('.')) {
    if (node === undefined || node.children.length === 0) {
      keys.push(name)
      node = undefined
      continue
    }
    const child: FieldIR | undefined = node.children.find(one => one.name === name)
    if (child === undefined) return undefined
    keys.push(child.alias ?? child.name)
    node = child
  }
  return keys
}

function at(value: unknown, keys: readonly string[]): unknown {
  let here = value
  for (const key of keys) {
    if (!isRecord(here) || !Object.prototype.hasOwnProperty.call(here, key)) return undefined
    here = here[key]
  }
  return here
}

/** A body as the text a reader compares: its lines, whitespace laid flat. */
const bodyText = (value: unknown, format: Parameters<typeof flatten>[1]) =>
  flatten(value, format)
    .lines.map(line => line.text.replace(/\s+/g, ' ').trim())
    .filter(line => line !== '')
    .join('\n')

/** The id a create's response names the new record by: a Jira key, a Slack ts, an id. */
const NEW_KEYS = ['key', 'ts', 'id']

function createdOf(block: ChangeBlock, root: FieldIR, value: unknown): Confirm | undefined {
  for (const name of NEW_KEYS) {
    for (const path of [name, `message.${name}`]) {
      const keys = keysOf(root, path)
      const found = keys === undefined ? undefined : at(value, keys)
      if (typeof found === 'string' || typeof found === 'number') {
        const noun = block.section.replace(/^NEW /, '').toLowerCase()
        return { label: 'created', value: e(`${noun === 'creates' ? '' : `${noun} `}${found}`), state: 'new', path: [root.path, ...(keys ?? [])].join('.') }
      }
    }
  }
  return undefined
}

/**
 * What the response confirms of each write root's new values, in the
 * preview's row order: `same`, or `differs` with what came back; for a
 * create, the record it made (`new`). Empty for a read, or when the response
 * carries none of them.
 */
export function confirmOf(ir: CallIR, data: Record<string, unknown> | undefined): Confirm[] {
  if (data === undefined) return []
  try {
    const out: Confirm[] = []
    for (const block of previewOf(ir)?.blocks ?? []) {
      const root = ir.roots.find(one => one.path === block.path)
      const value = data[block.path]
      if (root === undefined || value === undefined || value === null) continue
      if (block.kind === 'create') {
        const made = createdOf(block, root, value)
        if (made !== undefined) out.push(made)
      }
      for (const row of block.rows) {
        if (row.back === undefined || row.isDim === true) continue
        const keys = keysOf(root, row.back.path)
        if (keys === undefined) continue
        const got = at(value, keys)
        if (got === undefined) continue
        const path = [block.path, ...keys].join('.')
        if (row.back.format !== undefined) {
          const isSame = bodyText(row.back.value, row.back.format) === bodyText(got, row.back.format)
          // A body that differs is not quoted: a service normalizes markup, and the card says so.
          out.push({ label: row.label, state: isSame ? 'same' : 'differs', path })
          continue
        }
        const sent = shortValue(row.back.value)
        const back = shortValue(got)
        const isSame = sent === back
        out.push({ label: row.label, state: isSame ? 'same' : 'differs', path, ...(isSame ? sent.length <= SAID_MAX && { value: e(sent) } : { value: e(back), sent: e(sent) }) })
      }
    }
    return out.slice(0, MAX_CONFIRMS)
  } catch {
    return []
  }
}

/** A confirmation in words: `version 13 ✓`, `title came back as Old`, `body came back different`, `created page 98765`. */
export function confirmText(one: Confirm): string {
  if (one.state === 'new') return `${one.label} ${one.value ?? ''}`.trim()
  if (one.state === 'differs') return one.value === undefined || one.value === '' ? `${one.label} came back different` : `${one.label} came back as ${one.value}`
  return `${one.label}${one.value === undefined ? '' : ` ${one.value}`} ✓`
}
