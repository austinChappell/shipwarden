import SwiftUI

@main
struct ShipWardenApp: App {
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                // The Camera app opens a pairing link with the app.
                .onOpenURL { url in
                    if let link = PairingLink(url.absoluteString) {
                        model.pendingLink = link
                    }
                }
        }
        .onChange(of: scenePhase) { _, phase in
            // iOS stops the connections of an app in the background. Connect again when the app comes back.
            switch phase {
            case .active: model.start()
            case .background: model.stop()
            default: break
            }
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model
    @State private var agentsPath = NavigationPath()

    var body: some View {
        Group {
            if model.pairing == nil || model.pendingLink != nil {
                PairView()
            } else {
                TabView {
                    NavigationStack(path: $agentsPath) { AgentsView() }
                        .tabItem { Label("Agents", systemImage: "sparkles") }
                    NavigationStack { WorktreesView() }
                        .tabItem { Label("Worktrees", systemImage: "arrow.triangle.branch") }
                    NavigationStack { MacView() }
                        .tabItem { Label("Mac", systemImage: "laptopcomputer") }
                }
            }
        }
        .onAppear { model.start() }
        #if DEBUG
        .task { await runDebugAutomation() }
        #endif
    }

    #if DEBUG
    /// For checks from the command line: `SIMCTL_CHILD_SHIPWARDEN_PAIR_LINK` pairs the app, and
    /// `SIMCTL_CHILD_SHIPWARDEN_OPEN_AGENT` opens an agent. Release builds do not have this code.
    private func runDebugAutomation() async {
        let environment = ProcessInfo.processInfo.environment
        if let text = environment["SHIPWARDEN_PAIR_LINK"], let link = PairingLink(text) {
            try? await model.pair(with: link, deviceName: "Simulator")
        }
        if let id = environment["SHIPWARDEN_OPEN_AGENT"] {
            for _ in 0..<50 where !model.agents.contains(where: { $0.id == id }) {
                try? await Task.sleep(nanoseconds: 200_000_000)
            }
            agentsPath.append(id)
            // `SIMCTL_CHILD_SHIPWARDEN_SEND_TEXT` sends a text to the agent, as the "1" button does.
            if let text = environment["SHIPWARDEN_SEND_TEXT"], let agent = model.agents.first(where: { $0.id == id }) {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                try? await model.send(RemoteInput(text: text), to: agent)
            }
        }
    }
    #endif
}

/// A line at the top of a list when the app has no connection.
struct ConnectionBanner: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        switch model.connection {
        case .connected, .disconnected:
            EmptyView()
        case .connecting:
            Label("Connecting to \(model.pairing?.macName ?? "the Mac")…", systemImage: "antenna.radiowaves.left.and.right")
                .font(.footnote)
                .foregroundStyle(.secondary)
        case .failed(let message):
            Label(message, systemImage: "exclamationmark.triangle.fill")
                .font(.footnote)
                .foregroundStyle(.orange)
        }
    }
}
