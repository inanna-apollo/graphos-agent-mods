// Which MCP servers are Agent Services. Pure: no $.
//
// We never hard-code the connector's name: a server is Agent Services when it exposes
// the whole Agent Services contract (execute, validate, introspect, dry_run). That way
// the mod checks a call against the same server that will run it.

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

export function gasServers(tools: readonly { name: string; mcp: boolean }[]): Set<string> {
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
    if (GAS_TOOLS.every(tool => names.has(tool))) gas.add(server)
  }
  return gas
}
