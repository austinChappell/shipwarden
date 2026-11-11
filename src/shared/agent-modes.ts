import { agentProgramOf, type AgentProgram } from './agent-programs';

/**
 * The permission mode of a new agent session, from the agent settings or from an automation.
 * - auto: the agent does not stop to ask for permission.
 * - acceptEdits: the agent edits files without a question. It asks before other actions.
 * - plan: the agent reads the code and makes a plan. It does not change files.
 * - bypassPermissions: the agent does all actions without a question and without a sandbox.
 * Without a mode, the agent uses its own setting.
 */
export type AgentMode = 'auto' | 'acceptEdits' | 'plan' | 'bypassPermissions';

export const AGENT_MODES: readonly { mode: AgentMode; label: string; description: string }[] = [
    { mode: 'auto', label: 'Auto', description: 'The agent does not stop to ask for permission.' },
    { mode: 'acceptEdits', label: 'Accept edits', description: 'The agent edits files without a question. It asks before other actions.' },
    { mode: 'plan', label: 'Plan', description: 'The agent reads the code and makes a plan. It does not change files.' },
    { mode: 'bypassPermissions', label: 'Bypass permissions', description: 'The agent does all actions without a question and without a sandbox.' }
];

export function isAgentMode(value: unknown): value is AgentMode {
    return AGENT_MODES.some(item => item.mode === value);
}

export function agentModeLabel(mode: AgentMode): string {
    return AGENT_MODES.find(item => item.mode === mode)?.label ?? mode;
}

/** The command-line options of each mode for each agent program. A missing entry: the program does not have the mode. */
const MODE_OPTIONS: Record<AgentProgram, Partial<Record<AgentMode, string>>> = {
    claude: {
        auto: '--permission-mode auto',
        acceptEdits: '--permission-mode acceptEdits',
        plan: '--permission-mode plan',
        bypassPermissions: '--permission-mode bypassPermissions'
    },
    codex: {
        auto: '--sandbox workspace-write --ask-for-approval never',
        acceptEdits: '--sandbox workspace-write --ask-for-approval on-request',
        plan: '--sandbox read-only --ask-for-approval never',
        bypassPermissions: '--dangerously-bypass-approvals-and-sandbox'
    },
    gemini: {
        auto: '--approval-mode yolo',
        acceptEdits: '--approval-mode auto_edit',
        plan: '--approval-mode plan',
        bypassPermissions: '--approval-mode yolo'
    },
    opencode: {
        auto: '--auto',
        bypassPermissions: '--auto'
    }
};

/**
 * Returns the command that starts the agent in the mode. The options go after the command of the agent.
 * Throws an error with a message when the program is not known or does not have the mode.
 */
export function commandWithMode(command: string, program: AgentProgram | undefined, mode: AgentMode, agentName: string): string {
    if (!program) {
        throw new Error(
            `ShipWarden cannot set the mode "${agentModeLabel(mode)}" for the agent "${agentName}". It sets a mode only for Claude Code, Codex, Gemini CLI, and opencode.`
        );
    }
    const options = MODE_OPTIONS[program][mode];
    if (!options) {
        throw new Error(`The agent "${agentName}" does not have the mode "${agentModeLabel(mode)}". Select another mode.`);
    }
    return `${command.trim()} ${options}`;
}

/** Returns the modes that the program has. A program that ShipWarden does not know has no modes. */
export function modesOf(program: AgentProgram | undefined): AgentMode[] {
    return program ? AGENT_MODES.map(item => item.mode).filter(mode => MODE_OPTIONS[program][mode] !== undefined) : [];
}

/**
 * Returns the command that starts a new session of an agent. `mode` (for example from an automation) replaces the
 * default mode of the agent. Throws an error with a message when the agent does not have the mode.
 */
export function agentStartCommand(agent: { name: string; command: string; mode?: AgentMode }, mode?: AgentMode): string {
    const selected = mode ?? agent.mode;
    return selected ? commandWithMode(agent.command, agentProgramOf(agent.command), selected, agent.name) : agent.command;
}

/**
 * The mode that the status line of Claude Code shows on the screen. Without a mode text, the mode is "default".
 * The screen text can come without its spaces, so the test removes all whitespace first.
 */
export function claudeModeOnScreen(screen: string): AgentMode | 'default' {
    const text = screen.replace(/\s+/g, '').toLowerCase();
    if (text.includes('accepteditson')) return 'acceptEdits';
    if (text.includes('planmodeon')) return 'plan';
    if (text.includes('bypasspermissionson')) return 'bypassPermissions';
    if (text.includes('automodeon')) return 'auto';
    return 'default';
}

/** The keys of Shift+Tab. Claude Code goes to its next permission mode with them. */
export const SHIFT_TAB = '\x1b[Z';
