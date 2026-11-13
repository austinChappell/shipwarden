#!/usr/bin/env bash
# Makes a ShipWarden release on this Mac. It does the same steps as .github/workflows/release.yml.
# Usage: npm run release -- [patch|minor|major] [--dry-run]
#
# The script builds origin/main in a temporary worktree. It does not change your checkout.
# --dry-run builds the app and keeps the files, but does not push a tag or publish a release.
#
# Signing: the Developer ID Application certificate in build.mac.identity must be in your keychain.
# Notarization (optional): set APPLE_KEYCHAIN_PROFILE (from "xcrun notarytool store-credentials"),
# or set APPLE_API_KEY (the path of the .p8 file), APPLE_API_KEY_ID, and APPLE_API_ISSUER. See docs/RELEASING.md.
set -euo pipefail

BUMP=patch
DRY_RUN=false
for ARG in "$@"; do
    case "$ARG" in
        patch | minor | major) BUMP="$ARG" ;;
        --dry-run) DRY_RUN=true ;;
        *)
            echo "Unknown argument: $ARG. Usage: npm run release -- [patch|minor|major] [--dry-run]" >&2
            exit 2
            ;;
    esac
done

fail() {
    echo "Error: $*" >&2
    exit 1
}
warn() { echo "Warning: $*" >&2; }
step() { printf '\n==> %s\n' "$*"; }

REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"

step "Check the tools"
[ "$(uname -s)" = Darwin ] || fail "The release builds only on macOS."
[ "$(uname -m)" = arm64 ] || fail "The release builds only on Apple silicon (arm64)."
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 24 ] || fail "The release needs Node 24 or higher. This Node is $(node -v)."
command -v gh > /dev/null || fail "The GitHub CLI (gh) is not installed."
gh auth status > /dev/null 2>&1 || fail "The GitHub CLI is not signed in. Run: gh auth login"

IDENTITY=$(node -p 'require("./package.json").build.mac.identity')
security find-identity -v -p codesigning | grep -Fq "Developer ID Application: $IDENTITY" ||
    fail "The keychain does not have the certificate \"Developer ID Application: $IDENTITY\"."

NOTARIZE=false
if [ -n "${APPLE_KEYCHAIN_PROFILE:-}" ]; then
    NOTARIZE=true
    unset APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER
elif [ -n "${APPLE_API_KEY:-}" ] && [ -n "${APPLE_API_KEY_ID:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ]; then
    [ -f "$APPLE_API_KEY" ] || fail "APPLE_API_KEY must be the path of the .p8 file. The file $APPLE_API_KEY does not exist."
    NOTARIZE=true
else
    warn "No notarization key. The build is not notarized."
    unset APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER
fi

step "Get origin/main and the tags"
git fetch --quiet --tags origin main

# Build in a temporary worktree, so the release uses a clean copy of origin/main.
BUILD_DIR=$(mktemp -d "${TMPDIR:-/tmp}/shipwarden-release.XXXXXX")
cleanup() {
    if [ "$DRY_RUN" = true ]; then
        echo "The dry run keeps the build in $BUILD_DIR. Remove it with: git worktree remove --force $BUILD_DIR"
        return
    fi
    git -C "$REPO_ROOT" worktree remove --force "$BUILD_DIR" 2> /dev/null || rm -rf "$BUILD_DIR"
    git -C "$REPO_ROOT" worktree prune
}
trap cleanup EXIT
git worktree add --quiet --detach "$BUILD_DIR" origin/main
cd "$BUILD_DIR"
echo "The release builds $(git log -1 --format='%h %s')."

step "Install the dependencies"
npm ci

step "Typecheck and test"
npm run typecheck
npm test

step "Set the new version"
# The base is the newest release tag (or package.json, when it is higher).
VERSION=$(node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/next-version.mjs "$BUMP")
echo "New version: $VERSION"
if git ls-remote --exit-code --tags origin "refs/tags/v$VERSION" > /dev/null; then
    fail "The tag v$VERSION is already on GitHub."
fi

step "Write the release notes"
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/release-notes.mjs "$VERSION" release-notes.md

step "Build the app"
npx electron-vite build
# electron-builder downloads its tools (7zip, dmgbuild) from GitHub Releases, which sometimes answers with 504.
# Retry only the HTTP 504 download failure. Attempts 3 and 4 use a mirror.
# All other failures, including checksum mismatches, stop the release immediately.
for ATTEMPT in 1 2 3 4; do
    if [ "$ATTEMPT" -ge 3 ]; then
        export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
        warn "electron-builder uses the mirror $ELECTRON_BUILDER_BINARIES_MIRROR."
    fi
    BUILD_LOG="$BUILD_DIR/electron-builder-attempt-$ATTEMPT.log"
    if npx electron-builder --mac --publish never 2>&1 | tee "$BUILD_LOG"; then
        break
    fi
    if grep -Eiq 'checksum mismatch|integrity check failed' "$BUILD_LOG"; then
        fail "electron-builder reported an integrity failure. The script does not retry."
    fi
    if ! grep -Fq 'Response code 504 (Gateway Time-out)' "$BUILD_LOG"; then
        fail "electron-builder failed without an HTTP 504. The script does not retry."
    fi
    [ "$ATTEMPT" -lt 4 ] || fail "electron-builder failed with HTTP 504 four times."
    WAIT=$((10 * 2 ** (ATTEMPT - 1)))
    warn "electron-builder failed (attempt $ATTEMPT of 4). The next attempt starts in $WAIT seconds."
    sleep "$WAIT"
done
if [ "$NOTARIZE" = true ]; then
    # Stop the release if the app does not have a stapled notarization ticket.
    xcrun stapler validate dist/mac-arm64/ShipWarden.app
    spctl --assess --type execute --verbose=4 dist/mac-arm64/ShipWarden.app
fi

step "Write the update manifest"
ZIP=$(ls dist/*-"$VERSION"-arm64-mac.zip)
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/update-manifest.mjs "$VERSION" "$ZIP" dist/shipwarden-update.json

if [ "$DRY_RUN" = true ]; then
    step "Dry run: no tag and no release"
    echo "Release notes: $BUILD_DIR/release-notes.md"
    ls -lh dist/*-"$VERSION"-arm64.dmg "$ZIP" dist/shipwarden-update.json
    exit 0
fi

# The release commit has the new version in package.json. Only its tag goes to GitHub. The script does not push
# to main, so a push to main during the build does not stop the release.
step "Tag the version"
git commit --quiet --no-verify -am "Release v$VERSION"
git tag "v$VERSION"
git push origin "v$VERSION"

step "Publish the release"
gh release create "v$VERSION" \
    --title "ShipWarden $VERSION" \
    --notes-file release-notes.md \
    dist/*-"$VERSION"-arm64.dmg \
    "$ZIP" \
    dist/shipwarden-update.json

echo
echo "ShipWarden $VERSION is released."
