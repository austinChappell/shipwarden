import SwiftUI

/// The repositories and worktrees of each project, with their pull requests and CI state.
struct WorktreesView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        List {
            ConnectionBanner()
            ForEach(model.snapshot?.projects ?? []) { project in
                ForEach(project.repos) { repo in
                    Section {
                        ForEach(repo.worktrees) { worktree in
                            NavigationLink(value: WorktreeRoute(path: worktree.path)) {
                                WorktreeRow(worktree: worktree)
                            }
                        }
                    } header: {
                        HStack(spacing: 6) {
                            Circle().fill(Color(hex: repo.color) ?? .secondary).frame(width: 8, height: 8)
                            Text(repo.name)
                            if (model.snapshot?.projects.count ?? 0) > 1 {
                                Text("· \(project.name)").foregroundStyle(.tertiary)
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("Worktrees")
        .navigationDestination(for: WorktreeRoute.self) { route in
            WorktreeDetailView(path: route.path)
        }
        .navigationDestination(for: String.self) { id in
            AgentDetailView(agentId: id)
        }
        .refreshable { await model.refresh() }
    }
}

struct WorktreeRoute: Hashable {
    let path: String
}

struct ChecksBadge: View {
    let checks: String?

    var body: some View {
        switch checks {
        case "SUCCESS": Image(systemName: "checkmark.circle.fill").foregroundStyle(.green).accessibilityLabel("Checks passed")
        case "FAILURE", "ERROR": Image(systemName: "xmark.circle.fill").foregroundStyle(.red).accessibilityLabel("Checks failed")
        case "PENDING", "EXPECTED": Image(systemName: "clock.fill").foregroundStyle(.yellow).accessibilityLabel("Checks running")
        default: EmptyView()
        }
    }
}

struct WorktreeRow: View {
    @Environment(AppModel.self) private var model
    let worktree: RemoteWorktree

    var body: some View {
        let agents = model.agents(in: worktree).filter { !$0.exited }
        let state = agents.compactMap(\.state).min { $0.priority < $1.priority }
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(worktree.name).font(.body.weight(.medium)).lineLimit(1)
                if worktree.isMain {
                    Text("main").font(.caption2).padding(.horizontal, 5).background(.quaternary, in: Capsule())
                }
                Spacer()
                if let state {
                    Image(systemName: state.symbol).foregroundStyle(state.color).accessibilityLabel(state.label)
                }
            }
            if let task = worktree.task {
                Text([task.key, task.title].compactMap { $0 }.joined(separator: " "))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            if let pr = worktree.pullRequest {
                HStack(spacing: 4) {
                    ChecksBadge(checks: pr.checks)
                    Text("#\(pr.number)").monospacedDigit()
                    if pr.isDraft { Text("Draft") }
                    if pr.reviewDecision == "APPROVED" { Text("Approved").foregroundStyle(.green) }
                    if pr.reviewDecision == "CHANGES_REQUESTED" { Text("Changes requested").foregroundStyle(.orange) }
                    if let title = pr.title { Text(title).lineLimit(1) }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        }
    }
}

struct WorktreeDetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    let path: String

    @State private var approving = false
    @State private var confirmApprove = false
    @State private var comment = ""
    @State private var message: String?

    private var worktree: RemoteWorktree? {
        model.snapshot?.projects.flatMap(\.repos).flatMap(\.worktrees).first { $0.path == path }
    }

    var body: some View {
        List {
            if let worktree {
                Section("Worktree") {
                    LabeledContent("Branch", value: worktree.branch ?? "Detached HEAD")
                    LabeledContent("Folder", value: (worktree.path as NSString).abbreviatingWithTildeInPath)
                    if let task = worktree.task {
                        if let url = task.url.flatMap(URL.init(string:)) {
                            Link(destination: url) { LabeledContent("Task", value: [task.key, task.title].compactMap { $0 }.joined(separator: " ")) }
                        } else {
                            LabeledContent("Task", value: task.title)
                        }
                    }
                }

                let agents = model.agents(in: worktree)
                if !agents.isEmpty {
                    Section("Agents") {
                        ForEach(agents) { agent in
                            NavigationLink(value: agent.id) { AgentRow(agent: agent) }
                        }
                    }
                }

                if let pr = worktree.pullRequest {
                    Section("Pull request") {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(pr.title ?? "Pull request #\(pr.number)").font(.headline)
                            HStack(spacing: 6) {
                                ChecksBadge(checks: pr.checks)
                                Text("#\(pr.number)")
                                Text(checksLabel(pr.checks))
                                if pr.isDraft { Text("· Draft") }
                            }
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            if let decision = pr.reviewDecision {
                                Text(reviewLabel(decision)).font(.subheadline)
                            }
                        }
                        if let url = URL(string: pr.url) {
                            Button("Open on GitHub") { openURL(url) }
                        }
                        TextField("Comment (optional)", text: $comment, axis: .vertical)
                        Button {
                            confirmApprove = true
                        } label: {
                            HStack {
                                Label("Approve", systemImage: "checkmark.seal")
                                if approving { Spacer(); ProgressView() }
                            }
                        }
                        .disabled(approving || pr.headSha == nil)
                        .confirmationDialog("Approve pull request #\(pr.number)?", isPresented: $confirmApprove, titleVisibility: .visible) {
                            Button("Approve") { Task { await approve(pr, worktree) } }
                        } message: {
                            Text("GitHub records the approval with your account on the Mac.")
                        }
                    }
                } else {
                    Section("Pull request") {
                        Text("No open pull request for this branch.").foregroundStyle(.secondary)
                    }
                }

                if let message {
                    Section { Text(message).font(.footnote) }
                }
            } else {
                ContentUnavailableView("No worktree", systemImage: "arrow.triangle.branch", description: Text("This worktree is not in ShipWarden any more."))
            }
        }
        .navigationTitle(worktree?.name ?? "Worktree")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.refresh() }
    }

    private func checksLabel(_ checks: String?) -> String {
        switch checks {
        case "SUCCESS": "Checks passed"
        case "FAILURE", "ERROR": "Checks failed"
        case "PENDING", "EXPECTED": "Checks running"
        default: "No checks"
        }
    }

    private func reviewLabel(_ decision: String) -> String {
        switch decision {
        case "APPROVED": "Approved"
        case "CHANGES_REQUESTED": "Changes requested"
        case "REVIEW_REQUIRED": "Review required"
        default: decision.capitalized
        }
    }

    private func approve(_ pr: RemotePullRequest, _ worktree: RemoteWorktree) async {
        approving = true
        message = nil
        defer { approving = false }
        do {
            try await model.approve(pr, in: worktree, body: comment)
            comment = ""
            message = "You approved #\(pr.number)."
        } catch {
            message = error.localizedDescription
        }
    }
}

/// The paired Mac: its name, its addresses and the connection. The user can forget the Mac here.
struct MacView: View {
    @Environment(AppModel.self) private var model
    @State private var confirmUnpair = false

    var body: some View {
        List {
            ConnectionBanner()
            if model.demo != nil {
                Section {
                    Button("Exit the demo") { model.stopDemo() }
                } header: {
                    Text("Demo")
                } footer: {
                    Text("The demo shows sample agents. To see your own agents, install ShipWarden on your Mac, open Settings › Mobile and pair this phone.")
                }
            } else if let pairing = model.pairing {
                Section("Mac") {
                    LabeledContent("Name", value: pairing.macName)
                    if let version = model.snapshot?.mac.version {
                        LabeledContent("ShipWarden", value: version)
                    }
                    LabeledContent("Connection", value: connectionLabel)
                    LabeledContent("Address", value: "\(pairing.lastHost ?? pairing.hosts.first ?? "–"):\(pairing.port)")
                }
                Section {
                    Button("Pair with another Mac") {
                        model.pendingLink = nil
                        confirmUnpair = true
                    }
                    Button("Forget this Mac", role: .destructive) { confirmUnpair = true }
                } footer: {
                    Text("To remove the access of this phone on the Mac too, open ShipWarden › Settings › Mobile and remove the phone.")
                }
            }
        }
        .navigationTitle("Mac")
        .confirmationDialog("Forget \(model.pairing?.macName ?? "this Mac")?", isPresented: $confirmUnpair, titleVisibility: .visible) {
            Button("Forget", role: .destructive) { model.unpair() }
        } message: {
            Text("The phone deletes its key. To connect again, scan a new pairing code.")
        }
    }

    private var connectionLabel: String {
        switch model.connection {
        case .connected: "Connected"
        case .connecting: "Connecting…"
        case .disconnected: "Not connected"
        case .failed: "Failed"
        }
    }
}
