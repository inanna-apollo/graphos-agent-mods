import { renderQuery } from './query-lang.ts'
import type { Rendered } from './types.ts'

/** Jira JQL: one clause per line. Falls back to plain text when it cannot parse. */
export const renderJql = (value: unknown): Rendered => renderQuery(value)
