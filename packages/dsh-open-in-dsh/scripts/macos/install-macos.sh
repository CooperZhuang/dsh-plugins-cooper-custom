#!/bin/sh
#
# install-macos.sh — install "通过 DSH 打开" as a Finder Quick Action, as a
# service for QSpace Pro's context menu, and the dsh-open command for a
# terminal.
#
# Finder: a Quick Action (~/Library/Services/<label>.workflow, an Automator
# workflow). Appears under right-click a folder → 快速操作 → the label. No code
# signing, no Xcode, no privileged helper; it is a file tree this script can
# write, lint and remove. It cannot be a *top-level* menu item — that needs a
# Finder Sync app extension (Xcode project + signature + a re-sign on every
# Desktop update), which is not worth one menu entry.
#
# QSpace Pro: its context menu is an ordered list, and one built-in entry is the
# standard macOS "服务" (Services) submenu. A service is only valid in an app
# when its NSRequiredContext allows that app, so the Finder Quick Action (scoped
# to com.apple.finder) never shows up inside QSpace. This installer therefore
# writes a *second* workflow with the same label and script, scoped to QSpace's
# bundle id. QSpace's own settings pane (设置 → 右键菜单) can then drag it out of
# the "服务" list onto the top level.
#
# POSIX sh has no `local`, so every helper prefixes its variables; a shared name
# silently lets one helper overwrite another's argument (this file had exactly
# that bug: the QSpace bundle came out scoped to com.apple.finder).
#
# Usage: install-macos.sh [install|uninstall|status] [options]
#   --launcher <path>   launcher baked into the workflow
#   --services-dir <d>  where the .workflow lives (default ~/Library/Services)
#   --bin-dir <d>       where the dsh-open symlink lands (default ~/bin)
#   --label <text>      menu label / workflow name (default 通过 DSH 打开)
#   --qspace <auto|off|any|BUNDLE_ID>
#                       extra service scoped to QSpace (default auto: the
#                       bundle id when QSpace is installed, off otherwise).
#                       "any" drops the scope, the fallback if QSpace turns out
#                       to ignore an app-scoped service.
#
# The workflow calls the launcher by absolute path rather than by name: the
# shell Automator runs does not necessarily share the user's PATH.
set -u

label=${DSH_OPEN_LABEL:-通过 DSH 打开}
services_dir=$HOME/Library/Services
bin_dir=$HOME/bin
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
launcher=$here/open-in-dsh
action='install'
qspace='auto'

while [ $# -gt 0 ]; do
  case $1 in
    install|uninstall|status) action=$1 ;;
    --launcher) launcher=$2; shift ;;
    --launcher=*) launcher=${1#*=} ;;
    --services-dir) services_dir=$2; shift ;;
    --services-dir=*) services_dir=${1#*=} ;;
    --bin-dir) bin_dir=$2; shift ;;
    --bin-dir=*) bin_dir=${1#*=} ;;
    --label) label=$2; shift ;;
    --label=*) label=${1#*=} ;;
    --qspace) qspace=$2; shift ;;
    --qspace=*) qspace=${1#*=} ;;
    -h|--help) sed -n '3,40p' "$0" | sed -e 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'install-macos.sh: unknown argument: %s\n' "$1" >&2; exit 64 ;;
  esac
  shift
done

workflow="$services_dir/$label.workflow"
qspace_workflow="$services_dir/$label (QSpace).workflow"
cli_link="$bin_dir/dsh-open"

# XML-escape one line of text, so a label, a path or a bundle id with &, < or >
# cannot break the plist. The input is expected to be a single line.
xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

