<#
.SYNOPSIS
  Explorer verb launcher: hand one folder to the running DSH host.

.DESCRIPTION
  Registered as the `command` of the "通过 DSH 打开" context-menu verb, this
  script is the only thing that runs when the verb is clicked. It does three
  things and nothing else:

    1. POST the folder to the plugin's route on the local DSH host.
    2. When nothing is listening — the Desktop app is closed — start the
       Desktop app and post again once its server is up.
    3. Bring the DSH window to the front: a right-click means Explorer had the
       focus, so the DSH window is behind it (or hidden in the tray).

  It never creates a Workspace or a Session itself: that decision belongs to
  the page, which owns Workspace navigation.

  Two deployments run the same script, and the presence of a Desktop app
  decides which one this is:

    * **DSH 桌面版** (profile `desktop`, port 19387). The host is the Electron
      app itself, so "nothing is listening" means "the app is closed", and
      starting the app is the only thing that can help. There is deliberately
      no browser fallback here: the Desktop host serves every page at the
      authenticated URL the shell owns, and a bare
      `http://127.0.0.1:19387/` answers
      `401 dsh web authentication required`. Opening that URL would give the
      user an error page instead of their folder.

      Raising the window uses the shell's own single-instance behaviour:
      launching the app a second time hits `requestSingleInstanceLock()`, and
      the running instance answers with `second-instance` → `focusPrimaryWindow()`
      (restore, show, focus). That is the supported way to raise it from the
      outside; a page inside the app cannot do it, because the shell exposes no
      window-raising IPC to the product frame.

    * **`dsh web` node host** (port 3080). The legacy deployment, kept for a
      machine that has no Desktop app installed: the host can be up with no
      window at all, so the fallback is to open the Web URL in the browser.

  There is no console window: this script is started hidden by
  `scripts/open-in-dsh.vbs`, and every failure is reported through a message
  box rather than a stream nobody would see.

.PARAMETER Path
  The folder. Explorer substitutes this from the verb's `%V`; absent, it is read
  from `DSH_OPEN_PATH`, which is how the verb host passes it.

.PARAMETER Port
  The host port. Absent or 0, it is read from `DSH_OPEN_PORT`, then resolved:
  the Desktop port when a Desktop app is available, otherwise the `dsh web`
  port. Pass an explicit port to pin it.

.PARAMETER App
  The Desktop app to start and raise: an `.exe`, a `.lnk`, or the `dsh://open`
  URI the shell registers. Absent, it is read from `DSH_OPEN_APP`, then
  auto-detected. Pass `-NoAppLaunch` for none at all. On a `dsh web` port it
  keeps its historical meaning — the window to open when nobody is following.

.PARAMETER NoAppLaunch
  Never start or raise anything, and never fall back to a browser; only
  announce the folder. It also means "pretend this machine has no Desktop app":
  the port then resolves to the `dsh web` default instead of the Desktop one.
  Used by tests.

.PARAMETER Probe
  Report what this script resolved — port, app, whether the host answers —
  without announcing anything. Used by tests and by `install-menu.ps1 -Action status`.

.PARAMETER WaitSeconds
  How long to keep posting while a freshly started Desktop app boots.

.EXAMPLE
  pwsh -NoProfile -File .\scripts\open-in-dsh.ps1 -Path 'D:\project' -NoAppLaunch

.EXAMPLE
  pwsh -NoProfile -File .\scripts\open-in-dsh.ps1 -Probe
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)][string]$Path = '',
  [int]$Port = 0,
  [string]$App = '',
  [switch]$NoAppLaunch,
  [switch]$Probe,
  [int]$WaitSeconds = 30
)

$ErrorActionPreference = 'Stop'

# The two ports that exist in the wild. 19387 is the Desktop shell's own
# hard-coded port (`dsh-desktop-host` starts the profile with
# `--no-open --port 19387`); 3080 is the historical `dsh web` port this
# repository's README was written around. Mirrored in `install-menu.ps1` and
# asserted against the scripts by `test/scripts.test.mjs`.
$DesktopPort = 19387
$WebPort = 3080

# `scripts/open-in-dsh.vbs` hands these over through the process environment
# rather than the command line, so a folder name containing a space, an
# apostrophe or a trailing separator never has to survive being re-quoted.
if ([string]::IsNullOrWhiteSpace($Path)) { $Path = [string]$env:DSH_OPEN_PATH }
if ([string]::IsNullOrWhiteSpace($App)) { $App = [string]$env:DSH_OPEN_APP }
if ($Port -le 0) {
  $envPort = 0
  if ([int]::TryParse([string]$env:DSH_OPEN_PORT, [ref]$envPort) -and $envPort -gt 0) {
    $Port = $envPort
  }
}

