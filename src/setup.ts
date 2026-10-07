// What `/gas setup` reports: one line of state and, where something is not
// done, the next step, for each thing the mod needs. Pure: no $. The hook
// gathers the facts (the engine's version, the tool list, the permission
// checks, the link sources, the trust rules); this words them.

import { escapeText } from './escape.ts'
import type { BaseSource } from './links.ts'
import { SITE_KEYS, describeBases, learnable } from './sites.ts'
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
const list = (names: readonly string[]) => names.join(', ')

function versionLines(version: SetupFacts['version']): string[] {
  if (version === undefined) return [`[to do] Claude Code: its version could not be read here. Run \`claude --version\`; it must be ${MIN_CLAUDE_CODE} or later (\`claude update\` brings it up to date).`]
  const note = versionNote(version.base, 'GraphOS Agent Mods')
  if (note !== undefined) return [`[to do] Claude Code ${version.version}: ${note}`]
  if (version.base !== undefined && isOlder(version.base, MIN_CLAUDE_CODE) === false) return [`[ok] Claude Code ${version.version} (${MIN_CLAUDE_CODE} or later is needed).`]
  return [`[ok] Claude Code ${version.version} is a development build, so it cannot be compared with ${MIN_CLAUDE_CODE}, the oldest release this was tested on.`]
}

function connectorLines(servers: SetupFacts['servers']): string[] {
  if (servers === undefined) return ['[to do] GraphOS Agent Services connector: Claude Code could not list its tools just now. Run /mcp to see whether the connector is connected, then run /gas setup again.']
  if (servers.length > 0) return [`[ok] GraphOS Agent Services connector: found${servers.length > 1 ? ` (${servers.length} servers)` : ''}.`]
  return [
    '[to do] GraphOS Agent Services connector: none found.',
    '  Add the "GraphOS Agent Services" connector at claude.ai (Settings, then Connectors) and sign in to it.',
    '  Claude Code must be signed in to the same claude.ai account (/login); /mcp should then list the connector as connected.',
    '  Then run /gas setup again. This mod works with GraphOS Agent Services only (a server that offers execute, validate, introspect and dry_run), not with the open-source Apollo MCP Server.',
  ]
}

function permissionLines(facts: SetupFacts): string[] {
  const servers = facts.servers ?? []
  if (servers.length === 0) return ['Read-only tools: checked once the connector is found.']
  const out: string[] = []
  for (const name of servers) {
    const own = facts.tools.filter(one => one.server === name)
    const allowed = own.filter(one => one.state === 'allow').map(one => one.tool)
    const asks = own.filter(one => one.state === 'ask').map(one => one.tool)
    const denied = own.filter(one => one.state === 'deny').map(one => one.tool)
    const capped = own.filter(one => one.state === 'capped').map(one => one.tool)
    const label = servers.length > 1 ? ` for ${server(name)}` : ''
    if (own.length > 0 && allowed.length === own.length) {
      out.push(`[ok] Read-only tools${label}: all ${own.length} are allowed, so the pane can check access, schema and validity without asking you.`)
      continue
    }
    out.push(`[to do] Read-only tools${label}: ${allowed.length === 0 ? 'none is allowed yet' : `${list(allowed)} ${allowed.length === 1 ? 'is' : 'are'} allowed`}. Without them the pane still shows the parsed call, with access marked as not checked. None of them changes data.`)
    if (asks.length > 0) {
      out.push(`  Allow ${list(asks)} with /permissions (the Allow tab, Add a new rule) or under permissions.allow in your settings, one line each:`)
      for (const tool of asks) out.push(`    mcp__${server(name)}__${tool}`)
    }
    if (denied.length > 0) out.push(`  ${list(denied)} ${denied.length === 1 ? 'is' : 'are'} denied by a deny rule of yours or your organization's; an allow rule cannot override it, so remove the deny rule if you want the mod to use ${denied.length === 1 ? 'it' : 'them'}.`)
    if (capped.length > 0) out.push(`  ${list(capped)} ${capped.length === 1 ? 'is' : 'are'} limited by your organization's policy, which a rule of yours cannot widen.`)
  }
  return out
}

