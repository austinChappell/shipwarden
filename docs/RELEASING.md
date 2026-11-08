# Releasing ShipWarden

## Make a release

Run the **Release** workflow in GitHub › Actions, or run this command:

```sh
gh workflow run release.yml -f bump=patch   # or minor, or major
```

The workflow does these steps:

1. It installs the dependencies, and runs the typecheck and the tests.
2. It increases the version in `package.json` (patch, minor or major).
3. It writes the release notes from the commit subjects since the last `v*` tag (`scripts/release-notes.mjs`).
4. It builds the app: a DMG and a zip for Apple silicon (arm64).
5. It writes `shipwarden-update.json` with the version, size and SHA-256 of the zip (`scripts/update-manifest.mjs`).
6. It commits "Release vX.Y.Z", tags it, and pushes the commit and the tag to `main`.
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

To sign the builds with your certificate, add two repository secrets in GitHub › Settings › Secrets and variables › Actions:

1. In Keychain Access, find your Apple Development certificate under My Certificates. It must be the certificate
   that `build.mac.identity` in `package.json` names.
2. Export the certificate with its private key as a `.p12` file, and choose a password.
3. Add these secrets:
   - `MAC_CERTIFICATE_P12`: the file as base64. Get it with `base64 -i certificate.p12 | pbcopy`.
   - `MAC_CERTIFICATE_PASSWORD`: the password of the `.p12` file.
4. Delete the `.p12` file after you add the secrets.

An Apple Development certificate does not allow notarization. A DMG from a release therefore needs a right-click ›
Open on the first start (or `xattr -dr com.apple.quarantine /Applications/ShipWarden.app`). The in-app updates do
not need this, because the app downloads them itself.
