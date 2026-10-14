#!/usr/bin/env node
// Build a disposable Claude Code plugin containing the production Inspector
// view and synthetic hardening fixtures, then validate it without launching it.
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const plugin = mkdtempSync(join(tmpdir(), 'gas-inspector-preview-'))
const copyTree = (source, destination) => cpSync(join(root, source), join(plugin, destination), { recursive: true })

mkdirSync(join(plugin, '.claude-plugin'), { recursive: true })
for (const directory of ['.claude-plugin/types', 'src', 'types', 'test/fixtures']) {
  copyTree(directory, directory)
}
mkdirSync(join(plugin, 'hooks'), { recursive: true })
mkdirSync(join(plugin, '.claude-plugin'), { recursive: true })
cpSync(join(root, 'scripts/preview-inspector-hook.tsx'), join(plugin, 'hooks/register.tsx'))

writeFileSync(join(plugin, '.claude-plugin/plugin.json'), `${JSON.stringify({
  name: 'inspector-native-preview',
  displayName: 'Inspector Native Preview',
  description: 'Developer-only synthetic native rendering preview for GraphOS Inspector.',
  types: './types/index.d.ts',
}, null, 2)}\n`)
writeFileSync(join(plugin, 'hooks/hooks.json'), '{ "modules": ["./register.tsx"] }\n')
writeFileSync(join(plugin, 'package.json'), '{ "name": "inspector-native-preview", "private": true, "type": "module" }\n')
writeFileSync(join(plugin, 'tsconfig.json'), `${JSON.stringify({
  extends: './.claude-plugin/types/tsconfig.json',
  compilerOptions: {
    allowImportingTsExtensions: true,
    baseUrl: root,
    paths: { graphql: [join(root, 'node_modules/graphql/index.d.ts')] },
  },
  include: ['.claude-plugin/types', 'hooks', 'types', 'src', 'test/fixtures'],
}, null, 2)}\n`)

const validated = spawnSync('claude', ['plugin', 'validate', '--json', plugin], { encoding: 'utf8' })
if (validated.stdout) process.stdout.write(validated.stdout)
if (validated.stderr) process.stderr.write(validated.stderr)
if (validated.error) throw validated.error
if (validated.status !== 0) process.exit(validated.status ?? 1)

process.stdout.write(`\nTemporary plugin: ${plugin}\n`)
process.stdout.write(`Launch command: claude --plugin-dir "${plugin}"\n`)
process.stdout.write('After Claude Code starts, run /inspector-preview [jira|search|enum|enum61|object|long|partial|write|large|unicode] [32|50|64|84|100].\n')
process.stdout.write('Evidence fixtures: restored, checks, pendingchecks, trusted, auth, denied, errored, interrupted, expired, oversize, pendingsearch, searchunknown, searchzero, typeunknown, input, interface, union, invalid, validationmissing, drymissing, drymixed.\n')
process.stdout.write('Use /inspector-preview metrics for the actual viewport, focus to request keyboard focus, and raw to inspect the retained input.\n')
process.stdout.write('The launcher is ready; this script does not start an interactive Claude Code session.\n')
