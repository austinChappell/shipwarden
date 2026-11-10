# ShipWarden for iPhone

The iPhone app shows the agents that run in ShipWarden on your Mac. It connects to the Mac over your network.

- **Agents.** The agents of all projects. The agents that need you come first. Open an agent to see its terminal
  screen, answer a question with 1, 2 or 3, send keys (Enter, Esc, arrows, Tab, ⇧Tab, ⌃C) or type a reply.
- **Worktrees.** The worktrees of each repository with their task, their pull request and the CI state. You can
  approve a pull request.
- **Mac.** The paired Mac and the connection. You can forget the Mac here.
- **Demo.** "Try the demo" on the pairing screen shows sample agents that answer the buttons and replies. It uses no
  network. App Review uses it, because a reviewer has no Mac with ShipWarden.

The app is for iPhone only. To submit it to the App Store, see [AppStore/README.md](AppStore/README.md).

## Pair the phone

1. On the Mac, open ShipWarden › Settings › Mobile and turn on **Allow phone connections**.
2. Select **Pair a phone**. A QR code shows.
3. In the app, tap **Scan the QR code**. You can also scan the code with the Camera app, or copy the link on the Mac
   and paste it in the app.

The phone must reach the Mac: the same Wi-Fi network, or the same VPN (for example Tailscale). The first time,
iOS asks for access to the local network, and macOS can ask to accept incoming connections for ShipWarden. Allow both.

## Build

You need Xcode 16 or later. The project uses a synchronized folder, so a new file in `ShipWarden/` is part of the
app with no change to the project file.

```sh
open ios/ShipWarden.xcodeproj
```

To run the app on your iPhone, select your team in **Signing & Capabilities**. To build for the simulator from the
command line:

```sh
xcodebuild -project ios/ShipWarden.xcodeproj -scheme ShipWarden -destination 'generic/platform=iOS Simulator' build
```

### Checks without taps (Debug builds only)

In a Debug build, these environment variables drive the app, so you can check a change from the command line.
Release builds do not have this code.

| Variable | Effect |
|---|---|
| `SIMCTL_CHILD_SHIPWARDEN_DEMO=1` | Starts the demo. |
| `SIMCTL_CHILD_SHIPWARDEN_TAB` | Opens a tab: `agents`, `worktrees` or `mac`. |
| `SIMCTL_CHILD_SHIPWARDEN_PAIR_LINK` | Pairs the app with this `shipwarden://pair?…` link at start. |
| `SIMCTL_CHILD_SHIPWARDEN_OPEN_AGENT` | Opens the agent with this session ID. |
| `SIMCTL_CHILD_SHIPWARDEN_SEND_TEXT` | Sends this text to the opened agent. |

For example: `SIMCTL_CHILD_SHIPWARDEN_PAIR_LINK="$(pbpaste)" xcrun simctl launch booted dev.shipwarden.ios`.

## Code

| File | Contents |
|---|---|
| `Models.swift` | The API types. They are the same as `src/shared/remote.ts`. Change both together. `npm run check:ios-contract` (in the repository root) finds a difference. |
| `APIClient.swift` | HTTPS with the pinned certificate, the event streams and the keychain |
| `AppModel.swift` | The pairing, the connection and the agent list |
| `Demo.swift` | The sample agents of the demo |
| `TerminalStyle.swift` | The screen of an agent as styled text |
| `*View.swift` | The screens |