# Write a service bundle's Info.plist.
#   $1 target path   $2 menu label   $3 app scope ("any" = every app, else a bundle id)
write_info_plist() {
  _wipl_target=$1
  _wipl_label=$2
  _wipl_scope=$3
  {
    cat <<'HEAD'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>NSServices</key>
	<array>
		<dict>
HEAD
    # The label and the scope go in as single-line values. A heredoc that
    # opens the string tag and closes it on a later line leaves a literal
    # newline in the value, and that newline becomes part of the menu title:
    # pbs then reports it as a leading newline and the menu shows a gap.
    printf '\t\t\t<key>NSMenuItem</key>\n\t\t\t<dict>\n\t\t\t\t<key>default</key>\n\t\t\t\t<string>%s</string>\n\t\t\t</dict>\n' "$(xml_escape "$_wipl_label")"
    printf '\t\t\t<key>NSMessage</key>\n\t\t\t<string>runWorkflowAsService</string>\n'
    if [ -n "$_wipl_scope" ] && [ "$_wipl_scope" != 'any' ]; then
      printf '\t\t\t<key>NSRequiredContext</key>\n\t\t\t<dict>\n\t\t\t\t<key>NSApplicationIdentifier</key>\n\t\t\t\t<string>%s</string>\n\t\t\t</dict>\n' "$(xml_escape "$_wipl_scope")"
    fi
    cat <<'TAIL'
			<key>NSSendFileTypes</key>
			<array>
				<string>public.folder</string>
			</array>
		</dict>
	</array>
</dict>
</plist>
TAIL
  } >"$_wipl_target"
}