const SITE_NAME: Readonly<Record<keyof Sites, string>> = { atlassian: 'Atlassian site', slack: 'Slack workspace' }
const SITE_SERVICES: Readonly<Record<keyof Sites, string>> = { atlassian: 'Jira or Confluence', slack: 'Slack' }

function siteLines(facts: SetupFacts): string[] {
  const unset = learnable(facts.sources)
  const graph = facts.graph
  // A site whose service the graph does not have has nothing to link: a fact, not a step.
  const absent = graph === undefined ? [] : unset.filter(site => !graph.shown.includes(site))
  const own = Object.fromEntries(SITE_KEYS.filter(site => !absent.includes(site)).map(site => [site, facts.bases[site] ?? '']))
  const out = ['Record links (where a record key in the pane opens):', ...describeBases(own, facts.sources, facts.linksFile)]
  for (const site of absent) out.push(`  ${site}: not needed, your graph has no ${SITE_SERVICES[site]} service.`)
  const wanted = unset.filter(site => !absent.includes(site))
  if (wanted.length === 0) return out
  const named = (sites: readonly (keyof Sites)[]) => sites.map(site => SITE_NAME[site]).join(' and ')
  const them = (sites: readonly unknown[]) => (sites.length === 1 ? 'it' : 'them')
  const isAre = (sites: readonly unknown[]) => (sites.length === 1 ? 'is' : 'are')
  if (facts.servers === undefined || facts.servers.length === 0) {
    out.push(`[to do] Your ${named(wanted)} ${isAre(wanted)} not set. Connect GraphOS Agent Services first (above) and run /gas setup again, or set ${them(wanted)} as above. Any Agent Services response that shows ${them(wanted)} teaches ${them(wanted)} too.`)
    return out
  }
  if (graph === undefined) {
    out.push(`[to do] Your ${named(wanted)} ${isAre(wanted)} not set. Once search is allowed (above), /gas setup checks which your graph has and drafts the question that finds ${them(wanted)}. Any Agent Services response that shows ${them(wanted)} teaches ${them(wanted)} too, or set ${them(wanted)} as above.`)
    return out
  }
  const asked = wanted.filter(site => graph.askable.includes(site))
  const unasked = wanted.filter(site => !asked.includes(site))
  if (asked.length > 0 && facts.draft?.isDrafted === true) {
    out.push(`[to do] Your ${named(asked)} ${isAre(asked)} not set. A question is drafted in your prompt box: read it and send it. It asks Agent Services ${asked.length === 1 ? 'a read-only query' : 'read-only queries'} whose answer shows the site; the mod learns it from that answer, not from what Claude says.`)
  } else if (asked.length > 0 && facts.draft !== undefined && facts.draft.isDrafted === false) {
    out.push(`[to do] Your ${named(asked)} ${isAre(asked)} not set, and the question that would find ${them(asked)} could not be drafted into the prompt box (${facts.draft.why}). Run /gas setup again, or set ${them(asked)} as above.`)
  }
  if (unasked.length > 0) out.push(`[to do] Your ${named(unasked)} ${isAre(unasked)} not set. The first Agent Services response that shows ${them(unasked)} teaches ${them(unasked)}, or set ${them(unasked)} as above.`)
  return out
}

function trustLines(trust: SetupFacts['trust']): string[] {
  const where = trust.file === undefined ? 'your trust.graphql' : trust.file
  if (trust.count === 0) {
    return [`[ok] Trust rules (optional): none, so every Agent Services call asks you, as it does without this mod. To let reads you always approve run without a dialog, copy what you want from ${trust.example} to ${where} and run /gas trust.`]
  }
  const out = [`[ok] Trust rules (optional): ${trust.count} loaded${trust.isOff ? ', switched off for this session (/gas trust on)' : ''}. /gas trust lists them; ${trust.example} has commented examples.`]
  if (trust.isFileChanged) out.push(`  ${where} was saved since the rules were read: run /gas trust to load it.`)
  return out
}

/** The whole report, for the person to read. */
export function setupReport(facts: SetupFacts): string {
  return [
    'GraphOS Agent Mods setup',
    ...versionLines(facts.version),
    ...connectorLines(facts.servers),
    ...permissionLines(facts),
    ...siteLines(facts),
    ...trustLines(facts.trust),
  ].join('\n')
}
