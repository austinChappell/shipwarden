# Plan: onboarding and tutorial

Status: phases 1 to 3 done. Branch: `onboarding`, then one branch for each phase (`onboarding-2`, …).

This document is the brief for the onboarding work. Give it to Claude at the start of each session:

> Read `docs/onboarding-plan.md`, `CLAUDE.md`, `README.md` and `docs/ARCHITECTURE.md`. We work on phase N. Make a plan
> for that phase first. Do not write code until I approve the plan.

## 1. The problem

A new user opens ShipWarden and sees one line: "Default has no repositories", and an "Add a repository" button.
The app does not tell the user:

- what a project, a repository and a worktree are in ShipWarden
- which tools must be on the Mac (git, an agent CLI such as `claude`, a GitHub login)
- how to start an agent, and where to see all agents (Agents view, ⌥⌘2)
- what the views do (Dashboard, Agents, Tasks, Review, Pipelines, Notes: ⌥⌘1 to ⌥⌘6)
- what the right panel does (⌘E: files, changes, pull request, checks, processes)
- that agents continue to run after ⌘Q, and that ⇧⌥⌘Q stops them

Many features stay hidden until the user finds them by accident. Errors such as a missing GitHub token show late,
inside a panel, after the user already tried a task.

## 2. Goals

1. A new user gets from the first start to a running agent in a new worktree in a few minutes.
2. The app finds missing setup (git, agent CLI, GitHub access) before the user needs it, and tells the user how to fix it.
3. The user learns the main parts of the UI with a short tour that they can skip and open again.
4. Each view that is empty tells the user why, and gives one action to fix it.
5. Current users see no setup flow. They get one small offer to take the tour.

## 3. Not in scope

- Video, animated GIFs or a help website.
- Telemetry or analytics of onboarding steps. The app sends no usage data, and this work does not change that
  (see `docs/PRIVACY.md`).
- Onboarding for the iPhone app. The Mobile settings page already has the pairing steps.
- A new UI library. The app uses plain CSS with color tokens and no UI framework. Keep it that way.

## 4. The parts

There are four parts. Each part is useful alone, so we can ship them in order.

### 4.1 Setup checks (the base for the other parts)

One main-process service checks the setup and returns a list of results. Each result has an ID, a state
(`ok`, `missing`, `warning`, `unknown`), a short message and an optional fix action.

| Check | How | Fix action |
|---|---|---|
| git is in the login shell PATH | Use the same check as Settings › Agents (`api.settings.checkCommand`) | Show the install command (`xcode-select --install`) |
| The default agent command is in the PATH | `checkCommand` with the default agent command | Open Settings › Agents. Show the install link of Claude Code |
| GitHub access | The token order of `src/main/github/github-client.ts`: saved token, then `GITHUB_TOKEN`, then `gh auth token` | Show `gh auth login`, or open Settings › Code review to save a token |
| The project has a repository | `ProjectStore` | "Add a repository" or "Clone a repository" (`PullRepoDialog`, `repo-clone.ts`) |
| macOS notifications are on | Settings › Notifications state | Open Settings › Notifications |

Rules:

- Reuse the existing checks. Do not write a second PATH check or a second token lookup.
- The checks run only on request (the welcome page and the checklist), not on a timer.
- Put the results in TanStack Query. After a fix (for example a saved token), update the cache entry of that check.
  Do not reload all checks. See the "cache, not refetch" rule in section 7.
- The GitHub check must not call the GitHub API if a local token check is enough. When it must call the API, it uses
  the CA certificates of Settings › Network.

### 4.2 Welcome page (first start only)

A full page, like the settings page. It shows when the user has no repositories and the onboarding state is "not
started". It is not a modal, because the user must be able to leave it, open Settings and come back.

Steps on one page, as a vertical list. Each step shows its check result from 4.1:

1. **Welcome.** Two sentences: what ShipWarden does, and the words "project", "repository" and "worktree".
2. **Check your tools.** The results of 4.1, with a fix button for each problem and a "Check again" button.
3. **Add a repository.** Add a local folder, or clone one.
4. **Choose your agent.** The default agent of Settings › Agents. Claude Code is the default.
5. **Optional.** Theme (Settings › Appearance) and task tracker (Settings › Task managers). Links only.
6. **Start.** "Create a worktree and start an agent" opens the New worktree dialog (⌘N). Then the tour offers to start.

