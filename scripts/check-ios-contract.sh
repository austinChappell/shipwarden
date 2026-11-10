#!/bin/sh
# Checks that the iPhone models (ios/ShipWarden/Models.swift) agree with the desktop API (src/shared/remote.ts).
# The desktop tests write the fixtures. Run `UPDATE_CONTRACT_FIXTURES=1 npm test` after a change to remote.ts.
# This script needs the Swift compiler of Xcode or of the Command Line Tools.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
build=$(mktemp -d)
trap 'rm -rf "$build"' EXIT

swiftc -O -o "$build/contract-check" "$root/ios/ShipWarden/Models.swift" "$root/ios/ContractCheck/main.swift"
"$build/contract-check" "$root/ios/ContractFixtures"
