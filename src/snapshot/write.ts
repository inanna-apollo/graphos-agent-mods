// What to write for a snapshot of a call: the file names and bodies, with the
// per-session state (a folder and a sequence number per call, the last body
// per width, the file cap). Pure apart from that state. It never sees `$`
// (the engine only follows `$` into functions in hooks/register.tsx), so the
// hook does the writing, best effort, and never from the ui.render hook.

import type { InspectedCall, InspectorCalls } from '../../types'
import { CLOSED, viewOf } from '../view.tsx'
import { renderText, stubKit } from './text.ts'

/** Files written by hooks per session; a /gas snapshot is not counted. */
const MAX_FILES = 200

type Slot = { dir: string; seq: number }
const slots = new Map<string, Slot>()
const names = new Map<string, number>()
const lastBody = new Map<string, string>()
let written = 0

const safe = (text: string) => text.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'call'

function slotOf(call: InspectedCall): Slot {
  let slot = slots.get(call.id)
  if (slot === undefined) {
    const base = safe(call.ir.opName ?? call.ir.roots[0]?.name ?? 'call')
    const seen = (names.get(base) ?? 0) + 1
    names.set(base, seen)
    slot = { dir: seen === 1 ? base : `${base}-${seen}`, seq: 0 }
    slots.set(call.id, slot)
  }
  return slot
}

export const findCall = (state: InspectorCalls, id: string): InspectedCall | undefined =>
  [...state.queue, ...(state.last === null ? [] : [state.last]), ...state.history].find(one => one.id === id)

export type SnapshotFile = { name: string; cols: number; body: string }

/**
 * Renders `call` at each width: `<NN>-<stage>-<cols>.txt` under `dir`. A
 * rendering identical to the last one for that width is left out unless
 * `force`; undefined when there is nothing to write. Numbers the stage now,
 * so concurrent stages of one call keep their order.
 */
export function planSnapshots(opts: { call: InspectedCall; waiting: number; stage: string; widths: number[]; force?: boolean }): { dir: string; files: SnapshotFile[] } | undefined {
  const { call, stage, widths, force = false } = opts
  const slot = slotOf(call)
  const files: SnapshotFile[] = []
  for (const cols of widths) {
    if (!force && written + files.length >= MAX_FILES) break
    const body = renderText(viewOf(stubKit(), { call, waiting: opts.waiting }, cols, CLOSED, undefined, { surface: 'terminal' }), cols)
    const key = `${slot.dir}/${cols}`
    if (!force && lastBody.get(key) === body) continue
    lastBody.set(key, body)
    files.push({ name: '', cols, body })
  }
  if (files.length === 0) return undefined
  slot.seq += 1
  if (!force) written += files.length
  const seq = String(slot.seq).padStart(2, '0')
  for (const file of files) file.name = `${seq}-${safe(stage)}-${file.cols}.txt`
  return { dir: slot.dir, files }
}