The user can click "Skip setup" at all times. The page then does not show again. Help › Show Welcome opens it again.

Use the existing settings parts (`SettingsGroup`, `SettingsRow` in `settings-ui.tsx`) where they fit, so the page looks
like the rest of the app.

### 4.3 Guided tour

A short tour with callouts that point at real parts of the UI. 6 to 8 steps. Suggested steps:

1. Sidebar: projects, repositories and worktrees. ⌘N creates a worktree.
2. The Agent button: starts the default agent in the worktree.
3. The tab strip: agent and shell tabs, splits (as in Ghostty).
4. The right panel (⌘E): Files, Changes, pull request, checks, processes.
5. The Agents view (⌥⌘2): all agents and their state. "Needs input" means the agent waits for you.
6. Tasks (⌥⌘3) and "Start in worktree".
7. Review (⌥⌘4) and Dashboard (⌥⌘1).
8. Quit: ⌘Q keeps agents running. ⇧⌥⌘Q stops them.

Rules:

- Build it in the app. Do not add a tour library. One `Tour` component, one pure step model in `src/shared/` or
  `src/renderer/src/app/`, with unit tests.
- Mark the targets with a `data-tour="<step-id>"` attribute. Do not use CSS class names as targets.
- When a target is not on the screen (the sidebar is closed with ⌘B, the right panel is closed, the window is narrow),
  the step opens the panel first, or shows the callout in the center of the window. It never points at nothing.
- Keys: → and Enter go to the next step, ← goes back, Escape closes the tour. Focus moves into the callout, and goes
  back to the previous element at the end.
- The callout uses the theme tokens (`--bg`, `--text-strong` and others), so it works with all six themes, light and dark.
- Help › Take the Tour starts it at all times.

### 4.4 Empty states, checklist and Help menu

**Empty states.** Each view that can be empty gets a title, one sentence and one action. Examples:

| View | Empty when | Action |
|---|---|---|
| Worktree area | The project has no repositories | Add a repository / Clone a repository |
| Worktree area | A worktree has no tabs | Start the agent (exists now) and a hint for ⌘T |
| Agents | No agent runs | "Start an agent in a worktree" |
| Tasks | No task manager is set | Open Settings › Task managers |
| Review, Dashboard | No GitHub access | The fix of the GitHub check (4.1) |
| Pipelines | No checks or workflows | One sentence on GitHub Actions |

**Getting started checklist.** An optional small card (for example at the top of the Dashboard) with real progress:
add a repository, create a worktree, start an agent, open the Agents view, open a pull request. The app marks a step done
when the user does the action. The user can close the card for all time.

**Help menu.** The app has no Help menu now (`src/main/app/menu.ts`). Add one with:

- Show Welcome
- Take the Tour
- Keyboard Shortcuts: a page or dialog made from `src/shared/shortcuts.ts`, so the list cannot get out of date
- ShipWarden on GitHub (the README)

## 5. Onboarding state

Keep the state in `settings.json` (`AppSettings` in `src/shared/settings.ts`), not in local storage. It must be the same
in all windows and survive a cache clear.

```ts
interface OnboardingSettings {
    /** 'new' shows the welcome page. 'done' and 'skipped' do not. */
    welcome: 'new' | 'done' | 'skipped';
    /** The tour version that the user finished or closed. A new tour version can offer itself again. */
    tourSeen?: number;
    /** The checklist steps that are done, by step ID. */
    checklist?: Record<string, boolean>;
    checklistClosed?: boolean;
}
```

- `normalizeSettings` must give a default for a missing or wrong value. Add tests in `settings.test.ts`.
- **Current users:** when `onboarding` is missing and the user already has a repository, set `welcome: 'done'`. Show a
  one-time, small notice: "Take a short tour of ShipWarden?" with "Take the tour" and "No thanks".
- **New users:** when `onboarding` is missing and there is no repository, set `welcome: 'new'`.

## 6. Phases and pull requests

