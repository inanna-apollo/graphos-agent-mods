// The flags line under the summary: the call's surprises and risks, most
// important first, computed from the IR and the outcome (never from the
// summary). Pure: no $. Each flag says the consequence (`email denied for 4
// members`); the field's own facts (`✕ email  denied · pii.contact`) are on
// its name in the return tree, so the two never say the same thing.

import { policyUnits } from '../annotate.ts'
import { provisionalService } from '../build.ts'
import { own } from '../guards.ts'
import type { CallIR, CallOutcome, FieldIR } from '../ir.ts'
import { isDestructiveName, isWriteName } from '../risk.ts'
import { esc, humanPlural, humanType, walk } from './kit.ts'
import type { RequestItem } from './kit.ts'
import { grouped, overLimit, ownerOf } from './outcome.ts'
import { held, receiptOf } from './receipt.ts'
import { sizeText, tokensText } from '../weight.ts'
import { previewFlags, previewOf } from '../preview/changes.ts'
import { classificationOf } from '../attention.ts'

export type Flag = {
  /** Short, escaped: what the line says. */
  text: string
  /** The flag in full, escaped: what its hover card says. */
  detail: string
  /** What it is about, for its color: a policy, a write, or neither. */
  tone: 'deny' | 'mask' | 'write' | 'warn'
  /**
   * The execute response itself carried a denial token (never dry_run's: the
   * agent does not see that one) and the denial is requestable, so Agent Services takes
   * it as an access request. `text` leaves out `access request can be filed`,
   * which flagsText adds back unless the pane draws its own button (`a: draft
   * access request`); `what` is what the request is for (`email` on customer
   * data members), for the draft.
   */
  request?: RequestItem
}

/** The flag a mutation carries when no CHANGES block says what it writes, and no root sounds destructive. */
export const WRITES_DATA = 'writes data'

/** What a denial with a token lets the person do, said where nothing can be pressed. */
export const REQUEST_TEXT = 'access request can be filed'

/** A service as the reader names its product: `jira` → Jira, `incidentio` → incident.io. */
const PRODUCTS: Record<string, string> = {
  jira: 'Jira',
  confluence: 'Confluence',
  incidentio: 'incident.io',
  slack: 'Slack',
  glean: 'Glean',
  github: 'GitHub',
  pagerduty: 'PagerDuty',
}

/** A product's name, else its scope read as words in sentence case (`acme-customer-data` → `Acme customer data`). */
export function productOf(service: string | undefined): string | undefined {
  if (service === undefined || service === '') return undefined
  const product = own(PRODUCTS, service)
  if (product !== undefined) return product
  const words = esc(service.replace(/[-_]+/g, ' ').trim(), 120)
  return words === '' ? undefined : `${words.charAt(0).toUpperCase()}${words.slice(1)}`
}

/** A root's service: the scope it was checked against, else its own name's prefix (a root no scope claimed); never another root's. */
export const rootService = (root: FieldIR): string | undefined => root.service ?? provisionalService(root.name)

/** Every service the call touches, each once, in the order its roots appear. */
export function servicesOf(ir: CallIR): string[] {
  if (ir.services !== undefined && ir.services.length > 0) return ir.services
  const named = [...new Set(ir.roots.flatMap(root => rootService(root) ?? []))]
  return named.length > 0 || ir.service === undefined ? named : [ir.service]
}

/**
 * `members.email` by the names the reader sees: the root's alias, then real
 * names below it. An unaliased root's own (long) name is left out unless the
 * field is the root itself. A name alone is a field the pane has no node for.
 */
function pathOf(root: FieldIR, field: FieldIR | string): string {
  const trail: string[] = []
  const find = (node: FieldIR, at: string[]): boolean => {
    if (node === field) {
      trail.push(...at)
      return true
    }
    return node.children.some(child => find(child, [...at, child.name]))
  }
  if (typeof field === 'string') trail.push(field)
  else find(root, [])
  return esc([root.alias ?? (trail.length > 0 ? '' : root.name), ...trail].filter(Boolean).join('.'), 240)
}

/**
 * The noun for the items of the list a denial counts rows of (`members`),
 * when the schema says. `listPath` is that list's path, the root's own or one
 * inside it; with none, the root's list or its first list child.
 */
