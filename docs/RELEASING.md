# Releasing ShipWarden

## Make a release

Run the **Release** workflow in GitHub › Actions, or run this command:

```sh
gh workflow run release.yml -f bump=patch   # or minor, or major
```

The workflow does these steps:

1. It installs the dependencies, and runs the typecheck and the tests.
2. It finds the next version: the newest `v*` tag (or `package.json`, when it is higher), with the patch, minor or major
   part increased (`scripts/next-version.mjs`).
3. It writes the release notes from the commit subjects since the last `v*` tag (`scripts/release-notes.mjs`).
4. It builds the app: a DMG and a zip for Apple silicon (arm64).
5. It writes `shipwarden-update.json` with the version, size and SHA-256 of the zip (`scripts/update-manifest.mjs`).
6. It commits "Release vX.Y.Z" in the build only, tags that commit, and pushes only the tag. The workflow does not push
   to `main`, so a push to `main` during the build does not stop the release. `package.json` on `main` keeps an older
   version; the tags have the released versions.
7. It publishes the GitHub release with the notes, the DMG, the zip and the manifest.

## How the app updates

- The installed app reads the latest GitHub release when it starts, and then every 4 hours. Settings › About has
  "Check for updates".
- A release that is newer than the app shows a notice in the corner of the window, with the release notes.
  "Update and restart" downloads the zip and checks its size and SHA-256 against the manifest.
- The app unpacks the zip next to itself, and checks the version and the code signature of the new app. A helper
  script waits until the app quits, replaces `ShipWarden.app`, and opens the new app. When the replacement fails,
  the helper puts the old app back.
- The terminals and agents continue to run in the PTY host during the update.
- With a GitHub token (from `gh auth token`), the app can read the releases of a private repository. A public
  repository works without a token.
- The app in development (`npm run dev`) can check, but it does not install.

## Code signing

Without signing secrets, the build has an ad-hoc signature. The app works, but macOS treats each version as a new
app: it can ask again for keychain access (the secrets of the task managers) and for notification permission.

The builds use a Developer ID Application certificate. Only this type of certificate allows notarization. An
Apple Development or an Apple Distribution certificate does not. The Account Holder of a paid Apple Developer
Program membership makes the certificate in Xcode › Settings › Accounts › Manage Certificates, or at
developer.apple.com › Certificates.

To sign the builds, add two repository secrets in GitHub › Settings › Secrets and variables › Actions:

1. In Keychain Access, find the Developer ID Application certificate under My Certificates. It must be the
   certificate that `build.mac.identity` in `package.json` names.
2. Export the certificate with its private key as a `.p12` file, and choose a password.
3. Add these secrets:
   - `MAC_CERTIFICATE_P12`: `base64 -i certificate.p12 | gh secret set MAC_CERTIFICATE_P12`
   - `MAC_CERTIFICATE_PASSWORD`: `gh secret set MAC_CERTIFICATE_PASSWORD` (it asks for the password)
4. Keep a copy of the `.p12` file in a password manager. Then delete the file.

## Notarization

Apple checks a notarized app for malware and gives it a ticket. The workflow staples the ticket to the app. Then a
DMG from a release opens without a Gatekeeper warning.

To notarize the builds, make an App Store Connect API key, and add three more repository secrets:

1. In App Store Connect › Users and Access › Integrations › App Store Connect API, make a team key with the
   Developer role. Use the same team as the certificate.
2. Download the `.p8` file. Apple lets you download it only one time.
3. Add these secrets:
   - `APPLE_API_KEY_P8`: `base64 -i AuthKey_XXXX.p8 | gh secret set APPLE_API_KEY_P8`
   - `APPLE_API_KEY_ID`: the Key ID of the key
   - `APPLE_API_ISSUER`: the Issuer ID at the top of the keys page
4. Keep a copy of the `.p8` file in a password manager. Then delete the file.

The workflow notarizes only when all five secrets are present. Without the three notarization secrets, the build is
signed but not notarized, and the workflow shows a warning. When the workflow notarizes, it also checks the ticket
with `xcrun stapler validate` and `spctl`. If a check fails, the release stops.

To make a notarized build on your Mac, set the same values and run `npm run dist`:

```sh
export APPLE_API_KEY=~/path/AuthKey_XXXX.p8   # the path of the file, not base64
export APPLE_API_KEY_ID=XXXX
export APPLE_API_ISSUER=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
npm run dist
```

A build without notarization needs a right-click › Open on the first start, or
`xattr -dr com.apple.quarantine /Applications/ShipWarden.app`. The in-app updates do not need this, because the app
downloads them itself.

The app uses the hardened runtime, with the entitlements in `build/entitlements.mac.plist`. Notarization requires the
hardened runtime. Electron needs `allow-jit` and `allow-unsigned-executable-memory`. node-pty and the native
TypeScript binary need `disable-library-validation`.
