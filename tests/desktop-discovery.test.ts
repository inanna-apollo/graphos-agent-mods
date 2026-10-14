import { expect, mock, test } from 'claude-code/testing'
import { observeCache, untilCache } from './cache-observer.ts'

const SERVER = '12345678-1234-1234-1234-123456789abc'
const SEARCH = `mcp__${SERVER}__search`
const STATUS = 'mcp__ccd_connectors__session_connectors_status'
declare module 'claude-code' {
  interface McpToolInputs {
    'mcp__12345678-1234-1234-1234-123456789abc__search': { terms: string[] }
  }
}

test('Desktop search is forwarded and its completed result reaches retained Inspector history', async ($, on) => {
  const clock = mock.clock(on)
  const observed = observeCache(on)
  let statusCalls = 0
  let searches = 0
  let id = ''
  let connectorName = 'Other connector'
  on('tool.list', () => ({ value: [...['execute', 'search', 'validate', 'introspect', 'dry_run'].map(tool => ({ name: `mcp__${SERVER}__${tool}`, description: '', mcp: true })), { name: STATUS, description: '', mcp: true }] }))
  on('tool.check', () => ({ decision: 'allow' as const }))
  on('tool.call', { tool: STATUS }, () => {
    statusCalls++
    return { result: [], text: JSON.stringify({ servers: [{ name: connectorName, kind: 'connector', status: 'connected', id: SERVER }] }) }
  })
  const answer = { result: { content: [{ type: 'text' as const, text: JSON.stringify({ bundleDigest: 'desktop', scopes: ['jira'], results: [] }) }], isError: false } }
  on('tool.call', { tool: SEARCH }, (_, e) => { searches++; id = e.tool_use_id; return answer })
  expect(await $.tool.call({ tool: SEARCH, terms: ['jira'] })).toEqual(answer)
  const unrelatedId = id
  await untilCache(clock, () => statusCalls > 0)
  // A fresh call must re-read identity after reconnect/rename, rather than pinning the first UUID result.
  connectorName = 'GraphOS Agent Services'
  expect(await $.tool.call({ tool: SEARCH, terms: ['jira'] })).toEqual(answer)
  expect(searches).toBe(2)
  await untilCache(clock, () => observed.models.some(call => call.id === id && call.status === 'ran'))
  expect(statusCalls).toBeGreaterThan(1)
  expect(observed.models.some(call => call.id === unrelatedId)).toBe(false)
  expect(observed.models.find(call => call.id === id)?.server).toBe(SERVER)
  expect(observed.models.find(call => call.id === id)?.tool).toBe('search')
})
