import CryptoKit
import Foundation
import Security

enum APIError: LocalizedError {
    /// The Mac refused the token. The user must pair again.
    case unauthorized(String)
    case server(Int, String)
    case noHost
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .unauthorized(let message): message
        case .server(_, let message): message
        case .noHost: "The app cannot reach the Mac. Make sure that ShipWarden is open on the Mac and that phone connections are on. The phone must be on the same network as the Mac, and not on cellular data. Also make sure that iOS Settings › Privacy & Security › Local Network has ShipWarden on."
        case .invalidResponse: "The Mac sent a response that the app cannot read."
        }
    }
}

/// Accepts only the Mac's own certificate. The pairing code contains its SHA-256 fingerprint.
final class PinnedTrustDelegate: NSObject, URLSessionDelegate, URLSessionTaskDelegate {
    let fingerprint: String

    init(fingerprint: String) {
        self.fingerprint = fingerprint
    }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge) async -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        evaluate(challenge)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge) async -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        evaluate(challenge)
    }

    private func evaluate(_ challenge: URLAuthenticationChallenge) -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust,
              let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let leaf = chain.first else {
            return (.cancelAuthenticationChallenge, nil)
        }
        let der = SecCertificateCopyData(leaf) as Data
        let hash = SHA256.hash(data: der).map { String(format: "%02x", $0) }.joined()
        guard hash == fingerprint else {
            return (.cancelAuthenticationChallenge, nil)
        }
        return (.useCredential, URLCredential(trust: trust))
    }
}

/// An event of a stream from the Mac: a name and its JSON data.
struct ServerEvent {
    let name: String
    let data: Data
}

/// Sends the requests to one Mac. Each request trusts only the pinned certificate.
final class APIClient: @unchecked Sendable {
    let fingerprint: String
    let port: Int
    private(set) var host: String
    private let token: String?
    private let session: URLSession
    private let streamSession: URLSession

    init(host: String, port: Int, fingerprint: String, token: String?) {
        self.host = host
        self.port = port
        self.fingerprint = fingerprint
        self.token = token
        let delegate = PinnedTrustDelegate(fingerprint: fingerprint)
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 15
        config.waitsForConnectivity = false
        self.session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
        // The Mac sends a keepalive every 15 seconds, so a stream with no data for 45 seconds is dead.
        let streamConfig = URLSessionConfiguration.ephemeral
        streamConfig.timeoutIntervalForRequest = 45
        streamConfig.timeoutIntervalForResource = 60 * 60 * 24
        self.streamSession = URLSession(configuration: streamConfig, delegate: delegate, delegateQueue: nil)
    }

    deinit {
        session.invalidateAndCancel()
        streamSession.invalidateAndCancel()
    }

    /// Tries the hosts at the same time and returns the first that answers with the Mac's certificate.
    static func firstReachableHost(_ hosts: [String], port: Int, fingerprint: String) async -> String? {
        await withTaskGroup(of: String?.self) { group in
            for host in hosts {
                group.addTask {
                    let client = APIClient(host: host, port: port, fingerprint: fingerprint, token: nil)
                    var request = URLRequest(url: client.url("/v1/state"))
                    request.timeoutInterval = 5
                    // The Mac answers 401 without a token. Any answer proves that the host is the Mac with this certificate.
                    guard let (_, response) = try? await client.session.data(for: request), response is HTTPURLResponse else { return nil }
                    return host
                }
            }
            for await host in group {
                if let host {
                    group.cancelAll()
                    return host
                }
            }
            return nil
        }
    }

    func url(_ path: String) -> URL {
        // An IPv6 address needs brackets in a URL.
        let name = host.contains(":") ? "[\(host)]" : host
        return URL(string: "https://\(name):\(port)\(path)")!
    }

    private func request(_ path: String, method: String = "GET", body: Encodable? = nil) throws -> URLRequest {
        var request = URLRequest(url: url(path))
        request.httpMethod = method
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }
        return request
    }

    private func check(_ data: Data, _ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let message = (try? JSONDecoder().decode(APIErrorBody.self, from: data))?.error ?? "The Mac answered with status \(http.statusCode)."
            if http.statusCode == 401 { throw APIError.unauthorized(message) }
            throw APIError.server(http.statusCode, message)
        }
    }

    private func send<T: Decodable>(_ request: URLRequest, as type: T.Type) async throws -> T {
        let (data, response) = try await session.data(for: request)
        try check(data, response)
        return try JSONDecoder().decode(T.self, from: data)
    }

    private struct Empty: Decodable {}

    func pair(code: String, name: String) async throws -> PairResponse {
        struct Body: Encodable { let code: String; let name: String }
        return try await send(try request("/v1/pair", method: "POST", body: Body(code: code, name: name)), as: PairResponse.self)
    }

    func state() async throws -> RemoteSnapshot {
        try await send(try request("/v1/state"), as: RemoteSnapshot.self)
    }

    func input(agentId: String, _ input: RemoteInput) async throws {
        _ = try await send(try request("/v1/sessions/\(agentId)/input", method: "POST", body: input), as: Empty.self)
    }

    func approve(worktreePath: String, number: Int, headSha: String, body: String) async throws {
        struct Body: Encodable { let worktreePath: String; let number: Int; let headSha: String; let body: String }
        _ = try await send(try request("/v1/pull-requests/approve", method: "POST", body: Body(worktreePath: worktreePath, number: number, headSha: headSha, body: body)), as: Empty.self)
    }

    /// Opens an event stream. The stream ends when the connection closes.
    func events(_ path: String) -> AsyncThrowingStream<ServerEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let (bytes, response) = try await streamSession.bytes(for: try request(path))
                    if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                        var data = Data()
                        for try await byte in bytes { data.append(byte) }
                        try check(data, response)
                    }
                    // The Mac sends each event as an "event:" line and one "data:" line.
                    // `lines` leaves out the empty lines between events.
                    var name = "message"
                    for try await line in bytes.lines {
                        if line.hasPrefix("event: ") {
                            name = String(line.dropFirst(7))
                        } else if line.hasPrefix("data: ") {
                            continuation.yield(ServerEvent(name: name, data: Data(line.dropFirst(6).utf8)))
                            name = "message"
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

/// Keeps the tokens in the keychain. Only this device can read them.
enum Keychain {
    private static let service = "dev.shipwarden.ios.token"

    static func save(_ token: String, account: String) {
        delete(account: account)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecValueData as String: Data(token.utf8)
        ]
        SecItemAdd(query as CFDictionary, nil)
    }

    static func read(account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func delete(account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(query as CFDictionary)
    }
}
