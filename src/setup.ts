// What `/gas setup` reports: only what is left to do, as numbered steps, or one
// line saying it is ready. Pure: no $. The hook gathers the facts (the engine's
// version, the tool list, the permission checks, the link sources, the trust
// rules); this words them. Where each site comes from is /gas links's to say.

import { escapeText } from './escape.ts'
import type { BaseSource } from './links.ts'
import { learnable } from './sites.ts'
import type { GraphSites, Sites } from './sites.ts'
import { MIN_CLAUDE_CODE, isOlder, versionNote } from './version.ts'

/**
 * What the permission check answered for one tool: `allow` (and not capped by
 * the person's organization), `ask`, `deny`, or `capped` (allowed, but the
 * organization's policy stands above it).
 */
export type ToolState = 'allow' | 'ask' | 'deny' | 'capped'

export type SetupFacts = {
  /** `$.session.version()`; undefined when this engine has no such call (the mod loads from 2.1.287). */
  version?: { version: string; base?: string }
  /** The Agent Services servers' names (src/servers.ts); undefined when the tool list could not be read. */
  servers?: readonly string[]
  /** The check's answer for each read-only tool of each server (the tools the mod calls, which change nothing). */
  tools: readonly { server: string; tool: string; state: ToolState }[]
  /** The bases' values and where each comes from, as links.toml and the options set them. */
  bases: Readonly<Record<string, string>>
  sources: Readonly<Record<string, BaseSource>>
  /** Where the person's links.toml goes. */
  linksFile?: string
  /** Which sites the graph's services can show and the setup question can find (src/sites.ts sitesOfGraph); undefined when `search` could not be called. */
  graph?: GraphSites
  /** What was done about the unset sites the question can find: drafted into the prompt box, or why not. Absent when nothing was tried. */
  draft?: { isDrafted: true } | { isDrafted: false; why: string }
  trust: { count: number; isOff: boolean; isFileChanged: boolean; file?: string; example: string }
}

const server = (name: string) => escapeText(name, 200).text
const list = (names: readonly string[]) => (names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`)

/** One step: its first line, then the lines under it. */
type Step = string[]

export const READY = 'GraphOS Inspector is ready. Ask Claude for anything from GraphOS Agent Services; the pane opens on a wide terminal, or with /gas.'

function versionSteps(version: SetupFacts['version']): Step[] {
  if (version === undefined) return [[`Check that Claude Code is ${MIN_CLAUDE_CODE} or later (\`claude --version\`; \`claude update\` brings it up to date): its version could not be read here.`]]
  const note = versionNote(version.base, 'GraphOS Agent Mods')
  if (note !== undefined) return [[`Update Claude Code: ${note}`]]
  // Skip the release comparison for development builds.
  return version.base !== undefined && isOlder(version.base, MIN_CLAUDE_CODE) === true ? [[`Update Claude Code to ${MIN_CLAUDE_CODE} or later (\`claude update\`).`]] : []
}

function connectorSteps(servers: SetupFacts['servers']): Step[] {
  if (servers === undefined) return [['Check the GraphOS Agent Services connector: Claude Code could not list its tools just now. Run /mcp to see whether it is connected, then /gas setup again.']]
  if (servers.length > 0) return []
  return [[
    'Connect GraphOS Agent Services: add the "GraphOS Agent Services" connector at claude.ai (Settings, then Connectors) and sign in to it. Claude Code must be signed in to the same claude.ai account (/login); /mcp then lists it. Then run /gas setup again.',
    'This mod requires GraphOS Agent Services. The open-source Apollo MCP Server does not provide the required Agent Services tools.',
  ]]
}

function permissionSteps(facts: SetupFacts): { steps: Step[]; notes: string[] } {
  const steps: Step[] = []
  const notes: string[] = []
  const servers = facts.servers ?? []
  for (const name of servers) {
    const own = facts.tools.filter(one => one.server === name)
    const asks = own.filter(one => one.state === 'ask').map(one => one.tool)
    const denied = own.filter(one => one.state === 'deny').map(one => one.tool)
    const capped = own.filter(one => one.state === 'capped').map(one => one.tool)
    const label = servers.length > 1 ? ` on ${server(name)}` : ''
    if (asks.length > 0) {
      steps.push([
        `Allow Agent Services' read-only ${asks.length === 1 ? 'tool' : 'tools'}${label} (${list(asks)}), so the pane can check access, schema and validity without asking you. None of them changes data. Run /permissions, open the Allow tab, choose Add a new rule, and add ${asks.length === 1 ? 'this line' : 'each line'}:`,
        ...asks.map(tool => `  mcp__${server(name)}__${tool}`),
        'Then run /gas setup again.',
      ])
    }
    if (denied.length > 0) steps.push([`Remove the deny rule for ${list(denied)}${label} (yours or your organization's) if you want the pane to use ${denied.length === 1 ? 'it' : 'them'}; an allow rule cannot override a deny.`])
    if (capped.length > 0) notes.push(`Your organization's policy limits ${list(capped)}${label}, which a rule of yours cannot widen.`)
  }
  return { steps, notes }
}

const SITE_NAME: Readonly<Record<keyof Sites, string>> = { atlassian: 'Jira and Confluence', slack: 'Slack' }

/** The read-only question that finds the sites, when one was drafted (or could not be). Every other site is learned from the first response that shows it. */
function siteSteps(facts: SetupFacts): Step[] {
  const graph = facts.graph
  if (graph === undefined || facts.draft === undefined) return []
  const asked = learnable(facts.sources).filter(site => graph.shown.includes(site) && graph.askable.includes(site))
  if (asked.length === 0) return []
  const names = asked.length > 1 ? 'Jira, Confluence and Slack' : SITE_NAME[asked[0] ?? 'atlassian']
  if (facts.draft.isDrafted) return [[`Send the read-only question in your prompt box to configure links for ${names} records on your ${asked.length === 1 && asked[0] === 'slack' ? 'workspace' : 'sites'}. Agent Services' response supplies the site URL.`]]
  return [[`Run /gas setup again: the read-only question that finds your ${names} ${asked.length === 1 && asked[0] === 'slack' ? 'workspace' : 'sites'} could not be put in your prompt box (${facts.draft.why}).`]]
}

function trustNotes(trust: SetupFacts['trust']): string[] {
  const where = trust.file === undefined ? 'trust.graphql' : trust.file
  const out = trust.count === 0 ? [] : [`Trust rules: ${trust.count} loaded${trust.isOff ? ', switched off for this session (/gas trust on)' : ''}; /gas trust lists them.`]
  if (trust.isFileChanged) out.push(`${where} was saved since the rules were read: run /gas trust to load it.`)
  return out
}

/** The whole report, for the person to read: the steps left, else that it is ready. */
export function setupReport(facts: SetupFacts): string {
  const connector = connectorSteps(facts.servers)
  // Nothing past the connector can be checked without one.
  const permissions = connector.length === 0 ? permissionSteps(facts) : { steps: [], notes: [] }
  const steps = [...versionSteps(facts.version), ...connector, ...permissions.steps, ...(connector.length === 0 ? siteSteps(facts) : [])]
  const notes = [...permissions.notes, ...trustNotes(facts.trust)]
  if (steps.length === 0) return [READY, ...notes].join('\n')
  const numbered = steps.flatMap((step, index) => [`${index + 1}. ${step[0] ?? ''}`, ...step.slice(1).map(line => `   ${line}`)])
  return [`GraphOS Inspector setup: ${steps.length === 1 ? 'one step' : `${steps.length} steps`} left.`, '', ...numbered, ...(notes.length === 0 ? [] : ['', ...notes])].join('\n')
}