# Write the Automator document that runs the launcher once per selected folder.
#   $1 target path   $2 the app the service is registered for (Automator metadata)
write_document() {
  _wd_target=$1
  _wd_service_app=$2
  # Selected items arrive as arguments (inputMethod=1), one per argument, and
  # the launcher accepts any number of folders, so multi-select works.
  #
  # The launcher is baked in as an absolute path (the shell Automator runs does
  # not necessarily share the user's PATH), so moving this checkout leaves the
  # click pointing at nothing. Measured 2026-11-05 after moving the repository
  # into Code/Dsh/: Finder showed the action, and clicking it popped Automator's
  # bare 「操作“运行Shell脚本”遇到了错误 -: line 2: <path>: No such file or
  # directory」. The guard names the missing launcher and says what to re-run;
  # the path travels as argv so a path with spaces or quotes cannot break the
  # AppleScript. Exit 0 after the alert so Automator does not add a second,
  # less specific error dialog on top of it.
  _wd_script="launcher=\"$launcher\"
if [ ! -x \"\$launcher\" ]; then
  osascript -e 'on run argv' -e 'display alert \"无法通过 DSH 打开\" message (\"找不到启动器：\" & item 1 of argv & \"。这个 checkout 移动过的话，重跑 packages/dsh-open-in-dsh/scripts/macos/install-macos.sh install。\")' -e 'end run' \"\$launcher\" || {
    printf 'open-in-dsh: launcher missing: %s\n' \"\$launcher\" >&2
    exit 1
  }
  exit 0
fi
for f in \"\$@\"; do
  \"\$launcher\" \"\$f\" || exit \$?
done"
  {
    cat <<'HEAD'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>AMApplicationBuild</key><string>523</string>
	<key>AMApplicationVersion</key><string>2.10</string>
	<key>AMDocumentVersion</key><string>2</string>
	<key>actions</key>
	<array>
		<dict>
			<key>action</key>
			<dict>
				<key>AMAccepts</key>
				<dict>
					<key>Container</key><string>List</string>
					<key>Optional</key><true/>
					<key>Types</key><array><string>com.apple.cocoa.string</string></array>
				</dict>
				<key>AMActionVersion</key><string>2.0.3</string>
				<key>AMApplication</key><array><string>Automator</string></array>
				<key>AMParameterProperties</key>
				<dict>
					<key>COMMAND_STRING</key><dict/>
					<key>CheckedForUserDefaultShell</key><dict/>
					<key>inputMethod</key><dict/>
					<key>shell</key><dict/>
					<key>source</key><dict/>
				</dict>
				<key>AMProvides</key>
				<dict>
					<key>Container</key><string>List</string>
					<key>Types</key><array><string>com.apple.cocoa.string</string></array>
				</dict>
				<key>ActionBundlePath</key><string>/System/Library/Automator/Run Shell Script.action</string>
				<key>ActionName</key><string>Run Shell Script</string>
				<key>ActionParameters</key>
				<dict>
					<key>COMMAND_STRING</key><string>
HEAD
    printf '%s' "$_wd_script" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
    cat <<'TAIL'
</string>
					<key>CheckedForUserDefaultShell</key><true/>
					<key>inputMethod</key><integer>1</integer>
					<key>shell</key><string>/bin/sh</string>
					<key>source</key><string></string>
				</dict>
				<key>BundleIdentifier</key><string>com.apple.RunShellScript</string>
				<key>CFBundleVersion</key><string>2.0.3</string>
				<key>CanShowSelectedItemsWhenRun</key><false/>
				<key>CanShowWhenRun</key><true/>
				<key>Category</key><array><string>AMCategoryUtilities</string></array>
				<key>Class Name</key><string>RunShellScriptAction</string>
				<key>InputUUID</key><string>@UUID_IN@</string>
				<key>Keywords</key><array><string>Shell</string><string>Script</string><string>Command</string><string>Run</string><string>Unix</string></array>
				<key>OutputUUID</key><string>@UUID_OUT@</string>
				<key>UUID</key><string>@UUID@</string>
				<key>UnlocalizedApplications</key><array><string>Automator</string></array>
				<key>arguments</key><dict/>
				<key>isViewVisible</key><integer>1</integer>
				<key>location</key><string>309.000000:253.000000</string>
				<key>nibPath</key><string>/System/Library/Automator/Run Shell Script.action/Contents/Resources/Base.lproj/main.nib</string>
			</dict>
			<key>isViewVisible</key><integer>1</integer>
		</dict>
	</array>
	<key>connectors</key><dict/>
	<key>workflowMetaData</key>
	<dict>
		<key>applicationBundleIDsByPath</key><dict/>
		<key>applicationPaths</key><array/>
		<key>inputTypeIdentifier</key><string>com.apple.Automator.fileSystemObject</string>
		<key>outputTypeIdentifier</key><string>com.apple.Automator.nothing</string>
		<key>presentationMode</key><integer>15</integer>
		<key>processesInput</key><integer>0</integer>
		<key>serviceApplicationBundleID</key><string>@SERVICE_APP@</string>
		<key>serviceApplicationPath</key><string>/System/Library/CoreServices/Finder.app</string>
		<key>serviceInputTypeIdentifier</key><string>com.apple.Automator.fileSystemObject.folder</string>
		<key>serviceOutputTypeIdentifier</key><string>com.apple.Automator.nothing</string>
		<key>serviceProcessesInput</key><integer>0</integer>
		<key>useAutomaticInputType</key><integer>0</integer>
		<key>workflowTypeIdentifier</key><string>com.apple.Automator.servicesMenu</string>
	</dict>
</dict>
</plist>
TAIL
  } >"$_wd_target"
  # BSD sed wants an explicit empty backup suffix; separate patterns so a
  # replacement can never contain its own placeholder.
  sed -i '' \
    -e "s|@SERVICE_APP@|$_wd_service_app|" \
    -e "s|@UUID_IN@|$(uuidgen)|" \
    -e "s|@UUID_OUT@|$(uuidgen)|" \
    -e "s|@UUID@|$(uuidgen)|" \
    "$_wd_target"
}

# Install one service bundle.
#   $1 bundle path   $2 label   $3 app scope ("any" = every app, else a bundle id)
install_bundle() {
  _ib_bundle=$1
  _ib_scope=$3
  _ib_automator_app='com.apple.finder'
  if [ -n "$_ib_scope" ] && [ "$_ib_scope" != 'any' ]; then
    _ib_automator_app=$_ib_scope
  fi
  rm -rf "$_ib_bundle"
  mkdir -p "$_ib_bundle/Contents" || return 1
  write_info_plist "$_ib_bundle/Contents/Info.plist" "$2" "$_ib_scope"
  write_document "$_ib_bundle/Contents/document.wflow" "$_ib_automator_app"
  plutil -lint "$_ib_bundle/Contents/Info.plist" "$_ib_bundle/Contents/document.wflow" >/dev/null
}

