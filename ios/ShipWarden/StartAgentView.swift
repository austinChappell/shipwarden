import SwiftUI

/// The start screen: a repository, a task or a prompt, an agent, and a model. The Mac makes a new worktree and starts
/// the agent in it.
struct StartAgentView: View {
    enum Work: String, CaseIterable {
        case task = "Task"
        case prompt = "Prompt"
    }

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    /// Called with the new agent after the start.
    let onStarted: (RemoteAgent) -> Void

    @State private var options: RemoteStartOptions?
    @State private var loadError: String?
    @State private var repoPath = ""
    @State private var work = Work.prompt
    @State private var task: RemoteTaskChoice?
    @State private var prompt = ""
    @State private var agentId = ""
    @State private var modelName = ""
    @State private var branch = ""
    @State private var starting = false
    @State private var startError: String?

    private var agent: RemoteAgentChoice? {
        options?.agents.first { $0.id == agentId }
    }

    private var trimmedPrompt: String {
        prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var canStart: Bool {
        guard !starting, !repoPath.isEmpty, agent != nil, agent?.budgetWait == nil else { return false }
        return work == .task ? task != nil : !trimmedPrompt.isEmpty
    }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Start an agent")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { dismiss() }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        if starting {
                            ProgressView()
                        } else {
                            Button("Start") { start() }
                                .disabled(!canStart)
                        }
                    }
                }
                .interactiveDismissDisabled(starting)
        }
        .task { await load() }
    }

    @ViewBuilder
    private var content: some View {
        if let options {
            form(options)
        } else if let loadError {
            ContentUnavailableView("Cannot start agents", systemImage: "lock", description: Text(loadError))
        } else {
            ProgressView("Loading")
        }
    }

    private func form(_ options: RemoteStartOptions) -> some View {
        Form {
            Section("Repository") {
                Picker("Repository", selection: $repoPath) {
                    ForEach(options.repos) { repo in
                        Text(options.repos.filter { $0.name == repo.name }.count > 1 ? "\(repo.name) · \(repo.projectName)" : repo.name)
                            .tag(repo.path)
                    }
                }
                .onChange(of: repoPath) { _, path in
                    // Each repository can have its own agent on the Mac.
                    if let repo = options.repos.first(where: { $0.path == path }) { selectAgent(repo.agentId) }
                }
            }

            Section {
                Picker("Work", selection: $work) {
                    ForEach(Work.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                if work == .task {
                    NavigationLink {
                        TaskPickerView(tasks: options.tasks, note: options.tasksNote, selection: $task)
                    } label: {
                        LabeledContent("Task") {
                            Text(task.map { [$0.key, $0.title].compactMap { $0 }.joined(separator: " ") } ?? "Select")
                                .lineLimit(1)
                        }
                    }
                } else {
                    TextField("What must the agent do?", text: $prompt, axis: .vertical)
                        .lineLimit(4...10)
                }
            } footer: {
                Text(work == .task ? "The agent gets the task, the same as “Start in worktree” on the Mac." : "The agent gets the prompt in a new worktree.")
            }

            Section {
                Picker("Agent", selection: $agentId) {
                    ForEach(options.agents) { agent in
                        Text(agent.name).tag(agent.id)
                    }
                }
                .onChange(of: agentId) { _, _ in modelName = "" }
                if let agent, agent.canSetModel {
                    TextField("Model", text: $modelName, prompt: Text(agent.model ?? "Own setting"))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                if let wait = agent?.budgetWait {
                    Label(wait, systemImage: "gauge.with.dots.needle.100percent")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                }
            } header: {
                Text("Agent")
            } footer: {
                if agent?.canSetModel == true {
                    Text("Leave the model empty to use the model of Settings › Agents on the Mac.")
                }
            }

            Section {
                TextField("Branch", text: $branch, prompt: Text(work == .task ? "From the branch template" : "From the prompt"))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            } header: {
                Text("Branch")
            } footer: {
                Text("Optional. The new worktree gets this branch.")
            }

            if let startError {
                Section {
                    Label(startError, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                }
            }
        }
    }

    private func selectAgent(_ id: String) {
        if options?.agents.contains(where: { $0.id == id }) == true {
            agentId = id
        } else if let first = options?.agents.first {
            agentId = first.id
        }
    }

    private func load() async {
        do {
            let loaded = try await model.startOptions()
            options = loaded
            if let repo = loaded.repos.first {
                repoPath = repo.path
                selectAgent(repo.agentId)
            }
            if loaded.tasks.isEmpty { work = .prompt }
        } catch {
            loadError = error.localizedDescription
        }
    }

    private func start() {
        let value = { (text: String) -> String? in
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }
        let request = RemoteStartRequest(
            repoPath: repoPath,
            task: work == .task ? task.map { RemoteStartTask(connectionId: $0.connectionId, id: $0.id) } : nil,
            prompt: work == .prompt ? value(prompt) : nil,
            branch: value(branch),
            agentId: agentId,
            model: agent?.canSetModel == true ? value(modelName) : nil
        )
        starting = true
        startError = nil
        Task {
            do {
                let agent = try await model.startAgent(request)
                dismiss()
                onStarted(agent)
            } catch {
                startError = error.localizedDescription
            }
            starting = false
        }
    }
}

/// A searchable list of the tasks. The list can be long, so it has a search field.
struct TaskPickerView: View {
    let tasks: [RemoteTaskChoice]
    let note: String?
    @Binding var selection: RemoteTaskChoice?
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    private var shown: [RemoteTaskChoice] {
        let words = query.trimmingCharacters(in: .whitespaces)
        guard !words.isEmpty else { return tasks }
        return tasks.filter { "\($0.key ?? "") \($0.title)".localizedCaseInsensitiveContains(words) }
    }

    var body: some View {
        List(shown) { task in
            Button {
                selection = task
                dismiss()
            } label: {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(task.title).foregroundStyle(.primary).lineLimit(2)
                        Text([task.key, task.status].compactMap { $0 }.joined(separator: " · "))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    if selection?.id == task.id {
                        Image(systemName: "checkmark").foregroundStyle(.tint)
                    }
                }
            }
        }
        .overlay {
            if tasks.isEmpty {
                ContentUnavailableView("No tasks", systemImage: "checklist", description: Text(note ?? "The Mac sent no tasks."))
            } else if shown.isEmpty {
                ContentUnavailableView.search(text: query)
            }
        }
        .searchable(text: $query, prompt: "Search the tasks")
        .navigationTitle("Task")
    }
}
