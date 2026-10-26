<#
.SYNOPSIS
  Register (or remove) the Explorer context-menu verb "通过 DSH 打开".

.DESCRIPTION
  Writes two HKCU verbs — one for a right-clicked folder, one for the blank
  area inside a folder — that both run `scripts/open-in-dsh.vbs`, which hands
  the folder Explorer substitutes for `%V` to `open-in-dsh.ps1`.

  The verb deliberately points at `wscript.exe` rather than at PowerShell: a
  console application always has a console window created before it can hide
  it, which shows as a flicker on every right-click. wscript is GUI-subsystem,
  so no console exists to flash.

  HKCU, not HKLM: nothing here needs elevation, and a per-user verb is the
  right blast radius for a personal tool.

  Windows 11: measured on build 26200, a classic verb registered this way does
  appear in the trimmed top-level menu (next to PowerShell 7 and VS Code), not
  only under "显示更多选项". No MSIX sparse package or `IExplorerCommand` is
  needed for this machine's build. Explorer caches context menus per process,
  so restart the shell once after installing.

.PARAMETER Action
  install, uninstall, or status.

.PARAMETER Port
  The host port baked into the verb. 0 (the default) asks the launcher what it
  resolves right now: the DSH Desktop port (19387) when a Desktop app is
  installed, otherwise the `dsh web` port (3080). Pass a number to pin it.

.PARAMETER App
  The Desktop app baked into the verb: an .exe, a .lnk, or the `dsh://open` URI
  the shell registers. Empty (the default) resolves it the same way — the
  launcher's own auto-detection — and stores the result, so a click never has to
  guess. The launcher re-resolves by itself if that path later disappears.

.PARAMETER VerbText
  The menu label.
#>
[CmdletBinding()]
param(
  [ValidateSet('install', 'uninstall', 'status')][string]$Action = 'install',
  [int]$Port = 0,
  [string]$VerbText = '通过 DSH 打开',
  [string]$App = ''
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $PSScriptRoot 'open-in-dsh.ps1'
$verbHost = Join-Path $PSScriptRoot 'open-in-dsh.vbs'
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$iconPath = Join-Path $root 'assets\icon.ico'

$verbKeys = @(
  'HKCU:\Software\Classes\Directory\shell\DSHOpen',
  'HKCU:\Software\Classes\Directory\Background\shell\DSHOpen'
)

<#
  Draw the menu icon once.

  The shell reads an icon from a file, not from the SVG the Web UI ships, so a
  small .ico is generated here rather than sourced. A failure is not fatal: the
  verb simply falls back to the shell's generic icon.
#>
function New-MenuIcon([string]$Target) {
  if (Test-Path -LiteralPath $Target) { return }
  try {
    Add-Type -AssemblyName System.Drawing
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Target) | Out-Null

    $size = 256
    $bitmap = New-Object System.Drawing.Bitmap($size, $size)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
    $graphics.Clear([System.Drawing.Color]::Transparent)

    $rect = New-Object System.Drawing.Rectangle(16, 16, 224, 224)
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
      $rect,
      [System.Drawing.Color]::FromArgb(255, 96, 128, 255),
      [System.Drawing.Color]::FromArgb(255, 38, 60, 200),
      45.0
    )
    $graphics.FillRectangle($brush, $rect)

    $font = New-Object System.Drawing.Font('Segoe UI', 78, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $format = New-Object System.Drawing.StringFormat
    $format.Alignment = [System.Drawing.StringAlignment]::Center
    $format.LineAlignment = [System.Drawing.StringAlignment]::Center
    $box = New-Object System.Drawing.RectangleF(16, 16, 224, 224)
    $graphics.DrawString('DSH', $font, [System.Drawing.Brushes]::White, $box, $format)

    $icon = [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())
    $stream = [System.IO.File]::Create($Target)
    try { $icon.Save($stream) } finally { $stream.Close() }

    $graphics.Dispose()
    $bitmap.Dispose()
  } catch {
    Write-Warning "icon not generated ($Target): $($_.Exception.Message)"
  }
}

<#
  Write one verb: label, icon, and the command line Explorer runs.

  `MultiSelectModel` is deliberately NOT written. Its `Single` value reads as
  "applies when exactly one item is selected", which is true for a right-clicked
  folder but false for the blank area of a folder — and Explorer answers that by
  removing the verb from the background menu entirely. Verified against a
  control verb: identical key and parent, no `MultiSelectModel`, renders in both
  menus.
