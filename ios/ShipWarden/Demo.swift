import Foundation
import Observation

/// Sample agents for people without a Mac nearby, for example App Review. The demo uses no network.
/// The agents answer the buttons and the replies, so each screen of the app works.
@MainActor
@Observable
final class DemoState {
    private(set) var snapshot: RemoteSnapshot
    private(set) var agents: [RemoteAgent]
    private(set) var screens: [String: [[ScreenRun]]]
    /// Called when an agent changes after a delay, for example when a simulated test run ends.
    var onChange: () -> Void = {}

    private static let cols = 72

    init() {
        let now = Date().timeIntervalSince1970 * 1000
        agents = [
            RemoteAgent(id: "demo-login", title: "Claude", worktreePath: "/demo/web-app-login", cwd: "/demo/web-app-login",
                        state: .waiting, message: "Claude needs your permission to use Bash", prompt: "Fix the login redirect loop",
                        stateAt: now - 95_000, exited: false),
            RemoteAgent(id: "demo-search", title: "Claude", worktreePath: "/demo/web-app-search", cwd: "/demo/web-app-search",
                        state: .working, message: "Running npm test", prompt: "Add fuzzy search to the command bar",
                        stateAt: now - 40_000, exited: false),
            RemoteAgent(id: "demo-api", title: "Claude", worktreePath: "/demo/api", cwd: "/demo/api",
                        state: .done, message: "I updated the rate limiter and added two tests.", prompt: "Tighten the rate limiter",
                        stateAt: now - 640_000, exited: false)
        ]
        snapshot = RemoteSnapshot(
            protocol: remoteProtocol,
            mac: MacInfo(name: "Demo Mac", version: "demo"),
            projects: [RemoteProject(id: "demo", name: "Demo", repos: [
                RemoteRepo(path: "/demo/web-app", name: "web-app", color: "#4a8fe7", worktrees: [
                    RemoteWorktree(path: "/demo/web-app", branch: "main", name: "main", isMain: true, task: nil, pullRequest: nil),
                    RemoteWorktree(path: "/demo/web-app-login", branch: "fix-login-loop", name: "fix-login-loop", isMain: false,
                                   task: RemoteTask(title: "Login page loops after sign-in", key: "WEB-112", url: nil),
                                   pullRequest: RemotePullRequest(number: 482, title: "Fix the login redirect loop", url: "https://github.com",
                                                                  isDraft: false, reviewDecision: "REVIEW_REQUIRED", checks: "PENDING", headSha: "demo")),
                    RemoteWorktree(path: "/demo/web-app-search", branch: "fuzzy-search", name: "fuzzy-search", isMain: false, task: nil,
                                   pullRequest: RemotePullRequest(number: 479, title: "Add fuzzy search to the command bar", url: "https://github.com",
                                                                  isDraft: true, reviewDecision: nil, checks: "FAILURE", headSha: "demo"))
                ]),
                RemoteRepo(path: "/demo/api", name: "api", color: "#4fae5a", worktrees: [
                    RemoteWorktree(path: "/demo/api", branch: "rate-limits", name: "rate-limits", isMain: true, task: nil,
                                   pullRequest: RemotePullRequest(number: 77, title: "Tighten the rate limiter", url: "https://github.com",
                                                                  isDraft: false, reviewDecision: "REVIEW_REQUIRED", checks: "SUCCESS", headSha: "demo"))
                ])
            ])],
            agents: []
        )
        screens = [
            "demo-login": Self.loginScreen + Self.permissionBox,
            "demo-search": [
                [Self.bullet, ScreenRun("I added a fuzzy matcher and wired it to the command bar.")],
                [],
                [Self.bullet, ScreenRun("Bash", bold: true), ScreenRun("(npm test)")],
                [ScreenRun("  ⎿  Running…", dim: true)]
            ],
            "demo-api": [
                [Self.bullet, ScreenRun("Update", bold: true), ScreenRun("(src/limits.ts)")],
                [ScreenRun("  ⎿  Updated "), ScreenRun("src/limits.ts", bold: true), ScreenRun(" with 4 additions")],
                [],
                [Self.bullet, ScreenRun("I updated the rate limiter and added two tests.")],
                [],
                Self.promptLine
            ]
        ]
    }

