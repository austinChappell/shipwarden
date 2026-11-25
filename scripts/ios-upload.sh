#!/usr/bin/env bash
# Builds the iPhone app and uploads the build to App Store Connect.
# Usage: npm run ios:upload -- [--version X.Y] [--build N] [--dry-run]
#
# --version  Sets the version (MARKETING_VERSION) for this build. Use it after Apple approves a version.
#            Apple refuses a new build for a version that is approved or released.
# --build    Sets the build number (CURRENT_PROJECT_VERSION). The default is the date and time, for example
#            20261124.1530. Each upload must have a build number that is higher than the last upload.
# --dry-run  Makes the archive and the .ipa file, but does not upload them.
#
# Sign-in: the script uses the Apple ID in Xcode > Settings > Accounts.
# To use an App Store Connect API key, set APPLE_API_KEY (the path of the .p8 file), APPLE_API_KEY_ID,
# and APPLE_API_ISSUER. These are the same variables that scripts/release-local.sh reads.
set -euo pipefail

usage="Usage: npm run ios:upload -- [--version X.Y] [--build N] [--dry-run]"
VERSION=""
BUILD=$(date +%Y%m%d.%H%M)
DRY_RUN=false
while [ $# -gt 0 ]; do
    case "$1" in
        --version)
            [ $# -ge 2 ] || { echo "$usage" >&2; exit 2; }
            VERSION="$2"
            shift 2
            ;;
        --build)
            [ $# -ge 2 ] || { echo "$usage" >&2; exit 2; }
            BUILD="$2"
            shift 2
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        *)
            echo "Unknown argument: $1. $usage" >&2
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

PROJECT=ios/ShipWarden.xcodeproj
SCHEME=ShipWarden
TEAM_ID=76A95UF226

step "Check the tools"
[ "$(uname -s)" = Darwin ] || fail "The iPhone app builds only on macOS."
command -v xcodebuild > /dev/null || fail "Xcode is not installed."
[[ "$BUILD" =~ ^[0-9]+(\.[0-9]+){0,2}$ ]] || fail "The build number must be 1 to 3 numbers with dots, for example 42 or 20261124.1530."
if [ -n "$VERSION" ]; then
    [[ "$VERSION" =~ ^[0-9]+(\.[0-9]+){0,2}$ ]] || fail "The version must be 1 to 3 numbers with dots, for example 1.1."
fi

AUTH_ARGS=()
if [ -n "${APPLE_API_KEY:-}" ] || [ -n "${APPLE_API_KEY_ID:-}" ] || [ -n "${APPLE_API_ISSUER:-}" ]; then
    [ -n "${APPLE_API_KEY:-}" ] && [ -n "${APPLE_API_KEY_ID:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ] ||
        fail "Set all three of APPLE_API_KEY, APPLE_API_KEY_ID, and APPLE_API_ISSUER, or set none of them."
    [ -f "$APPLE_API_KEY" ] || fail "APPLE_API_KEY must be the path of the .p8 file. The file $APPLE_API_KEY does not exist."
    AUTH_ARGS=(
        -authenticationKeyPath "$APPLE_API_KEY"
        -authenticationKeyID "$APPLE_API_KEY_ID"
        -authenticationKeyIssuerID "$APPLE_API_ISSUER"
    )
    echo "Sign-in: App Store Connect API key $APPLE_API_KEY_ID."
else
    echo "Sign-in: the Apple ID in Xcode > Settings > Accounts."
fi

if [ -n "$(git status --porcelain -- ios)" ]; then
    warn "The ios folder has changes that are not committed. The build includes them."
fi

PROJECT_VERSION=$(sed -n 's/.*MARKETING_VERSION = \(.*\);/\1/p' "$PROJECT/project.pbxproj" | head -n 1)
echo "Version: ${VERSION:-$PROJECT_VERSION}"
echo "Build:   $BUILD"
echo "Commit:  $(git rev-parse --short HEAD) on $(git rev-parse --abbrev-ref HEAD)"

WORK_DIR="$REPO_ROOT/ios/build/upload-$BUILD"
ARCHIVE="$WORK_DIR/ShipWarden.xcarchive"
EXPORT_DIR="$WORK_DIR/export"
rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"

if [ "$DRY_RUN" = true ]; then
    DESTINATION=export
else
    DESTINATION=upload
fi

# Xcode must not change the build number. The script sets it.
cat > "$WORK_DIR/ExportOptions.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>app-store-connect</string>
    <key>destination</key>
    <string>$DESTINATION</string>
    <key>teamID</key>
    <string>$TEAM_ID</string>
    <key>signingStyle</key>
    <string>automatic</string>
    <key>manageAppVersionAndBuildNumber</key>
    <false/>
    <key>uploadSymbols</key>
    <true/>
</dict>
</plist>
PLIST

VERSION_ARGS=(CURRENT_PROJECT_VERSION="$BUILD")
[ -n "$VERSION" ] && VERSION_ARGS+=(MARKETING_VERSION="$VERSION")

step "Make the archive"
xcodebuild archive \
    -project "$PROJECT" \
    -scheme "$SCHEME" \
    -configuration Release \
    -destination 'generic/platform=iOS' \
    -archivePath "$ARCHIVE" \
    -allowProvisioningUpdates \
    ${AUTH_ARGS[@]+"${AUTH_ARGS[@]}"} \
    "${VERSION_ARGS[@]}" \
    -quiet

if [ "$DRY_RUN" = true ]; then
    step "Export the .ipa file (dry run, no upload)"
else
    step "Upload the build to App Store Connect"
fi
if ! xcodebuild -exportArchive \
    -archivePath "$ARCHIVE" \
    -exportPath "$EXPORT_DIR" \
    -exportOptionsPlist "$WORK_DIR/ExportOptions.plist" \
    -allowProvisioningUpdates \
    ${AUTH_ARGS[@]+"${AUTH_ARGS[@]}"}; then
    echo >&2
    echo "Hint: if Apple says that the version is closed or already approved, the version needs a higher number." >&2
    echo "Increase MARKETING_VERSION in $PROJECT, or run: npm run ios:upload -- --version X.Y" >&2
    fail "The export or the upload failed. See the errors above."
fi

step "Done"
if [ "$DRY_RUN" = true ]; then
    echo "The archive and the .ipa file are in $WORK_DIR. Nothing was uploaded."
else
    echo "Build $BUILD is uploaded. Apple processes it in a few minutes."
    echo "Then it shows in App Store Connect > ShipWarden > TestFlight."
    echo "The archive is in $WORK_DIR."
fi
