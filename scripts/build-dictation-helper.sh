#!/bin/sh
# Builds the dictation helper (native/dictation/main.swift) into native/build/shipwarden-dictation.
# The helper changes speech into text with the speech recognition of macOS, on this Mac only.
# electron-builder runs this script before it packs the app (scripts/before-pack.cjs). The app ships the helper in
# Contents/Resources/native. In development (npm run dev), run "npm run build:dictation" one time.
# With --typecheck, the script only checks the Swift code and writes no file. CI runs this check.
# This script needs the Swift compiler of Xcode or of the Command Line Tools.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
source="$root/native/dictation/main.swift"
plist="$root/native/dictation/Info.plist"
# The same minimum macOS version as Electron 45, on Apple silicon (the release builds only for arm64).
target=arm64-apple-macos12

if [ "${1:-}" = "--typecheck" ]; then
    swiftc -typecheck -swift-version 5 -target "$target" "$source"
    exit 0
fi

mkdir -p "$root/native/build"
# The Info.plist goes into the binary. macOS reads the usage texts of the microphone and speech permissions from it.
swiftc -O -swift-version 5 -target "$target" \
    -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$plist" \
    -o "$root/native/build/shipwarden-dictation" "$source"
