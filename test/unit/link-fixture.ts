// The link settings the unit tests run on: example sites, never the shipped
// links.toml's (which names no site; each person sets their own at install).
import { configOf } from '../../src/links.ts'

export const SITE = 'https://example.atlassian.net'
export const SLACK = 'https://example.slack.com'
export const GLEAN = 'https://glean.example.com'

/** Every named site set in a person's links.toml. */
export const LINKS = configOf({ user: `[bases]\natlassian = "${SITE}"\nslack = "${SLACK}"\nglean = "${GLEAN}"\n` })