    func screen(for id: String) -> ScreenSnapshot? {
        guard let lines = screens[id] else { return nil }
        return ScreenSnapshot(cols: Self.cols, rows: lines.count, lines: lines, cursor: ScreenCursor(x: 0, y: max(lines.count - 1, 0), visible: false))
    }

    // MARK: Input

    func handle(_ input: RemoteInput, agentId: String) {
        guard let agent = agents.first(where: { $0.id == agentId }) else { return }
        let text = input.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if agent.state == .waiting {
            if text == "1" || text == "2" || input.key == .enter {
                answerPermission(agentId)
            } else if text == "3" || input.key == .escape {
                replaceBox(agentId, with: [[ScreenRun("  ⎿  Interrupted. What should Claude do instead?", fg: .palette(3))], [], Self.promptLine])
                update(agentId, state: .idle, message: "Interrupted. Tell Claude what to do instead.")
            }
            return
        }
        if input.submit == true, !text.isEmpty {
            reply(text, agentId: agentId)
        } else if input.key == .ctrlC || input.key == .escape, agent.state == .working {
            append(agentId, [[ScreenRun("  ⎿  Interrupted by user", fg: .palette(1))], [], Self.promptLine])
            update(agentId, state: .idle, message: "Interrupted.")
        }
    }

    func approve(worktreePath: String) {
        snapshot = RemoteSnapshot(
            protocol: snapshot.protocol,
            mac: snapshot.mac,
            projects: snapshot.projects.map { project in
                RemoteProject(id: project.id, name: project.name, repos: project.repos.map { repo in
                    RemoteRepo(path: repo.path, name: repo.name, color: repo.color, worktrees: repo.worktrees.map { worktree in
                        guard worktree.path == worktreePath, let pr = worktree.pullRequest else { return worktree }
                        return RemoteWorktree(path: worktree.path, branch: worktree.branch, name: worktree.name, isMain: worktree.isMain, task: worktree.task,
                                              pullRequest: RemotePullRequest(number: pr.number, title: pr.title, url: pr.url, isDraft: pr.isDraft,
                                                                             reviewDecision: "APPROVED", checks: pr.checks, headSha: pr.headSha))
                    })
                })
            },
            agents: []
        )
    }

    private func answerPermission(_ id: String) {
        replaceBox(id, with: [[ScreenRun("  ⎿  Running…", dim: true)]])
        update(id, state: .working, message: "Running npm test -- auth")
        later(2.5) { state in
            state.replaceLast(id, with: [
                [ScreenRun("  ⎿  "), ScreenRun("14 passed", fg: .palette(2)), ScreenRun(", 0 failed")],
                [],
                [Self.bullet, ScreenRun("The login redirect works now. All 14 auth tests pass.")],
                [],
                Self.promptLine
            ])
            state.update(id, state: .done, message: "The login redirect works now. All 14 auth tests pass.")
        }
    }

    private func reply(_ text: String, agentId id: String) {
        var lines = screens[id] ?? []
        if lines.last == Self.promptLine { lines.removeLast() }
        lines += [[ScreenRun("> \(text)", dim: true)], [], [Self.bullet, ScreenRun("Thinking…", dim: true)]]
        screens[id] = lines
        update(id, state: .working, message: "Thinking…", prompt: text)
        later(3) { state in
            state.replaceLast(id, with: [[Self.bullet, ScreenRun("Done. This is the demo, so nothing changed on a real Mac.")], [], Self.promptLine])
            state.update(id, state: .done, message: "Done. This is the demo, so nothing changed on a real Mac.")
        }
    }

