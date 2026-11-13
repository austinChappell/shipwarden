import type { ReactNode } from 'react';
import { agentProgramOf } from '@shared/agent-programs';
import type { NoteTarget } from '@shared/code-note';
import type { PullRequest } from '@shared/github';
import type { AgentDefinition } from '@shared/settings';
import type { TerminalSession, TerminalSettings } from '@shared/terminal';
import type { Worktree } from '@shared/worktrees';
import { BrowserView } from '../components/BrowserView';
import { AgentTabView } from '../components/AgentTabView';
import { ChangeDiffView } from '../components/ChangeDiffView';
import { DiffView } from '../components/DiffView';
import { FileView } from '../components/FileView';
import { WorktreeChangesView } from '../components/WorktreeChangesView';
import type { ExtraTab, TabKey } from './tabs';
import type { Reveal } from './use-workspace-tabs';

/** The data and the actions of the selected worktree that the tab views use. */
export interface TabViewContext {
    selectedPath: string | undefined;
    selected: Worktree | undefined;
    sessions: readonly TerminalSession[];
    extras: readonly ExtraTab[];
    /** True while the user drags a tab. A browser page then hides, so that the pane gets the drag events. */
    dragging: boolean;
    reveal: Reveal | undefined;
    focusRequest: { root: string; path: string; nonce: number } | undefined;
    settings: TerminalSettings | undefined;
    terminalSettings: TerminalSettings | undefined;
    /** Changes when the terminal colors change. The terminal view then opens again. */
    terminalColorsKey: string;
    agents: AgentDefinition[];
    defaultAgentId: string;
    /** The setting "agentChat": a new agent tab shows the chat. */
    agentChat: boolean;
    /** Returns the newest data of a pull request. */
    latestPullRequest: (pr: PullRequest) => PullRequest;
    refreshGitHub: () => Promise<void>;
    closeFromView: (tab: TabKey) => void;
    openFile: (path: string) => void;
    /** Shows the active file in the file explorer of the right panel. Undefined when the view has no file explorer. */
    revealInExplorer?: () => void;
    sendToAgent: (prompt: string, worktree?: Worktree, target?: NoteTarget) => Promise<void>;
    setError: (error: string | undefined) => void;
}

/**
 * Returns true when an agent tab starts Claude Code. An agent tab has the name of its agent as its title, so the
 * command comes from the agent in Settings › Agents.
 */
function runsClaude(session: TerminalSession, agents: readonly AgentDefinition[]): boolean {
    if (!session.isAgent) return false;
    const definition = agents.find(agent => agent.name === session.title);
    return !!definition && agentProgramOf(definition.command) === 'claude';
}

/** Returns the view of one tab: a diff, a file or a terminal. `focused` is false for a pane without the focus. */
export function renderTabView(tab: TabKey, focused: boolean, context: TabViewContext): ReactNode {
    const { selectedPath, openFile, sendToAgent } = context;
    if (!selectedPath) return null;
    const extra = context.extras.find(item => item.key === tab);
    if (extra?.kind === 'browser') {
        return <BrowserView key={extra.id} id={extra.id} hidden={context.dragging} focused={focused} onClose={() => context.closeFromView(extra.key)} />;
    }
    if (extra?.kind === 'changes') {
        return <WorktreeChangesView key={selectedPath} worktree={selectedPath} focused={focused} onOpenFile={path => openFile(path)} />;
    }
    if (extra?.kind === 'change') {
        return (
            <ChangeDiffView
                key={`${selectedPath}\0${extra.key}`}
                worktree={selectedPath}
                change={extra.change}
                side={extra.side}
                onOpenFile={path => openFile(path)}
            />
        );
    }
    if (extra?.kind === 'diff') {
        return (
            <DiffView
                key={`${selectedPath}\0${extra.key}`}
                target={selectedPath}
                pr={context.latestPullRequest(extra.pr)}
                file={extra.file}
                revealLine={extra.line}
                revealNonce={extra.nonce}
                onRefresh={context.refreshGitHub}
                onSendToAgent={sendToAgent}
            />
        );
    }
    if (tab.startsWith('f:')) {
        const path = tab.slice(2);
        const { reveal, focusRequest } = context;
        const revealHere = reveal && reveal.root === selectedPath && reveal.path === path;
        return (
            <FileView
                key={`${selectedPath}\0${path}`}
                root={selectedPath}
                path={path}
                revealLine={revealHere ? reveal.line : undefined}
                revealColumn={revealHere ? reveal.column : undefined}
                revealNonce={reveal?.nonce}
                focusNonce={focusRequest && focusRequest.root === selectedPath && focusRequest.path === path ? focusRequest.nonce : undefined}
                onError={context.setError}
                onOpenFile={file => openFile(file)}
                onRevealInExplorer={context.revealInExplorer}
                agents={context.agents}
                defaultAgentId={context.defaultAgentId}
                onSendNote={(prompt, target) => void sendToAgent(prompt, context.selected, target)}
            />
        );
    }
    const session = context.sessions.find(item => `t:${item.id}` === tab);
    return session && context.settings ? (
        <AgentTabView
            key={session.id}
            session={session}
            settings={context.terminalSettings ?? context.settings}
            terminalKey={`${session.id}:${context.terminalColorsKey}`}
            focused={focused}
            chatByDefault={context.agentChat}
            claude={runsClaude(session, context.agents)}
        />
    ) : null;
}
