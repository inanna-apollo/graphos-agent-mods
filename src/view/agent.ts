// What the pane says about a call a subagent or a plugin made: that one did,
// and which (a subagent's type and the task it was given, a plugin's name).
// Claude's own calls in the main loop say nothing.
// The task is text a model wrote, so it is escaped when recorded and again
// when drawn, and bounded. Pure: no $.

import type { CallAgent } from '../ir.ts'
import { escapeText } from '../escape.ts'
import { esc } from './kit.ts'

/** Generous safety bounds, several times a realistic value: an agent id is a short token, a type a word or two, a task description a few words. */
const ID_MAX = 100
const TYPE_MAX = 100
const TASK_MAX = 500
const PLUGIN_MAX = 100

/** Whitespace laid flat, escaped, bounded. */
const tidy = (text: string, max: number) => escapeText(text.replace(/\s+/g, ' ').trim(), max).text

/**
 * The record a call keeps of its agent: the id tool.call carried, and a label
 * from what `$.agent.list()` knows (`Explore: find naming pages`), empty when
 * the list does not know the agent (yet).
 */
export function agentOf(id: string, info?: { type?: string; description?: string }): CallAgent {
  const type = tidy(info?.type ?? '', TYPE_MAX)
  const task = tidy(info?.description ?? '', TASK_MAX)
  return { id: tidy(id, ID_MAX), label: type === '' ? task : task === '' ? type : `${type}: ${task}` }
}

/** The plugin whose hook made a call (tool.call's `next.origin.plugin`), as a call keeps it: undefined for Claude's own (`engine`) and a surface's post (`client`). */
export function pluginOf(origin: string | undefined): string | undefined {
  if (origin === undefined || origin === 'engine' || origin === 'client') return undefined
  const name = tidy(origin, PLUGIN_MAX)
  return name === '' ? undefined : name
}

export type AgentLine = {
  /** `from subagent · Explore: find naming pages` or `from the acme-helper plugin`, escaped: the line under the trust line. */
  text: string
  /** The subagent's label alone, escaped: what the card says in full. */
  label: string
  /** The plugin that made the call, escaped, when one did. */
  plugin?: string
}

/** The pane's line for a call a subagent or a plugin made; undefined for Claude's own in the main loop. */
export function agentLineOf(agent: CallAgent | undefined): AgentLine | undefined {
  if (agent === undefined) return undefined
  const label = esc(agent.label.replace(/\s+/g, ' ').trim(), TYPE_MAX + TASK_MAX + 2)
  const plugin = esc((agent.plugin ?? '').replace(/\s+/g, ' ').trim(), PLUGIN_MAX)
  if (plugin !== '') return { text: `from the ${plugin} plugin${label === '' ? '' : ` · in subagent ${label}`}`, label, plugin }
  return { text: label === '' ? 'from subagent' : `from subagent · ${label}`, label }
}
