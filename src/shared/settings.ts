import { DEFAULT_AUTOMATION_SETTINGS, normalizeAutomationSettings, type AutomationSettings } from './automations';
import { DEFAULT_NOTIFICATION_SETTINGS, normalizeNotificationSettings, type NotificationSettings } from './notifications';
import {
    DEFAULT_WORKTREE_SETTINGS,
    normalizeRepoWorktreeSettings,
    normalizeWorktreeSettings,
    type RepoWorktreeSettings,
    type WorktreeSettings
} from './worktree-settings';
import { DEFAULT_APPEARANCE, normalizeAppearance, type Appearance } from './themes';
import { normalizeHiddenWorktrees, type HiddenWorktree } from './worktrees';
import { DEFAULT_REMOTE_SETTINGS, normalizeRemoteSettings, type RemoteSettings } from './remote';
import { normalizeOnboarding, type OnboardingSettings } from './onboarding';
import { isAgentMode, type AgentMode } from './agent-modes';

/**
 * An agent that the Agent button can start, for example Claude Code. The command runs in an interactive login shell,
 * so the PATH and aliases of the user's shell apply.
 */
export interface AgentDefinition {
    id: string;
    name: string;
    command: string;
    /** The permission mode of a new session. An automation can set another mode. Without it, the agent uses its own setting. */
    mode?: AgentMode;
}

/** The colors that a repository can have. Each one is readable on light and dark themes. */
export const REPO_COLORS = {
    red: '#e5534b',
    orange: '#e8833a',
    yellow: '#d4a72c',
    green: '#4fae5a',
    teal: '#2fa59b',
    blue: '#4a8fe7',
    purple: '#9b6ce0',
    pink: '#d6609c'
} as const;

export type RepoColor = keyof typeof REPO_COLORS;

/** The settings of one repository. Each value is optional. Without it, the repository uses the default. */
export interface RepoSettings {
    /** The name in the sidebar and the other views. Without it, the folder name. */
    name?: string;
    /** The ID of the agent that the Agent button starts in the repository. Without it, the global default agent. */
    agentId?: string;
    color?: RepoColor;
    /** The worktree settings of this repository. A missing value uses the global worktree settings. */
    worktrees?: RepoWorktreeSettings;
    /** Saved scripts of the repository. The ▷ menu of the workspace header runs them in a new terminal tab. */
    scripts?: RepoScript[];
}

/** A saved script of a repository, for example "npm test". */
export interface RepoScript {
    id: string;
    name: string;
    /** A shell command or a script with more lines. It runs in the login shell of the user. */
    command: string;
}

/** Keeps the scripts with an ID, a name and a command. The order stays. */
export function normalizeScripts(value: unknown): RepoScript[] {
    if (!Array.isArray(value)) return [];
    const scripts: RepoScript[] = [];
    for (const item of value) {
        const raw = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
        const name = typeof raw.name === 'string' ? raw.name.trim() : '';
        const command = typeof raw.command === 'string' ? raw.command.replace(/\s+$/, '') : '';
        if (typeof raw.id !== 'string' || !raw.id || !name || !command.trim() || scripts.some(script => script.id === raw.id)) continue;
        scripts.push({ id: raw.id, name, command });
    }
    return scripts;
}

