# App Store submission

The text for App Store Connect, the review notes and the steps. The screenshots are in `screenshots/`:
`6.9-inch/` (1320 × 2868, iPhone 17 Pro Max) and `6.3-inch/` (1206 × 2622, iPhone 17 Pro). App Store Connect requires
both sizes. They come from the demo. To make them again, see "Screenshots" below.

## App information

| Field | Value |
|---|---|
| Name | ShipWarden |
| Subtitle (30 characters) | Your coding agents, on iPhone |
| Bundle ID | `dev.shipwarden.ios` |
| Primary category | Developer Tools |
| Age rating | 4+ (no objectionable content) |
| Price | Free |
| Privacy policy URL | https://shipwarden.tech/privacy |
| Support URL | https://github.com/austinChappell/shipwarden/issues |
| Marketing URL | https://shipwarden.tech |
| Copyright | 2026 Austin Chappell |

## Description

```
ShipWarden runs many coding agents on your Mac at the same time, each in its own git worktree. This app shows them on your iPhone.

See your agents
• All agents of all projects in one list. The agents that need you come first.
• The state of each agent: working, needs input, or done, and what it does now.
• Why an agent is waiting, for example "Waiting for CI" or "Waiting for your reply".
• The terminal screen of each agent, with colors, as on your Mac.

Answer from anywhere
• When an agent asks for permission, tap 1, 2, or 3.
• Send Enter, Esc, the arrow keys, Tab, and Control-C.
• Type a reply, and the agent continues.

Start new work
• Start an agent from your phone. Select a repository, a task or a prompt, an agent, and a model.
• Your Mac makes a new worktree and starts the agent in it.
• Approve or skip the automation runs that are waiting for you.

Follow your pull requests
• Each worktree with its task, its pull request, and its CI state.
• Approve a pull request from the phone.

Private and secure
• The phone connects directly to your Mac, on your local network or your VPN (for example Tailscale). There is no server and no account.
• The connection is encrypted, and the phone accepts only the certificate of your Mac.
• Each phone has its own key. You can remove a phone on the Mac at any time.
• You select on the Mac which phones can start agents.

You need the free ShipWarden app for macOS. Turn on Settings › Mobile, then scan the pairing code with your iPhone. No Mac nearby? Tap "Try the demo".
```

## What's New (version 1.1)

```
• Start an agent from your iPhone. Tap +, select a repository, a task or a prompt, an agent, and a model. Your Mac makes a new worktree and starts the agent. Turn on "Start agents" for your phone in ShipWarden › Settings › Mobile.
• Approve or skip automation runs that are waiting for you.
• See why an agent is not working, for example "Waiting for CI".

This version needs the newest ShipWarden for macOS.
```

## Keywords (100 characters)

```
claude,claude code,agent,ai,coding,git,worktree,terminal,pull request,github,developer,codex
```

Check the keywords before you submit. Apple can refuse the names of other companies' products in keywords.

## Promotional text (170 characters)

```
Answer your coding agents from your phone. See what each agent does, approve its tool calls, and reply, while your Mac does the work.
```

## App privacy

In App Store Connect › App Privacy, select **Data Not Collected**. The app collects no data (see the privacy policy).

## Export compliance

`ITSAppUsesNonExemptEncryption` is `NO` in `ShipWarden-Info.plist`. The app uses only the HTTPS of iOS, so App Store
Connect does not ask about encryption for each build.

## App Review information

Sign-in required: **No**.

Notes for the reviewer:

