#!/bin/bash
# Builds Jev Bar.app from the SwiftPM package and signs it ad hoc (no Apple ID needed).
#   widget/scripts/bundle.sh            -> widget/build/Jev Bar.app
#   widget/scripts/bundle.sh --install  -> also copies it to ~/Applications and opens it
set -euo pipefail

cd "$(dirname "$0")/.."
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

if [[ "${1:-}" == "--install" ]]; then
  mkdir -p "$HOME/Applications"
  rm -rf "$HOME/Applications/Jev Bar.app"
  cp -R "$APP" "$HOME/Applications/"
  open "$HOME/Applications/Jev Bar.app"
  echo "Installed to ~/Applications/Jev Bar.app"
fi