/** The app settings. The main process keeps them in `<app data>/settings.json`. */
export interface AppSettings {
    /** The color scheme and the themes. */
    appearance: Appearance;
    /** The agents that the user can start. There is always at least one. */
    agents: AgentDefinition[];
    /** The ID of the agent that a repository without its own choice starts. */
    defaultAgentId: string;
    /**
     * True to show a new agent tab as a chat. The chat needs the transcript of Claude Code. Other agents always show the
     * terminal. Each tab can change between the chat and the terminal.
     */
    agentChat: boolean;
    /** The settings of each repository, by the root of its main worktree. */
    repos: Record<string, RepoSettings>;
    /**
     * The GitHub owners of older versions. "all" means all owners. At the first start, `ReviewProviders` makes a GitHub
     * provider from it, with a list as the scope. Newer versions keep the scope in the provider.
     */
    reviewOwners?: string[] | 'all';
    /**
     * The Dashboard does not show comments from these authors, for example accounts of automations.
     * A name is a GitHub login or a task manager user name. The match ignores case.
     */
    dashboardHiddenAuthors?: string[];
    /** The Dashboard does not show comments that match one of these rules, for example a comment that an automation posts on each pull request. */
    dashboardHiddenRules?: HiddenCommentRule[];
    /** The certificates that ShipWarden trusts in addition to the default ones, for a network that inspects TLS traffic. */
    network: NetworkSettings;
    /** The worktree settings of all repositories. A repository can have its own values. */
    worktrees: WorktreeSettings;
    /** The macOS notifications: on or off, and a switch and a sound for each event. */
    notifications: NotificationSettings;
    /** The display names of worktrees, by the worktree path. A worktree without a name shows its branch. */
    worktreeNames?: Record<string, string>;
    /** The worktrees that the sidebar does not show, by the worktree path. A snoozed worktree shows again at its end time. */
    hiddenWorktrees?: Record<string, HiddenWorktree>;
    /** The connection of the phone app. */
    remote: RemoteSettings;
    /** The settings of all automations: pause, and the usage limit. The automations are files in ~/.shipwarden/automations. */
    automations: AutomationSettings;
    /**
     * The state of the welcome page, the tour and the checklist. It is missing before the first start of this version.
     * The main process then sets it one time from the repositories of the user (see `initialOnboarding`).
     */
    onboarding?: OnboardingSettings;
}

/** Keeps the names that are text, trimmed and at most 80 characters. */
function normalizeWorktreeNames(raw: unknown): Record<string, string> | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const entries = Object.entries(raw as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length > 0 && entry[0].startsWith('/'))
        .map(([path, name]) => [path, name.trim().slice(0, 80)]);
    return entries.length ? Object.fromEntries(entries) : undefined;
}

export interface NetworkSettings {
    /**
     * A PEM file with extra CA certificates. When it is empty, ShipWarden uses NODE_EXTRA_CA_CERTS from the login shell.
     */
    caCertsFile?: string;
    /** True to trust the certificates in the macOS keychain. Company CAs are often there. */
    useSystemCertificates: boolean;
}

function normalizeNetwork(raw: unknown): NetworkSettings {
    const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const file = typeof value.caCertsFile === 'string' ? value.caCertsFile.trim() : '';
    return { ...(file ? { caCertsFile: file } : {}), useSystemCertificates: value.useSystemCertificates === true };
}

export type HiddenCommentMatch = 'startsWith' | 'contains' | 'regex';

/** A rule that hides comments on the Dashboard. A comment must match the author (when set) and the text. */
export interface HiddenCommentRule {
    id: string;
    /** A GitHub login or a task manager user name. Without it, the rule applies to all authors. The match ignores case. */
    author?: string;
    match: HiddenCommentMatch;
    /** The text to find. "startsWith" and "contains" ignore case. "regex" is a JavaScript regular expression with the "i" flag. */
    text: string;
}

const MATCHES: HiddenCommentMatch[] = ['startsWith', 'contains', 'regex'];

function normalizeRules(raw: unknown): HiddenCommentRule[] | undefined {
    if (!Array.isArray(raw)) {
        return undefined;
    }
    const rules: HiddenCommentRule[] = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const rule = item as Record<string, unknown>;
        const text = typeof rule.text === 'string' ? rule.text : '';
        const match = MATCHES.includes(rule.match as HiddenCommentMatch) ? (rule.match as HiddenCommentMatch) : undefined;
        if (!text.trim() || !match || typeof rule.id !== 'string' || !rule.id || rules.some(other => other.id === rule.id)) continue;
        const author = typeof rule.author === 'string' && rule.author.trim() ? rule.author.trim() : undefined;
        rules.push({ id: rule.id, ...(author ? { author } : {}), match, text });
    }
    return rules;
}

