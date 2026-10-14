import type { InspectedCall } from '../../types'
import { completeArgFacts, completeFieldFacts } from './card-facts.ts'
import { checkFacts } from './checks.ts'
import { trustFacts } from './trust.ts'
import { esc, walk } from './kit.ts'
import { rawPages } from './raw-pages.ts'

export type Detail = { id: string; title: string; lines: string[] }

export function detailPage(call: InspectedCall, address: string): (Detail & { page: number; pages: number; baseId: string }) | undefined {
  const [baseId = 'all', at] = address.split('@page:')
  const detail = detailOf(call, baseId)
  if (detail === undefined) return undefined
  const pages = rawPages(detail.lines.join('\n'))
  const page = Math.max(0, Math.min(pages.length - 1, Number(at) || 0))
  return { ...detail, baseId, page, pages: pages.length, lines: (pages[page] ?? '').split('\n') }
}

/** Addresses refer to retained data in this call; they never fetch or reinterpret a response. */
export function detailOf(call: InspectedCall, id: string): Detail | undefined {
  if (id === 'checks') return { id, title: 'Inspection checks', lines: checkFacts(call) }
  if (id === 'trust') return { id, title: 'Trust rules · permission decision', lines: trustFacts(call.trust, call.status) }
  const facts = { isDeclared: call.tool === 'search' || call.tool === 'introspect', policyFacts: call.tool === undefined || call.tool === 'dry_run', ...(call.tool === undefined ? {} : { tool: call.tool }) }
  const fields = walk(call.ir.roots)
  const field = fields.find(one => id === `f:${one.path}` || id === `r:${one.path}`)
  if (field !== undefined) {
    return { id, title: esc(field.coordinate, Infinity), lines: completeFieldFacts(field, call.outcome, facts, call.ir.roots) }
  }
  for (const root of call.ir.roots) {
    const arg = root.args.find(one => id === `a:${root.path}.${one.name}`)
    if (arg !== undefined) return { id, title: esc(arg.name, Infinity), lines: completeArgFacts(arg, false, facts) }
    const omitted = root.omittedArgs?.find(one => id === `a:${root.path}.${one.name}`)
    if (omitted !== undefined) return { id, title: esc(omitted.name, Infinity), lines: completeArgFacts(omitted, true, facts) }
  }
  if (id.startsWith('member:')) {
    const at = Number(id.slice(7))
    const name = call.found?.members?.[at]
    if (name === undefined) return undefined
    const detail = call.found?.memberDetails?.[at]
    return { id, title: esc(name, Infinity), lines: [detail?.description === undefined ? 'No description supplied for this member.' : esc(detail.description, Number.MAX_SAFE_INTEGER), ...(detail?.deprecated === undefined ? [] : [`Deprecated: ${esc(detail.deprecated, Infinity)}`])] }
  }
  if (id !== 'all') return undefined
  return { id, title: 'Complete retained details', lines: [
    ...(call.found?.omissions ?? []).map(one => `Coverage: ${esc(one, Infinity)}`),
    ...checkFacts(call),
    ...fields.flatMap(one => [esc(one.coordinate, Infinity), ...completeFieldFacts(one, call.outcome, facts, call.ir.roots)]),
    ...(call.found?.members ?? []).flatMap((one, at) => [esc(one, Infinity), ...(detailOf(call, `member:${at}`)?.lines ?? [])]),
    ...(call.found?.requests ?? []).map(one => `${esc(one.scope, Infinity)}: ${one.error === undefined ? one.isDenied ? 'operation denied' : 'check answered' : esc(one.error, Infinity)}`),
    ...(call.agent === undefined ? [] : [`Agent: ${esc(call.agent.label, Infinity)}`]),
    ...trustFacts(call.trust, call.status),
  ] }
}

/** Why only an overview remains, in user terms rather than storage enum names. */
export function retentionReason(details: string): string {
  switch (details) {
    case 'oversize': return 'This call exceeded the retained-detail size limit.'
    case 'expired': case 'available': return 'The full details expired from this session’s history.'
    default: return 'The full details were not retained for this call.'
  }
}
