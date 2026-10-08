// Which MCP server is Agent Services. Pure: no $.
//
// The claude.ai GraphOS Agent Services connector, by its server name, and
// only while it exposes the whole Agent Services contract (execute,
// validate, introspect, dry_run). The hook matchers name the same server, so
// no other server's calls reach the mod at all: every MCP server's `execute`
// or `search` would otherwise pass through its hooks.

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
    if (server === CONNECTOR && GAS_TOOLS.every(tool => names.has(tool))) gas.add(server)
  }
  return gas
}