/** The agents of a new installation. */
export const DEFAULT_AGENTS: readonly AgentDefinition[] = [
    { id: 'claude', name: 'Claude Code', command: 'claude' },
    { id: 'codex', name: 'Codex', command: 'codex' },
    { id: 'gemini', name: 'Gemini CLI', command: 'gemini' },
    { id: 'opencode', name: 'opencode', command: 'opencode' }
];

export const DEFAULT_SETTINGS: AppSettings = {
    appearance: DEFAULT_APPEARANCE,
    agents: [...DEFAULT_AGENTS],
    defaultAgentId: 'claude',
    agentChat: true,
    repos: {},
    network: { useSystemCertificates: false },
    worktrees: DEFAULT_WORKTREE_SETTINGS,
    notifications: DEFAULT_NOTIFICATION_SETTINGS,
    remote: DEFAULT_REMOTE_SETTINGS,
    automations: DEFAULT_AUTOMATION_SETTINGS
};

/** The maximum length of an agent command. A longer value is not a command that a person types. */
const MAX_COMMAND_LENGTH = 1000;
const MAX_NAME_LENGTH = 80;

/** Returns a valid command, or undefined. A command is one line. */
export function cleanCommand(value: unknown): string | undefined {
    const command = typeof value === 'string' ? value.trim() : '';
    return command && command.length <= MAX_COMMAND_LENGTH && !command.includes('\n') ? command : undefined;
}

function cleanName(value: unknown): string | undefined {
    const name = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
    return name && name.length <= MAX_NAME_LENGTH ? name : undefined;
}

function normalizeAgents(raw: Record<string, unknown>): { agents: AgentDefinition[]; defaultAgentId: string } {
    const agents: AgentDefinition[] = [];
    for (const item of Array.isArray(raw.agents) ? raw.agents : []) {
        const agent = item as Record<string, unknown> | null;
        const command = cleanCommand(agent?.command);
        const id = typeof agent?.id === 'string' && agent.id ? agent.id : undefined;
        if (!agent || !id || !command || agents.some(existing => existing.id === id)) {
            continue;
        }
        agents.push({ id, name: cleanName(agent.name) ?? agentTitle(command), command, ...(isAgentMode(agent.mode) ? { mode: agent.mode } : {}) });
    }
    if (agents.length === 0) {
        // Settings from before the agent list have one "agentCommand". It becomes the default agent.
        agents.push(...DEFAULT_AGENTS);
        const old = cleanCommand(raw.agentCommand);
        if (old && !agents.some(agent => agent.command === old)) {
            agents.push({ id: 'custom', name: agentTitle(old), command: old });
        }
        const oldDefault = old ? agents.find(agent => agent.command === old) : undefined;
        return { agents, defaultAgentId: oldDefault?.id ?? 'claude' };
    }
    const defaultAgentId = typeof raw.defaultAgentId === 'string' && agents.some(agent => agent.id === raw.defaultAgentId) ? raw.defaultAgentId : agents[0].id;
    return { agents, defaultAgentId };
}

function normalizeRepos(value: unknown, agents: AgentDefinition[]): Record<string, RepoSettings> {
    const repos: Record<string, RepoSettings> = {};
    const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    for (const [repo, item] of Object.entries(raw)) {
        const entry = item as Record<string, unknown> | null;
        if (!repo.startsWith('/') || !entry || typeof entry !== 'object') {
            continue;
        }
        const settings: RepoSettings = {};
        const name = cleanName(entry.name);
        if (name) settings.name = name;
        // An agent that the user removed is no longer a choice. The repository then uses the default agent.
        if (typeof entry.agentId === 'string' && agents.some(agent => agent.id === entry.agentId)) settings.agentId = entry.agentId;
        if (typeof entry.color === 'string' && entry.color in REPO_COLORS) settings.color = entry.color as RepoColor;
        const worktrees = normalizeRepoWorktreeSettings(entry.worktrees);
        if (worktrees) settings.worktrees = worktrees;
        const scripts = normalizeScripts(entry.scripts);
        if (scripts.length > 0) settings.scripts = scripts;
        if (Object.keys(settings).length > 0) repos[repo] = settings;
    }
    return repos;
}

