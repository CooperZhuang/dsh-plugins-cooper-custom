/**
 * Manifest contract tests: the declarations the DSH kernel reads when it
 * composes a profile must keep matching this package.
 *
 * The kernel reads three of them: the bundle patch file (`dsh.bundle.patch`),
 * the browser half's platform (`dsh.client.platform`), and the export map it
 * resolves `./client` through. A typo in any of them is invisible until a
 * profile boots, so it is pinned here instead.
 *
 * Run with `npm test`.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

/** This package's manifest, as the kernel reads it. */
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/**
 * Resolve an export-map entry to the file it points at.
 *
 * @param {unknown} entry - the raw `exports` value.
 * @returns the relative path, or undefined when the entry names no file.
 */
function exportTarget(entry) {
  if (typeof entry === 'string') return entry
  if (entry !== null && typeof entry === 'object' && typeof entry.default === 'string') return entry.default
  return undefined
}

test('the package declares the bundle patch the kernel composes', () => {
  const patch = manifest.dsh?.bundle?.patch
  assert.equal(patch, './cordis.patch.yml')
  assert.ok(existsSync(new URL('../cordis.patch.yml', import.meta.url)), 'the patch file exists')
})

test('the browser half is declared for the web platform', () => {
  assert.equal(manifest.dsh?.client?.platform, 'web')
})

test('the export map points the kernel at both halves', () => {
  const host = exportTarget(manifest.exports?.['.'])
  const client = exportTarget(manifest.exports?.['./client'])
  assert.equal(host, './lib/index.js')
  assert.equal(client, './lib/client.js')
  assert.ok(existsSync(new URL('../lib/index.js', import.meta.url)), 'the host half exists')
  assert.ok(existsSync(new URL('../lib/client.js', import.meta.url)), 'the browser bundle exists')
})

test('the bundle patch inserts a row naming this package', () => {
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const id = /^\s*-\s+id:\s*(\S+)\s*$/m.exec(patch)
  const name = /^\s+name:\s*(\S+)\s*$/m.exec(patch)
  assert.ok(id !== null, 'the patch row carries an id')
  assert.ok(name !== null, 'the patch row carries a name')
  // The row name is the module specifier the kernel imports; it must resolve
  // from the profile's own node_modules, so it has to be the package name.
  assert.equal(name[1], manifest.name)
})

test('the package publishes the files the kernel loads', () => {
  for (const file of ['lib/index.js', 'lib/client.js', 'cordis.patch.yml']) {
    assert.ok(manifest.files.includes(file), `${file} is published`)
  }
})
