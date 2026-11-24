// The dictation helper of ShipWarden. It records the microphone and changes the speech into text with the speech
// recognition of macOS. It uses only the recognition on this Mac (requiresOnDeviceRecognition), so no audio leaves
// the Mac.
//
// Usage: shipwarden-dictation [--locale <identifier>]
//
// Output: one JSON object on each line of stdout.
//   {"type":"listening"}                                  The microphone records.
//   {"type":"partial","text":"..."}                       The text until now. The next partial text replaces it.
//   {"type":"final","text":"..."}                         The last text. The helper then stops with status 0.
//   {"type":"error","code":"...","message":"..."}         The helper then stops with status 1.
//
// Input: one command on each line of stdin.
//   stop     Stop the recording. The helper sends the final text, then stops.
//   cancel   Stop at once, without a final text.
// The end of stdin is the same as "cancel". Thus the helper stops when ShipWarden stops.
//
// The error codes: unsupportedLanguage, onDeviceUnavailable, speechDenied, microphoneDenied, noMicrophone,
// audioFailed, recognitionFailed, badArguments.

import AVFoundation
import Foundation
import Speech

/// Writes one JSON object as one line on stdout.
func emit(_ object: [String: String]) {
    guard var data = try? JSONSerialization.data(withJSONObject: object, options: []) else { return }
    data.append(0x0A)
    FileHandle.standardOutput.write(data)
}

/// Writes an error line and stops the process with status 1.
func fail(_ code: String, _ message: String) -> Never {
    emit(["type": "error", "code": code, "message": message])
    exit(1)
}

/// Reads the value of the --locale argument. Returns nil when the argument is not there.
func localeArgument() -> String? {
    let arguments = CommandLine.arguments.dropFirst()
    guard let index = arguments.firstIndex(of: "--locale") else {
        if let other = arguments.first { fail("badArguments", "The argument \(other) is not known.") }
        return nil
    }
    let next = arguments.index(after: index)
    guard next < arguments.endIndex, !arguments[next].isEmpty else { fail("badArguments", "--locale needs a value.") }
    return arguments[next]
}

/// Asks for the speech recognition permission when macOS did not ask before. Calls `done` on the main queue.
func requestSpeechPermission(_ done: @escaping (Bool) -> Void) {
    switch SFSpeechRecognizer.authorizationStatus() {
    case .authorized:
        done(true)
    case .notDetermined:
        SFSpeechRecognizer.requestAuthorization { status in
            DispatchQueue.main.async { done(status == .authorized) }
        }
    default:
        done(false)
    }
}

/// Asks for the microphone permission when macOS did not ask before. Calls `done` on the main queue.
func requestMicrophonePermission(_ done: @escaping (Bool) -> Void) {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized:
        done(true)
    case .notDetermined:
        AVCaptureDevice.requestAccess(for: .audio) { granted in
            DispatchQueue.main.async { done(granted) }
        }
    default:
        done(false)
    }
}

/// One dictation: the audio engine, the recognition request, and the recognition task.
final class Dictation {
    let recognizer: SFSpeechRecognizer
    let engine = AVAudioEngine()
    let request = SFSpeechAudioBufferRecognitionRequest()
    var task: SFSpeechRecognitionTask?
    /// The newest text. An error after "stop" sends it as the final text.
    var lastText = ""
    var stopping = false
    var finished = false

    init(recognizer: SFSpeechRecognizer) {
        self.recognizer = recognizer
    }

    func start() {
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
        if #available(macOS 13.0, *) {
            request.addsPunctuation = true
        }

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        if format.channelCount == 0 || format.sampleRate == 0 {
            fail("noMicrophone", "macOS has no microphone for the recording.")
        }
        let request = self.request
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
        }

        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            DispatchQueue.main.async { self?.handle(result: result, error: error) }
        }

        engine.prepare()
        do {
            try engine.start()
        } catch {
            fail("audioFailed", "The recording did not start: \(error.localizedDescription)")
        }
        emit(["type": "listening"])
    }

    func handle(result: SFSpeechRecognitionResult?, error: Error?) {
        if finished { return }
        if let result {
            lastText = result.bestTranscription.formattedString
            if result.isFinal {
                finish(lastText)
                return
            }
            emit(["type": "partial", "text": lastText])
        }
        if let error {
            // After "stop", an error such as "No speech detected" ends the dictation with the newest text.
            if stopping {
                finish(lastText)
                return
            }
            fail("recognitionFailed", error.localizedDescription)
        }
    }

    /// Stops the recording. The recognition task then sends its final result.
    func stop() {
        if stopping || finished { return }
        stopping = true
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        request.endAudio()
    }

    /// Stops at once, without a final text.
    func cancel() -> Never {
        finished = true
        task?.cancel()
        engine.stop()
        exit(0)
    }

    func finish(_ text: String) {
        finished = true
        emit(["type": "final", "text": text])
        exit(0)
    }
}

/// The dictation after the permission checks. It is nil while macOS asks for a permission.
var current: Dictation?

/// Reads the commands on stdin on a background thread. The commands run on the main queue.
func readCommands() {
    Thread.detachNewThread {
        while let line = readLine() {
            let command = line.trimmingCharacters(in: .whitespaces)
            DispatchQueue.main.async {
                if command == "cancel" { exit(0) }
                guard command == "stop" else { return }
                if let current {
                    current.stop()
                } else {
                    // A stop before the recording starts: no text.
                    emit(["type": "final", "text": ""])
                    exit(0)
                }
            }
        }
        DispatchQueue.main.async {
            if let current { current.cancel() }
            exit(0)
        }
    }
}

let localeId = localeArgument()
let recognizer = localeId.map { SFSpeechRecognizer(locale: Locale(identifier: $0)) } ?? SFSpeechRecognizer()
guard let recognizer else {
    fail("unsupportedLanguage", "macOS has no speech recognition for the language \(localeId ?? Locale.current.identifier).")
}
if !recognizer.supportsOnDeviceRecognition {
    fail(
        "onDeviceUnavailable",
        "macOS has no speech recognition on this Mac for the language \(recognizer.locale.identifier)."
    )
}

readCommands()
requestSpeechPermission { speechAllowed in
    if !speechAllowed { fail("speechDenied", "ShipWarden has no permission for speech recognition.") }
    requestMicrophonePermission { microphoneAllowed in
        if !microphoneAllowed { fail("microphoneDenied", "ShipWarden has no permission for the microphone.") }
        let dictation = Dictation(recognizer: recognizer)
        current = dictation
        dictation.start()
    }
}

dispatchMain()
