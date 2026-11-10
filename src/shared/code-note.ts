import { AGENT_STATE_LABELS } from './agents';
import { fence, lineLabel, MAX_PATCH } from './ask-agent';
import { DEFAULT_AGENTS, type AgentDefinition } from './settings';
import type { TerminalSession } from './terminal';

/** The agent that gets a note: an agent that runs in a tab, or a new session of an agent definition. */
export type NoteTarget = { kind: 'session'; id: string } | { kind: 'new'; agentId: string };

/** One choice in the agent menu of a note. */
export interface NoteTargetOption {
    /** A unique key for the menu: "s:<session ID>" or "n:<agent ID>". */
    key: string;
    label: string;
    target: NoteTarget;
}

/** Returns true when the session is an agent tab, or a shell tab that runs an agent program. An ended session is not an agent. */
export function isLiveAgent(session: TerminalSession): boolean {
    return !session.exited && (session.isAgent || !!session.agentProgram);
}

/** Returns the label of an agent tab, for example "Claude Code · Working · fix the login test". */
function sessionLabel(session: TerminalSession): string {
    const name = session.isAgent ? session.title : DEFAULT_AGENTS.find(agent => agent.id === session.agentProgram)?.name ?? session.title;
    const parts = [name];
    if (session.agentState) parts.push(AGENT_STATE_LABELS[session.agentState]);
    if (session.agentPrompt) parts.push(session.agentPrompt.length > 40 ? `${session.agentPrompt.slice(0, 40)}…` : session.agentPrompt);
    return parts.join(' · ');
}

/**
 * Returns the choices for a note: first the agents that run in the worktree, then a new session of each agent definition.
 * `defaultAgentId` is the agent of the repository. Its "New" choice comes first.
 */
export function noteTargetOptions(sessions: readonly TerminalSession[], agents: readonly AgentDefinition[], defaultAgentId?: string): NoteTargetOption[] {
    const running = sessions.filter(isLiveAgent).map((session): NoteTargetOption => ({
        key: `s:${session.id}`,
        label: sessionLabel(session),
        target: { kind: 'session', id: session.id }
    }));
    const ordered = [...agents].sort((a, b) => Number(b.id === defaultAgentId) - Number(a.id === defaultAgentId));
    const fresh = ordered.map((agent): NoteTargetOption => ({
        key: `n:${agent.id}`,
        label: `New ${agent.name}`,
        target: { kind: 'new', agentId: agent.id }
    }));
    return [...running, ...fresh];
}

export interface CodeNotePromptInput {
    /** The path of the file, relative to the worktree. */
    path: string;
    startLine: number;
    endLine: number;
    /** The text of the lines in the editor. It can contain changes that are not saved. */
    code: string;
    note: string;
}

/** Returns the prompt for a note about lines of a file. The agent can change files, so the note is a task. */
export function codeNotePrompt(input: CodeNotePromptInput): string {
    const code = input.code.length > MAX_PATCH ? `${input.code.slice(0, MAX_PATCH)}\n… (the lines continue)` : input.code;
    const marker = fence(code);
    return [
        `My note is about ${input.path}, ${lineLabel(input.startLine, input.endLine)}.`,
        `The lines as they are in my editor now. They can contain changes that I did not save:\n\n${marker}\n${code}\n${marker}`,
        input.note
    ].join('\n\n');
}