```
ShipWarden for iPhone is a companion to the ShipWarden app for macOS (open source, https://github.com/austinChappell/shipwarden). The phone connects directly to the Mac on the local network. There is no server and no account.

To review the app without a Mac:
1. Open the app. The pairing screen shows.
2. Tap "Try the demo" at the bottom.
3. The Agents tab shows three sample agents. Tap "Login page loops after sign-in". It needs input.
4. Tap "1" to allow the command. After a few seconds, the agent is done.
5. Type a reply in the text field and tap the send button. The agent answers.
6. On the Worktrees tab, open "fix-login-loop" and tap Approve. The pull request shows as approved.
7. On the Agents tab, the "Waiting for approval" section shows the automation "Fix failed CI". Tap Approve. A new agent starts and fixes the CI. Tap Skip to only remove the run.
8. Tap + at the top of the Agents tab. Select a repository, a task or a prompt, and an agent, then tap Start. The demo makes a sample worktree and opens the new agent. After a few seconds, the agent is done.
9. On the Mac tab, tap "Exit the demo and pair with a Mac" to go back to the pairing screen.

The demo uses no network. With a real Mac, the same screens show the real agents.

New in 1.1:
- Start an agent: the + button on the Agents tab starts a new agent on the Mac. The Mac makes a new git worktree and starts the agent there. The user must allow this for each phone in ShipWarden on the Mac (Settings › Mobile › Start agents).
- Approvals: automation runs on the Mac that wait for approval show at the top of the Agents tab, with Skip and Approve.
- Each agent that is not working shows the reason, for example "Waiting for CI".

Permissions:
- Local network: to connect to the paired Mac.
- Camera: only to scan the pairing QR code on the Mac.
```

## Steps

1. **Join the Apple Developer Program** at https://developer.apple.com/programs/ ($99 per year). Use the same
   Apple ID as the team in Xcode.
2. **Create the app** in App Store Connect (https://appstoreconnect.apple.com) › Apps › **+** › New App:
   platform iOS, name "ShipWarden", bundle ID `dev.shipwarden.ios`, SKU `shipwarden-ios`. If the name is in use,
   try "ShipWarden for Claude Code" or "ShipWarden Agents".
3. **Upload a build.** Run this command from the repository root:

   ```sh
   npm run ios:upload                       # archive, sign, and upload
   npm run ios:upload -- --version 1.2      # set a new version (after Apple approves 1.1)
   npm run ios:upload:dry                   # make the .ipa file only, no upload
   ```

   `scripts/ios-upload.sh` sets the build number to the date and time (for example `20261124.1530`), so each upload
   has a higher number. You do not change `CURRENT_PROJECT_VERSION`. The script signs in with the Apple ID in
   Xcode › Settings › Accounts, or with an App Store Connect API key in `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and
   `APPLE_API_ISSUER`. The archive stays in `ios/build/`.

   To upload by hand: in Xcode, select **Any iOS Device (arm64)**, then **Product › Archive**. In the Organizer,
   select **Distribute App › App Store Connect › Upload**. Increase **Build** in the target settings first.
4. **Test with TestFlight** (optional, recommended). The build shows in App Store Connect › TestFlight after a few
   minutes. Add yourself as an internal tester.
5. **Fill in the version page** with the text above, the screenshots, the privacy answers and the review notes.
   Select the build.
6. **Submit for review.** A review usually takes one to three days.

## Before the release

- **The macOS app must have Settings › Mobile.** No released Mac version has it yet. Run the Release workflow
  before the iPhone app goes live.
- **The macOS app is not notarized.** A new user sees a security warning when they open it. To remove the warning,
  sign the Mac app with a Developer ID certificate and notarize it. The Developer Program includes the certificate.

## Screenshots

In a Debug build, environment variables start the demo and open screens (see `ios/README.md`). With the iPhone 17
Pro Max simulator (6.9") or the iPhone 17 Pro simulator (6.3") booted:

```sh
xcrun simctl status_bar booted override --time 9:41 --batteryState charged --batteryLevel 100 --wifiBars 3 --cellularBars 4
SIMCTL_CHILD_SHIPWARDEN_DEMO=1 xcrun simctl launch booted dev.shipwarden.ios
xcrun simctl io booted screenshot 1-agents.png
```

Add `SIMCTL_CHILD_SHIPWARDEN_OPEN_AGENT=demo-login` to open the agent, `SIMCTL_CHILD_SHIPWARDEN_SEND_TEXT=1` to answer
it, or `SIMCTL_CHILD_SHIPWARDEN_TAB=worktrees` to open the Worktrees tab. Terminate the app before each launch.
