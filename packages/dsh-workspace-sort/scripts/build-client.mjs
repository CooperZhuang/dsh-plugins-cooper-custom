/**
 * Compose the browser bundle.
 *
 * A DSH client bundle is one classic script that registers a lazy CJS factory
 * (`window.__ModuleLoader__.load({ id, factory })`); it cannot `import` a
 * sibling file, because the loader resolves only registered modules. So the
 * pure rules in `src/sort.js` are inlined into `src/client.js` here, at the
 * `/* SORT_RULES_PLACEHOLDER *\/` marker, with their `export ` keywords removed.
 * The test suite keeps importing `src/sort.js` directly.
 *
 * Run by `npm run build`; `lib/client.js` is committed because a linked profile
 * install serves it as-is.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const marker = '/* SORT_RULES_PLACEHOLDER */'
const packageName = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name

const rules = readFileSync(join(root, 'src', 'sort.js'), 'utf8')
  .replace(/^export /gm, '')
  .replace(/\n+$/, '')

const template = readFileSync(join(root, 'src', 'client.js'), 'utf8')
if (!template.includes(marker)) throw new Error(`src/client.js lost its ${marker} marker`)
const bundle = template.replace(marker, rules)
if (bundle.includes(marker)) throw new Error('placeholder was not replaced')

// The factory id must be the package name: the module system keys factories by it.
const declared = /^\s*id:\s*'([^']+)'/m.exec(bundle)
if (declared === null || declared[1] !== packageName) {
  throw new Error(`client factory id ${declared?.[1] ?? '(missing)'} does not match package name ${packageName}`)
}

const target = join(root, 'lib', 'client.js')
mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, bundle)
console.log(`client bundle -> ${target} (${bundle.length} bytes)`)
