// Chooses a renderer by argument name and declared type only. Never by anything
// a model wrote; the value is consulted only for its shape.
import type { Renderer } from '../ir.ts'
import { isIsoDate } from './date.ts'

const JIRA_KEY = /^[A-Z][A-Z0-9]+-\d+$/

function isHttpUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

export function pickRenderer(arg: { name: string; type?: string; value: unknown }, rootField: string): Renderer | undefined {
  const { name, type, value } = arg
  if (name === 'cql') return 'cql'
  if (name === 'jql') return 'jql'
  if (rootField.startsWith('slack_') && name === 'query') return 'slack'
  if (
    (type !== undefined && /^ID!?$/.test(type.trim())) ||
    /(Id|ID)$/.test(name) ||
    ((name === 'id' || name === 'key') && typeof value === 'string' && JIRA_KEY.test(value))
  ) return 'id'
  if (isHttpUrl(value)) return 'url'
  if (typeof value === 'string' && isIsoDate(value)) return 'date'
  return undefined
}
