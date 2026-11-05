/**
 * macOS launcher + Quick Action installer.
 *
 * The Windows half hands a folder to the plugin's loopback route. On macOS
 * none of that applies: the Desktop shell rejects every request that did not
 * come from its own renderer, so the folder goes over as the shell's own launch
 * argument instead. These tests cover what can be checked without opening a
 * Workspace on the running app:
 *
 *   * path canonicalisation (symlinks, trailing separators, relative paths,
 *     spaces and quotes — the Quick Action passes whatever Finder selected),
 *   * the mode matrix (Desktop app vs. `dsh web`, `--port` pinning, a stale
 *     `--app`),
 *   * the generated Automator workflow: valid plists, the launcher path baked
 *     in, and a real `automator -i` run delivering a folder to that launcher.
 *
 * The last one is the point. A workflow that lint-checks but hands the item
 * over as the literal string "$@" looks fine everywhere except on a click.
 *
 * This file deliberately imports nothing from `lib/`: the kernel packages are
 * peer dependencies, so a bare checkout has no node_modules and the shell half
 * must stay testable there.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const launcher = join(root, 'scripts/macos/open-in-dsh')
const installer = join(root, 'scripts/macos/install-macos.sh')
const read = (relative) => readFileSync(join(root, relative), 'utf8')
const darwin = process.platform === 'darwin'

/** A scratch directory per test, so no test can see another's files. */
function scratch() {
  return mkdtempSync(join(tmpdir(), 'dsh-open-macos-'))
}

/**
 * Run the launcher with a clean open-in-dsh environment.
 *
 * The log file is redirected per test: the launcher logs every failure, and a
 * test that asserts "no such folder" must not append to the real user log.
 */
function runLauncher(args, options = {}) {
  const env = { ...process.env }
  delete env.DSH_OPEN_APP
  delete env.DSH_OPEN_PORT
  delete env.DSH_OPEN_DRY_RUN
  env.DSH_OPEN_LOG = join(options.tmp ?? scratch(), 'launcher.log')
  Object.assign(env, options.env ?? {})
  return spawnSync(launcher, args, { encoding: 'utf8', env, cwd: options.cwd })
}

/** Parse one `--print` line into its key=value pairs. */
function parseReport(stdout) {
  const line = stdout.trim().split('\n').pop() ?? ''
  // Values contain spaces (app bundles, folder names), so split on the known
  // keys rather than on whitespace.
  const markers = [...line.matchAll(/(?:^| )(mode|app|exe|running|socket|port|path)=/g)]
  const fields = {}
  markers.forEach((marker, index) => {
    const start = marker.index + marker[0].length
    const end = index + 1 < markers.length ? markers[index + 1].index : line.length
    fields[marker[1]] = line.slice(start, end).trimEnd()
  })
  assert.ok(['desktop', 'web'].includes(fields.mode), `unexpected report: ${line}`)
  return fields
}

test('the launcher and the host half agree on the route they both use', () => {
  const declared = read('lib/index.js').match(/export const ROUTE_OPEN = '([^']+)'/)
  assert.ok(declared, 'lib/index.js no longer declares ROUTE_OPEN')
  assert.match(read('scripts/macos/open-in-dsh'), new RegExp(`ROUTE_OPEN='${declared[1]}'`))
})

test('the launcher and the host half agree on the handoff socket path', () => {
  assert.match(read('lib/index.js'), /DEFAULT_SOCKET_PATH = join\(homedir\(\), '\.dsh', 'run', 'dsh-open-in-dsh\.sock'\)/)
  assert.match(read('scripts/macos/open-in-dsh'), /SOCKET_PATH_DEFAULT="\$HOME\/\.dsh\/run\/dsh-open-in-dsh\.sock"/)
})