function nounOf(root: FieldIR, count: number, scope: string | undefined, listPath?: string): string | undefined {
  const list = listPath === undefined ? undefined : walk([root]).find(field => field.path === listPath)
  const type =
    listPath !== undefined
      ? list?.schema?.isList === true ? list.schema.type : undefined
      : root.schema?.isList === true ? root.schema.type : root.children.find(child => child.schema?.isList === true)?.schema?.type
  return type === undefined ? undefined : esc(humanPlural(humanType(type, root.service ?? scope), count), 120)
}

/**
 * What Agent Services denied of `name` under `root` once the call ran: in how many
 * distinct rows (the outcome's tally; undefined when the root is not a list,
 * or the outcome kept none), and what the denials said, from its errors and
 * the rows it shows.
 */
function deniedIn(outcome: CallOutcome, root: FieldIR, name: string) {
  const tally = outcome.denials?.find(one => one.root === root.path && one.field === name)
  const errors = outcome.errors.filter(error => error.isDenied === true && error.field === name && (error.path === undefined || error.path.split('.')[0] === root.path))
  const lists = (outcome.preview ?? []).filter(list => ownerOf([root], list) !== undefined)
  const tags = lists.flatMap(list => list.items.flatMap(item => (item.denied ?? []).filter(one => one.field === name || one.field.endsWith(`.${name}`))))
  const all = [...errors, ...tags]
  return {
    rows: tally?.rows,
    list: tally?.list,
    // A denial that said it is not requestable means a request for the field would be refused.
    isRequestable: all.some(one => one.isRequestable === true) && !all.some(one => one.isRequestable === false),
    isPrivate: all.some(one => one.isRequestable === false),
    hasToken: all.some(one => one.hasToken === true),
    classification: all.find(one => one.classification !== undefined)?.classification,
    // What the denial token said of the field, for the request's draft: the tally's, else a listed error's.
    coord: tally?.coord ?? errors.find(one => one.coord !== undefined)?.coord,
    service: tally?.service ?? errors.find(one => one.service !== undefined)?.service,
    reason: tally?.reason ?? errors.find(one => one.reason !== undefined)?.reason,
  }
}

/** Why a background check failed, in a few plain words; undefined for an error with no known cause (the card has it). */
const NOT_ALLOWED = 'the read-only tools are not allowed'

