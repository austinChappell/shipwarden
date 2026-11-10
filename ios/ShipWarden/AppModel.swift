import Foundation
import Observation
import UIKit

/// The Mac that the app is paired with. The token is in the keychain, not here.
struct Pairing: Codable, Equatable {
    var macName: String
    var hosts: [String]
    var port: Int
    var fingerprint: String
    var deviceId: String
    /// The host that answered last. The app tries it first.
    var lastHost: String?

    var orderedHosts: [String] {
        guard let lastHost, hosts.contains(lastHost) else { return hosts }
        return [lastHost] + hosts.filter { $0 != lastHost }
    }
}

enum ConnectionState: Equatable {
    case disconnected
    case connecting
    case connected
    case failed(String)
}

/// Where an agent works: its project, repository and worktree.
struct AgentPlace {
    let project: RemoteProject?
    let repo: RemoteRepo?
    let worktree: RemoteWorktree?
}

@MainActor
@Observable
final class AppModel {
    private static let pairingKey = "pairing"

    private(set) var pairing: Pairing?
    private(set) var snapshot: RemoteSnapshot?
    private(set) var agents: [RemoteAgent] = []
    private(set) var connection: ConnectionState = .disconnected
    /// A pairing link from the Camera app or a QR scan. The pairing screen shows it.
    var pendingLink: PairingLink?

    private(set) var client: APIClient?
    private var loop: Task<Void, Never>?
    /// The sample agents. While the demo runs, the app uses no network.
    private(set) var demo: DemoState?

    init() {
        if let data = UserDefaults.standard.data(forKey: Self.pairingKey),
           let stored = try? JSONDecoder().decode(Pairing.self, from: data),
           Keychain.read(account: stored.deviceId) != nil {
            pairing = stored
        }
    }

    // MARK: Pairing

    func pair(with link: PairingLink, deviceName: String) async throws {
        // The first connection shows the iOS prompt for local network access. The connections fail until the user
        // answers, so try again for a few seconds.
        var found: String?
        for attempt in 0..<8 {
            if attempt > 0 { try await Task.sleep(nanoseconds: 2_500_000_000) }
            found = await APIClient.firstReachableHost(link.hosts, port: link.port, fingerprint: link.fingerprint)
            if found != nil { break }
        }
        guard let host = found else {
            throw APIError.noHost
        }
        let response = try await APIClient(host: host, port: link.port, fingerprint: link.fingerprint, token: nil).pair(code: link.code, name: deviceName)
        if let old = pairing { Keychain.delete(account: old.deviceId) }
        Keychain.save(response.token, account: response.deviceId)
        let next = Pairing(macName: response.mac.name, hosts: link.hosts, port: link.port, fingerprint: link.fingerprint, deviceId: response.deviceId, lastHost: host)
        save(next)
        pendingLink = nil
        demo = nil
        stop()
        start()
    }

    /// Forgets the Mac on this phone. The Mac keeps the device until the user removes it there.
    func unpair() {
        stop()
        if let pairing { Keychain.delete(account: pairing.deviceId) }
        UserDefaults.standard.removeObject(forKey: Self.pairingKey)
        pairing = nil
        snapshot = nil
        agents = []
        client = nil
    }

    private func save(_ next: Pairing) {
        pairing = next
        if let data = try? JSONEncoder().encode(next) {
            UserDefaults.standard.set(data, forKey: Self.pairingKey)
        }
    }

    // MARK: Demo

    func startDemo() {
        stop()
        let demo = DemoState()
        demo.onChange = { [weak self, weak demo] in
            guard let self, let demo else { return }
            self.agents = demo.agents
        }
        self.demo = demo
        pendingLink = nil
        snapshot = demo.snapshot
        agents = demo.agents
        connection = .connected
    }

    func stopDemo() {
        demo = nil
        snapshot = nil
        agents = []
        connection = .disconnected
        start()
    }

    // MARK: Connection

    /// Connects and keeps the connection. After a failure, it tries again after a short wait.
    func start() {
        guard pairing != nil, demo == nil, loop == nil else { return }
        loop = Task { [weak self] in
            var delay: UInt64 = 1
            while !Task.isCancelled {
                guard let self else { return }
                let stop = await self.runConnection()
                if stop || Task.isCancelled { return }
                try? await Task.sleep(nanoseconds: delay * 1_000_000_000)
                delay = min(delay * 2, 15)
            }
        }
    }

