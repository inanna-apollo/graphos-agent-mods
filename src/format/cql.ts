import { renderQuery } from './query-lang.ts'
import type { Rendered } from './types.ts'

/** Confluence CQL: one clause per line. Falls back to plain text when it cannot parse. */
export const renderCql = (value: unknown): Rendered => renderQuery(value)