    // MARK: Helpers

    private func later(_ seconds: Double, _ action: @escaping (DemoState) -> Void) {
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            guard let self else { return }
            action(self)
            self.onChange()
        }
    }

    private func update(_ id: String, state: AgentState, message: String, prompt: String? = nil) {
        agents = agents.map { agent in
            guard agent.id == id else { return agent }
            return RemoteAgent(id: agent.id, title: agent.title, worktreePath: agent.worktreePath, cwd: agent.cwd, state: state, message: message,
                               prompt: prompt ?? agent.prompt, stateAt: Date().timeIntervalSince1970 * 1000, exited: false)
        }
    }

    private func append(_ id: String, _ lines: [[ScreenRun]]) {
        var current = screens[id] ?? []
        if current.last == Self.promptLine { current.removeLast() }
        screens[id] = current + lines
    }

    /// Replaces the permission box at the end of the screen.
    private func replaceBox(_ id: String, with lines: [[ScreenRun]]) {
        guard var current = screens[id] else { return }
        current.removeLast(min(Self.permissionBox.count, current.count))
        screens[id] = current + lines
    }

    /// Replaces the last line, for example "Running…" with the result.
    private func replaceLast(_ id: String, with lines: [[ScreenRun]]) {
        guard var current = screens[id], !current.isEmpty else { return }
        current.removeLast()
        screens[id] = current + lines
    }

    // MARK: Screen text

    private static let bullet = ScreenRun("⏺ ", fg: .palette(174))
    private static let promptLine = [ScreenRun("> ", fg: .palette(8)), ScreenRun("Reply on the phone or on the Mac", dim: true)]

    private static let loginScreen: [[ScreenRun]] = [
        [bullet, ScreenRun("I found the cause. The middleware redirects before the session loads.")],
        [],
        [bullet, ScreenRun("Update", bold: true), ScreenRun("(src/middleware/auth.ts)")],
        [ScreenRun("  ⎿  Updated "), ScreenRun("src/middleware/auth.ts", bold: true), ScreenRun(" with 3 additions and 1 removal")],
        [ScreenRun("       12 +   if (!session.loaded) return next();", bg: .rgb(0x223c22))],
        [ScreenRun("       13 -   redirect(\"/login\");", bg: .rgb(0x461e1e))],
        [],
        [bullet, ScreenRun("Bash", bold: true), ScreenRun("(npm test -- auth)")]
    ]

    private static let permissionBox: [[ScreenRun]] = {
        let border = TerminalColor.palette(110)
        let width = cols - 2
        func row(_ runs: [ScreenRun]) -> [ScreenRun] {
            let length = runs.reduce(0) { $0 + $1.t.count }
            return [ScreenRun("│", fg: border)] + runs + [ScreenRun(String(repeating: " ", count: max(0, width - length))), ScreenRun("│", fg: border)]
        }
        return [
            [],
            [ScreenRun("╭" + String(repeating: "─", count: width) + "╮", fg: border)],
            row([ScreenRun(" Bash command", bold: true)]),
            row([ScreenRun("   npm test -- auth")]),
            row([ScreenRun(" Do you want to proceed?")]),
            row([ScreenRun(" ❯ 1. Yes", fg: border)]),
            row([ScreenRun("   2. Yes, and don't ask again for npm test commands")]),
            row([ScreenRun("   3. No, and tell Claude what to do differently "), ScreenRun("(esc)", dim: true)]),
            [ScreenRun("╰" + String(repeating: "─", count: width) + "╯", fg: border)]
        ]
    }()
}

extension ScreenRun {
    init(_ text: String, fg: TerminalColor? = nil, bg: TerminalColor? = nil, bold: Bool = false, dim: Bool = false) {
        self.init(t: text, fg: fg, bg: bg, b: bold ? 1 : nil, d: dim ? 1 : nil, i: nil, u: nil, v: nil)
    }
}