    func stop() {
        loop?.cancel()
        loop = nil
        if case .failed = connection {} else { connection = .disconnected }
    }

    /// Loads the state again, for example on pull to refresh.
    func refresh() async {
        guard demo == nil, let client else { return }
        do {
            apply(try await client.state())
        } catch {
            connection = .failed(error.localizedDescription)
        }
    }

    /// One connection: find the host, load the state, then follow the events. Returns true when the app must stop trying.
    private func runConnection() async -> Bool {
        guard let pairing, let token = Keychain.read(account: pairing.deviceId) else { return true }
        connection = .connecting
        guard let host = await APIClient.firstReachableHost(pairing.orderedHosts, port: pairing.port, fingerprint: pairing.fingerprint) else {
            connection = .failed(APIError.noHost.localizedDescription)
            return false
        }
        if host != pairing.lastHost {
            var next = pairing
            next.lastHost = host
            save(next)
        }
        let client = APIClient(host: host, port: pairing.port, fingerprint: pairing.fingerprint, token: token)
        self.client = client
        do {
            apply(try await client.state())
            connection = .connected
            for try await event in client.events("/v1/events") {
                if event.name == "agents", let list = try? JSONDecoder().decode([RemoteAgent].self, from: event.data) {
                    agents = list
                }
            }
            connection = .connecting
            return false
        } catch APIError.unauthorized(let message) {
            connection = .failed(message)
            return true
        } catch is CancellationError {
            return true
        } catch {
            if Task.isCancelled { return true }
            connection = .failed(error.localizedDescription)
            return false
        }
    }

    private func apply(_ next: RemoteSnapshot) {
        snapshot = next
        agents = next.agents
        if var pairing, pairing.macName != next.mac.name {
            pairing.macName = next.mac.name
            save(pairing)
        }
    }

    // MARK: Data

    /// The agents in list order: the agents that need the user first, then the newest changes.
    var sortedAgents: [RemoteAgent] {
        agents.sorted { a, b in
            let pa = a.state?.priority ?? (a.exited ? 6 : 4)
            let pb = b.state?.priority ?? (b.exited ? 6 : 4)
            if pa != pb { return pa < pb }
            return (a.stateAt ?? 0) > (b.stateAt ?? 0)
        }
    }

    func place(of agent: RemoteAgent) -> AgentPlace {
        guard let snapshot, let path = agent.worktreePath else { return AgentPlace(project: nil, repo: nil, worktree: nil) }
        for project in snapshot.projects {
            for repo in project.repos {
                if let worktree = repo.worktrees.first(where: { $0.path == path }) {
                    return AgentPlace(project: project, repo: repo, worktree: worktree)
                }
            }
        }
        return AgentPlace(project: nil, repo: nil, worktree: nil)
    }

    /// The name of an agent: its task, else its last prompt, else its worktree, else its tab title. The same as the Mac.
    func name(of agent: RemoteAgent) -> String {
        let place = place(of: agent)
        if let task = place.worktree?.task { return task.title }
        if let prompt = agent.prompt, !prompt.isEmpty { return prompt }
        if let worktree = place.worktree { return worktree.name }
        return agent.title
    }

    func agents(in worktree: RemoteWorktree) -> [RemoteAgent] {
        agents.filter { $0.worktreePath == worktree.path }
    }

    // MARK: Actions

    func send(_ input: RemoteInput, to agent: RemoteAgent) async throws {
        if let demo {
            demo.handle(input, agentId: agent.id)
            agents = demo.agents
            return
        }
        guard let client else { throw APIError.noHost }
        try await client.input(agentId: agent.id, input)
    }

    func approve(_ pullRequest: RemotePullRequest, in worktree: RemoteWorktree, body: String) async throws {
        if let demo {
            demo.approve(worktreePath: worktree.path)
            snapshot = demo.snapshot
            return
        }
        guard let client else { throw APIError.noHost }
        guard let headSha = pullRequest.headSha else {
            throw APIError.server(400, "The Mac did not send the head commit of this pull request. Update ShipWarden on the Mac.")
        }
        try await client.approve(worktreePath: worktree.path, number: pullRequest.number, headSha: headSha, body: body)
        await refresh()
    }

    static var deviceName: String {
        UIDevice.current.name
    }
}