export function checkFailureWords(error: string | undefined): string | undefined {
  if (error === undefined || error === '') return undefined
  if (/doesn't want to proceed|rejected|refused|interrupt|abort|cancel/i.test(error)) return 'the call was stopped'
  if (/not allowed without a prompt|permission/i.test(error)) return NOT_ALLOWED
  if (/time(d)? ?out|no answer/i.test(error)) return 'no answer in time'
  if (/sign.?in|auth/i.test(error)) return 'a sign-in is needed'
  return undefined
}

/** Without a token the person can still ask for access, but nothing here can file it. */
const requestable = (isRequestable: boolean) => (isRequestable ? 'access requestable' : undefined)

/** `email` on customer data members: a denied field and whose it is, for an access request's draft. */
function requestWhat(root: FieldIR, field: FieldIR | string, noun: string | undefined): string {
  const product = productOf(rootService(root))
  const whose = [product, noun ?? pathOf(root, field).split('.').slice(0, -1).join('.')].filter(Boolean).join(' ')
  return `\`${esc(typeof field === 'string' ? field : field.name, 120)}\`${whose === '' ? '' : ` on ${whose}`}`
}

/** A denied field once the call ran: how many rows it cost, and whether a request can be filed for it. */
function deniedFlag(ir: CallIR, outcome: CallOutcome, root: FieldIR, field: FieldIR | string): Flag {
  const name = esc(typeof field === 'string' ? field : field.name, 120)
  const got = deniedIn(outcome, root, typeof field === 'string' ? field : field.name)
  const noun = got.rows === undefined ? undefined : nounOf(root, got.rows, ir.service, got.list)
  // Only a token the execute response itself carried can be filed; and not for a denial that said it is not requestable.
  const canFile = got.hasToken && !got.isPrivate
  const how = canFile ? REQUEST_TEXT : requestable(got.isRequestable)
  const text = got.rows === undefined ? `${name} denied` : `${name} denied for ${grouped(got.rows)} ${noun ?? `row${got.rows === 1 ? '' : 's'}`}`
  // One classification, said as the cards say it: the schema's, else the one Agent Services gave the denial.
  const classification = typeof field === 'string' ? got.classification : (classificationOf(field, outcome) ?? got.classification)
  const detail = [
    `${pathOf(root, field)} denied by policy`,
    classification === undefined ? '' : `classified ${esc(classification, 40)}`,
    got.rows === undefined ? '' : `missing from ${grouped(got.rows)} ${noun ?? 'rows'}`,
    got.isPrivate ? 'not requestable' : (how ?? ''),
  ]
    .filter(Boolean)
    .join(' · ')
  const what = requestWhat(root, field, nounOf(root, 2, ir.service, got.list))
  const request: RequestItem = {
    what,
    ...(got.coord !== undefined && { coord: esc(got.coord, 200) }),
    ...(got.service !== undefined && { service: esc(got.service, 63) }),
    ...(classification !== undefined && { classification: esc(classification, 40) }),
    ...(got.reason !== undefined && { reason: esc(got.reason, 300) }),
  }
  return { text: canFile || how === undefined ? text : `${text} · ${how}`, detail, tone: 'deny', ...(canFile && { request }) }
}

/** The (root key, field name) pairs Agent Services denied in the response, in the order it said them: its tally, its errors, then the rows shown. */
function deniedPairs(ir: CallIR, outcome: CallOutcome): [string, string][] {
  const pairs = new Map<string, [string, string]>()
  const add = (rootKey: string | undefined, name: string | undefined) => {
    if (rootKey !== undefined && name !== undefined && name !== '') pairs.set(`${rootKey}\u0000${name}`, [rootKey, name])
  }
  for (const one of outcome.denials ?? []) add(one.root, one.field)
  for (const error of outcome.errors) if (error.isDenied === true) add(error.path?.split('.')[0], error.field)
  for (const list of outcome.preview ?? []) {
    const rootKey = list.root ?? ownerOf(ir.roots, list)?.path
    for (const item of list.items) for (const tag of item.denied ?? []) add(rootKey, tag.field.split('.').pop())
  }
  return [...pairs.values()]
}

/** The flags, most important first; empty when nothing is unusual. `outcome` only for a call that ran. */
export function flagsOf(ir: CallIR, outcome?: CallOutcome, isSettled = false): Flag[] {
  const flags: Flag[] = []
  if (ir.isOperationDenied === true) flags.push({ text: 'policy denies the whole operation', detail: 'dry_run refused the whole operation for your role: nothing will come back', tone: 'deny' })

  // A write's CHANGES block says that it writes, and a delete's says what goes: the flags line does not say it again.
  const blocks = new Map((previewOf(ir)?.all ?? []).map(block => [block.path, block] as const))
  const destructive = ir.roots.filter(root => isDestructiveName(root.name))
  for (const root of destructive) {
    if (blocks.get(root.path)?.kind === 'delete') continue
    flags.push({ text: `destructive: ${esc(root.name, 120)}`, detail: `${esc(root.name, 120)} sounds destructive (delete, remove, archive, revoke): it may change or remove data`, tone: 'write' })
  }
  if (destructive.length === 0 && ir.opType === 'mutation' && ir.roots.some(root => !blocks.has(root.path))) flags.push({ text: WRITES_DATA, detail: 'a mutation: approving it changes data in the service', tone: 'write' })
  // A query can still write (GraphQL does not stop a query field's resolver from writing), so a root named for a change is said whatever the operation type.
  if (ir.opType !== 'mutation') {
    for (const root of ir.roots.filter(one => !isDestructiveName(one.name) && isWriteName(one.name))) {
      flags.push({ text: `may change data: ${esc(root.name, 120)}`, detail: `${esc(root.name, 120)} is named for a change (create, update, send…): a query field can still change data, so check what it does before approving`, tone: 'write' })
    }
  }

  // What a write's own arguments show (src/preview/changes.ts): a delete that cannot be undone, @channel, an admin override.
  for (const flag of previewFlags(ir)) flags.push({ text: flag.text, detail: flag.detail, tone: flag.tone })

  for (const link of outcome?.authLinks ?? []) {
    const service = productOf(link.service) ?? 'a service'
    flags.push({ text: `link ${service} to read it`, detail: `${service} needs your account linked before Agent Services can read it (UPSTREAM_AUTH_REQUIRED); the link is under RESULT`, tone: 'warn' })
  }

  // Policy: a denied field once per root, with what it cost there once the call ran; a masked one once per name. A denied or masked object is one field (policyUnits).
  const seen = new Set<string>()
  for (const root of ir.roots) {
    for (const field of policyUnits([root])) {
      if (field.policy !== 'deny' && field.policy !== 'mask') continue
      const name = esc(field.name, 120)
      const key = field.policy === 'mask' ? `mask:${isSettled ? name : pathOf(root, field)}` : `deny:${root.path}:${field.name}`
      if (seen.has(key)) continue
      seen.add(key)
      if (field.policy === 'mask') {
        flags.push({ text: `${isSettled ? name : pathOf(root, field)} masked`, detail: `${pathOf(root, field)} comes back masked for your role`, tone: 'mask' })
      } else if (outcome !== undefined) {
        flags.push(deniedFlag(ir, outcome, root, field))
      } else {
        flags.push({ text: `${pathOf(root, field)} denied`, detail: `${pathOf(root, field)} is denied for your role: it comes back null`, tone: 'deny' })
      }
    }
  }
  // What Agent Services denied that the policy check did not say it would: a flag all the same.
  if (outcome !== undefined) {
    for (const [rootKey, name] of deniedPairs(ir, outcome)) {
      const root = ir.roots.find(one => one.path === rootKey)
      if (root === undefined || seen.has(`deny:${root.path}:${name}`)) continue
      seen.add(`deny:${root.path}:${name}`)
      flags.push(deniedFlag(ir, outcome, root, walk([root]).find(one => one.name === name) ?? name))
    }
  }

  if (outcome?.isUnreadable === true) {
    // In the unit RESULT says it in: `about 58 KB`, never characters.
    const kept = receiptOf(outcome, ir)
    const size = kept?.bytes === undefined ? '' : ` · ${held(`${kept.isApproximate ? 'about ' : ''}${sizeText(kept.bytes)}`)}`
    flags.push(
      outcome.isTooLarge === true
        ? { text: `response kept out of Claude's context${size}`, detail: "Claude Code saved the whole response to a file and gave Claude a short preview and the file's path, so the pane cannot show what came back", tone: 'warn' }
        : { text: 'response not readable', detail: 'the result was not a GraphQL response the pane could read', tone: 'warn' },
    )
  }

  // More rows than the limit asked for: by product, or by alias when two roots share one.
  const over = ir.roots.flatMap(root => {
    const found = overLimit(outcome, ir, root)
    return found === undefined ? [] : [{ root, ...found }]
  })
  // A root no scope claimed is its own name's product, never the first root's.
  const products = over.map(one => productOf(rootService(one.root)))
  for (const [index, one] of over.entries()) {
    const product = products[index]
    const isShared = product === undefined || products.filter(other => other === product).length > 1
    const who = isShared ? esc(one.root.alias ?? one.root.name, 120) : product
    flags.push({ text: `${who} returned ${grouped(one.got)} (asked ${grouped(one.asked)})`.replace(/ /g, ' '), detail: `${esc(one.root.alias ?? one.root.name, 120)} asked for ${grouped(one.asked)} and got ${grouped(one.got)}: the service ignored or capped the limit, so the agent read more than it asked for`, tone: 'warn' })
  }

  // One field is most of a big response: the agent spent its context on it.
  const receipt = receiptOf(outcome, ir)
  const heavy = receipt?.dominant
  if (receipt !== undefined && heavy !== undefined && receipt.bytes !== undefined) {
    const size = sizeText(receipt.bytes)
    const keptOut = receipt.isKeptOut ? ' Claude saw only a short preview of it: the whole response is in a file Claude Code saved.' : ''
    flags.push({
      text: `${heavy.label} is ${heavy.share} of a ${held(size)} result`,
      detail: `${heavy.label}${heavy.gloss === undefined ? '' : ` (${heavy.gloss})`} is ${heavy.share} of the ${size} response (${tokensText(receipt.bytes)}). Without it the response would be about ${heavy.without.size}: asking for fewer fields or fewer rows would cost less context.${keptOut}`,
      tone: 'warn',
    })
  }

  const checks = ir.checks
  // A check that failed says why in a few plain words; the error itself (a diagnostic blob, the plugin's and the engine's words) is the card's, whole.
  const failed = [checks?.policy === 'failed' ? 'policy' : '', checks?.schema === 'failed' ? 'schema' : ''].filter(Boolean)
  if (failed.length > 0) {
    const raw = checks?.error === undefined ? undefined : checks.error.replace(/\s+/g, ' ').trim()
    const why = checkFailureWords(raw)
    flags.push({
      text: `${failed.join(' and ')} not checked${why === undefined ? '' : `: ${why}`}`,
      detail: why === NOT_ALLOWED
        ? `The pane checks a call's ${failed.join(' and ')} with Agent Services' read-only tools (search, introspect, validate and dry_run), and only where your permission settings already allow them, so it never adds a dialog of its own. To have it check, allow them in /permissions, or choose "don't ask again" when Claude itself first uses one. None of them changes data.`
        : `Agent Services could not check this call's ${failed.join(' or ')}${raw === undefined ? '.' : `. The error: ${esc(raw, 600)}`}`,
      tone: 'warn',
    })
  }
  return flags
}

/** The flags as one line; `isRequestDrawn` when the pane draws the access request as its own button row. */
export const flagsText = (flags: readonly Flag[], isRequestDrawn = false) =>
  flags.map(flag => (flag.request === undefined || isRequestDrawn ? flag.text : `${flag.text} · ${REQUEST_TEXT}`)).join(' · ')

/**
 * What the access-request button puts in the prompt box: every requestable
 * denial in one request. Claude holds the denial tokens from the response,
 * and filing is a write, so it still asks before it files. A call is named by
 * its operation name when it has one; without, by what it did to the field.
 */
export function requestDraft(flags: readonly Flag[], opName: string | undefined): string | undefined {
  return requestDraftFor(flags.flatMap(flag => (flag.request === undefined ? [] : [flag.request])), opName)
}

const quoted = (text: string) => `"${text}"`
const listed = (items: readonly string[]) => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`)

/**
 * The draft for the denials named: what to file, the exact API Claude will
 * call and with what, and why the fields were denied, so the person reading
 * the prompt box sees the write before Claude makes it. Every value is what
 * the denial token or the call said, escaped where it was kept.
 */
export function requestDraftFor(items: readonly RequestItem[], opName: string | undefined): string | undefined {
  const unique = items.filter((item, at) => items.findIndex(other => other.what === item.what) === at)
  if (unique.length === 0) return undefined
  const call = opName === undefined ? 'the Agent Services call that denied it' : `the ${esc(opName, 120)} call`
  const whats = listed(unique.map(item => item.what))
  const services = [...new Set(unique.flatMap(item => (item.service === undefined ? [] : [item.service])))]
  const fields = unique.map(item => item.coord ?? item.what.replace(/^`([^`]+)`.*$/, '$1'))
  const service = services.length === 0 ? 'the service_name inside the denial token' : services.length === 1 ? quoted(services[0] ?? '') : `${services.map(quoted).join(' or ')} (one request per service)`
  const classes = [...new Set(unique.flatMap(item => (item.classification === undefined ? [] : [item.classification])))]
  const reasons = [...new Set(unique.flatMap(item => (item.reason === undefined ? [] : [item.reason])))]
  const why = [classes.length === 0 ? '' : `classified ${listed(classes)}`, reasons.length === 0 ? '' : `"${reasons.join('" "')}"`].filter(Boolean).join(': ')
  return [
    opName === undefined ? `File an Agent Services access request for ${whats}. The denial token is in the response of the Agent Services call that denied it.` : `File an Agent Services access request for ${whats}, denied in ${call}.`,
    `How: find Agent Services' createAccessRequestByServiceName mutation with search, then run it through execute with serviceName ${service}, requestedFields [${fields.map(quoted).join(', ')}], denialContext and sourceOperation from the denied fields' extensions in ${call}'s response, appId from that token's app_id, and a reason: ask me for it.`,
    `Why: Agent Services policy denied ${listed(fields)}${why === '' ? '' : `, ${why}`}.`,
    'Filing asks approvers to grant access; it changes no data in the service. It is a write to Agent Services, so show me the exact mutation and wait for my yes before running it.',
  ].join('\n')
}