/** Converts stored or received values to valid settings. A value with a wrong type gets its default. */
export function normalizeSettings(value: unknown): AppSettings {
    const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    const { agents, defaultAgentId } = normalizeAgents(raw);
    return {
        appearance: normalizeAppearance(raw.appearance),
        agents,
        defaultAgentId,
        agentChat: raw.agentChat !== false,
        repos: normalizeRepos(raw.repos, agents),
        network: normalizeNetwork(raw.network),
        // Older versions kept the sort in "worktreeSort".
        worktrees: normalizeWorktreeSettings(raw.worktrees, raw.worktreeSort),
        notifications: normalizeNotificationSettings(raw.notifications),
        remote: normalizeRemoteSettings(raw.remote),
        automations: normalizeAutomationSettings(raw.automations),
        ...(normalizeOnboarding(raw.onboarding) ? { onboarding: normalizeOnboarding(raw.onboarding) } : {}),
        ...(normalizeWorktreeNames(raw.worktreeNames) ? { worktreeNames: normalizeWorktreeNames(raw.worktreeNames) } : {}),
        ...(normalizeHiddenWorktrees(raw.hiddenWorktrees) ? { hiddenWorktrees: normalizeHiddenWorktrees(raw.hiddenWorktrees) } : {}),
        ...(raw.reviewOwners === 'all'
            ? { reviewOwners: 'all' as const }
            : Array.isArray(raw.reviewOwners)
              ? { reviewOwners: [...new Set(raw.reviewOwners.filter((owner): owner is string => typeof owner === 'string' && owner.length > 0))] }
              : {}),
        ...(Array.isArray(raw.dashboardHiddenAuthors)
            ? {
                  dashboardHiddenAuthors: [
                      ...new Set(
                          raw.dashboardHiddenAuthors
                              .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
                              .map(name => name.trim())
                      )
                  ]
              }
            : {}),
        ...(normalizeRules(raw.dashboardHiddenRules) ? { dashboardHiddenRules: normalizeRules(raw.dashboardHiddenRules) } : {})
    };
}

/** Returns the agent that the Agent button starts in a repository: its own choice, else the default agent. */
export function agentForRepo(settings: AppSettings, repo: string | undefined): AgentDefinition {
    const own = repo ? settings.repos[repo]?.agentId : undefined;
    return (
        settings.agents.find(agent => agent.id === own) ??
        settings.agents.find(agent => agent.id === settings.defaultAgentId) ??
        settings.agents[0] ??
        DEFAULT_AGENTS[0]
    );
}

/** Returns the name of a repository: its own name from the settings, else its folder name. */
export function repoDisplayName(settings: AppSettings, repo: string): string {
    return settings.repos[repo]?.name ?? repo.split('/').filter(Boolean).pop() ?? repo;
}

/** Returns the program of a command, for example "claude" for "claude --model opus". */
export function commandProgram(command: string): string {
    return command.trim().split(/\s+/)[0] ?? '';
}

/** Returns the tab title of an agent: the name of its program without the folder. */
export function agentTitle(command: string): string {
    const program = commandProgram(command);
    return program.slice(program.lastIndexOf('/') + 1) || 'agent';
}

/**
 * Returns the default agents that are not in an agent list. An agent with the same program counts as present.
 * The settings page offers them, so an older installation can add an agent that ShipWarden got later (for example Gemini CLI).
 */
export function missingDefaultAgents(agents: readonly AgentDefinition[]): AgentDefinition[] {
    const programs = new Set(agents.map(agent => agentTitle(agent.command)));
    return DEFAULT_AGENTS.filter(agent => !programs.has(agentTitle(agent.command)) && !agents.some(item => item.id === agent.id));
}

/** The result of a check of the agent command. */
export interface CommandCheck {
    program: string;
    /** The full path of the program in the login shell PATH. It is undefined when the program is not there. */
    path?: string;
}
