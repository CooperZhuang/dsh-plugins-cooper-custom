/**
 * Wrap the hand-written browser half into the DSH client bundle contract.
 *
 * The client module system executes a plugin bundle as a plain classic script
 * that REGISTERS a lazy CJS factory:
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => exports })
 *
 * so the bundle needs no bundler. `client/index.js` defines `createPlugin`; this
 * script wraps it and writes `lib/client.js`, which is what `exports['./client']`
 * points at. Run by `npm run build` (and by `prepare`, so a `dsh plugin add`
 * always ships a bundle).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'client', 'index.js'), 'utf8')
const target = join(root, 'lib', 'client.js')

const indent = (text) =>
  text
    .split('\n')
    .map((line) => (line.length > 0 ? `    ${line}` : line))
    .join('\n')

const bundle = `window.__ModuleLoader__.load({
  id: "dsh-folder-path",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    // ---- client/index.js ----
${indent(source)}
    const plugin = createPlugin(require);
    exports.apply = plugin.apply;
    return module.exports;
  }
});
`

mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, bundle)
console.log(`client bundle -> ${target} (${bundle.length} bytes)`)
