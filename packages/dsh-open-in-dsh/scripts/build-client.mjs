/**
 * Wrap the hand-written browser half into the DSH client bundle contract.
 *
 * The client module system executes a plugin bundle as a plain classic script
 * that REGISTERS a lazy CJS factory:
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => exports })
 *
 * so the bundle needs no bundler. `client/index.js` defines `createPlugin`;
 * this script wraps it and writes `lib/client.js`, which is what
 * `exports['./client']` points at.
 *
 * `lib/client.js` is committed rather than built on install: the profile
 * installs a local package with no build step, and a `prepare` script would
 * turn into an approval prompt for a script that only concatenates two files.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'client', 'index.js'), 'utf8')
const target = join(root, 'lib', 'client.js')

/** The marker client/index.js carries where the locale dictionaries belong. */
const DICTIONARY_MARKER = '/* @menu-dictionaries */ { zh: {}, en: {} }'

/**
 * Read one locale file's menu labels, flattened to the keys the client looks up
 * ('menu.qspace', 'menu.failed', ...).
 *
 * Building this from the shipped locale files keeps one source of truth: the
 * same files also carry the plugin page's meta title and description.
 *
 * @param language - zh or en.
 * @returns the flattened dictionary.
 */
function readMenuDictionary(language) {
  const file = join(root, 'locale', language + '.json')
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  const menu = parsed.menu
  if (menu === null || typeof menu !== 'object' || Array.isArray(menu)) {
    throw new Error(file + ': missing the "menu" object the client bundle needs')
  }
  const entries = Object.entries(menu)
  if (entries.length === 0) throw new Error(file + ': "menu" is empty')
  return Object.fromEntries(entries.map(([key, value]) => ['menu.' + key, String(value)]))
}

const dictionaries = { zh: readMenuDictionary('zh'), en: readMenuDictionary('en') }
if (!source.includes(DICTIONARY_MARKER)) {
  throw new Error('client/index.js: the @menu-dictionaries marker moved; update scripts/build-client.mjs')
}
const withDictionaries = source.replace(DICTIONARY_MARKER, '/* @menu-dictionaries */ ' + JSON.stringify(dictionaries))

const indent = (text) =>
  text
    .split('\n')
    .map((line) => (line.length > 0 ? `    ${line}` : line))
    .join('\n')

const bundle = `window.__ModuleLoader__.load({
  id: "dsh-open-in-dsh",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    // ---- client/index.js ----
${indent(withDictionaries)}
    const plugin = createPlugin(require);
    exports.apply = plugin.apply;
    exports.inject = plugin.inject;
    exports.__internals = __internals;
    return module.exports;
  }
});
`

mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, bundle)
console.log(`client bundle -> ${target} (${bundle.length} bytes)`)