#>
function Set-Verb([string]$Key, [string]$Text, [string]$Icon, [string]$Command, [string]$Position) {
  New-Item -Path $Key -Force | Out-Null
  Set-ItemProperty -Path $Key -Name '(default)' -Value $Text
  Remove-ItemProperty -Path $Key -Name 'MultiSelectModel' -ErrorAction SilentlyContinue
  if (-not [string]::IsNullOrWhiteSpace($Position)) {
    Set-ItemProperty -Path $Key -Name 'Position' -Value $Position
  } else {
    Remove-ItemProperty -Path $Key -Name 'Position' -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $Icon) {
    Set-ItemProperty -Path $Key -Name 'Icon' -Value $Icon
  }
  New-Item -Path (Join-Path $Key 'command') -Force | Out-Null
  Set-ItemProperty -Path (Join-Path $Key 'command') -Name '(default)' -Value $Command
}

if ($Action -eq 'uninstall') {
  foreach ($key in $verbKeys) {
    if (Test-Path $key) {
      Remove-Item -Path $key -Recurse -Force
      Write-Output "removed $key"
    }
  }
  exit 0
}

if ($Action -eq 'status') {
  foreach ($key in $verbKeys) {
    if (Test-Path $key) {
      $text = (Get-ItemProperty -Path $key).'(default)'
      $command = (Get-ItemProperty -Path (Join-Path $key 'command')).'(default)'
      Write-Output "$key`n  label:   $text`n  command: $command"
    } else {
      Write-Output "$key`n  (not registered)"
    }
  }
  # What a click would do *now*: the registered command line is a snapshot, and
  # the interesting failures (host moved, app uninstalled, app not running) only
  # show up against the live machine.
  if (Test-Path -LiteralPath $launcher) {
    $probe = (& $launcher -Probe) | ConvertFrom-Json
    Write-Output ''
    Write-Output 'resolved now:'
    Write-Output "  mode:    $($probe.mode)"
    Write-Output "  port:    $($probe.port)   (host answering: $($probe.host), pages following: $($probe.clients))"
    Write-Output "  app:     $(if ($probe.app -eq '') { '(none - browser fallback)' } else { $probe.app })"
  }
  exit 0
}

if (-not (Test-Path -LiteralPath $launcher)) {
  throw "launcher missing: $launcher"
}
if (-not (Test-Path -LiteralPath $verbHost)) {
  throw "verb host missing: $verbHost"
}
if (-not (Test-Path -LiteralPath $wscript)) {
  throw "wscript missing: $wscript"
}

New-MenuIcon $iconPath

# The verb points at `wscript.exe`, never at PowerShell. wscript is a
# GUI-subsystem host, so Windows creates no console for it; PowerShell, being a
# console application, always gets one created before it can hide it — that
# late hide is the flicker. The verb host passes the folder through the process
# environment, which is also why no path ever appears on this command line.
#
# Port and app are resolved by asking the launcher itself (`-Probe` announces
# nothing and launches nothing), so there is exactly one implementation of
# "which host is this machine running" in the repository — the one that runs on
# every click. The resolved values are then stored, so a click does not depend
# on detection succeeding twice.
$resolution = (& $launcher -Probe -Port $Port -App $App) | ConvertFrom-Json
$verbPort = [int]$resolution.port
$verbApp = [string]$resolution.app

$appArg = ''
if (-not [string]::IsNullOrWhiteSpace($verbApp)) {
  $appArg = ' "{0}"' -f $verbApp
}
$command = '"{0}" //nologo "{1}" "%V" {2}{3}' -f $wscript, $verbHost, $verbPort, $appArg

Set-Verb $verbKeys[0] $VerbText $iconPath $command ''
# No `Position` either: the Windows 11 menus order their own entries, and the
# value bought nothing measurable while adding one more thing to be wrong.
Set-Verb $verbKeys[1] $VerbText $iconPath $command ''

Write-Output "registered '$VerbText' on:"
Write-Output "  $($verbKeys[0])   (right-click a folder)"
Write-Output "  $($verbKeys[1])   (right-click inside a folder)"
Write-Output "  host:        $wscript -> $verbHost   (no console window)"
Write-Output "  target:      $($resolution.mode) host, port $verbPort"
if ($verbApp -ne '') {
  Write-Output "  app:         $verbApp   (cold start + window raise)"
} else {
  Write-Output '  app:         (none found - a cold start opens the Web URL in the browser)'
}
if (Test-Path -LiteralPath $iconPath) { Write-Output "  icon:        $iconPath" }
Write-Output ''
Write-Output 'Windows 11: restart Explorer (or sign out and back in) once so the'
Write-Output 'shell rebuilds its context-menu cache, then right-click any folder.'
