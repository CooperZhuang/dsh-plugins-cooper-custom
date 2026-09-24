<#
.SYNOPSIS
  Explorer verb launcher: hand one folder to the running `dsh web` host.

.DESCRIPTION
  Registered as the `command` of the "通过 DSH 打开" context-menu verb, this
  script is the only thing that runs when the verb is clicked. It does two
  things and nothing else:

    1. POST the folder to the plugin's route on the local `dsh web` server.
       The host answers with how many DSH pages are currently following it.
    2. When no page is following — DSH is closed, or the window is gone — open
       the app, so the request still lands (the page replays it on connect).

  It never creates a Workspace or a Session itself: that decision belongs to
  the page, which owns Workspace navigation.

  There is no console window: the verb launches PowerShell with
  -WindowStyle Hidden, and every failure is reported through a message box
  rather than a stream nobody would see.

.PARAMETER Path
  The folder. Explorer substitutes this from the verb's `%V`; absent, it is read
  from `DSH_OPEN_PATH`, which is how the verb host passes it.

.PARAMETER Port
  The `dsh web` port. Absent, it is read from `DSH_OPEN_PORT`, then 3080.

.PARAMETER AppShortcut
  Optional .lnk to launch when DSH is not open. Empty falls back to opening
  the Web URL in the default browser.

.PARAMETER NoAppLaunch
  Never open anything; only announce the folder. Used by tests.

.EXAMPLE
  pwsh -NoProfile -File .\scripts\open-in-dsh.ps1 -Path 'D:\project' -NoAppLaunch
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)][string]$Path = '',
  [int]$Port = 0,
  [string]$AppShortcut = '',
  [switch]$NoAppLaunch
)

$ErrorActionPreference = 'Stop'

# `scripts/open-in-dsh.vbs` hands these over through the process environment
# rather than the command line, so a folder name containing a space, an
# apostrophe or a trailing separator never has to survive being re-quoted.
if ([string]::IsNullOrWhiteSpace($Path)) { $Path = [string]$env:DSH_OPEN_PATH }
if ($Port -le 0) {
  $envPort = 0
  if ([int]::TryParse([string]$env:DSH_OPEN_PORT, [ref]$envPort) -and $envPort -gt 0) {
    $Port = $envPort
  } else {
    $Port = 3080
  }
}
if ([string]::IsNullOrWhiteSpace($AppShortcut)) { $AppShortcut = [string]$env:DSH_OPEN_APP }

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

$target = Get-CanonicalFolder $Path
if ($null -eq $target) {
  # The verb only fires on folders, so this is a shell oddity, not a user error.
  exit 0
}

$endpoint = "http://127.0.0.1:$Port/dsh-open-in-dsh/api/v1/open"
$payload = @{ path = $target } | ConvertTo-Json -Compress

$reply = $null
try {
  $reply = Invoke-RestMethod -Uri $endpoint -Method Post -ContentType 'application/json' -Body $payload -TimeoutSec 5
} catch {
  Show-Failure "无法连接 DSH（$endpoint）。`n`n请确认 dsh web 正在运行，然后重试。`n`n$($_.Exception.Message)"
  exit 1
}

if (-not $reply.ok) {
  Show-Failure "DSH 没有接受这个目录：$target`n`n原因：$($reply.reason)"
  exit 1
}

if ($NoAppLaunch) { exit 0 }
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

if (-not [string]::IsNullOrWhiteSpace($AppShortcut) -and (Test-Path -LiteralPath $AppShortcut)) {
  Start-Process -FilePath $AppShortcut
} else {
  Start-Process "http://127.0.0.1:$Port/"
}

exit 0
