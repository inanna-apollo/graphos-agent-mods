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
import { grouped, overLimit } from './outcome.ts'
import { held, receiptOf } from './receipt.ts'
import { sizeText, tokensText } from '../weight.ts'
import { previewFlags, previewOf } from '../preview/changes.ts'
import { classifiedOf } from './personal.ts'
import { observedDenials } from '../denials.ts'
import type { ObservedDenial } from '../denials.ts'

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

/** Without a token the person can still ask for access, but nothing here can file it. */
const requestable = (isRequestable: boolean) => (isRequestable ? 'access requestable' : undefined)

/** `email` on customer data members: a denied field and whose it is, for an access request's draft. */
function requestWhat(root: FieldIR, field: FieldIR | string, noun: string | undefined): string {
  const product = productOf(rootService(root))
  const whose = [product, noun ?? pathOf(root, field).split('.').slice(0, -1).join('.')].filter(Boolean).join(' ')
  return `\`${esc(typeof field === 'string' ? field : field.name, 120)}\`${whose === '' ? '' : ` on ${whose}`}`
}

/** A denied field once the call ran: how many rows it cost, and whether a request can be filed for it. */
function deniedFlag(ir: CallIR, outcome: CallOutcome, got: ObservedDenial, isRepeated: boolean): Flag {
  const root = ir.roots.find(root => root.path === got.root)
  const field = got.field
  const relative = root !== undefined && ir.roots.length === 1 && got.path?.startsWith(`${root.path}.`) ? got.path.slice(root.path.length + 1) : got.path
  const name = esc(isRepeated ? relative ?? got.name : got.name, 240)
  const noun = got.rows === undefined || root === undefined ? undefined : nounOf(root, got.rows, ir.service, got.list)
  // Only a token the execute response itself carried can be filed; and not for a denial that said it is not requestable.
  const canFile = got.path !== undefined && got.hasToken && got.isRequestable !== false
  const how = canFile ? REQUEST_TEXT : requestable(got.isRequestable === true && got.path !== undefined)
  const text = got.rows === undefined ? `${name} denied` : `${name} denied for ${grouped(got.rows)} ${noun ?? `row${got.rows === 1 ? '' : 's'}`}`
  // One classification, said as the cards say it: the schema's, else the one Agent Services gave the denial.
  const classification = field === undefined ? got.classification : (classifiedOf(field) ?? got.classification)
  const location = got.path === undefined ? `${got.root === undefined ? '' : `${esc(got.root, 240)}: `}${name} (exact response location not retained)` : esc(got.path, 240)
  const detail = [
    `${location} denied in the execution response`,
    classification === undefined ? '' : `classified ${esc(classification, 40)}`,
    got.rows === undefined ? '' : `missing from ${grouped(got.rows)} ${noun ?? 'rows'}`,
    got.isRequestable === false ? 'not requestable' : (how ?? ''),
  ]
    .filter(Boolean)
    .join(' · ')
  const what = root === undefined ? `\`${location}\`` : requestWhat(root, field ?? got.path ?? got.name, nounOf(root, 2, ir.service, got.list))
  const request: RequestItem = {
    what,
    ...(got.path !== undefined && { path: got.path }),
    ...(got.coord !== undefined && { coord: esc(got.coord, 200) }),
    ...(got.service !== undefined && { service: esc(got.service, 63) }),
    ...(classification !== undefined && { classification: esc(classification, 40) }),
    ...(got.reason !== undefined && { reason: esc(got.reason, 300) }),
  }
  return { text: canFile || how === undefined ? text : `${text} · ${how}`, detail, tone: 'deny', ...(canFile && { request }) }
}

/** The flags, most important first; empty when nothing is unusual. `outcome` only for a call that ran. */
export function flagsOf(ir: CallIR, outcome?: CallOutcome, isSettled = false): Flag[] {
  const flags: Flag[] = []
  if (!isSettled && outcome === undefined && ir.isOperationDenied === true) flags.push({ text: 'operation refusal reported by dry_run', detail: 'The earlier access check reported an operation refusal. For a multi-service call or a batch, this may apply to only one checked operation; it does not establish the outcome of every request.', tone: 'deny' })

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

  // Pending flags describe the rehearsal. Once execute answers, only its
  // observed denials describe the result; predictions stay in check details.
  for (const root of !isSettled && outcome === undefined ? ir.roots : []) {
    for (const field of policyUnits([root])) {
      if (field.policy !== 'deny' && field.policy !== 'mask') continue
      if (field.policy === 'mask') {
        flags.push({ text: `${pathOf(root, field)} masked`, detail: `dry_run reports masking for ${pathOf(root, field)}. This is an access-check decision, not an observed execution result.`, tone: 'mask' })
      } else {
        flags.push({ text: `${pathOf(root, field)} denied`, detail: `dry_run reports denial for ${pathOf(root, field)}. This is an access-check decision, not an observed execution result.`, tone: 'deny' })
      }
    }
  }
  if (outcome !== undefined) {
    const selected = walk(ir.roots)
    for (const denied of observedDenials(outcome, ir.roots)) flags.push(deniedFlag(ir, outcome, denied, selected.filter(field => field.name === denied.name).length > 1))
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
  const identity = (item: RequestItem) => JSON.stringify([item.service, item.coord, item.path, item.coord === undefined && item.path === undefined ? item.what : undefined])
  const unique = items.filter((item, at) => items.findIndex(other => identity(other) === identity(item)) === at)
  if (unique.length === 0) return undefined
  const call = opName === undefined ? 'the Agent Services call that denied it' : `the ${esc(opName, 120)} call`
  const whats = listed(unique.map(item => item.what))
  const services = [...new Set(unique.flatMap(item => (item.service === undefined ? [] : [item.service])))]
  const fields = [...new Set(unique.map(item => item.coord ?? item.what.replace(/^`([^`]+)`.*$/, '$1')))]
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
