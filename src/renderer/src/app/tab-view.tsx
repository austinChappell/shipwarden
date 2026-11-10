import type { ReactNode } from 'react';
import type { NoteTarget } from '@shared/code-note';
import type { CheckRun, PullRequest } from '@shared/github';
import type { LspMissingServer } from '@shared/lsp';
import type { AgentDefinition } from '@shared/settings';
import type { TerminalSession, TerminalSettings } from '@shared/terminal';
import type { Worktree } from '@shared/worktrees';
import { BrowserView } from '../components/BrowserView';
import { ChangeDiffView } from '../components/ChangeDiffView';
import { DiffView } from '../components/DiffView';
import { FileView } from '../components/FileView';
import { LogView } from '../components/LogView';
import { TerminalView } from '../components/TerminalView';
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
    /** Returns the newest data of a pull request. */
    latestPullRequest: (pr: PullRequest) => PullRequest;
    refreshGitHub: () => Promise<void>;
    closeFromView: (tab: TabKey) => void;
    openFile: (path: string) => void;
    sendToAgent: (prompt: string, worktree?: Worktree, target?: NoteTarget) => Promise<void>;
    sendLogToAgent: (check: CheckRun) => Promise<void>;
    installServer: (worktreePath: string, server: LspMissingServer) => Promise<void>;
    setError: (error: string | undefined) => void;
}

/** Returns the view of one tab: a diff, a CI log, a file or a terminal. `focused` is false for a pane without the focus. */
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
    if (extra) {
        return extra.kind === 'diff' ? (
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
        ) : (
            <LogView key={`${selectedPath}\0${extra.key}`} target={selectedPath} check={extra.check} onSendToAgent={context.sendLogToAgent} />
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
                onInstallServer={server => void context.installServer(selectedPath, server)}
                onOpenFile={file => openFile(file)}
                agents={context.agents}
                defaultAgentId={context.defaultAgentId}
                onSendNote={(prompt, target) => void sendToAgent(prompt, context.selected, target)}
            />
        );
    }
    const session = context.sessions.find(item => `t:${item.id}` === tab);
    return session && context.settings ? (
        <TerminalView
            key={`${session.id}:${context.terminalColorsKey}`}
            session={session}
            settings={context.terminalSettings ?? context.settings}
            focused={focused}
        />
    ) : null;
}
