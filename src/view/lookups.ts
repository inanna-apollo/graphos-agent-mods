import type { InspectedCall } from '../../types'
import type { PaneUi } from './kit.ts'
import { esc, summaryOfDescription } from './kit.ts'
import { cardId, cellWidth, wrapLines } from './plan.ts'
import { productOf } from './flags.ts'
import { detailPage } from './details.ts'

type LookupPart = { text: string; tone?: 'accent' | 'data' | 'quiet'; bold?: boolean }
export type LookupLine = { text: string; parts?: LookupPart[]; indent?: number; detailId?: string; targetDetailId?: string; expand?: 'more' | 'less'; bold?: boolean; dim?: boolean }
export type LookupBodyPlan = { lines: (LookupLine & { rows: string[]; rowParts: LookupPart[][] })[]; rows: number; anchors: Map<string, { row: number; rows: number }> }

export { countText } from './checks.ts'
import { countText } from './checks.ts'

/** Tool-specific schema content. Display cuts keep the observed source counts beside them. */
export function lookupBody(call: InspectedCall, ui: PaneUi, width: number, start: number): LookupBodyPlan | undefined {
  if (call.tool !== 'search' && call.tool !== 'introspect') return undefined
  const lines: LookupLine[] = []
  const found = call.found
  const selected = ui.detail?.callId === call.id ? detailPage(call, ui.detail.detailId) : undefined
  const selectedId = selected?.baseId
  const selectedMember = selectedId?.startsWith('member:') ? Number(selectedId.slice(7)) : -1
  const selectedField = call.ir.roots[0]?.children.findIndex(field => cardId.field(field.path) === selectedId) ?? -1
  const selectedCandidate = call.ir.roots.findIndex(root => cardId.field(root.path) === selectedId)
  const expanded = ui.detail?.callId === call.id && (ui.detail.detailId === 'lookup:all' || selectedMember >= 12 || selectedField >= 12 || (call.tool === 'search' && selectedCandidate >= 5))
  const add = (text: string, extra: Omit<LookupLine, 'text'> = {}) => {
    lines.push({ text, ...extra })
    if (extra.detailId === undefined || selected?.baseId !== extra.detailId) return
    lines.push({ text: selected.title, bold: true })
    for (const line of selected.lines) lines.push({ text: line })
    if (selected.pages > 1) lines.push({ text: `Detail page ${selected.page + 1} of ${selected.pages}`, dim: true })
    if (selected.page > 0) lines.push({ text: 'Previous detail page', targetDetailId: `${selected.baseId}@page:${selected.page - 1}` })
    if (selected.page + 1 < selected.pages) lines.push({ text: 'Next detail page', targetDetailId: `${selected.baseId}@page:${selected.page + 1}` })
  }
  const section = (label: string, name: string, extra: Omit<LookupLine, 'text'> = {}, context?: string) => {
    const parts: LookupPart[] = [{ text: '┃ ', tone: 'accent' }, { text: `${label}  `, bold: true }, { text: name, bold: true }, ...(context === undefined ? [] : [{ text: ` · ${context}`, tone: 'data' as const }])]
    add(parts.map(part => part.text).join(''), { ...extra, parts })
  }
  const fact = (label: string, value: string, extra: Omit<LookupLine, 'text'> = {}, quietLabel = false, gutter = 14) => {
    // Long identifiers stack instead of squeezing their type to a few cells.
    const stacked = cellWidth(label) > gutter || width < 36
    const valueIndent = Math.min(stacked ? 4 : gutter + 4, Math.max(0, width - 1))
    const values = wrapLines(value, Math.max(1, width - valueIndent))
    const parts: LookupPart[] = [{ text: `  ${label}${stacked ? '\n' : ' '.repeat(gutter - cellWidth(label) + 2)}`, ...(quietLabel && { tone: 'quiet' }) }]
    for (const [at, text] of values.entries()) {
      if (stacked || at > 0) parts.push({ text: `${at > 0 ? '\n' : ''}${' '.repeat(valueIndent)}` })
      parts.push({ text, tone: 'data' })
    }
    add(parts.map(part => part.text).join(''), { ...extra, parts })
  }
  if (found === undefined) add(call.status === 'pending' ? 'Waiting for schema discovery.' : 'No schema answer is available.', { dim: true })
  else if (call.tool === 'search') {
    const roots = call.ir.roots
    if ((call.input?.terms ?? []).length === 0 && found.scopes !== undefined) {
      section('SERVICES', 'Available services')
      for (const scope of found.scopes.slice(0, expanded ? Infinity : 12)) add(productOf(scope) ?? esc(scope), { indent: 2 })
      if (!expanded && found.scopes.length > 12) add(`Show ${found.scopes.length - 12} more services`, { expand: 'more' })
    }
    const shown = roots.slice(0, expanded ? Infinity : 5)
    const total = found.counts?.hits ?? (found.hits === undefined ? undefined : { kind: 'exact' as const, value: found.hits })
    if (shown.length < roots.length || total?.kind !== 'exact' || total.value > shown.length) add(`${shown.length} operations shown · ${countText(total, 'match')}`, { dim: true })
    for (const [at, root] of shown.entries()) {
      if (at > 0) add('')
      const required = (root.omittedArgs ?? []).filter(arg => arg.isRequired && arg.default === undefined)
      section(root.coordinate?.startsWith('Mutation.') ? 'WRITE' : 'READ', esc(root.name), { detailId: cardId.field(root.path) }, root.service === undefined ? undefined : productOf(root.service) ?? esc(root.service))
      add(summaryOfDescription(root.schema?.description) ?? 'Purpose not supplied in the available schema.', { dim: true, indent: 2 })
      fact('requires', required.length === 0 ? root.schema === undefined ? 'unavailable' : 'none declared' : required.map(arg => `${esc(arg.name)}: ${esc(arg.type)}`).join(' · '), {}, true)
      fact('returns', root.schema === undefined ? 'type unavailable' : esc(root.schema.type), {}, true)
    }
    if (!expanded && roots.length > 5) add(`Show ${roots.length - 5} more operations`, { expand: 'more' })
  } else {
    const kind = found.typeKind
    if (kind === 'unavailable' || (kind === undefined && found.members === undefined)) add('The type declaration is unavailable; absence is not confirmed.', { dim: true })
    else if (kind === 'absent') add('The complete response declares no visible type by this name.', { dim: true })
    else {
      const root = call.ir.roots[0]
      const declaration = kind === undefined ? 'Stored members · declaration kind unavailable' : `Declared ${kind === 'input' ? 'input object' : kind}`
      section(kind === 'enum' ? 'VALUES' : kind === 'union' ? 'TYPES' : kind === 'scalar' ? 'SCALAR' : 'FIELDS', declaration)
      const purpose = summaryOfDescription(root?.schema?.description)
      if (purpose !== undefined) add(purpose, { dim: true, indent: 2 })
      const members = found.members
      if (members !== undefined) {
        const shown = members.slice(0, expanded ? Infinity : 12)
        const total = found.counts?.members
        if (shown.length < members.length || (total !== undefined && (total.kind !== 'exact' || total.value > shown.length))) add(`${shown.length} members shown · ${countText(total ?? { kind: 'exact', value: members.length }, 'member')}`, { dim: true })
        const gutter = Math.min(16, Math.max(8, ...shown.map(member => cellWidth(member.split(':')[0] ?? member))))
        for (const [at, member] of shown.entries()) {
          const suffix = found.memberDetails?.[at]?.deprecated === undefined ? '' : ' · deprecated'
          const colon = kind === 'input' ? member.indexOf(':') : -1
          if (colon >= 0) fact(esc(member.slice(0, colon)), `${esc(member.slice(colon + 1).trim())}${suffix}`, { detailId: `member:${at}` }, false, gutter)
          else add(`${esc(member)}${suffix}`, { detailId: `member:${at}`, indent: 2, ...(kind === 'union' && { parts: [{ text: `${esc(member)}${suffix}`, tone: 'data' }] }) })
        }
        if (!expanded && members.length > 12) add(`Show ${members.length - 12} more members`, { expand: 'more' })
      } else if (kind === 'object' || kind === 'interface') {
        const fields = root?.children ?? []
        const shown = fields.slice(0, expanded ? Infinity : 12)
        const total = found.counts?.fields
        if (shown.length < fields.length || (total !== undefined && (total.kind !== 'exact' || total.value > shown.length))) add(`${shown.length} fields shown · ${countText(total, 'field')}`, { dim: true })
        const gutter = Math.min(16, Math.max(8, ...shown.map(field => cellWidth(field.name))))
        for (const field of shown) fact(esc(field.name), esc(field.schema?.type ?? '?'), { detailId: cardId.field(field.path) }, false, gutter)
        if (!expanded && fields.length > 12) add(`Show ${fields.length - 12} more fields`, { expand: 'more' })
      }
    }
  }
  for (const omission of found?.omissions ?? []) add(`Coverage: ${esc(omission)}`, { dim: true })
  if (expanded) add('Show fewer', { expand: 'less' })
  const anchors = new Map<string, { row: number; rows: number }>()
  let rows = 0
  const wrapped = lines.map(line => {
    const indent = Math.min(line.indent ?? 0, Math.max(0, width - 1))
    const source = line.parts ?? [{ text: line.text, ...(line.dim && { tone: 'quiet' as const }), ...(line.bold && { bold: true }) }]
    const one = wrapLines(line.text, Math.max(1, width - indent))
    let offset = 0
    const rowParts = one.map(row => {
      const start = line.text.indexOf(row, offset)
      const end = start + row.length
      offset = end
      let at = 0
      const parts: LookupPart[] = indent === 0 ? [] : [{ text: ' '.repeat(indent) }]
      for (const part of source) {
        const from = Math.max(start, at)
        const to = Math.min(end, at + part.text.length)
        if (to > from) parts.push({ ...part, text: part.text.slice(from - at, to - at) })
        at += part.text.length
      }
      // Native Text drops an empty child; an explicit space retains section gaps.
      return parts.length === 0 ? [{ text: ' ' }] : parts
    })
    if (line.detailId !== undefined) anchors.set(line.detailId, { row: start + rows, rows: one.length })
    rows += one.length
    return { ...line, rows: rowParts.map(parts => parts.map(part => part.text).join('')), rowParts }
  })
  return { lines: wrapped, rows, anchors }
}