test('the desktop handoff no longer passes the launch argument 2.0.19 removed', () => {
  // Passing --dsh-desktop-workspace to the packaged executable now dies in
  // Chromium's option parser ("bad option", exit 9), so the launcher must not
  // mention it at all — the socket is the whole hand-off.
  const launcherText = read('scripts/macos/open-in-dsh')
  // 注释里可以提它为什么被替换，但不能再把它当参数传出去。
  assert.ok(!/"\$exe" "--dsh-desktop-workspace/.test(launcherText), 'launcher still passes the removed argument to the executable')
  assert.ok(!/--args "--dsh-desktop-workspace/.test(launcherText), 'cold start still passes the removed argument')
  assert.match(launcherText, /--unix-socket "\$socket_path"/)
})

test('a folder with spaces, quotes and a trailing separator reports its real path', { skip: !darwin }, () => {
  const tmp = scratch()
  const dir = join(tmp, "带 空格 'q'")
  mkdirSync(dir)
  const report = parseReport(runLauncher(['--print', `${dir}/`], { tmp }).stdout)
  assert.equal(report.path, realpathSync(dir))
})

test('a relative folder is resolved against the current directory', { skip: !darwin }, () => {
  const tmp = scratch()
  const dir = join(tmp, 'sub')
  mkdirSync(dir)
  const result = runLauncher(['--print', 'sub'], { tmp, cwd: tmp })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(parseReport(result.stdout).path, realpathSync(dir))
})

test('a symlinked folder resolves to its target, not to the link', { skip: !darwin }, () => {
  const tmp = scratch()
  const target = join(tmp, 'real')
  mkdirSync(target)
  const link = join(tmp, 'link')
  symlinkSync(target, link)
  const report = parseReport(runLauncher(['--print', link], { tmp }).stdout)
  assert.equal(report.path, realpathSync(target))
  assert.equal(lstatSync(link).isSymbolicLink(), true)
})

test('a file is refused as "not a folder", a missing path as "no such folder"', { skip: !darwin }, () => {
  const tmp = scratch()
  const file = join(tmp, 'a.txt')
  writeFileSync(file, 'x')
  const notFolder = runLauncher(['--print', file], { tmp })
  assert.equal(notFolder.status, 2)
  assert.match(notFolder.stderr, /not a folder/)
  const missing = runLauncher(['--print', join(tmp, 'gone')], { tmp })
  assert.equal(missing.status, 2)
  assert.match(missing.stderr, /no such folder/)
})

test('no argument means the current directory, which is what a terminal click is', { skip: !darwin }, () => {
  const tmp = scratch()
  const result = runLauncher(['--print'], { tmp, cwd: tmp })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(parseReport(result.stdout).path, realpathSync(tmp))
})

test('the Desktop app is resolved, and a stale --app falls back to detection', { skip: !darwin }, () => {
  const tmp = scratch()
  const report = parseReport(runLauncher(['--print', tmp], { tmp }).stdout)
  if (report.mode === 'desktop') {
    assert.equal(existsSync(report.app), true, 'reported app does not exist')
    assert.equal(existsSync(report.exe), true, 'reported executable does not exist')
    assert.match(report.running, /^[01]$/)
  } else {
    assert.equal(report.port, '3080')
  }
  const stale = runLauncher(['--print', '--app', join(tmp, 'no-such.app'), tmp], { tmp })
  assert.equal(stale.status, 0, stale.stderr)
  assert.equal(parseReport(stale.stdout).mode, report.mode)
})

test('--port pins the legacy dsh web route even with the app installed', { skip: !darwin }, () => {
  const tmp = scratch()
  const report = parseReport(runLauncher(['--print', '--port', '3080', tmp], { tmp }).stdout)
  assert.equal(report.mode, 'web')
  assert.equal(report.port, '3080')
  assert.equal(report.path, realpathSync(tmp))
})

/**
 * Install the workflow against a probe launcher that records its arguments.
 *
 * The extra service defaults to off so these cases do not depend on what is
 * installed on the machine; the QSpace cases below pass the scope explicitly.
 */
function installProbe(services, bin, probe, argsFile, extra = ['--qspace', 'off']) {
  writeFileSync(probe, '#!/bin/sh\nprintf "%s\\n" "$@" >>"' + argsFile + '"\n')
  chmodSync(probe, 0o755)
  return spawnSync(
    installer,
    ['install', '--launcher', probe, '--services-dir', services, '--bin-dir', bin, ...extra],
    { encoding: 'utf8' },
  )
}

/** The plist value at one key path, or '' when the key is absent. */
function plistValue(plist, keyPath) {
  const result = spawnSync('/usr/libexec/PlistBuddy', ['-c', `Print :${keyPath}`, plist], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : ''
}

test('the installer writes a lint-clean workflow that calls the launcher it was given', { skip: !darwin }, () => {
  const tmp = scratch()
  const services = join(tmp, 'Services')
  const bin = join(tmp, 'bin')
  const probe = join(tmp, 'probe-launcher')
  const install = installProbe(services, bin, probe, join(tmp, 'probe-args.txt'))
  assert.equal(install.status, 0, install.stderr)

  const workflow = join(services, '通过 DSH 打开.workflow')
  const info = join(workflow, 'Contents/Info.plist')
  const document = join(workflow, 'Contents/document.wflow')
  assert.equal(spawnSync('plutil', ['-lint', info, document]).status, 0, 'generated plists do not lint')
  assert.match(readFileSync(info, 'utf8'), /public\.folder/)
  const wflow = readFileSync(document, 'utf8')
  assert.ok(wflow.includes(probe), 'workflow does not call the launcher it was installed with')
  assert.ok(wflow.includes('for f in "$@"; do'), 'workflow does not iterate the selected items')
  assert.equal(readlinkSync(join(bin, 'dsh-open')), probe)
})

test('the generated workflow actually delivers a folder to the launcher', { skip: !darwin }, () => {
  const tmp = scratch()
  const services = join(tmp, 'Services')
  const bin = join(tmp, 'bin')
  const probe = join(tmp, 'probe-launcher')
  const argsFile = join(tmp, 'probe-args.txt')
  const install = installProbe(services, bin, probe, argsFile)
  assert.equal(install.status, 0, install.stderr)

  const folder = join(tmp, "选中的 文件夹 'q'")
  mkdirSync(folder)
  const run = spawnSync('automator', ['-i', folder, join(services, '通过 DSH 打开.workflow')], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(readFileSync(argsFile, 'utf8').trim(), folder)
})

test('a moved checkout makes the workflow say what to re-run, not fail bare', { skip: !darwin }, () => {
  // Measured 2026-11-05: the repository moved into Code/Dsh/ and the Quick
  // Action, whose launcher path is baked at install time, failed with
  // 「操作“运行Shell脚本”遇到了错误 -: line 2: <old path>: No such file or directory」.
  // The workflow must name the missing path and the installer to re-run.
  const tmp = scratch()
  const services = join(tmp, 'Services')
  const bin = join(tmp, 'bin')
  const probe = join(tmp, 'probe-launcher')
  const argsFile = join(tmp, 'probe-args.txt')
  const install = installProbe(services, bin, probe, argsFile)
  assert.equal(install.status, 0, install.stderr)

  const document = join(services, '通过 DSH 打开.workflow/Contents/document.wflow')
  const payload = join(tmp, 'action.sh')
  writeFileSync(payload, `${plistValue(document, 'actions:0:action:ActionParameters:COMMAND_STRING')}\n`)
  const alertFile = join(tmp, 'alert-args.txt')
  const fakeBin = join(tmp, 'fakebin')
  mkdirSync(fakeBin)
  // The alert is checked, not shown: a real osascript here would put a modal
  // dialog on the screen of whoever runs the tests.
  const fakeOsascript = join(fakeBin, 'osascript')
  writeFileSync(fakeOsascript, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(alertFile)}\n`)
  chmodSync(fakeOsascript, 0o755)
  const folder = join(tmp, 'folder')
  mkdirSync(folder)

  rmSync(probe) // the checkout moved: the baked absolute path is gone
  const run = spawnSync('/bin/sh', [payload, folder], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${fakeBin}:/usr/bin:/bin` },
  })
  assert.equal(run.status, 0, run.stderr)
  const alert = readFileSync(alertFile, 'utf8')
  assert.match(alert, /找不到启动器/)
  assert.ok(alert.includes(probe), 'the alert does not name the missing launcher')
  assert.equal(existsSync(argsFile), false, 'a missing launcher was still invoked')

  // No osascript at all (a broken PATH): the action must fail loudly instead of
  // looking like a click that did nothing.
  const noOsascript = spawnSync('/bin/sh', [payload, folder], {
    encoding: 'utf8',
    env: { ...process.env, PATH: '/nonexistent' },
  })
  assert.equal(noOsascript.status, 1)
  assert.match(noOsascript.stderr, /launcher missing/)
})

test('status reports a stale workflow, and says so with a non-zero exit', { skip: !darwin }, () => {
  const tmp = scratch()
  const services = join(tmp, 'Services')
  const bin = join(tmp, 'bin')
  const probe = join(tmp, 'probe-launcher')
  const install = installProbe(services, bin, probe, join(tmp, 'probe-args.txt'))
  assert.equal(install.status, 0, install.stderr)

  const fresh = spawnSync(installer, ['status', '--launcher', probe, '--services-dir', services, '--bin-dir', bin], { encoding: 'utf8' })
  assert.equal(fresh.status, 0, fresh.stderr)
  assert.match(fresh.stdout, /matches this installer/)

  // What a moved checkout looks like: the workflow still runs the old absolute
  // path while this installer sits at a new one.
  const moved = join(tmp, 'moved', 'open-in-dsh')
  const stale = spawnSync(installer, ['status', '--launcher', moved, '--services-dir', services, '--bin-dir', bin], { encoding: 'utf8' })
  assert.equal(stale.status, 1)
  assert.match(stale.stdout, /STALE/)
  assert.ok(stale.stdout.includes(probe), 'status does not name the path the workflow would run')
})

test('QSpace gets its own service: same label and script, scoped to its bundle id', { skip: !darwin }, () => {
  const tmp = scratch()
  const services = join(tmp, 'Services')
  const bin = join(tmp, 'bin')
  const probe = join(tmp, 'probe-launcher')
  const install = installProbe(services, bin, probe, join(tmp, 'probe-args.txt'), ['--qspace', 'com.jinghaoshe.qspace.pro'])
  assert.equal(install.status, 0, install.stderr)

  // The Finder Quick Action cannot be reused inside QSpace: AppKit only offers a
  // service whose NSRequiredContext allows the frontmost app, so a second bundle
  // is the only way to get a 服务 entry there.
  const qspace = join(services, '通过 DSH 打开 (QSpace).workflow')
  const info = join(qspace, 'Contents/Info.plist')
  assert.equal(spawnSync('plutil', ['-lint', info, join(qspace, 'Contents/document.wflow')]).status, 0, 'QSpace plists do not lint')
  assert.equal(plistValue(info, 'NSServices:0:NSRequiredContext:NSApplicationIdentifier'), 'com.jinghaoshe.qspace.pro')
  assert.equal(plistValue(info, 'NSServices:0:NSMenuItem:default'), '通过 DSH 打开')
  assert.equal(plistValue(join(services, '通过 DSH 打开.workflow/Contents/Info.plist'), 'NSServices:0:NSRequiredContext:NSApplicationIdentifier'), 'com.apple.finder')
  // The menu title is read from the plist value verbatim; a stray newline in
  // there becomes a gap before the label (pbs reported "\n通过 DSH 打开").
  assert.ok(!/<string>\s*\n/.test(readFileSync(info, 'utf8')), 'menu label starts with a newline')
  assert.ok(readFileSync(join(qspace, 'Contents/document.wflow'), 'utf8').includes(probe))
})

test('--qspace off installs no extra bundle, --qspace any drops the scope', { skip: !darwin }, () => {
  const tmp = scratch()
  const services = join(tmp, 'Services')
  const bin = join(tmp, 'bin')
  const probe = join(tmp, 'probe-launcher')
  const extra = join(services, '通过 DSH 打开 (QSpace).workflow')

  const off = installProbe(services, bin, probe, join(tmp, 'args.txt'), ['--qspace', 'off'])
  assert.equal(off.status, 0, off.stderr)
  assert.equal(existsSync(extra), false, '--qspace off still installed a bundle')

  const any = installProbe(services, bin, probe, join(tmp, 'args.txt'), ['--qspace', 'any'])
  assert.equal(any.status, 0, any.stderr)
  const info = join(extra, 'Contents/Info.plist')
  assert.equal(plistValue(info, 'NSServices:0:NSRequiredContext:NSApplicationIdentifier'), '')
  assert.equal(plistValue(info, 'NSServices:0:NSMenuItem:default'), '通过 DSH 打开')
})

test('uninstall removes the workflow and the command, and leaves other files alone', { skip: !darwin }, () => {
  const tmp = scratch()
  const services = join(tmp, 'Services')
  const bin = join(tmp, 'bin')
  const probe = join(tmp, 'probe-launcher')
  const install = installProbe(services, bin, probe, join(tmp, 'probe-args.txt'), ['--qspace', 'com.jinghaoshe.qspace.pro'])
  assert.equal(install.status, 0, install.stderr)
  const unrelated = join(bin, 'keep-me')
  writeFileSync(unrelated, 'x')
  const uninstall = spawnSync(installer, ['uninstall', '--launcher', probe, '--services-dir', services, '--bin-dir', bin], { encoding: 'utf8' })
  assert.equal(uninstall.status, 0, uninstall.stderr)
  assert.equal(existsSync(join(services, '通过 DSH 打开.workflow')), false)
  assert.equal(existsSync(join(services, '通过 DSH 打开 (QSpace).workflow')), false)
  assert.equal(existsSync(join(bin, 'dsh-open')), false)
  assert.equal(existsSync(unrelated), true)
})