<#
  Canonicalize what Explorer handed over.

  `%V` is the selected folder for a folder verb and the current folder for a
  background verb; at the top of a drive it is `D:\`, and `D:` without the
  separator appears when something upstream already trimmed it.
#>
function Get-CanonicalFolder([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
  $text = $Value.Trim().Trim('"')
  if ($text -match '^[A-Za-z]:$') { $text = "$text\" }
  if ($text.Length -gt 3) { $text = $text.TrimEnd('\', '/') }
  if (-not (Test-Path -LiteralPath $text -PathType Container)) { return $null }
  return (Resolve-Path -LiteralPath $text).ProviderPath
}

<#
  Report a failure where the user can see it.

  The verb runs hidden, so an exception would vanish. A message box is the only
  channel left that does not require the user to go looking for a log.
#>
function Show-Failure([string]$Message) {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
      $Message,
      'DSH',
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Warning
    ) | Out-Null
  } catch {
    # Even the message box can fail on a session without a desktop.
  }
}

<# Join a path without failing on an environment variable Windows may not set. #>
function Join-Candidate([string]$Root, [string]$Relative) {
  if ([string]::IsNullOrWhiteSpace($Root)) { return '' }
  return (Join-Path $Root $Relative)
}

<#
  Where the Desktop app may be, newest layout first.

  The per-user install (`%LOCALAPPDATA%\Programs`) is where the current
  installer puts it; the Start Menu shortcut is checked because the shortcut
  survives an install location the script does not know about.
#>
function Get-DshAppCandidates {
  @(
    (Join-Candidate $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'),
    (Join-Candidate $env:ProgramFiles 'DeepSeek Harness\DeepSeek Harness.exe'),
    (Join-Candidate ${env:ProgramFiles(x86)} 'DeepSeek Harness\DeepSeek Harness.exe'),
    (Join-Candidate $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\DeepSeek Harness.lnk')
  ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
}

<#
  Resolve the Desktop app to start and raise.

  An explicit value wins, but only while it still points at something: an app
  update can move the file, and a stale registry entry must not break the verb.
  The last resort is the `dsh://open` URI, which the shell registers with the
  OS for exactly this purpose (`focusPrimaryWindow`); ShellExecute on it starts
  the app or hands it to the running instance.

  @returns the app to launch, or '' when this machine has no Desktop app.
