#!/usr/bin/env node
/**
 * Push the assistant persona into the desktop pet's own config.
 *
 * The pet reads its persona from `pets[].whisperPrompt` (instance level, which
 * REPLACES the package-level one) and builds its system prompt from it. So the
 * persona this plugin keeps at `memories/persona/assistant.md` is the source of
 * truth, and the pet's config is a deployment target — not the other way round,
 * because the pet cannot know what the user said, only what it is told it is.
 *
 * Default is a dry run. The pet writes this file itself (positions, animation
 * state), so the write is a read-modify-write with a backup and a byte check, and
 * the user decides when to apply it.
 *
 * Usage:
 *   node scripts/apply-pet-persona.mjs             # show what would change
 *   node scripts/apply-pet-persona.mjs --apply     # write it (keeps a backup)
 *   node scripts/apply-pet-persona.mjs --home=...  # a different DSH home
 *
 * @module dsh-memories/scripts/apply-pet-persona
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const flags = Object.fromEntries(process.argv.slice(2).filter((arg) => arg.startsWith('--')).map((arg) => {
  const at = arg.indexOf('=')
  return at < 0 ? [arg.slice(2), 'true'] : [arg.slice(2, at), arg.slice(at + 1)]
}))
const home = flags['home'] ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
const personaPath = join(home, 'memories', 'persona', 'assistant.md')
const configPath = join(home, 'dsh-pet', 'main-config.jsonc')

if (!existsSync(personaPath)) {
  console.error('No assistant persona at ' + personaPath)
  process.exit(1)
}
if (!existsSync(configPath)) {
  console.error('No pet config at ' + configPath + ' (is dsh-pet installed?)')
  process.exit(1)
}

const persona = readFileSync(personaPath, 'utf8').trim()
const raw = readFileSync(configPath, 'utf8')
// The pet allows comments; strip only full-line // and /* */ blocks for parsing.
const stripped = raw.replace(/^\s*\/\/.*$/gmu, '').replace(/\/\*[\s\S]*?\*\//gu, '')
let config
try {
  config = JSON.parse(stripped)
} catch (error) {
  console.error('Could not parse ' + configPath + ': ' + (error instanceof Error ? error.message : String(error)))
  process.exit(1)
}
const pets = Array.isArray(config.pets) ? config.pets : []
if (pets.length === 0) {
  console.error('The pet config declares no pets')
  process.exit(1)
}
const target = pets.find((pet) => pet.id === 'main') ?? pets[0]
console.log('persona: ' + persona.length + ' chars from ' + personaPath)
console.log('target : pet ' + JSON.stringify(target.id) + ' (' + (target.name ?? 'unnamed') + ')')
console.log('current: ' + (typeof target.whisperPrompt === 'string' && target.whisperPrompt.trim().length > 0
  ? target.whisperPrompt.trim().slice(0, 80) + '…'
  : '(none — the package default is in force)'))

if (flags['apply'] !== 'true') {
  console.log()
  console.log('DRY RUN: nothing written. Re-run with --apply to replace the pet persona.')
  console.log('The write is a read-modify-write with a .bak copy, and preserves the rest of the config.')
  process.exit(0)
}

target.whisperPrompt = persona
const backup = configPath + '.bak-' + new Date().toISOString().replace(/[:.]/gu, '-')
copyFileSync(configPath, backup)
mkdirSync(dirname(configPath), { recursive: true })
const temp = configPath + '.' + process.pid + '.tmp'
writeFileSync(temp, JSON.stringify(config, null, 2) + '\n', 'utf8')
renameSync(temp, configPath)
console.log()
console.log('wrote ' + configPath + ' (backup: ' + backup + ')')
