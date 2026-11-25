# Dictation

ShipWarden can change speech into a prompt for an agent. It uses the speech recognition of macOS on the Mac only
(`requiresOnDeviceRecognition`). No audio leaves the Mac. ShipWarden does not use the Web Speech API of Chromium,
because it sends the audio to a Google server and needs a Google key.

## Use

- The chat field and the top right of an agent terminal have a microphone button. The default key is ⌥⌘L (the command
  `dictation` in Settings › Keyboard).
- The key starts the dictation for the agent tab with the focus. Without a focused agent tab, it uses the agent of the
  active tab or of the worktree. A second press stops the dictation.
- While the microphone records, a bar shows "Listening" and the text until now. **Done** stops the recording. The close
  icon stops without text.
- The final text goes to the cursor of the chat field when the chat shows. Else it goes to the prompt of the agent in
  the terminal, as a bracketed paste without Enter. Thus a character such as "!" or "?" at the start does not change
  the mode of the agent, and the user can check the text before sending it.
- One dictation runs at a time. A new dictation stops the dictation before it without text.

## The helper

`native/dictation/main.swift` is a small command-line program. It uses `SFSpeechRecognizer` and `AVAudioEngine`.

- It writes one JSON object on each line of stdout: `listening`, `partial` (with `text`), `final` (with `text`), or
  `error` (with `code` and `message`).
- It reads one command on each line of stdin: `stop` (stop the recording and send the final text) or `cancel`. The end
  of stdin is the same as `cancel`, so the helper stops when the app stops.
- It uses the language of macOS. When macOS has no speech recognition on the Mac for that language, it stops with the
  error `onDeviceUnavailable`. It never falls back to the server recognition.
- The Info.plist of the helper (`native/dictation/Info.plist`) is in the `__TEXT,__info_plist` section of the binary.
  macOS stops a process that asks for the microphone or for speech recognition without the usage texts.

The main process (`src/main/dictation`) starts the helper, reads its lines, and sends the states to the window that
started the dictation. A window that closes cancels its dictation. After `stop`, the helper has 5 seconds for the final
text. After that time, the newest partial text is the final text.

## Build

- `npm run build:dictation` builds `native/build/shipwarden-dictation` with `swiftc`. `npm run dev` needs it one time.
- electron-builder runs `scripts/before-pack.cjs` before it packs the app. The hook builds the helper, and
  `extraResources` copies it to `Contents/Resources/native`. electron-builder signs it with the entitlements of the app.
- `build/entitlements.mac.plist` has `com.apple.security.device.audio-input`. The hardened runtime blocks the microphone
  without it.
- The Info.plist of the app has `NSMicrophoneUsageDescription` and `NSSpeechRecognitionUsageDescription`
  (`build.mac.extendInfo` in `package.json`).
- CI runs `npm run check:dictation` (`swiftc -typecheck`). It does not link or run the helper.

## Permissions

macOS asks for the microphone and speech recognition permissions at the first dictation. By default, macOS reads the
usage texts from the Info.plist of the app that started a process (the "responsible" process). In development, that is
Electron or the terminal app that runs `npm run dev`. Their Info.plist has no `NSSpeechRecognitionUsageDescription`, so
macOS stopped the helper with SIGABRT.

Thus the helper starts itself again at launch, as its own responsible process
(`responsibility_spawnattrs_setdisclaim` with `POSIX_SPAWN_SETEXEC`). The PID, stdin, and stdout stay the same. macOS
then reads the usage texts from the Info.plist in the helper binary, and the dialog names ShipWarden Dictation. To reset
the permissions, run `tccutil reset Microphone dev.shipwarden.app.dictation` and
`tccutil reset SpeechRecognition dev.shipwarden.app.dictation`.
