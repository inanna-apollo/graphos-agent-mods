import assert from 'node:assert/strict'
import { test } from 'node:test'

import { MIN_CLAUDE_CODE, isOlder, versionNote } from '../../src/version.ts'

test('releases compare by number, segment by segment', () => {
  assert.equal(isOlder('2.1.288', '2.1.290'), true)
  assert.equal(isOlder('2.1.290', '2.1.290'), false)
  assert.equal(isOlder('2.1.300', '2.1.290'), false)
  assert.equal(isOlder('2.2.0', '2.1.290'), false)
  assert.equal(isOlder('2.1', '2.1.290'), true)
  assert.equal(isOlder('2.1.290-dev', '2.1.290'), undefined)
})

test('an older release gets one line saying what to do; a current or unknown one gets none', () => {
  assert.match(versionNote('2.1.288', 'graphos-agent-mods') ?? '', new RegExp(`needs Claude Code ${MIN_CLAUDE_CODE.replace(/\./g, '\\.')} or later \\(this is 2\\.1\\.288\\): run \`claude update\``))
  assert.equal(versionNote(MIN_CLAUDE_CODE, 'x'), undefined)
  assert.equal(versionNote('9.0.0', 'x'), undefined)
  assert.equal(versionNote(undefined, 'x'), undefined)
  assert.equal(versionNote('nightly', 'x'), undefined)
})
