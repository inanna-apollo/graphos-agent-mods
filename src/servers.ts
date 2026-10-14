// Which MCP server is Agent Services. Pure: no $.
//
// Terminal uses the connector's name; Desktop supplies its UUID in a separate
// connector inventory. Both must expose the Agent Services tool contract.

const PREFIX = 'mcp__'

/**
 * `mcp__claude_ai_GraphOS_Agent_Services__execute` → server and tool. The
 * server name may itself hold `__`, so split at the last one.
 */
export function splitMcpTool(name: string): { server: string; tool: string } | undefined {
  if (!name.startsWith(PREFIX)) return undefined
  const cut = name.lastIndexOf('__')
  const server = name.slice(PREFIX.length, cut)
  const tool = name.slice(cut + 2)
  return cut > PREFIX.length && server !== '' && tool !== '' ? { server, tool } : undefined
}

export const GAS_TOOLS = ['execute', 'validate', 'introspect', 'dry_run'] as const

/** The claude.ai connector's server name, as tool names spell it (`mcp__claude_ai_GraphOS_Agent_Services__execute`). The hook matchers in hooks/register.tsx spell it too. */
export const CONNECTOR = 'claude_ai_GraphOS_Agent_Services'

export function gasServers(tools: readonly { name: string; mcp: boolean }[], desktop: readonly string[] = []): Set<string> {
  const byServer = new Map<string, Set<string>>()
  for (const { name, mcp } of tools) {
    if (!mcp) continue
    const split = splitMcpTool(name)
    if (split === undefined) continue
    const names = byServer.get(split.server) ?? new Set<string>()
    names.add(split.tool)
    byServer.set(split.server, names)
  }
  const gas = new Set<string>()
  for (const [server, names] of byServer) {
    if ((server === CONNECTOR || desktop.includes(server)) && GAS_TOOLS.every(tool => names.has(tool))) gas.add(server)
  }
  return gas
}

/** Desktop publishes connector IDs separately from tool names. Never infer identity from a tool set. */
export function desktopGasServers(text: string): string[] {
  const body: unknown = JSON.parse(text)
  if (body === null || typeof body !== 'object' || !('servers' in body) || !Array.isArray(body.servers)) throw new Error('Invalid Desktop connector inventory')
  const rows = body.servers as unknown[]
  const ids = new Set<string>()
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const item = row as Record<string, unknown>
    if (item.name === 'GraphOS Agent Services' && item.kind === 'connector' && item.status === 'connected' && typeof item.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.id)) ids.add(item.id)
  }
  return [...ids]
}
