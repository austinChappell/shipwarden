import SwiftUI

/// The agents of all projects. The agents that need the user come first.
struct AgentsView: View {
    @Environment(AppModel.self) private var model
    @State private var showExited = false

    private var visibleAgents: [RemoteAgent] {
        model.sortedAgents.filter { showExited || !$0.exited }
    }

    var body: some View {
        List {
            ConnectionBanner()
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
                    description: Text("Agents that you start in ShipWarden on the Mac show here.")
                )
            }
        }
        .navigationTitle("Agents")
        .navigationDestination(for: String.self) { id in
            AgentDetailView(agentId: id)
        }
        .refreshable { await model.refresh() }
        .toolbar {
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
