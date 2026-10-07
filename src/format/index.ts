// Entry point: draws one argument. Never throws; anything unexpected is plain text.
import type { ArgIR } from '../ir.ts'
import { renderCql } from './cql.ts'
import { renderDate } from './date.ts'
import { renderFallback } from './fallback.ts'
import { renderId } from './id.ts'
import { renderJql } from './jql.ts'
import { pickRenderer } from './pick.ts'
import { withRecordLinks } from './record-links.ts'
import type { LinkConfig } from '../links.ts'
import { isStructured, renderStructure } from './structure.ts'
import { renderSlack } from './slack.ts'
import { renderUrl } from './url.ts'
import type { Rendered } from './types.ts'

export type { Rendered, Segment, Tone } from './types.ts'
export { full, renderFallback } from './fallback.ts'
export { renderStructure } from './structure.ts'
export { pickRenderer } from './pick.ts'

export function renderArg(arg: ArgIR, rootField: string, now: number, links?: LinkConfig): Rendered {
  try {
    const renderer = arg.renderer ?? pickRenderer(arg, rootField)
    const { value } = arg
    const rendered = ((): Rendered => {
      switch (renderer) {
        case 'cql': return renderCql(value)
        case 'jql': return renderJql(value)
        case 'slack': return renderSlack(value)
        case 'id': return renderId(value)
        case 'url': return renderUrl(value)
        case 'date': return typeof value === 'string' ? renderDate(value, now) : renderFallback(value)
        default: return isStructured(value) ? renderStructure(value) : renderFallback(value)
      }
    })()
    return withRecordLinks(rendered, arg, renderer, rootField, links)
  } catch {
    try {
      return renderFallback(arg.value)
    } catch {
      return { lines: [[{ text: '[unprintable value]' }]], isFallback: true }
    }
  }
}