# The QSpace bundle id of an installed app, or nothing.
detect_qspace() {
  for _dq_bundle in \
    '/Applications/QSpace Pro.app' \
    '/Applications/QSpace.app' \
    "$HOME/Applications/QSpace Pro.app" \
    "$HOME/Applications/QSpace.app"; do
    if [ -d "$_dq_bundle" ]; then
      _dq_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$_dq_bundle/Contents/Info.plist" 2>/dev/null) || _dq_id=''
      if [ -n "$_dq_id" ]; then
        printf '%s' "$_dq_id"
        return 0
      fi
    fi
  done
  for _dq_id in com.jinghaoshe.qspace.pro com.jinghaoshe.qspace; do
    _dq_hit=$(mdfind "kMDItemCFBundleIdentifier == '$_dq_id'" 2>/dev/null | head -n 1)
    if [ -n "$_dq_hit" ] && [ -d "$_dq_hit" ]; then
      printf '%s' "$_dq_id"
      return 0
    fi
  done
  return 1
}

# Resolve --qspace into the scope of the extra bundle: "off", "any", or an id.
resolve_qspace_scope() {
  case $qspace in
    off|none|no) printf 'off' ;;
    any|all) printf 'any' ;;
    auto)
      _rq_detected=$(detect_qspace) || _rq_detected=''
      if [ -n "$_rq_detected" ]; then printf '%s' "$_rq_detected"; else printf 'off'; fi
      ;;
    *) printf '%s' "$qspace" ;;
  esac
}

refresh_services() {
  if [ -x /System/Library/CoreServices/pbs ]; then
    /System/Library/CoreServices/pbs -update >/dev/null 2>&1 || true
  fi
}

# The launcher path an installed workflow would run, or "" when this bundle was
# not written by this installer (no `launcher=` line in its shell action).
baked_launcher() {
  _bl_doc=$1/Contents/document.wflow
  [ -f "$_bl_doc" ] || return 1
  _bl_cmd=$(/usr/libexec/PlistBuddy -c 'Print :actions:0:action:ActionParameters:COMMAND_STRING' "$_bl_doc" 2>/dev/null) || return 1
  printf '%s\n' "$_bl_cmd" | sed -n 's/^launcher="\(.*\)"$/\1/p' | head -n 1
}

# One line of "is this bundle installed, and with which scope". Returns non-zero
# when the bundle would not work from this checkout: invalid plists, or a baked
# launcher that is not the one this installer was run against (a moved checkout
# leaves the workflow pointing at the old absolute path).
describe_bundle() {
  _db_bundle=$1
  if [ ! -f "$_db_bundle/Contents/document.wflow" ]; then
    printf 'workflow   %s (not installed)\n' "$_db_bundle"
    return 0
  fi
  _db_scope=$(/usr/libexec/PlistBuddy -c 'Print :NSServices:0:NSRequiredContext:NSApplicationIdentifier' "$_db_bundle/Contents/Info.plist" 2>/dev/null) || _db_scope=''
  [ -n "$_db_scope" ] || _db_scope='any app'
  if plutil -lint "$_db_bundle/Contents/Info.plist" "$_db_bundle/Contents/document.wflow" >/dev/null 2>&1; then
    printf 'workflow   %s (scope: %s, plists OK)\n' "$_db_bundle" "$_db_scope"
  else
    printf 'workflow   %s (scope: %s, plists INVALID)\n' "$_db_bundle" "$_db_scope"
    return 1
  fi
  _db_baked=$(baked_launcher "$_db_bundle") || _db_baked=''
  if [ -z "$_db_baked" ]; then
    printf 'launcher   (workflow names no launcher; not written by this installer)\n'
    return 0
  fi
  if [ "$_db_baked" != "$launcher" ]; then
    printf 'launcher   %s (STALE: this checkout is %s; re-run install-macos.sh install)\n' "$_db_baked" "$launcher"
    return 1
  fi
  if [ ! -x "$_db_baked" ]; then
    printf 'launcher   %s (MISSING: re-run install-macos.sh install)\n' "$_db_baked"
    return 1
  fi
  printf 'launcher   %s (matches this installer)\n' "$_db_baked"
  return 0
}

