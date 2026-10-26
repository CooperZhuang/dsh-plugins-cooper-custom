/**
 * Launcher-side tests: the constants that are *mirrored* between files.
 *
 * The Explorer verb is three files that cannot import each other — a registry
 * command line, a `.vbs` host and a PowerShell worker — plus the route paths
 * the host half actually serves. Everything they agree on is copied by hand,
 * and a copy that drifts fails silently and expensively: a wrong route makes
 * the click do nothing, a wrong port sends the folder to the wrong DSH (this
 * machine ran both a `dsh web` on 3080 and the Desktop host on 19387 while the
 * verb still pointed at 3080), and a wrong app path opens a blank 401 page
 * instead of the app.
 *
 * So this file is a tripwire, not a specification: it reads the files and
 * asserts the copies are still copies.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'

import { ROUTE_EVENTS, ROUTE_OPEN, ROUTE_STATUS } from '../lib/index.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => readFileSync(join(root, relative), 'utf8')

const launcher = read('scripts/open-in-dsh.ps1')
const verbHost = read('scripts/open-in-dsh.vbs')
const installer = read('scripts/install-menu.ps1')
const clientSource = read('client/index.js')
const clientBundle = read('lib/client.js')

/** The single numeric assignment for a named PowerShell variable. */
function powershellNumber(source, name) {
  const match = source.match(new RegExp(`\\$${name}\\s*=\\s*(\\d+)`))
  assert.ok(match, `no $${name} number in the script`)
  return Number(match[1])
}

test('the launcher calls the route paths the host half exports', () => {
  for (const route of [ROUTE_OPEN, ROUTE_STATUS]) {
    assert.ok(launcher.includes(route), `scripts/open-in-dsh.ps1 does not call ${route}`)
  }
  // The events route is the browser half's, in both the source and the bundle
  // built from it; the launcher has no business following the stream.
  assert.ok(clientSource.includes(ROUTE_EVENTS), `client/index.js does not follow ${ROUTE_EVENTS}`)
  assert.ok(clientBundle.includes(ROUTE_EVENTS), `lib/client.js is stale: rebuild with npm run build`)
  assert.ok(!launcher.includes(ROUTE_EVENTS), 'the launcher must not follow the stream')
})

test('every script agrees on which port the Desktop host listens on', () => {
  const desktopPort = powershellNumber(launcher, 'DesktopPort')
  const webPort = powershellNumber(launcher, 'WebPort')

  // `dsh-desktop-host` starts the Desktop profile with a hard-coded
  // `--no-open --port 19387`; this is the one place the number is written down
  // outside that package, and the assertion is what keeps it honest.
  assert.equal(desktopPort, 19387, 'the Desktop host hard-codes 19387')
  assert.equal(webPort, 3080, 'the historical `dsh web` port')

  const vbsDefault = verbHost.match(/^port = "(\d+)"/m)
  assert.ok(vbsDefault, 'open-in-dsh.vbs has no default port')
  assert.equal(Number(vbsDefault[1]), desktopPort, 'the verb host default port drifted')
})

test('the installer resolves the target through the launcher instead of guessing', () => {
  // One implementation of "which host is this machine running" — the one that
  // runs on every click. The installer stores what it reports.
  assert.match(installer, /-Probe/, 'install-menu.ps1 must ask open-in-dsh.ps1 what it resolves')
  assert.match(installer, /\[int\]\$Port = 0/, 'the installer default must be auto (0), not a pinned port')
  assert.ok(installer.includes('DSHOpen'), 'the installer must write the two HKCU verbs')
})

/**
 * Run the launcher's read-only probe.
 * @param args - extra probe arguments.
 * @returns the parsed report, or null when no PowerShell is available.
 */
function probe(args = []) {
  const shell = ['pwsh', 'powershell'].find((name) => {
    try {
      execFileSync(name, ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  })
  if (shell === undefined) return null
  const output = execFileSync(
    shell,
    ['-NoProfile', '-File', join(root, 'scripts', 'open-in-dsh.ps1'), '-Probe', ...args],
    { encoding: 'utf8' },
  )
  return JSON.parse(output.trim())
}

test('the probe changes nothing and resolves without a Desktop app', () => {
  const report = probe(['-NoAppLaunch'])
  if (report === null) return
  // `-NoAppLaunch` is also "pretend this machine has no Desktop app": the
  // legacy `dsh web` target, with no app to start and no app to raise.
  assert.deepEqual(
    { port: report.port, app: report.app, mode: report.mode },
    { port: 3080, app: '', mode: 'web' },
  )
})

test('a Desktop app is resolved onto the Desktop port', () => {
  const report = probe()
  if (report === null) return
  if (report.mode === 'desktop') {
    assert.equal(report.port, 19387)
    assert.notEqual(report.app, '', 'desktop mode without an app to launch')
  } else {
    assert.equal(report.port, 3080)
    assert.equal(report.app, '')
  }
})

test('a pinned web port keeps the web behaviour even with the app installed', () => {
  const report = probe(['-Port', '3080'])
  if (report === null) return
  // The app may still be reported (it is where the verb's `-App` lands in web
  // mode), but the *flow* must stay the legacy one.
  assert.equal(report.port, 3080)
  assert.equal(report.mode, 'web')
})

test('a stale app path falls back to detection rather than breaking the verb', () => {
  const report = probe(['-App', join(root, 'no-such-app.exe')])
  if (report === null) return
  assert.notEqual(report.app, join(root, 'no-such-app.exe'))
  // Either it found the real app, or this machine has none; both are fine.
  assert.ok(report.app === '' || existsSync(report.app) || report.app.includes('://'))
})
