// The standing line under the prompt (`$.ui.status`): what the mod has done
// this session at a glance, `Agent Services · 5 calls · 212 KB read · 3 trust rules · 2 ran unasked`.
// Counts and our own words only, never anything a call or a response said.
// Nothing at all in a session with no Agent Services call and no trust rule. Pure: no $.

import { sizeText } from '../weight.ts'

/** What the line is made of. */
export type StatusFacts = {
  /** Agent Services execute calls this session, however each ended. */
  calls: number
  /** Calls that ran with no dialog because they fit a trust rule (their `trust.isAllowed`), counted once they ran. */
  unasked: number
  /** Bytes of the responses Claude read this session (a result Claude Code kept out of the context is not read). Absent counts as none. */
  bytes?: number
  /** Trust rules loaded. */
  rules: number
  /** `/gas trust off`: the rules are loaded but every call asks. */
  isTrustOff: boolean
  /** trust.graphql was saved since the rules were read: what is loaded stands until the person runs `/gas trust`. */
  isTrustFileChanged: boolean
}

const counted = (count: number, noun: string) => `${count.toLocaleString('en-US')} ${noun}${count === 1 ? '' : 's'}`

/** The line, or undefined for nothing to say (the status is then cleared). */
export function statusLine(facts: StatusFacts): string | undefined {
  const parts = [
    facts.calls > 0 ? counted(facts.calls, 'call') : '',
    (facts.bytes ?? 0) > 0 ? `${sizeText(facts.bytes ?? 0)} read` : '',
    facts.rules > 0 ? (facts.isTrustOff ? 'trust off' : counted(facts.rules, 'trust rule')) : '',
    facts.unasked > 0 ? `${facts.unasked.toLocaleString('en-US')} ran unasked` : '',
    facts.isTrustFileChanged ? 'trust.graphql changed · run /gas trust to reload' : '',
  ].filter(part => part !== '')
  return parts.length === 0 ? undefined : ['Agent Services', ...parts].join(' · ')
}
