// http(s) URLs: scheme dim, host emphasized, userinfo as a warning. The segments
// concatenate to exactly the input. Anything odd falls back to plain text.
import { renderFallback } from './fallback.ts'
import { isTooLong, seg } from './types.ts'
import type { Rendered, Segment } from './types.ts'

const SCHEME = /^(https?:\/\/)/i
// Whitespace, controls and backslashes are where parsers disagree (URL() strips
// tabs and newlines and treats `\` as `/`), so such strings are not drawn as URLs.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\x00-\x20\x7f-\x9f\\]/

export function renderUrl(value: unknown): Rendered {
  if (typeof value !== 'string' || isTooLong(value) || UNSAFE.test(value)) return renderFallback(value)
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return renderFallback(value)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return renderFallback(value)
  const scheme = SCHEME.exec(value)?.[1]
  if (scheme === undefined) return renderFallback(value)

  const afterScheme = value.slice(scheme.length)
  const authorityEnd = afterScheme.search(/[/?#]/)
  const authority = authorityEnd < 0 ? afterScheme : afterScheme.slice(0, authorityEnd)
  const tail = authorityEnd < 0 ? '' : afterScheme.slice(authorityEnd)
  const at = authority.lastIndexOf('@')
  const userinfo = at < 0 ? '' : authority.slice(0, at + 1)
  const hostPort = authority.slice(at + 1)
  const portMatch = /:\d*$/.exec(hostPort)
  const port = portMatch === null ? '' : portMatch[0]
  const host = port === '' ? hostPort : hostPort.slice(0, -port.length)

  const isInternational = /[^\x00-\x7f]/.test(host) || /(^|\.)xn--/i.test(host)
  // The host we show must be the host the URL parser will use.
  if (!isInternational && host.toLowerCase() !== parsed.hostname) return renderFallback(value)
  if (host === '') return renderFallback(value)

  const line: Segment[] = [seg(scheme, 'dim')]
  if (userinfo !== '') line.push(seg(userinfo, 'warn'))
  line.push(seg(host, 'emph'))
  if (port !== '') line.push(seg(port, 'dim'))
  if (tail !== '') line.push(seg(tail, 'dim'))
  const lines = [line]
  if (isInternational) lines.push([seg(`internationalized host: ${parsed.hostname}`, 'warn')])
  return { lines, isFallback: false }
}
