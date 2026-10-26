#!/usr/bin/env node
/**
 * Ask the desktop pet a question WITHOUT restarting the harness.
 *
 * The pet's HTTP routes live inside the running host, so a payload bug normally
 * costs a full restart to discover — and restarts are the most expensive thing in
 * this project (three were wasted on a hardlink problem, two more on guessing).
 * But the pet plugin is ordinary ESM: `apply(ctx)` needs a handful of services,
 * and it registers its route table with whatever `webServer.register` it is given.
 * So this script runs the pet's REAL code on a stub context, calls the REAL route
 * handler with the REAL bytes we would send, and prints the REAL answer. Same
 * validation, no host, no restart.
 *
 * It is also how the `surface` parameter was found: without it the pet answers
 * {"ok":false,"reason":"bad-request","message":"surface 必填：web / desktop /
 * both / any"} — a requirement that appears nowhere in the route's happy path.
 *
 * Usage:
 *   node scripts/pet-probe.mjs
 *   node scripts/pet-probe.mjs --path='/dsh-pet-7340/broadcast?pet=main&surface=any' --body='{"text":"hi","duration":3000}'
 *   node scripts/pet-probe.mjs --raw          # print the response body alone
 *   node scripts/pet-probe.mjs --home=/Users/you/.dsh --profile=desktop
 *
 * Exit code 0 when the pet answered ok:true.
 *
 * @module dsh-memories/scripts/pet-probe
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'

const flags = Object.fromEntries(process.argv.slice(2).filter((arg) => arg.startsWith('--')).map((arg) => {
  const at = arg.indexOf('=')
  return at < 0 ? [arg.slice(2), 'true'] : [arg.slice(2, at), arg.slice(at + 1)]
}))
const home = flags['home'] ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profile = flags['profile'] ?? 'desktop'
const appRoot = flags['app'] ?? '/Applications/DSH Desktop Beta.app/Contents/Resources/app'
const profModules = join(home, 'profiles', profile, 'node_modules')
const petSrc = join(profModules, 'dsh-pet')
const path = flags['path'] ?? '/dsh-pet-7340/broadcast?pet=main&surface=any'
const body = flags['body'] ?? JSON.stringify({ text: 'probe', duration: 8000 })
const method = flags['method'] ?? 'POST'

if (!existsSync(petSrc)) {
  console.error('no dsh-pet at ' + petSrc)
  process.exit(1)
}

// An isolated tree, so the pet's imports resolve: its @deepseek-ai peers come from
// the app bundle, its runtime dependencies from the profile.
const root = join(tmpdir(), 'dsh-memories-pet-probe')
rmSync(root, { recursive: true, force: true })
const modules = join(root, 'node_modules')
mkdirSync(modules, { recursive: true })
cpSync(join(petSrc, 'lib'), join(modules, 'dsh-pet', 'lib'), { recursive: true })
cpSync(join(petSrc, 'package.json'), join(modules, 'dsh-pet', 'package.json'))
if (existsSync(join(petSrc, 'assets', 'config.jsonc'))) {
  mkdirSync(join(modules, 'dsh-pet', 'assets'), { recursive: true })
  cpSync(join(petSrc, 'assets', 'config.jsonc'), join(modules, 'dsh-pet', 'assets', 'config.jsonc'))
}
const link = (from, to) => { if (!existsSync(to)) symlinkSync(from, to) }
const list = (dir) => { try { return readdirSync(dir) } catch { return [] } }
for (const name of list(join(appRoot, 'node_modules', '@deepseek-ai'))) {
  mkdirSync(join(modules, '@deepseek-ai'), { recursive: true })
  link(join(appRoot, 'node_modules', '@deepseek-ai', name), join(modules, '@deepseek-ai', name))
}
for (const name of list(profModules)) {
  if (name === 'dsh-pet' || name.startsWith('.')) continue
  link(join(profModules, name), join(modules, name))
}

const pet = await import(pathToFileURL(join(modules, 'dsh-pet', 'lib', 'index.js')).href)
const routes = []
const noop = () => () => {}
const ctx = new Proxy({
  effect: (fn) => { try { const out = fn(); return typeof out === 'function' ? out : noop() } catch { return noop() } },
  on: () => noop(), emit: () => {}, get: () => undefined, set: () => {}, provide: () => {},
  plugin: () => ({ dispose: noop() }),
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  webServer: {
    port: 0,
    register: (route) => { routes.push(route); return noop() },
    registerFallback: () => noop(),
    registerUpgrade: () => noop(),
  },
  connection: { authenticatedUrl: (url) => url },
  commands: { register: () => noop() },
}, { get: (target, key) => (key in target ? target[key] : undefined) })

try {
  pet.apply(ctx)
} catch (error) {
  console.error('apply threw: ' + (error instanceof Error ? error.message : String(error)))
}

const wanted = '/' + path.split('?')[0].split('/').filter((part) => part.length > 0).slice(0, 1).join('/')
const route = routes.find((row) => row.kind === 'prefix' && row.path === wanted)
if (route === undefined) {
  console.error('the pet registered no prefix route for ' + wanted + ' (got: ' + routes.map((row) => row.path).join(', ') + ')')
  process.exit(2)
}

const captured = { status: 0, body: '' }
const response = {
  statusCode: 200,
  writeHead(status) { captured.status = status; this.statusCode = status },
  setHeader() {},
  end(chunk) { if (typeof chunk === 'string') captured.body += chunk },
  on() {}, off() {}, removeListener() {}, once() {},
}
const request = Object.assign(Readable.from([Buffer.from(body, 'utf8')]), {
  method,
  url: path,
  headers: { 'content-type': 'application/json' },
})

await route.handler(request, response)
if (flags['raw'] === 'true') {
  console.log(captured.body)
} else {
  console.log('request : ' + method + ' ' + path)
  console.log('body    : ' + body)
  console.log('status  : ' + captured.status)
  console.log('response: ' + captured.body)
}
rmSync(root, { recursive: true, force: true })
process.exit(captured.body.includes('"ok":true') ? 0 : 1)
