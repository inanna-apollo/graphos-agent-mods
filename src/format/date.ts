// ISO-8601 dates and timestamps, with a relative description from the mod's clock.
import { renderFallback } from './fallback.ts'
import { isTooLong, seg } from './types.ts'
import type { Rendered } from './types.ts'

const ISO =
  /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|z|[+-]\d{2}(?::?\d{2})?)?)?$/

export type ParsedDate = { ms: number; hasZone: boolean }

/** Strict parse: rejects impossible dates such as Feb 30. Zoneless timestamps count as UTC. */
export function parseIso(value: string): ParsedDate | undefined {
  const m = ISO.exec(value)
  if (m === null) return undefined
  const [, y, mo, d, h = '0', mi = '0', s = '0', frac = '', zone = ''] = m
  const [year, month, day, hour, minute, second] = [y, mo, d, h, mi, s].map(Number)
  if (
    year === undefined || month === undefined || day === undefined ||
    hour === undefined || minute === undefined || second === undefined
  ) return undefined
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return undefined
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  if (date.getUTCMonth() !== month - 1) return undefined
  date.setUTCHours(hour, minute, second, Number(frac.slice(0, 3).padEnd(3, '0')))
  let offset = 0
  if (zone !== '' && zone.toUpperCase() !== 'Z') {
    const digits = zone.slice(1).replace(':', '')
    const oh = Number(digits.slice(0, 2))
    const om = Number(digits.slice(2) || '0')
    if (oh > 23 || om > 59) return undefined
    offset = (oh * 60 + om) * 60_000 * (zone.startsWith('-') ? -1 : 1)
  }
  const ms = date.getTime() - offset
  return Number.isFinite(ms) ? { ms, hasZone: zone !== '' } : undefined
}

export const isIsoDate = (value: string): boolean => parseIso(value) !== undefined

const UNITS: [string, number][] = [
  ['year', 365 * 86_400_000],
  ['month', 30 * 86_400_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
]

function relative(diff: number): string {
  const abs = Math.abs(diff)
  for (const [name, size] of UNITS) {
    if (abs >= size) {
      const n = Math.floor(abs / size)
      const label = `${n} ${name}${n === 1 ? '' : 's'}`
      return diff >= 0 ? `in ${label}` : `${label} ago`
    }
  }
  return 'just now'
}

/** Line 1 is the value as sent; line 2 is how far it is from `now` (epoch ms). */
export function renderDate(value: string, now: number): Rendered {
  if (typeof value !== 'string' || isTooLong(value)) return renderFallback(value)
  const parsed = parseIso(value)
  if (parsed === undefined || !Number.isFinite(now)) return renderFallback(value)
  const note = relative(parsed.ms - now)
  const hasTime = /[Tt ]/.test(value)
  const zoneNote = hasTime && !parsed.hasZone ? ' (no timezone given, read as UTC)' : ''
  return {
    lines: [[seg(value, 'value')], [seg(`${note}${zoneNote}`, 'dim')]],
    isFallback: false,
  }
}
