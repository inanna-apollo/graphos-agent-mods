import test from 'node:test'
import assert from 'node:assert/strict'
import { gasServers, splitMcpTool } from '../../src/servers.ts'

const mcp = (name: string) => ({ name, mcp: true })
const full = (server: string) => ['execute', 'validate', 'introspect', 'dry_run'].map(tool => mcp(`mcp__${server}__${tool}`))

test('splits the real Agent Services connector name', () => {
  assert.deepEqual(splitMcpTool('mcp__claude_ai_GraphOS_Agent_Services__execute'), {
    server: 'claude_ai_GraphOS_Agent_Services',
    tool: 'execute',
  })
})

test('splits at the last __ when the server contains __', () => {
  assert.deepEqual(splitMcpTool('mcp__my__server__dry_run'), { server: 'my__server', tool: 'dry_run' })
})

test('non-mcp names do not split', () => {
  for (const name of ['Bash', 'execute', 'mcp_a__b', 'xmcp__a__b', '', 'MCP__a__b']) {
    assert.equal(splitMcpTool(name), undefined, name)
  }
})

test('degenerate mcp names do not split', () => {
  for (const name of ['mcp__', 'mcp____', 'mcp____execute', 'mcp__server', 'mcp__server__', 'mcp______']) {
    assert.equal(splitMcpTool(name), undefined, name)
  }
})

test('gasServers finds a server with the full set', () => {
  assert.deepEqual([...gasServers(full('gas'))], ['gas'])
})

test('gasServers ignores extra tools and non-mcp tools', () => {
  const tools = [...full('gas'), mcp('mcp__gas__search'), { name: 'Bash', mcp: false }]
  assert.deepEqual([...gasServers(tools)], ['gas'])
})

test('gasServers rejects a partial set', () => {
  const tools = full('gas').filter(tool => !tool.name.endsWith('__dry_run'))
  assert.equal(gasServers(tools).size, 0)
})

test('gasServers ignores tools with mcp: false', () => {
  const tools = full('gas').map(tool => ({ ...tool, mcp: false }))
  assert.equal(gasServers(tools).size, 0)
  const oneBuiltin = full('gas').map((tool, i) => (i === 0 ? { ...tool, mcp: false } : tool))
  assert.equal(gasServers(oneBuiltin).size, 0)
})

test('gasServers handles two servers independently', () => {
  const partial = full('other').slice(0, 3)
  assert.deepEqual([...gasServers([...full('a'), ...partial, ...full('b__c')])].sort(), ['a', 'b__c'])
})

test('tools of different servers are not pooled', () => {
  const tools = [mcp('mcp__a__execute'), mcp('mcp__a__validate'), mcp('mcp__b__introspect'), mcp('mcp__b__dry_run')]
  assert.equal(gasServers(tools).size, 0)
})

test('gasServers of nothing is empty', () => {
  assert.equal(gasServers([]).size, 0)
})
