#!/bin/sh
#
# install-macos.sh — install "通过 DSH 打开" as a Finder Quick Action, plus the
# dsh-open command for a terminal.
#
# A Finder context-menu entry has two possible homes on macOS:
#
#   * a Quick Action (~/Library/Services/<label>.workflow, an Automator
#     workflow). Appears under Finder → right-click a folder → 快速操作
#     (Quick Actions) → the label. Needs no code signing, no Xcode and no
#     privileged helper, and it is a file tree this script can write, lint and
#     remove again. It cannot be a *top-level* menu item.
#   * a Finder Sync app extension. That is the only way to get a top-level
#     item, but it needs an Xcode-built .appex inside a signed app bundle, and
#     every DSH Desktop update would need a re-sign. Not worth it for one menu
#     entry, so this installer does not do it.
#
# Usage: install-macos.sh [install|uninstall|status] [options]
#   --launcher <path>   launcher baked into the workflow
#   --services-dir <d>  where the .workflow lives (default ~/Library/Services)
#   --bin-dir <d>       where the dsh-open symlink lands (default ~/bin)
#   --label <text>      menu label / workflow name (default 通过 DSH 打开)
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
    -h|--help) sed -n '3,25p' "$0" | sed -e 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'install-macos.sh: unknown argument: %s\n' "$1" >&2; exit 64 ;;
  esac
  shift
done

workflow="$services_dir/$label.workflow"
workflow_plist="$workflow/Contents/Info.plist"
workflow_document="$workflow/Contents/document.wflow"
cli_link="$bin_dir/dsh-open"

# XML-escape one line of text, so a label or a path with &, < or > cannot break
# the plist. The input is expected to be a single line.
xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

write_info_plist() {
  {
    cat <<'HEAD'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>NSServices</key>
	<array>
		<dict>
			<key>NSMenuItem</key>
			<dict>
				<key>default</key>
				<string>
HEAD
    xml_escape "$label"
    cat <<'TAIL'
</string>
			</dict>
			<key>NSMessage</key>
			<string>runWorkflowAsService</string>
			<key>NSRequiredContext</key>
			<dict>
				<key>NSApplicationIdentifier</key>
				<string>com.apple.finder</string>
			</dict>
			<key>NSSendFileTypes</key>
			<array>
				<string>public.folder</string>
			</array>
		</dict>
	</array>
</dict>
</plist>
TAIL
  } >"$workflow_plist"
}

write_document() {
  # Selected items arrive as arguments (inputMethod=1), one per argument, and
  # the launcher accepts any number of folders, so multi-select works.
  _script="for f in \"\$@\"; do
  \"$launcher\" \"\$f\" || exit \$?
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
    printf '%s' "$_script" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
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
		<key>serviceApplicationBundleID</key><string>com.apple.finder</string>
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
  } >"$workflow_document"
  # BSD sed wants an explicit empty backup suffix; three separate patterns so a
  # replacement can never contain its own placeholder.
  sed -i '' \
    -e "s|@UUID_IN@|$(uuidgen)|" \
    -e "s|@UUID_OUT@|$(uuidgen)|" \
    -e "s|@UUID@|$(uuidgen)|" \
    "$workflow_document"
}

refresh_services() {
  if [ -x /System/Library/CoreServices/pbs ]; then
    /System/Library/CoreServices/pbs -update >/dev/null 2>&1 || true
  fi
}

install() {
  if [ ! -x "$launcher" ]; then
    printf 'install-macos.sh: launcher is not executable: %s\n' "$launcher" >&2
    exit 3
  fi
  mkdir -p "$services_dir" || exit 3
  rm -rf "$workflow"
  mkdir -p "$workflow/Contents" || exit 3
  write_info_plist
  write_document
  if ! plutil -lint "$workflow_plist" "$workflow_document" >/dev/null; then
    printf 'install-macos.sh: generated workflow is not a valid plist\n' >&2
    exit 3
  fi
  mkdir -p "$bin_dir" || exit 3
  ln -sfn "$launcher" "$cli_link"
  refresh_services
  printf 'installed\n'
  printf '  workflow  %s\n' "$workflow"
  printf '  command   %s -> %s\n' "$cli_link" "$launcher"
  printf '\n'
  printf 'Finder: right-click a folder -> 快速操作 -> %s\n' "$label"
  printf 'Terminal: dsh-open <folder>   (or just dsh-open for the current folder)\n'
  printf 'If the entry does not appear: killall Finder, or log out and back in.\n'
  printf 'Visibility / shortcut: 系统设置 -> 键盘 -> 键盘快捷键 -> 服务\n'
}

uninstall() {
  rm -rf "$workflow"
  if [ -L "$cli_link" ]; then
    rm -f "$cli_link"
  fi
  refresh_services
  printf 'removed\n'
  printf '  workflow  %s\n' "$workflow"
  printf '  command   %s\n' "$cli_link"
}

status() {
  if [ -x "$launcher" ]; then
    printf 'launcher   %s (executable)\n' "$launcher"
  else
    printf 'launcher   %s (MISSING)\n' "$launcher"
  fi
  if [ -f "$workflow_document" ]; then
    printf 'workflow   %s\n' "$workflow"
    if plutil -lint "$workflow_plist" "$workflow_document" >/dev/null 2>&1; then
      printf 'plists     OK\n'
    else
      printf 'plists     INVALID\n'
    fi
  else
    printf 'workflow   NOT INSTALLED (%s)\n' "$workflow"
  fi
  if [ -L "$cli_link" ]; then
    printf 'command    %s -> %s\n' "$cli_link" "$(readlink "$cli_link")"
  elif [ -e "$cli_link" ]; then
    printf 'command    %s (not a symlink; left alone)\n' "$cli_link"
  else
    printf 'command    NOT INSTALLED (%s)\n' "$cli_link"
  fi
  printf '\nwhat a click would do:\n'
  "$launcher" --print . 2>&1 | sed -e 's/^/  /'
}

case $action in
  install) install ;;
  uninstall) uninstall ;;
  status) status ;;
esac

