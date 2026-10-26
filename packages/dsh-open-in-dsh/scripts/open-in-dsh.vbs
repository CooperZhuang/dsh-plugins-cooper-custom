' dsh-open-in-dsh — Explorer verb host.
'
' Why this file exists at all: the verb used to point straight at pwsh.exe.
' A console application has its console window created by Windows *before* the
' program gets to run, so PowerShell's own `-WindowStyle Hidden` could only hide
' it a moment late — and that late hide is the flicker you see. wscript.exe is a
' GUI-subsystem host: Windows never allocates a console for it, and it starts
' the real worker with SW_HIDE, so the console is created hidden instead of
' being hidden afterwards.
'
' The folder travels through the process environment rather than the command
' line. That removes every quoting hazard at once: spaces, apostrophes and a
' trailing separator (`D:\`) are just characters in an environment value, and
' nothing has to survive being re-quoted by the shell or by PowerShell.
'
' Arguments: 0 = folder (Explorer substitutes %V), 1 = port, 2 = the DSH Desktop
' app to start and raise (.exe, .lnk, or the dsh://open URI). Absent values fall
' back to the launcher's own resolution: DSH_OPEN_PORT and DSH_OPEN_APP.
'
' This file is deliberately static — it resolves the interpreter itself, so the
' installer never has to generate or patch it.

Option Explicit

Dim shell, fso, args, path, port, app, script, exe, cmd, env

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
Set args = WScript.Arguments

If args.Count < 1 Then WScript.Quit 0
path = args(0)
If Len(Trim(path)) = 0 Then WScript.Quit 0

script = fso.GetParentFolderName(WScript.ScriptFullName) & "\open-in-dsh.ps1"
If Not fso.FileExists(script) Then WScript.Quit 1

' The Desktop shell's own port (dsh-desktop-host starts the profile with
' `--port 19387`). Kept in step with $DesktopPort in open-in-dsh.ps1 and with
' the installer by test/scripts.test.mjs.
port = "19387"
If args.Count >= 2 Then
  If IsNumeric(args(1)) Then port = Trim(args(1))
End If

app = ""
If args.Count >= 3 Then app = args(2)

exe = PowerShellPath()
If Len(exe) = 0 Then WScript.Quit 1

Set env = shell.Environment("PROCESS")
env("DSH_OPEN_PATH") = path
env("DSH_OPEN_PORT") = port
If Len(app) > 0 Then env("DSH_OPEN_APP") = app

' 0 = the child's window is created hidden; False = do not wait for it.
' `-WindowStyle Hidden` stays as a second line of defence in case this host
' ever runs without honouring the show state.
cmd = """" & exe & """ -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & script & """"
shell.Run cmd, 0, False

' Prefer PowerShell 7, fall back to the one Windows always ships.
Function PowerShellPath()
  Dim candidates, i
  candidates = Array( _
    shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\PowerShell\7\pwsh.exe", _
    shell.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\PowerShell\7\pwsh.exe", _
    shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Microsoft\WindowsApps\pwsh.exe", _
    shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe")

  For i = 0 To UBound(candidates)
    If fso.FileExists(candidates(i)) Then
      PowerShellPath = candidates(i)
      Exit Function
    End If
  Next

  PowerShellPath = "powershell.exe"
End Function
