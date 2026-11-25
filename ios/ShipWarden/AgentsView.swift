import SwiftUI

/// The agents of all projects. The agents that need the user come first.
struct AgentsView: View {
    @Environment(AppModel.self) private var model
    @State private var showExited = false
    @State private var answerError: String?
    @State private var showStart = false
    /// The agent that the start screen started. The app opens it.
    @State private var startedAgent: String?

    private var visibleAgents: [RemoteAgent] {
        model.sortedAgents.filter { showExited || !$0.exited }
    }

    var body: some View {
        List {
            ConnectionBanner()
            if !model.pendingRuns.isEmpty {
                Section("Waiting for approval") {
                    ForEach(model.pendingRuns) { run in
                        PendingRunRow(run: run) { approve in
                            do {
                                try await model.answer(run, approve: approve)
                            } catch {
                                answerError = error.localizedDescription
                            }
                        }
                    }
                }
            }
            ForEach(visibleAgents) { agent in
                NavigationLink(value: agent.id) {
                    AgentRow(agent: agent)
                }
            }
        }
        .overlay {
            if visibleAgents.isEmpty && model.connection == .connected {
                ContentUnavailableView(
                    "No agents",
                    systemImage: "sparkles",
                    description: Text("Agents that you start in ShipWarden on the Mac show here. Tap + to start an agent.")
                )
            }
        }
        .alert("The answer did not reach the Mac", isPresented: Binding(get: { answerError != nil }, set: { if !$0 { answerError = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(answerError ?? "")
        }
        .navigationTitle("Agents")
        .navigationDestination(for: String.self) { id in
            AgentDetailView(agentId: id)
        }
        .navigationDestination(item: $startedAgent) { id in
            AgentDetailView(agentId: id)
        }
        .sheet(isPresented: $showStart) {
            StartAgentView { agent in startedAgent = agent.id }
        }
        .refreshable { await model.refresh() }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showStart = true
                } label: {
                    Label("Start an agent", systemImage: "plus")
                }
                .disabled(model.connection != .connected)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Toggle("Show ended agents", isOn: $showExited)
                } label: {
                    Label("Filter", systemImage: "line.3.horizontal.decrease")
                }
            }
        }
    }
}

struct AgentStateBadge: View {
    let state: AgentState?
    let exited: Bool

    var body: some View {
        let shown = state ?? (exited ? .exited : nil)
        Label(shown?.label ?? "Running", systemImage: shown?.symbol ?? "terminal")
            .font(.caption.weight(.semibold))
            .foregroundStyle(shown?.color ?? .secondary)
            .symbolEffect(.pulse, isActive: shown == .working)
    }
}

struct AgentRow: View {
    @Environment(AppModel.self) private var model
    let agent: RemoteAgent

    var body: some View {
        let place = model.place(of: agent)
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                AgentStateBadge(state: agent.state, exited: agent.exited)
                Spacer()
                if let date = agent.stateDate {
                    Text(date, style: .relative)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
            }
            Text(model.name(of: agent))
                .font(.body.weight(.medium))
                .lineLimit(2)
            if let reason = agent.reason, !reason.isEmpty {
                Text(reason)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            if let message = agent.message, !message.isEmpty {
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(agent.state == .waiting ? .primary : .secondary)
                    .lineLimit(3)
            }
            if let repo = place.repo {
                HStack(spacing: 4) {
                    Circle()
                        .fill(Color(hex: repo.color) ?? .secondary)
                        .frame(width: 7, height: 7)
                    Text(repo.name)
                    if let branch = place.worktree?.branch {
                        Text("·")
                        Text(branch).lineLimit(1)
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}

/// An automation run that is waiting for approval, with the Skip and Approve buttons.
struct PendingRunRow: View {
    let run: RemoteAutomationRun
    let answer: (Bool) async -> Void
    @State private var sending = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Label("Waiting for approval", systemImage: "hand.raised")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.orange)
                Spacer()
                Text(run.createdDate, style: .relative)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            Text(run.automationName)
                .font(.body.weight(.medium))
                .lineLimit(2)
            Text(run.label)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(2)
            HStack {
                Spacer()
                Button("Skip") { send(false) }
                    .buttonStyle(.bordered)
                Button("Approve") { send(true) }
                    .buttonStyle(.borderedProminent)
            }
            .controlSize(.small)
            .disabled(sending)
        }
        .padding(.vertical, 2)
    }

    private func send(_ approve: Bool) {
        sending = true
        Task {
            await answer(approve)
            sending = false
        }
    }
}