Make one pull request for each phase. Each phase must pass `npm run check`, `npm run typecheck` and `npm test`.

| Phase | Content | Done when |
|---|---|---|
| 1 | Onboarding state in settings (section 5). Setup checks service and IPC (4.1). Help menu with the three items, which can do nothing at first. | Unit tests for the normalize rules and for each check's result mapping. |
| 2 | Welcome page (4.2). | A new data folder shows the page. Each step works. "Skip setup" keeps it closed after a restart. |
| 3 | Guided tour (4.3). | The tour works with the sidebar and the right panel closed, in light and dark themes, with the keyboard only. |
| 4 | Empty states (4.4). | Each view in the table shows its empty state and action. |
| 5 | Keyboard shortcuts page and checklist card (4.4). | The shortcuts page lists all actions of `shortcuts.ts`. The checklist marks steps from real actions. |

### How to test a first start

The app keeps its data in `~/Library/Application Support/ShipWarden`. Do not delete your real data to test.
Phase 1 must add a development override, for example `SHIPWARDEN_USER_DATA_DIR=/tmp/sw-fresh`, that calls
`app.setPath('userData', …)` before the app reads any data. Document it in the README table of environment variables.

Notes for a fresh data folder:

- The legacy migration (`legacy-migration.ts`) copies Yardmaster data at the first start. Make sure the override does not
  copy your old data into the test folder.
- The PTY host socket is in the data folder, so a fresh folder starts a second PTY host. Quit it with ⇧⌥⌘Q after the test.
- Use `SHIPWARDEN_DEBUG_PORT=9333` for automated UI checks of the welcome page and the tour.

## 7. Rules for this work

These are the project rules that apply most here. Claude must follow them.

- **Writing.** All UI text, code comments and docs use Simplified Technical English: short sentences, active voice,
  simple tenses. Write natural time amounts: "a few seconds", "a few minutes". Never "some seconds".
- **Network data.** All network data goes through TanStack Query (`src/renderer/src/query-client.ts`). After a write,
  update the cache. Do not refetch. Keep API calls to a minimum.
- **Network certificates.** New network code must use the CA certificates of Settings › Network. The work network
  inspects TLS traffic.
- **No new UI dependencies.** Use React, plain CSS, the theme tokens and Lucide icons.
- **Shared logic.** Put pure logic (step order, check result mapping, state rules) in plain functions with Vitest tests.
  Keep React components thin.
- **Accessibility.** All new UI works with the keyboard only, and has labels for screen readers.
- **Docs.** Update `README.md` and `docs/ARCHITECTURE.md` in the same pull request as the feature.

## 8. Open questions

We decided these in phase 1.

1. Does the welcome page also show for a user who has repositories but no agent CLI in the PATH?
   **No.** A banner in the worktree area shows the problem instead.
2. Where does the checklist card go: Dashboard, sidebar footer or the empty worktree area?
   **The Dashboard.** It already shows a summary of the work and has space for a card.
3. Does the tour step for Tasks show when no task manager is set?
   **Yes**, with the link to Settings › Task managers.
4. Do we include Codex, Gemini CLI and opencode in step 4 of the welcome page, or only Claude Code?
   **All four built-in agents.** They are already the default agents. Claude Code stays the selected agent.
5. Do we need a sample repository for users who want to try the app without their own code?
   **Not now.** "Clone a repository" covers this case.

## 9. Notes from phase 1

- A setup check result has a list of fixes (`fixes`), not one fix. Some checks have two fixes, for example
  "Install Claude Code" and "Open Settings › Agents".
- The agent check and the GitHub check give `warning`, not `missing`. A shell alias can start an agent, and the PATH
  check cannot find an alias. Agents and local repositories work without GitHub.
- The notifications check reads only the ShipWarden setting. Electron cannot read the macOS permission.
- Phase 2 adds the TanStack Query hook for the check results (`api.setup.check`), together with the welcome page.
- Phase 2: the welcome page opens when `welcome` is 'new', also when the user added a repository on the page and
  restarted the app before the last step. The page then shows the progress, and the user can finish or skip.
- Phase 3 adds the one-time "Take a short tour of ShipWarden?" notice for current users, together with the tour.
