// Opening a link in the system browser: the decision, pure. Only a canonical
// https URL on a host the person configured is ever handed to the opener, as an
// argument vector (never a shell). The host call itself lives in hooks/register.tsx.
import { openableUrl } from './links.ts'
import type { LinkConfig } from './links.ts'

export const OPEN_TIMEOUT_MS = 5000

/** The opener command for a `uname -s`, or undefined (Windows and the rest are skipped). */
export function openerFor(uname: string): readonly string[] | undefined {
  const name = uname.trim()
  if (name === 'Darwin') return ['open']
  if (name === 'Linux') return ['xdg-open']
  return undefined
}

/** The argv that opens `url`, or why not. */
export function openArgv(url: unknown, config: LinkConfig, uname: string, fromGas: readonly string[] = []): { argv: readonly string[] } | { refused: string } {
  // Agent Services' own link to connect an account (UPSTREAM_AUTH_REQUIRED) is on Agent Services' host, never a configured base: it opens when it is exactly one the pane drew.
  const safe = openableUrl(url, config) ?? (typeof url === 'string' && fromGas.includes(url) ? canonicalHttps(url) : undefined)
  if (safe === undefined) return { refused: 'a link outside the configured hosts' }
  const command = openerFor(uname)
  return command === undefined ? { refused: 'no opener for this platform' } : { argv: [...command, safe] }
}

/** `url` when it is an https URL written exactly as it parses, with no credentials; else undefined. */
function canonicalHttps(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.href === url && parsed.username === '' && parsed.password === '' ? url : undefined
  } catch {
    return undefined
  }
}
