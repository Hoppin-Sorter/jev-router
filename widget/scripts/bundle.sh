#!/bin/bash
# Builds Jev Bar.app from the SwiftPM package and signs it ad hoc (no Apple ID needed).
#   widget/scripts/bundle.sh            -> widget/build/Jev Bar.app
#   widget/scripts/bundle.sh --install  -> also copies it to ~/Applications and opens it
#
# It asks before building and again before installing. Nothing else in jev-router runs
# this script or builds the widget. --yes answers yes to both, for when you have
# already decided (say, your own setup script).
set -euo pipefail

INSTALL=0
YES=0
for arg in "$@"; do
  case "$arg" in
    --install) INSTALL=1 ;;
    --yes|-y) YES=1 ;;
    -h|--help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg (use --install, --yes or --help)" >&2; exit 2 ;;
  esac
done

# Asks a yes/no question; anything but y or yes is no. Without a terminal to ask on,
# the answer is no unless --yes was given.
confirm() {
  if [[ $YES == 1 ]]; then return 0; fi
  if [[ ! -t 0 ]]; then
    echo "$1 Not asked: no terminal to answer on. Run it yourself, or pass --yes if you've decided." >&2
    return 1
  fi
  local reply
  read -r -p "$1 [y/N] " reply
  [[ "$reply" =~ ^([yY]|[yY][eE][sS])$ ]]
}

cd "$(dirname "$0")/.."

echo "This compiles the Jev Bar menu bar app with Swift (a few minutes the first time),"
echo "writes it to widget/build/Jev Bar.app and signs it ad hoc on this Mac."
if ! confirm "Build it now?"; then
  echo "Nothing built."
  exit 1
fi
VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' ../.claude-plugin/plugin.json | head -1)

swift build -c release --product JevBar
BIN="$(swift build -c release --show-bin-path)/JevBar"

APP="build/Jev Bar.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/JevBar"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Jev Bar</string>
  <key>CFBundleDisplayName</key><string>Jev Bar</string>
  <key>CFBundleIdentifier</key><string>io.github.hoppin-sorter.jev-bar</string>
  <key>CFBundleExecutable</key><string>JevBar</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION:-0.0.0}</string>
  <key>CFBundleVersion</key><string>${VERSION:-0.0.0}</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

codesign --force --sign - --timestamp=none "$APP"
codesign --verify --verbose=2 "$APP"
echo "Built $APP"

if [[ $INSTALL == 1 ]]; then
  if ! confirm "Copy it to ~/Applications (replacing any older copy) and open it?"; then
    echo "Not installed. The app is at widget/$APP."
    exit 0
  fi
  mkdir -p "$HOME/Applications"
  rm -rf "$HOME/Applications/Jev Bar.app"
  cp -R "$APP" "$HOME/Applications/"
  open "$HOME/Applications/Jev Bar.app"
  echo "Installed to ~/Applications/Jev Bar.app"
fi
