// The plugin's name is spelled in several places that must agree: the manifest,
// the `$.state` contract, every atom, and the folder of the person's own files.
// A rename that misses one is caught here, not by a person's lost state.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const manifest = JSON.parse(read('.claude-plugin/plugin.json')) as { name: string; displayName?: string; userConfig?: Record<string, unknown> }
const NAME = manifest.name

test('the plugin is graphos-agent-mods, and GraphOS Inspector is the feature inside it', () => {
  assert.equal(NAME, 'graphos-agent-mods')
  assert.equal(manifest.displayName, 'GraphOS Agent Mods')
})

test('every atom, and the state contract, name the plugin the manifest names', () => {
  const hooks = read('hooks/register.tsx')
  const keys = [...hooks.matchAll(/plugin: '([^']+)'/g)].map(match => match[1])
  assert.ok(keys.length >= 8, 'the atoms are found')
  assert.deepEqual([...new Set(keys)], [NAME])
  assert.match(read('types/index.d.ts'), new RegExp(`^    '${NAME}': \\{`, 'm'))
})

test('the person’s own files live under ~/.claude/<the plugin name>/, in the code, the file watcher and the docs', () => {
  const hooks = read('hooks/register.tsx')
  assert.ok(hooks.includes(`/.claude/${NAME}/\${name}`), 'userFile')
  assert.ok(hooks.includes(`\\/\\.claude\\/${NAME}\\/(links\\.toml|trust\\.graphql)$`), 'the FileChanged pattern')
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

test('the manifest carries what a listing needs, and the dev-only snapshot options are not offered', () => {
  const full = JSON.parse(read('.claude-plugin/plugin.json')) as Record<string, unknown> & { userConfig: Record<string, { description: string }> }
  assert.equal(full.repository, 'https://github.com/inanna-apollo/graphos-agent-mods')
  assert.equal(full.homepage, full.repository)
  assert.equal(full.license, 'Elastic-2.0')
  assert.ok(Array.isArray(full.keywords) && full.keywords.length > 0)
  assert.ok(typeof full.description === 'string' && full.description !== '')
  assert.deepEqual(Object.keys(full.userConfig).sort(), ['atlassianBase', 'extraLinks', 'gleanBase', 'slackBase'])
  // An empty Atlassian site or Slack workspace is learned from Agent Services responses, and the options say so.
  for (const option of ['atlassianBase', 'slackBase']) assert.match(full.userConfig[option]?.description ?? '', /learned from Agent Services responses/)
})
