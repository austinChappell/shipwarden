import SwiftUI

/// Follows the screen of one agent while the view shows.
@MainActor
@Observable
final class ScreenModel {
    private(set) var snapshot: ScreenSnapshot?
    private(set) var text = AttributedString()
    private(set) var ended = false
    private(set) var error: String?
    private var task: Task<Void, Never>?
    private var fontSize: CGFloat = 11

    func start(client: APIClient?, agentId: String) {
        stop()
        guard let client else { return }
        task = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    for try await event in client.events("/v1/sessions/\(agentId)/screen") {
                        guard let self else { return }
                        if event.name == "screen", let next = try? JSONDecoder().decode(ScreenSnapshot.self, from: event.data) {
                            self.error = nil
                            self.update(next)
                        } else if event.name == "exit" {
                            self.ended = true
                        }
                    }
                } catch {
                    if Task.isCancelled { return }
                    self?.error = error.localizedDescription
                }
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
    }

    func setFontSize(_ size: CGFloat) {
        guard size != fontSize else { return }
        fontSize = size
        if let snapshot { text = TerminalStyle.attributed(snapshot, fontSize: size) }
    }

    private func update(_ next: ScreenSnapshot) {
        snapshot = next
        text = TerminalStyle.attributed(next, fontSize: fontSize)
    }
}

struct AgentDetailView: View {
    @Environment(AppModel.self) private var model
    let agentId: String

    @State private var screen = ScreenModel()
    @State private var reply = ""
    @State private var sending = false
    @State private var error: String?
    /// 0 means that the text fits the width of the screen.
    @AppStorage("terminalFontSize") private var fixedFontSize: Double = 0
    @FocusState private var replyFocused: Bool

    private var agent: RemoteAgent? { model.agents.first { $0.id == agentId } }

    var body: some View {
        VStack(spacing: 0) {
            if let agent { header(agent) }
            terminal
            if let error {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(.orange)
                    .padding(.horizontal)
                    .padding(.top, 6)
            }
            if let agent, !agent.exited { controls(agent) }
        }
        .navigationTitle(agent.map { model.name(of: $0) } ?? "Agent")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Fit to width") { fixedFontSize = 0 }
                    Button("Larger text") { fixedFontSize = min(max(fixedFontSize, 8) + 1, 20) }
                    Button("Smaller text") { fixedFontSize = max((fixedFontSize == 0 ? 11 : fixedFontSize) - 1, 5) }
                } label: {
                    Label("Text size", systemImage: "textformat.size")
                }
            }
        }
        .onAppear { screen.start(client: model.client, agentId: agentId) }
        .onDisappear { screen.stop() }
        .onChange(of: model.connection) { _, state in
            // A new connection has a new client.
            if state == .connected { screen.start(client: model.client, agentId: agentId) }
        }
    }

    private func header(_ agent: RemoteAgent) -> some View {
        let place = model.place(of: agent)
        return VStack(alignment: .leading, spacing: 4) {
            HStack {
                AgentStateBadge(state: agent.state, exited: agent.exited)
                Spacer()
                if let date = agent.stateDate {
                    Text(date, style: .relative).font(.caption).foregroundStyle(.secondary).monospacedDigit()
                }
            }
            if let message = agent.message, !message.isEmpty {
                Text(message).font(.subheadline).lineLimit(4)
            }
            if let repo = place.repo {
                Text([repo.name, place.worktree?.branch].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.bar)
    }

    private var terminal: some View {
        GeometryReader { geometry in
            let cols = CGFloat(screen.snapshot?.cols ?? 80)
            let fitSize = max(4, ((geometry.size.width - 14) / (cols * TerminalStyle.characterWidthRatio) * 2).rounded(.down) / 2)
            let size = fixedFontSize == 0 ? fitSize : CGFloat(fixedFontSize)
            ScrollView(fixedFontSize == 0 ? .vertical : [.vertical, .horizontal]) {
                Text(screen.text)
                    .fixedSize(horizontal: true, vertical: true)
                    .textSelection(.enabled)
                    .padding(6)
                    .frame(minWidth: geometry.size.width, alignment: .leading)
            }
            .defaultScrollAnchor(.bottomLeading)
            .background(TerminalStyle.background)
            .overlay {
                if screen.snapshot == nil {
                    ProgressView().tint(.white)
                }
            }
            .overlay(alignment: .top) {
                if screen.ended {
                    Text("The agent has ended.")
                        .font(.footnote)
                        .padding(6)
                        .background(.thinMaterial, in: Capsule())
                        .padding(8)
                }
            }
            .onAppear { screen.setFontSize(size) }
            .onChange(of: size) { _, next in screen.setFontSize(next) }
        }
    }

    private func controls(_ agent: RemoteAgent) -> some View {
        VStack(spacing: 8) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    if agent.state == .waiting {
                        // Claude Code numbers the answers of a question. A number selects the answer.
                        ForEach(["1", "2", "3"], id: \.self) { number in
                            KeyButton(title: number, prominent: true) { send(RemoteInput(text: number), to: agent) }
                        }
                    }
                    KeyButton(title: "Enter", symbol: "return") { send(RemoteInput(key: .enter), to: agent) }
                    KeyButton(title: "Esc") { send(RemoteInput(key: .escape), to: agent) }
                    KeyButton(title: "Up", symbol: "arrow.up") { send(RemoteInput(key: .up), to: agent) }
                    KeyButton(title: "Down", symbol: "arrow.down") { send(RemoteInput(key: .down), to: agent) }
                    KeyButton(title: "Tab") { send(RemoteInput(key: .tab), to: agent) }
                    KeyButton(title: "⇧Tab") { send(RemoteInput(key: .shiftTab), to: agent) }
                    KeyButton(title: "⌃C") { send(RemoteInput(key: .ctrlC), to: agent) }
                }
                .padding(.horizontal)
            }
            HStack(alignment: .bottom, spacing: 8) {
                TextField("Reply to the agent", text: $reply, axis: .vertical)
                    .lineLimit(1...5)
                    .textFieldStyle(.roundedBorder)
                    .focused($replyFocused)
                    .submitLabel(.send)
                Button {
                    let text = reply
                    send(RemoteInput(text: text, submit: true), to: agent) { reply = "" }
                } label: {
                    Image(systemName: "arrow.up.circle.fill").font(.title)
                }
                .disabled(reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || sending)
                .accessibilityLabel("Send")
            }
            .padding(.horizontal)
        }
        .padding(.vertical, 8)
        .background(.bar)
    }

    private func send(_ input: RemoteInput, to agent: RemoteAgent, then done: @escaping () -> Void = {}) {
        sending = true
        error = nil
        Task {
            defer { sending = false }
            do {
                try await model.send(input, to: agent)
                done()
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

struct KeyButton: View {
    let title: String
    var symbol: String?
    var prominent = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Group {
                if let symbol {
                    Image(systemName: symbol).accessibilityLabel(title)
                } else {
                    Text(title)
                }
            }
            .font(.callout.weight(.medium).monospaced())
            .frame(minWidth: 36, minHeight: 32)
        }
        .buttonStyle(.bordered)
        .tint(prominent ? .accentColor : .secondary)
    }
}
