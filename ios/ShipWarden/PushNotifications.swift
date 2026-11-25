import Foundation
import Observation
import UIKit
import UserNotifications

/// What a tap on a notification opens.
enum PushTarget: Equatable {
    /// The agent that needs input.
    case agent(String)
    /// The list of the automation runs that are waiting for approval.
    case approvals
}

/// Keeps the APNs device token and the last tap on a notification. The app delegate gives both.
@MainActor
@Observable
final class PushCenter {
    static let shared = PushCenter()

    /// The APNs device token, as lowercase hex. iOS gives it again at each launch.
    private(set) var deviceToken: String?
    /// The target of the last tap. RootView opens it and sets it to nil.
    var tapped: PushTarget?
    private var waiters: [CheckedContinuation<String?, Never>] = []

    /// The APNs environment of this build. A build from Xcode uses the sandbox. TestFlight and the App Store use production.
    nonisolated static var environment: String {
        #if DEBUG
        "sandbox"
        #else
        "production"
        #endif
    }

    /// Asks for permission to show notifications, then gets the device token. Returns nil when the user does not allow notifications.
    func requestToken() async -> String? {
        let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])) ?? false
        guard granted else { return nil }
        if let deviceToken { return deviceToken }
        return await withCheckedContinuation { continuation in
            waiters.append(continuation)
            if waiters.count == 1 {
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }

    func received(token: Data) {
        let hex = token.map { String(format: "%02x", $0) }.joined()
        deviceToken = hex
        resume(hex)
    }

    func failed(_ error: Error) {
        print("[push] The registration for notifications failed: \(error.localizedDescription)")
        resume(nil)
    }

    private func resume(_ value: String?) {
        let current = waiters
        waiters = []
        for waiter in current { waiter.resume(returning: value) }
    }
}

/// The app delegate. iOS gives the device token and the taps on notifications to it.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in PushCenter.shared.received(token: deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Task { @MainActor in PushCenter.shared.failed(error) }
    }

    /// Shows the notification also while the app is open.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    /// A tap opens the agent, or the runs that are waiting for approval. The relay puts the kind and the IDs in the payload.
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        let kind = info["kind"] as? String
        let agentId = info["agentId"] as? String
        let target: PushTarget?
        switch kind {
        case "needsInput": target = agentId.map(PushTarget.agent)
        case "approval": target = .approvals
        default: target = nil
        }
        guard let target else { return }
        await MainActor.run { PushCenter.shared.tapped = target }
    }
}

/// The push relay. It turns the device token into a ticket for the Mac. The Mac never gets the device token.
enum PushRelay {
    private struct RegisterBody: Encodable {
        let deviceToken: String
        let environment: String
    }

    private struct RegisterAnswer: Decodable {
        let ticket: String
        let key: String
    }

    /// The last registration. The relay gives the same ticket for the same token, so the app asks it again only after a change.
    private struct Cached: Codable {
        let relayUrl: String
        let deviceToken: String
        let environment: String
        let ticket: String
        let key: String
    }

    private static let cacheAccount = "push-registration"

    /// Returns the ticket and the push key for this device token from the relay.
    static func register(relayUrl: String, deviceToken: String) async throws -> RemotePushRegistration {
        let environment = PushCenter.environment
        if let text = Keychain.read(account: cacheAccount), let cached = try? JSONDecoder().decode(Cached.self, from: Data(text.utf8)),
           cached.relayUrl == relayUrl, cached.deviceToken == deviceToken, cached.environment == environment {
            return RemotePushRegistration(relayUrl: relayUrl, ticket: cached.ticket, key: cached.key)
        }
        guard let url = URL(string: relayUrl.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/v1/register") else {
            throw APIError.server(400, "The relay address of the Mac is not valid.")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(RegisterBody(deviceToken: deviceToken, environment: environment))
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let message = (try? JSONDecoder().decode(APIErrorBody.self, from: data))?.error ?? "The push relay did not accept the registration."
            throw APIError.server((response as? HTTPURLResponse)?.statusCode ?? 0, message)
        }
        let answer = try JSONDecoder().decode(RegisterAnswer.self, from: data)
        let cached = Cached(relayUrl: relayUrl, deviceToken: deviceToken, environment: environment, ticket: answer.ticket, key: answer.key)
        if let encoded = try? JSONEncoder().encode(cached), let text = String(data: encoded, encoding: .utf8) {
            Keychain.save(text, account: cacheAccount)
        }
        return RemotePushRegistration(relayUrl: relayUrl, ticket: answer.ticket, key: answer.key)
    }
}
