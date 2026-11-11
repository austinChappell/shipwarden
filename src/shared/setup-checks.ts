import type { NotificationSettings } from './notifications';
import type { ReviewTokenSource } from './review-providers';
import { agentTitle, type AgentDefinition, type CommandCheck } from './settings';

/** The setup checks of the welcome page and the checklist, in the order that the page shows them. */
export const SETUP_CHECK_IDS = ['git', 'agent', 'github', 'repository', 'notifications'] as const;

export type SetupCheckId = (typeof SETUP_CHECK_IDS)[number];

/**
 * The result of a check:
 * - ok: the setup is correct.
 * - missing: a part that ShipWarden needs is not there.
 * - warning: ShipWarden works, but a feature does not work or the check cannot be sure.
 * - unknown: the check failed.
 */
export type SetupCheckState = 'ok' | 'missing' | 'warning' | 'unknown';

/** An action that fixes a problem. The page shows each fix as a button. */
export type SetupFix =
    /** A command that the user runs in a terminal. The page shows it with a copy button. */
    | { kind: 'command'; label: string; command: string }
    /** Opens a section of the settings page, for example "agents". */
    | { kind: 'settings'; label: string; section: string }
    /** Opens a web page in the browser. */
    | { kind: 'link'; label: string; url: string }
    /** Adds a local repository to the active project, or clones a repository into it. */
    | { kind: 'repository'; label: string; action: 'add' | 'clone' };

export interface SetupCheckResult {
    id: SetupCheckId;
    state: SetupCheckState;
    /** One or two short sentences for the user. */
    message: string;
    /** The actions that fix the problem. It is empty when the state is "ok". */
    fixes: SetupFix[];
}

/** Returns true when a value is the ID of a setup check. */
export function isSetupCheckId(value: unknown): value is SetupCheckId {
    return typeof value === 'string' && (SETUP_CHECK_IDS as readonly string[]).includes(value);
}

/** The install pages of the default agents, by program name. */
export const AGENT_INSTALL_URLS: Readonly<Record<string, string>> = {
    claude: 'https://docs.anthropic.com/en/docs/claude-code/setup',
    codex: 'https://github.com/openai/codex',
    gemini: 'https://github.com/google-gemini/gemini-cli',
    opencode: 'https://opencode.ai'
};

/** Maps the PATH check of `git` to a result. */
export function gitCheckResult(check: CommandCheck): SetupCheckResult {
    if (check.path) {
        return { id: 'git', state: 'ok', message: `git is at ${check.path}.`, fixes: [] };
    }
    return {
        id: 'git',
        state: 'missing',
        message: 'ShipWarden cannot find git in the PATH of your login shell. Install the Xcode Command Line Tools to get git.',
        fixes: [{ kind: 'command', label: 'Install git', command: 'xcode-select --install' }]
    };
}

/**
 * Maps the PATH check of the default agent to a result. A program that is not in the PATH gives a warning, not
 * "missing", because a shell alias can start the agent and the PATH check cannot find an alias.
 */
export function agentCheckResult(agent: AgentDefinition, check: CommandCheck): SetupCheckResult {
    const settings: SetupFix = { kind: 'settings', label: 'Open Settings › Agents', section: 'agents' };
    if (!check.program) {
        return { id: 'agent', state: 'missing', message: `The agent "${agent.name}" has no command.`, fixes: [settings] };
    }
    if (check.path) {
        return { id: 'agent', state: 'ok', message: `${agent.name} is at ${check.path}.`, fixes: [] };
    }
    const installUrl = AGENT_INSTALL_URLS[agentTitle(check.program)];
    return {
        id: 'agent',
        state: 'warning',
        message: `ShipWarden cannot find "${check.program}" in the PATH of your login shell. Install ${agent.name}, or select a different default agent.`,
        fixes: [...(installUrl ? [{ kind: 'link' as const, label: `Install ${agent.name}`, url: installUrl }] : []), settings]
    };
}

/** The places of a GitHub token, as the user sees them. */
const TOKEN_SOURCE_TEXT: Record<ReviewTokenSource, string> = {
    saved: 'the token in Settings › Code review',
    env: 'the GITHUB_TOKEN variable',
    cli: 'the GitHub CLI login'
};

/**
 * Maps the place of the GitHub token to a result. No token gives a warning, not "missing", because agents and local
 * repositories work without GitHub. Only the pull requests, the checks and the Review view need it.
 */
export function githubCheckResult(source: ReviewTokenSource | undefined): SetupCheckResult {
    if (source) {
        return { id: 'github', state: 'ok', message: `ShipWarden uses ${TOKEN_SOURCE_TEXT[source]} for GitHub.`, fixes: [] };
    }
    return {
        id: 'github',
        state: 'warning',
        message: 'ShipWarden has no GitHub token. Pull requests, checks and the Review view need one.',
        fixes: [
            { kind: 'command', label: 'Log in with the GitHub CLI', command: 'gh auth login' },
            { kind: 'settings', label: 'Save a token in Settings › Code review', section: 'review' }
        ]
    };
}

/** Maps the number of repositories in the active project to a result. */
export function repositoryCheckResult(repoCount: number): SetupCheckResult {
    if (repoCount > 0) {
        return {
            id: 'repository',
            state: 'ok',
            message: repoCount === 1 ? 'The project has 1 repository.' : `The project has ${repoCount} repositories.`,
            fixes: []
        };
    }
    return {
        id: 'repository',
        state: 'missing',
        message: 'The project has no repositories. Add a repository to create worktrees and start agents.',
        fixes: [
            { kind: 'repository', label: 'Add a repository', action: 'add' },
            { kind: 'repository', label: 'Clone a repository', action: 'clone' }
        ]
    };
}

/**
 * Maps the notification settings to a result. Electron cannot read the macOS permission, so the check reads only the
 * setting of ShipWarden.
 */
export function notificationsCheckResult(settings: NotificationSettings): SetupCheckResult {
    if (settings.enabled) {
        return { id: 'notifications', state: 'ok', message: 'Notifications are on.', fixes: [] };
    }
    return {
        id: 'notifications',
        state: 'warning',
        message: 'Notifications are off. ShipWarden cannot tell you when an agent needs input.',
        fixes: [{ kind: 'settings', label: 'Open Settings › Notifications', section: 'notifications' }]
    };
}

/** Returns the result of a check that failed. */
export function failedCheckResult(id: SetupCheckId, error: unknown): SetupCheckResult {
    const detail = error instanceof Error ? error.message : String(error);
    return { id, state: 'unknown', message: `ShipWarden cannot do this check. ${detail}`.trim(), fixes: [] };
}

/** Puts a new result of one check in a list of results. The order stays. A check that is not in the list goes at the end. */
export function replaceCheckResult(results: readonly SetupCheckResult[], result: SetupCheckResult): SetupCheckResult[] {
    return results.some(item => item.id === result.id) ? results.map(item => (item.id === result.id ? result : item)) : [...results, result];
}
