import { useEffect, useRef, type ReactNode } from 'react';
import { onExplorerFocusRequest } from '../files/explorer-focus';
import { CircleCheck, Files, GitCommitVertical, GitPullRequest, Plug, Workflow } from 'lucide-react';
import type { CheckRun, DiffSide, PullRequest, PullRequestFile, RepoRef } from '@shared/github';
import type { BranchStatusState } from '../github/use-branch-status';
import { ChecksPanel } from './ChecksPanel';
import { FileExplorer } from './FileExplorer';
import { ProcessesPanel } from './ProcessesPanel';
import { ChangesPanel } from './ChangesPanel';
import { PipelinesPanel } from './PipelinesPanel';
import { changeCount, type ChangeSide, type FileChange } from '@shared/git';
import { useGitChanges } from '../git/git-store';
import { PullRequestPanel } from './PullRequestPanel';
import { moveTabFocus } from '../tablist';

export type PanelTab = 'files' | 'changes' | 'pr' | 'checks' | 'pipelines' | 'processes';
const TAB_STORAGE_KEY = 'shipwarden.rightPanelTab';

interface Props {
    root: string;
    /** The tab that shows. The app keeps it in the query of the history entry. */
    tab: PanelTab;
    /** Shows a different tab. */
    onSelectTab(tab: PanelTab): void;
    activeFile?: string;
    github: BranchStatusState;
    onOpenFile(path: string, line?: number): void;
    onOpenDiff(pr: PullRequest, file: PullRequestFile, line?: number, side?: DiffSide): void;
    onSendToAgent(prompt: string): void;
    onSendLogToAgent(check: CheckRun): void;
    onSendChecksToAgent(checks: CheckRun[]): void;
    onShowTerminal(sessionId: string): void;
    onOpenChange(change: FileChange, side: ChangeSide): void;
    onOpenAllChanges(): void;
    /** Opens the pull request of the branch in the Review view. Without it, the PR tab has no "Open in Review" button. */
    onOpenInReview?(repo: RepoRef, pr: PullRequest): void;
    /** The buttons of the manual pull request automations. The PR tab shows them under the header. */
    renderPrAutomations?(pr: PullRequest): ReactNode;
}

/** True when the text is the name of a tab of the right panel. */
export function isPanelTab(value: string | undefined): value is PanelTab {
    return value === 'files' || value === 'changes' || value === 'pr' || value === 'checks' || value === 'pipelines' || value === 'processes';
}

/** Returns the tab that the user selected last. */
export function readPanelTab(): PanelTab {
    try {
        const value = localStorage.getItem(TAB_STORAGE_KEY) ?? undefined;
        return isPanelTab(value) ? value : 'files';
    } catch {
        return 'files';
    }
}

/** Keeps the tab that the user selected last. A new worktree page starts on this tab. */
export function writePanelTab(tab: PanelTab): void {
    try {
        localStorage.setItem(TAB_STORAGE_KEY, tab);
    } catch {
        // The tab stays for this session only.
    }
}

/** The right panel: the file explorer, the pull request of the branch and its checks. */
export function RightPanel(props: Props) {
    const tab = props.tab;
    const status = props.github.status;
    const pr = status?.pullRequest;
    const openInReview = props.onOpenInReview;
    const unresolved = pr?.threads.filter(thread => !thread.isResolved).length ?? 0;
    // The changes load while the panel shows, also on other tabs, for the count on the Changes tab.
    const git = useGitChanges(props.root);
    const changed = git.changes ? changeCount(git.changes) : 0;
    const behind = git.changes?.behind ?? 0;

    const select = props.onSelectTab;
    const selectRef = useRef(select);
    selectRef.current = select;

    // ⇧⌘E shows the Files tab. The explorer then takes the focus request when it mounts.
    useEffect(() => onExplorerFocusRequest(() => selectRef.current('files')), []);

    // ← and → move the focus to the previous or the next tab. That tab then shows.
    const tabButton = (id: PanelTab, title: string, icon: React.ReactNode, badge?: React.ReactNode) => (
        <button
            className={`panel-tab${tab === id ? ' selected' : ''}`}
            role="tab"
            aria-selected={tab === id}
            aria-label={title}
            tabIndex={tab === id ? 0 : -1}
            title={title}
            onClick={() => select(id)}
            onKeyDown={event => moveTabFocus(event)?.click()}
        >
            {icon}
            {badge}
        </button>
    );

    return (
        <aside className="explorer" data-tour="rightPanel">
            <div className="panel-tabs" role="tablist" aria-label="Right panel">
                {tabButton('files', 'Files', <Files size={17} strokeWidth={1.5} />)}
                {tabButton(
                    'changes',
                    [changed ? `Changes (${changed} files)` : 'Changes', behind ? `${behind} commits to pull` : ''].filter(Boolean).join(' · '),
                    <GitCommitVertical size={17} strokeWidth={1.5} />,
                    // A dot, without a number: local changes (accent), or only commits to pull (blue). The tooltip has the counts.
                    changed > 0 || behind > 0 ? <span className={`panel-badge${changed === 0 ? ' pull' : ''}`} aria-hidden="true" /> : undefined
                )}
                {tabButton(
                    'pr',
                    [
                        pr ? `Pull request #${pr.number}` : 'Pull request',
                        unresolved ? `${unresolved} unresolved ${unresolved === 1 ? 'thread' : 'threads'}` : ''
                    ]
                        .filter(Boolean)
                        .join(' · '),
                    <GitPullRequest size={17} strokeWidth={1.5} />,
                    unresolved > 0 ? <span className="panel-badge" aria-hidden="true" /> : undefined
                )}
                {tabButton('checks', 'Checks', <CircleCheck size={17} strokeWidth={1.5} />)}
                {tabButton('pipelines', 'Pipelines of this repository', <Workflow size={17} strokeWidth={1.5} />)}
                {tabButton('processes', 'Processes and ports', <Plug size={17} strokeWidth={1.5} />)}
            </div>
            {tab === 'files' && <FileExplorer key={props.root} root={props.root} activePath={props.activeFile} onOpenFile={props.onOpenFile} />}
            {tab === 'pr' && (
                <PullRequestPanel
                    target={props.root}
                    status={props.github.status}
                    loading={props.github.loading}
                    error={props.github.error}
                    onRefresh={props.github.refresh}
                    onOpenDiff={props.onOpenDiff}
                    onSendToAgent={props.onSendToAgent}
                    onSendChecksToAgent={props.onSendChecksToAgent}
                    onOpenInReview={openInReview && status ? pr => openInReview(status.repo, pr) : undefined}
                    renderAutomations={props.renderPrAutomations}
                />
            )}
            {tab === 'changes' && (
                <ChangesPanel
                    key={props.root}
                    worktree={props.root}
                    changes={git.changes}
                    error={git.error}
                    fetched={git.fetched}
                    onReload={() => git.reload(true)}
                    onOpenChange={props.onOpenChange}
                    onOpenAllChanges={props.onOpenAllChanges}
                    onOpenFile={path => props.onOpenFile(path)}
                />
            )}
            {tab === 'pipelines' && (
                <PipelinesPanel key={props.root} root={props.root} branch={git.changes?.branch} onSendLogToAgent={props.onSendLogToAgent} />
            )}
            {tab === 'processes' && <ProcessesPanel key={props.root} worktreePath={props.root} onShowTerminal={props.onShowTerminal} />}
            {tab === 'checks' && <ChecksPanel key={props.root} target={props.root} status={props.github.status} onSendLogToAgent={props.onSendLogToAgent} />}
        </aside>
    );
}
