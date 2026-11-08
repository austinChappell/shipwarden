import Foundation

// The API types. They are the same as `src/shared/remote.ts` in the desktop app.

/// The protocol version that this app speaks. The Mac sends its version in each snapshot.
let remoteProtocol = 1

enum AgentState: String, Codable {
    case starting, idle, working, waiting, done, exited

    var label: String {
        switch self {
        case .starting: "Starting"
        case .idle: "Ready"
        case .working: "Working"
        case .waiting: "Needs input"
        case .done: "Done"
        case .exited: "Exited"
        }
    }

    /// The order in the list. The first state needs the user most.
    var priority: Int {
        switch self {
        case .waiting: 0
        case .working: 1
        case .done: 2
        case .starting: 3
        case .idle: 4
        case .exited: 5
        }
    }
}

struct RemoteAgent: Codable, Identifiable, Equatable {
    let id: String
    let title: String
    let worktreePath: String?
    let cwd: String
    let state: AgentState?
    let message: String?
    let prompt: String?
    /// The time of the last state change, in milliseconds.
    let stateAt: Double?
    let exited: Bool

    var stateDate: Date? { stateAt.map { Date(timeIntervalSince1970: $0 / 1000) } }
}

struct RemotePullRequest: Codable, Equatable {
    let number: Int
    let title: String?
    let url: String
    let isDraft: Bool
    let reviewDecision: String?
    /// SUCCESS, FAILURE, ERROR, PENDING or EXPECTED. Nil without checks.
    let checks: String?
    let headSha: String?
}

struct RemoteTask: Codable, Equatable {
    let title: String
    let key: String?
    let url: String?
}

struct RemoteWorktree: Codable, Identifiable, Equatable {
    let path: String
    let branch: String?
    let name: String
    let isMain: Bool
    let task: RemoteTask?
    let pullRequest: RemotePullRequest?

    var id: String { path }
}

struct RemoteRepo: Codable, Identifiable, Equatable {
    let path: String
    let name: String
    let color: String?
    let worktrees: [RemoteWorktree]

    var id: String { path }
}

struct RemoteProject: Codable, Identifiable, Equatable {
    let id: String
    let name: String
    let repos: [RemoteRepo]
}

struct MacInfo: Codable, Equatable {
    let name: String
    let version: String
}

struct RemoteSnapshot: Codable, Equatable {
    let `protocol`: Int
    let mac: MacInfo
    let projects: [RemoteProject]
    let agents: [RemoteAgent]
}

/// A color of the terminal: an index in the 256-color palette, or an RGB value.
enum TerminalColor: Codable, Equatable {
    case palette(Int)
    case rgb(UInt32)

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let index = try? container.decode(Int.self) {
            self = .palette(index)
            return
        }
        let text = try container.decode(String.self)
        guard text.hasPrefix("#"), let value = UInt32(text.dropFirst(), radix: 16) else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "The color \(text) is not valid.")
        }
        self = .rgb(value)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .palette(let index): try container.encode(index)
        case .rgb(let value): try container.encode(String(format: "#%06x", value))
        }
    }
}

/// A run of characters with the same style.
struct ScreenRun: Codable, Equatable {
    let t: String
    let fg: TerminalColor?
    let bg: TerminalColor?
    let b: Int?
    let d: Int?
    let i: Int?
    let u: Int?
    let v: Int?
}

struct ScreenCursor: Codable, Equatable {
    let x: Int
    let y: Int
    let visible: Bool
}

/// The text of a terminal: some scrollback lines, then the visible screen.
struct ScreenSnapshot: Codable, Equatable {
    let cols: Int
    let rows: Int
    let lines: [[ScreenRun]]
    let cursor: ScreenCursor
}

/// The keys that the app can send to an agent.
enum RemoteKey: String, Codable, CaseIterable {
    case enter, escape, tab, shiftTab, up, down, left, right, backspace, ctrlC, ctrlD
}

struct RemoteInput: Encodable {
    var text: String?
    var key: RemoteKey?
    var submit: Bool?
}

struct PairResponse: Decodable {
    let `protocol`: Int
    let token: String
    let deviceId: String
    let mac: MacInfo
}

struct APIErrorBody: Decodable {
    let error: String
}

/// The content of a pairing QR code.
struct PairingLink: Equatable {
    let name: String
    let hosts: [String]
    let port: Int
    /// The SHA-256 fingerprint of the Mac's certificate, as lowercase hex.
    let fingerprint: String
    let code: String

    /// Reads a link such as `shipwarden://pair?v=1&name=Mac&h=mac.local,192.168.1.4&p=7429&fp=…&c=…`.
    init?(_ text: String) {
        guard let components = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              components.scheme == "shipwarden", components.host == "pair" else { return nil }
        let items = Dictionary((components.queryItems ?? []).map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { first, _ in first })
        let hosts = (items["h"] ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        let fingerprint = (items["fp"] ?? "").lowercased()
        guard let port = Int(items["p"] ?? ""), (1...65535).contains(port), !hosts.isEmpty,
              fingerprint.count == 64, fingerprint.allSatisfy({ $0.isHexDigit }),
              let code = items["c"], !code.isEmpty else { return nil }
        self.name = items["name"].flatMap { $0.isEmpty ? nil : $0 } ?? "Mac"
        self.hosts = hosts
        self.port = port
        self.fingerprint = fingerprint
        self.code = code
    }
}
