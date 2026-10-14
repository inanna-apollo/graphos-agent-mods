// Manifest data and the declared state namespace must agree. Atom references
// are checked against PluginState by TypeScript; register.test.ts exercises
// mounting the plugin and watch.test.ts exercises config paths through the host.

import { URL } from 'node:url'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { PluginState } from 'claude-code'

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const manifest = JSON.parse(read('.claude-plugin/plugin.json')) as { name: string; displayName?: string; userConfig?: Record<string, unknown> }
const NAME = 'graphos-agent-mods' satisfies keyof PluginState

test('the plugin is graphos-agent-mods, and GraphOS Inspector is the feature inside it', () => {
  assert.equal(manifest.name, NAME)
  assert.equal(manifest.displayName, 'GraphOS Agent Mods')
})

test('documentation and example configuration no longer name the old user folder', () => {
  for (const file of ['README.md', '.claude/CLAUDE.md', 'links.toml', 'trust.example.graphql', 'src/view/trust.ts', 'skills/graphos-inspector/SKILL.md']) {
    const text = read(file)
    assert.ok(!text.includes('.claude/gas-inspector'), `${file} still names the old folder`)
  }
})

test('the marketplace is graphos-experiments and lists this plugin from the repository root', () => {
  const marketplace = JSON.parse(read('.claude-plugin/marketplace.json')) as { name: string; owner: { name: string }; plugins: { name: string; source: string; description?: string }[] }
  assert.equal(marketplace.name, 'graphos-experiments')
  assert.equal(marketplace.owner.name, 'Inanna Malick')
  assert.equal(marketplace.plugins.length, 1)
  assert.equal(marketplace.plugins[0]?.name, NAME)
  assert.equal(marketplace.plugins[0]?.source, './')
  assert.ok((marketplace.plugins[0]?.description ?? '') !== '')
})

test('the manifest carries what a listing needs, and declares no options, so installing asks nothing', () => {
  const full = JSON.parse(read('.claude-plugin/plugin.json')) as Record<string, unknown>
  assert.equal(full.repository, 'https://github.com/inanna-apollo/graphos-agent-mods')
  assert.equal(full.homepage, full.repository)
  assert.equal(full.license, 'Elastic-2.0')
  assert.ok(Array.isArray(full.keywords) && full.keywords.length > 0)
  assert.ok(typeof full.description === 'string' && full.description !== '')
  // Claude Code asks for every declared option at install: sites are learned or set in links.toml instead.
  assert.equal(full.userConfig, undefined)
  // Unversioned: Claude Code versions the plugin by commit, so a push reaches people who update.
  assert.equal(full.version, undefined)
})