install() {
  if [ ! -x "$launcher" ]; then
    printf 'install-macos.sh: launcher is not executable: %s\n' "$launcher" >&2
    exit 3
  fi
  _in_scope=$(resolve_qspace_scope)
  mkdir -p "$services_dir" || exit 3
  if ! install_bundle "$workflow" "$label" 'com.apple.finder'; then
    printf 'install-macos.sh: generated Finder workflow is not valid\n' >&2
    exit 3
  fi
  printf 'installed\n'
  printf '  finder    %s (right-click a folder -> 快速操作)\n' "$workflow"
  if [ "$_in_scope" = 'off' ]; then
    rm -rf "$qspace_workflow"
    printf '  qspace    skipped (QSpace not found; --qspace any forces it on)\n'
  else
    if ! install_bundle "$qspace_workflow" "$label" "$_in_scope"; then
      printf 'install-macos.sh: generated QSpace workflow is not valid\n' >&2
      exit 3
    fi
    printf '  qspace    %s (scope: %s)\n' "$qspace_workflow" "$_in_scope"
  fi
  mkdir -p "$bin_dir" || exit 3
  ln -sfn "$launcher" "$cli_link"
  refresh_services
  printf '  command   %s -> %s\n' "$cli_link" "$launcher"
  printf '\n'
  printf 'Finder: right-click a folder -> 快速操作 -> %s\n' "$label"
  if [ "$_in_scope" != 'off' ]; then
    printf 'QSpace: right-click a folder -> 服务 -> %s\n' "$label"
    printf '        想要顶层条目：QSpace 设置 -> 右键菜单，把它从“服务”列表拖到左侧。\n'
    printf '        没出现就重启一次 QSpace（新注册的服务它要重新读）。\n'
  fi
  printf 'Terminal: dsh-open <folder>   (or just dsh-open for the current folder)\n'
  printf 'If the Finder entry does not appear: killall Finder, or log out and back in.\n'
  printf 'Visibility / shortcut: 系统设置 -> 键盘 -> 键盘快捷键 -> 服务\n'
}

uninstall() {
  rm -rf "$workflow" "$qspace_workflow"
  if [ -L "$cli_link" ]; then
    rm -f "$cli_link"
  fi
  refresh_services
  printf 'removed\n'
  printf '  finder    %s\n' "$workflow"
  printf '  qspace    %s\n' "$qspace_workflow"
  printf '  command   %s\n' "$cli_link"
}

status() {
  # Non-zero when a click would fail: missing launcher, invalid or stale bundle.
  # That makes "is the installed service still pointing at this checkout?" a
  # question a script can ask, not one a user answers by clicking and reading a
  # 「运行Shell脚本 遇到了错误」dialog.
  _st_rc=0
  if [ -x "$launcher" ]; then
    printf 'launcher   %s (executable)\n' "$launcher"
  else
    printf 'launcher   %s (MISSING)\n' "$launcher"
    _st_rc=1
  fi
  describe_bundle "$workflow" || _st_rc=1
  describe_bundle "$qspace_workflow" || _st_rc=1
  if [ -L "$cli_link" ]; then
    printf 'command    %s -> %s\n' "$cli_link" "$(readlink "$cli_link")"
  elif [ -e "$cli_link" ]; then
    printf 'command    %s (not a symlink; left alone)\n' "$cli_link"
  else
    printf 'command    NOT INSTALLED (%s)\n' "$cli_link"
  fi
  printf '\nwhat a click would do:\n'
  if [ -x "$launcher" ]; then
    "$launcher" --print . 2>&1 | sed -e 's/^/  /'
  else
    printf '  (skipped: launcher is not executable)\n'
  fi
  return $_st_rc
}

case $action in
  install) install ;;
  uninstall) uninstall ;;
  status) status ;;
esac

