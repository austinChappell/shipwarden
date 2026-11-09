import { useState } from 'react';
import { CircleCheck, Files, GitCommitVertical, GitPullRequest, Plug, Workflow } from 'lucide-react';
import type { CheckRun, PullRequest, PullRequestFile } from '@shared/github';
import type { BranchStatusState } from '../github/use-branch-status';
import { ChecksPanel } from './ChecksPanel';
import { FileExplorer } from './FileExplorer';
import { ProcessesPanel } from './ProcessesPanel';
import { ChangesPanel } from './ChangesPanel';
import { PipelinesPanel } from './PipelinesPanel';
import { changeCount, type ChangeSide, type FileChange } from '@shared/git';
import { useGitChanges } from '../git/git-store';
import { PullRequestPanel } from './PullRequestPanel';

type PanelTab = 'files' | 'changes' | 'pr' | 'checks' | 'pipelines' | 'processes';
const TAB_STORAGE_KEY = 'shipwarden.rightPanelTab';

interface Props {
    root: string;
    activeFile?: string;
    github: BranchStatusState;
    onOpenFile(path: string, line?: number): void;
    onOpenDiff(pr: PullRequest, file: PullRequestFile, line?: number): void;
    onOpenLog(check: CheckRun): void;
    onSendToAgent(prompt: string): void;
    onSendLogToAgent(check: CheckRun): void;
    onShowTerminal(sessionId: string): void;
    onOpenChange(change: FileChange, side: ChangeSide): void;
    onOpenAllChanges(): void;
}

function readTab(): PanelTab {
    try {
        const value = localStorage.getItem(TAB_STORAGE_KEY);
        return value === 'changes' || value === 'pr' || value === 'checks' || value === 'pipelines' || value === 'processes' ? value : 'files';
    } catch {
        return 'files';
    }
}

/** The right panel: the file explorer, the pull request of the branch and its checks. */
export function RightPanel(props: Props) {
    const [tab, setTab] = useState<PanelTab>(readTab);
    const pr = props.github.status?.pullRequest;
    const unresolved = pr?.threads.filter(thread => !thread.isResolved).length ?? 0;
    // The changes load while the panel shows, also on other tabs, for the count on the Changes tab.
    const git = useGitChanges(props.root);
    const changed = git.changes ? changeCount(git.changes) : 0;
    const behind = git.changes?.behind ?? 0;

    const select = (next: PanelTab) => {
        setTab(next);
        try {
            localStorage.setItem(TAB_STORAGE_KEY, next);
        } catch {
            // The tab stays for this session only.
        }
    };

    const tabButton = (id: PanelTab, title: string, icon: React.ReactNode, badge?: React.ReactNode) => (
        <button className={`panel-tab${tab === id ? ' selected' : ''}`} title={title} onClick={() => select(id)}>
            {icon}
            {badge}
        </button>
    );

    return (
        <aside className="explorer">
            <div className="panel-tabs">
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
                    [pr ? `Pull request #${pr.number}` : 'Pull request', unresolved ? `${unresolved} unresolved ${unresolved === 1 ? 'thread' : 'threads'}` : ''].filter(Boolean).join(' · '),
                    <GitPullRequest size={17} strokeWidth={1.5} />,
                    unresolved > 0 ? <span className="panel-badge" aria-hidden="true" /> : undefined
                )}
                {tabButton('checks', 'Checks', <CircleCheck size={17} strokeWidth={1.5} />)}
                {tabButton('pipelines', 'Pipelines of this repository', <Workflow size={17} strokeWidth={1.5} />)}
                {tabButton('processes', 'Processes and ports', <Plug size={17} strokeWidth={1.5} />)}
            </div>
            {tab === 'files' && (
                <FileExplorer key={props.root} root={props.root} activePath={props.activeFile} onOpenFile={props.onOpenFile} />
            )}
            {tab === 'pr' && (
                <PullRequestPanel
                    target={props.root}
                    status={props.github.status}
                    loading={props.github.loading}
                    error={props.github.error}
                    onRefresh={props.github.refresh}
                    onOpenDiff={props.onOpenDiff}
                    onSendToAgent={props.onSendToAgent}
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
                <PipelinesPanel key={props.root} root={props.root} branch={git.changes?.branch} onOpenLog={props.onOpenLog} />
            )}
            {tab === 'processes' && <ProcessesPanel key={props.root} worktreePath={props.root} onShowTerminal={props.onShowTerminal} />}
            {tab === 'checks' && (
                <ChecksPanel
                    key={props.root}
                    target={props.root}
                    status={props.github.status}
                    onOpenLog={props.onOpenLog}
                    onSendLogToAgent={props.onSendLogToAgent}
                />
            )}
        </aside>
    );
}
