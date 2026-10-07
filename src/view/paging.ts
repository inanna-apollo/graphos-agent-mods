// How a paged list says so before the call has run, and what each response
// field does in the paging. Pure.

import { own } from '../guards.ts'
import type { FieldIR, Paging } from '../ir.ts'
import { esc, returnsList } from './kit.ts'

/**
 * `first page · next page: cursor ← next`: the argument that continues the
 * list and the field that holds its continuation, or `first page · more: pass
 * nextPageToken back` where the two share a name; with no single pair, the
 * arguments alone. A later page says which argument moved it.
 */
export function pagingNote(paging: Paging): string {
  if (paging.isFirstPage) {
    const [only] = paging.via
    if (only !== undefined && paging.via.length === 1 && paging.kind === 'page' && paging.pageCountField !== undefined) {
      return `first page · next page: ${esc(only, 120)} ← ${esc(only, 120)} + 1 (of ${esc(paging.pageCountField, 120)})`
    }
    if (only !== undefined && paging.via.length === 1 && paging.moreField !== undefined) {
      const flag = paging.flagField === undefined ? '' : ` (${/^is[A-Z]/.test(paging.flagField) ? 'until' : 'while'} ${esc(paging.flagField, 120)})`
      // One name for the field and the argument: `nextPageToken ← nextPageToken` says it twice.
      if (only === paging.moreField) return `first page · more: pass ${esc(only, 120)} back${flag}`
      return `first page · next page: ${esc(only, 120)} ← ${esc(paging.moreField, 120)}${flag}`
    }
    if (paging.via.length > 0) return `first page · next page via ${esc(paging.via.join(', '), 120)}`
    return 'first page'
  }
  return paging.via.length === 0 ? 'a later page' : `a later page · via ${esc(paging.via.join(', '), 120)}`
}

// ---- What a response field does in the paging, for its hover card

/** Response fields that hold where the next page starts, and the arguments that take them back, likeliest first. */
const CONTINUATIONS: Record<string, readonly string[]> = {
  nextPageToken: ['nextPageToken', 'pageToken'],
  pageToken: ['pageToken', 'nextPageToken'],
  next: ['cursor', 'after', 'pageToken', 'nextPageToken'],
  nextCursor: ['cursor', 'after'],
  cursor: ['cursor', 'after'],
  endCursor: ['after', 'cursor'],
  after: ['after', 'cursor'],
}
const ON_LAST = ['isLast']
const WHILE_MORE = ['hasMoreResults', 'hasNextPage', 'hasMore', 'more']
const OFFSETS = ['startAt', 'offset', 'start', 'skip']
const TOTALS = ['total', 'totalCount', 'totalSize', 'totalResults', 'total_count']
const SIZES = ['maxResults', 'limit', 'pageSize', 'perPage', 'per_page']
const PAGE_INFO = ['pageInfo', 'pagination']

/** The argument a root takes a response field's continuation back as (`nextPageToken`), when it declares one. */
export function continuationArg(field: FieldIR, root: FieldIR): string | undefined {
  const takes = [...root.args.map(arg => arg.name), ...(root.omittedArgs ?? []).map(arg => arg.name)]
  return (own(CONTINUATIONS, field.name) ?? []).find(arg => takes.includes(arg))
}

/**
 * What a response field is for in the paging of the list its root returns,
 * by its name and the arguments the root takes: `nextPageToken` is `the next
 * page's token: pass it back as nextPageToken to get the next page`, `isLast`
 * is `true on the last page`, `startAt` where the page starts, `total` how
 * many in all. Only for a field directly under a root that returns a list, or
 * under its `pageInfo`; undefined for any other. Escaped.
 */
export function pagingRole(field: FieldIR, root: FieldIR, parent: FieldIR | undefined): string | undefined {
  const isListing = returnsList(root) || root.paging !== undefined
  if (!isListing || field === root || parent === undefined || (parent !== root && !PAGE_INFO.includes(parent.name))) return undefined
  const name = field.name
  const takes = [...root.args.map(arg => arg.name), ...(root.omittedArgs ?? []).map(arg => arg.name)]
  if (own(CONTINUATIONS, name) !== undefined) {
    const what = /cursor|after|^next$/i.test(name) ? 'where the next page starts (a cursor)' : "the next page's token"
    const back = continuationArg(field, root)
    if (back !== undefined) return esc(`${what}: pass it back as ${back} to get the next page; none comes back on the last page`, 300)
    // The schema was read and the root takes no argument for it: say so rather than guess.
    return esc(root.omittedArgs === undefined ? `${what}: pass it back to get the next page` : `${what}, though ${root.name} declares no argument that takes it back`, 300)
  }
  if (ON_LAST.includes(name)) return 'true on the last page; false means more pages remain'
  if (WHILE_MORE.includes(name)) return 'true while more pages remain; false on the last page'
  if (PAGE_INFO.includes(name)) return 'how the paging stands: whether more pages remain, and where the next one starts'
  const size = SIZES.find(arg => takes.includes(arg))
  if (OFFSETS.includes(name)) return esc(`where this page starts in the whole list, counted from 0${takes.includes(name) && size !== undefined ? `; the next page starts at ${name} + ${size}` : ''}`, 300)
  if (TOTALS.includes(name)) return 'how many match in all, across every page'
  if (SIZES.includes(name)) return 'how many items a page holds'
  if (name === 'page') return "this page's number"
  if (name === 'pageCount') return 'how many pages there are in all'
  return undefined
}