#>
function Resolve-DshApp([string]$Explicit) {
  if (-not [string]::IsNullOrWhiteSpace($Explicit)) {
    # A URI scheme, not a path: nothing to look up on disk.
    if ($Explicit -match '^[A-Za-z][A-Za-z0-9+.-]*://') { return $Explicit }
    if (Test-Path -LiteralPath $Explicit) { return $Explicit }
  }
  foreach ($candidate in (Get-DshAppCandidates)) {
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  if (Test-Path 'HKCU:\Software\Classes\dsh\shell\open\command') { return 'dsh://open' }
  return ''
}

<# GET the side-effect-free follower count; $null when nothing answers. #>
function Test-HostAlive([int]$HostPort) {
  try {
    return (Invoke-RestMethod -Uri "http://127.0.0.1:$HostPort/dsh-open-in-dsh/api/v1/status" -Method Get -TimeoutSec 2)
  } catch {
    return $null
  }
}

$desktopApp = ''
if (-not $NoAppLaunch) { $desktopApp = Resolve-DshApp $App }

# No explicit port: prefer the Desktop host when the Desktop app exists. That
# is the whole point of the check — with the app installed, a `dsh web` left
# running on 3080 must not capture the right-click.
if ($Port -le 0) {
  if ($desktopApp -ne '') { $Port = $DesktopPort } else { $Port = $WebPort }
}

# Which deployment this run is: the Desktop one only when the Desktop port was
# resolved *and* an app exists to start. Pinning `-Port 3080` on a machine that
# also has the Desktop app therefore keeps the `dsh web` behaviour instead of
# launching the wrong thing — and an explicit `-App` still works there as the
# old `-AppShortcut` did: the window to open when nobody is following.
$desktopMode = ($desktopApp -ne '') -and ($Port -eq $DesktopPort)

if ($Probe) {
  $status = Test-HostAlive $Port
  $report = [ordered]@{
    port   = $Port
    app    = $desktopApp
    mode   = if ($desktopMode) { 'desktop' } else { 'web' }
    host   = ($null -ne $status)
    clients = if ($null -ne $status) { [int]$status.clients } else { $null }
  }
  [pscustomobject]$report | ConvertTo-Json -Compress
  exit 0
}

$target = Get-CanonicalFolder $Path
if ($null -eq $target) {
  # The verb only fires on folders, so this is a shell oddity, not a user error.
  exit 0
}

$endpoint = "http://127.0.0.1:$Port/dsh-open-in-dsh/api/v1/open"
$payload = @{ path = $target } | ConvertTo-Json -Compress

$reply = $null
$lastError = ''
try {
  $reply = Invoke-RestMethod -Uri $endpoint -Method Post -ContentType 'application/json' -Body $payload -TimeoutSec 5
} catch {
  $lastError = $_.Exception.Message
}

# Nothing answered. In the Desktop deployment that is not an error, it is the
# cold start: the host *is* the app, so the app has to come up first and the
# announcement has to wait for it. In the `dsh web` deployment the host is a
# service the user starts, and there is nothing to launch.
$launched = $false
if ($null -eq $reply -and $desktopMode) {
  try {
    Start-Process -FilePath $desktopApp
    $launched = $true
  } catch {
    Show-Failure "无法启动 DSH 桌面版（$desktopApp）。`n`n$($_.Exception.Message)"
    exit 1
  }

  $deadline = (Get-Date).AddSeconds($WaitSeconds)
  while ($null -eq $reply -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 700
    try {
      $reply = Invoke-RestMethod -Uri $endpoint -Method Post -ContentType 'application/json' -Body $payload -TimeoutSec 3
      $lastError = ''
    } catch {
      $lastError = $_.Exception.Message
    }
  }
}

if ($null -eq $reply) {
  if ($desktopMode) {
    Show-Failure "已启动 DSH 桌面版，但在 $WaitSeconds 秒内没能连上它（$endpoint）。`n`n请确认 DSH 已正常打开后重试。`n`n$lastError"
  } else {
    Show-Failure "无法连接 DSH（$endpoint）。`n`n请确认 dsh web 正在运行，然后重试。`n`n$lastError"
  }
  exit 1
}

if (-not $reply.ok) {
  Show-Failure "DSH 没有接受这个目录：$target`n`n原因：$($reply.reason)"
  exit 1
}

if ($NoAppLaunch) { exit 0 }

if ($desktopMode) {
  # The request is delivered (a live page) or replayable for
  # `backlogTtlMs` (a page that is still loading), so what is missing is the
  # window: Explorer had the focus, which is why the app is behind it or hidden
  # in the tray. A second launch is how the shell raises itself; skip it when
  # this run already started the app, since that window is on its way up.
  if (-not $launched) {
    try {
      Start-Process -FilePath $desktopApp
    } catch {
      # The folder is open either way; a failed raise is not worth a dialog.
    }
  }
  exit 0
}

# ---- `dsh web` node host: the pre-Desktop behaviour, unchanged ----
if ([int]$reply.clients -gt 0) { exit 0 }

# Nobody was following when the folder was announced, so the request is sitting
# in the replay window and needs a page to land on. But "nobody right now" is
# also what a page in the middle of reconnecting looks like — and opening a
# browser for that would be a window nobody asked for. `recent` says the host
# saw a page go away moments ago, so wait that reconnect out first. A real cold
# start (no page for a while) skips the wait and opens immediately.
if ($reply.recent -eq $true) {
  $statusUrl = "http://127.0.0.1:$Port/dsh-open-in-dsh/api/v1/status"
  $deadline = (Get-Date).AddSeconds(4)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 400
    try {
      $status = Invoke-RestMethod -Uri $statusUrl -Method Get -TimeoutSec 3
      if ([int]$status.clients -gt 0) { exit 0 }
    } catch {
      # A failed probe only means keep waiting; the grace period decides.
    }
  }
}

# An explicit `-App` is the historical `-AppShortcut`: the thing to open when
# nobody is following. Without one, the Web URL is all a `dsh web` host offers.
if ($desktopApp -ne '') {
  Start-Process -FilePath $desktopApp
} else {
  Start-Process "http://127.0.0.1:$Port/"
}

exit 0
