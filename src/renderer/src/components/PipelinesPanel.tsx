import { useCallback, useEffect, useState } from 'react';
import { ChevronRight, ExternalLink, LoaderCircle, Play, RefreshCw, RotateCw, Square } from 'lucide-react';
import type { CheckRun, Workflow } from '@shared/github';
import { runIsActive, type WorkflowRun } from '@shared/pipelines';
import { errorText, formatDuration, timeAgo } from '../util';
import { CheckIcon } from './ChecksPanel';
import { confirmDialog } from './ConfirmDialog';
import { RunDialog, RunIcon } from './PipelinesView';
import { openLink } from '../links';

const github = window.shipwarden.github;
/** The time between two reads of the runs while a run waits or runs, and while all runs are done. */
const POLL_ACTIVE_MS = 10_000;
const POLL_IDLE_MS = 60_000;

interface Props {
    /** The worktree. Its repository gives the workflows and runs. */
    root: string;
    /** The branch of the worktree. Undefined for a detached HEAD. */
    branch: string | undefined;
    /** Opens the log of a job in a tab, with the live steps while it runs. */
    onOpenLog(job: CheckRun): void;
}

/** One run: a row that opens its jobs, with Cancel or Run again, and a link to GitHub. */
function RunRow({ root, run, ownBranch, onOpenLog, onChanged }: {
    root: string;
    run: WorkflowRun;
    /** True when the run is of the branch of the worktree. Its branch name shows as a tag. */
    ownBranch: boolean;
    onOpenLog(job: CheckRun): void;
    onChanged(): void;
}) {
    const [open, setOpen] = useState(false);
    const [jobs, setJobs] = useState<CheckRun[]>();
    const [error, setError] = useState<string>();
    const active = runIsActive(run);

    const loadJobs = useCallback(async () => {
        try {
            setJobs(await github.runJobs(root, run.id));
            setError(undefined);
        } catch (err) {
            setError(errorText(err));
        }
    }, [root, run.id]);

    // The jobs load when the row opens, and again when the run changes (for example a new status).
    useEffect(() => {
        if (open) void loadJobs();
    }, [open, run.status, run.updatedAt, loadJobs]);

    const act = async (title: string, label: string, action: () => Promise<void>) => {
        if (!(await confirmDialog({ title, confirmLabel: label }))) return;
        try {
            await action();
            onChanged();
        } catch (err) {
            setError(errorText(err));
        }
    };

    return (
        <div className={`pp-run${open ? ' open' : ''}`}>
            <div className="pp-run-head" onClick={() => setOpen(value => !value)} title={run.title}>
                <ChevronRight size={12} strokeWidth={1.8} className={`group-chevron${open ? ' open' : ''}`} />
                <RunIcon run={run} />
                <span className="pp-run-main">
                    <span className="pp-run-title">{run.title}</span>
                    <span className="pp-run-meta">
                        {run.workflowName} #{run.runNumber}
                        {run.branch && (ownBranch
                            ? <> · <span className="pp-own-branch" title="The branch of this worktree">{run.branch}</span></>
                            : ` · ${run.branch}`)}
                        {` · ${timeAgo(run.createdAt)}`}
                        {run.startedAt ? ` · ${formatDuration(run.startedAt, active ? null : run.updatedAt)}` : ''}
                    </span>
                </span>
                <span className="pp-run-actions" onClick={event => event.stopPropagation()}>
                    {active
                        ? <button className="icon-button" title="Cancel the run" onClick={() => void act(`Cancel the run "${run.title}"?`, 'Cancel run', () => github.cancelRun(root, run.id))}><Square size={12} strokeWidth={2} /></button>
                        : <button className="icon-button" title="Run all jobs again" onClick={() => void act(`Run "${run.title}" again?`, 'Run again', () => github.rerunRun(root, run.id))}><RotateCw size={13} strokeWidth={1.8} /></button>}
                    <button className="icon-button" title="Open on GitHub" onClick={event => openLink(run.url, event)}><ExternalLink size={13} strokeWidth={1.7} /></button>
                </span>
            </div>
            {open && (
                <div className="pp-jobs">
                    {error && <div className="form-error">{error}</div>}
                    {!jobs && !error && <div className="panel-note pp-note"><LoaderCircle size={12} className="spin" /> Loading the jobs…</div>}
                    {jobs?.length === 0 && <div className="panel-note pp-note">The run has no jobs yet.</div>}
                    {jobs?.map(job => (
                        <button key={job.id} className="pp-job" title={`Open the log of ${job.name}`} onClick={() => onOpenLog(job)}>
                            <CheckIcon check={job} />
                            <span className="pp-job-name">{job.name}</span>
                            <span className="pp-job-time">{formatDuration(job.startedAt, job.completedAt)}</span>
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

/**
 * The Pipelines tab of the right panel: the GitHub Actions of the repository of the worktree. The newest runs of all
 * branches (the runs of the branch of the worktree have a tag), their jobs, and the workflows that the user can start
 * by hand.
 */
export function PipelinesPanel({ root, branch, onOpenLog }: Props) {
    const [runs, setRuns] = useState<WorkflowRun[]>();
    const [workflows, setWorkflows] = useState<Workflow[]>();
    const [error, setError] = useState<string>();
    const [loading, setLoading] = useState(false);
    const [running, setRunning] = useState<Workflow>();
    const [branches, setBranches] = useState<string[]>();
    /** The branch that the workflow list (and the inputs) came from. The Run dialog starts on it. */
    const [workflowRef, setWorkflowRef] = useState<string>();
    const [showWorkflows, setShowWorkflows] = useState(false);

    const load = useCallback(async () => {
        if (document.visibilityState !== 'visible') return;
        setLoading(true);
        try {
            setRuns(await github.workflowRuns(root));
            setError(undefined);
        } catch (err) {
            setError(errorText(err));
        } finally {
            setLoading(false);
        }
    }, [root]);

    useEffect(() => {
        setRuns(undefined);
        void load();
    }, [load]);

    const active = runs?.some(runIsActive) ?? false;
    useEffect(() => {
        const timer = setInterval(() => void load(), active ? POLL_ACTIVE_MS : POLL_IDLE_MS);
        return () => clearInterval(timer);
    }, [load, active]);

    // The workflows of the branch of the worktree: its workflow files can differ from the default branch. A branch
    // that is not on GitHub yet has no files there, so then the workflows of the default branch show.
    useEffect(() => {
        if (!showWorkflows || workflows) return;
        let current = true;
        (async () => {
            const list = await github.branches(root);
            const defaultBranch = list[0];
            let ref = branch && list.includes(branch) ? branch : defaultBranch;
            let found = ref ? await github.workflows(root, ref) : [];
            if (!found.some(item => item.dispatchable) && defaultBranch && ref !== defaultBranch) {
                ref = defaultBranch;
                found = await github.workflows(root, ref);
            }
            if (!current) return;
            setWorkflowRef(ref);
            setBranches(ref ? [ref, ...list.filter(item => item !== ref)] : list);
            setWorkflows(found);
        })().catch(err => current && setError(errorText(err)));
        return () => {
            current = false;
        };
    }, [showWorkflows, workflows, root, branch]);

    const startRun = (workflow: Workflow) => setRunning(workflow);


    return (
        <div className="pipelines-panel">
            <div className="pp-header">
                <span className="pp-title">Newest runs</span>
                <span className="header-spacer" />
                <button className={`button pp-run-button${showWorkflows ? ' on' : ''}`} title="Run a workflow" onClick={() => setShowWorkflows(value => !value)}>
                    <Play size={13} strokeWidth={1.8} /><span className="pp-run-label">Run</span>
                </button>
                <button className="icon-button" title="Refresh" onClick={() => void load()}>
                    <RefreshCw size={14} strokeWidth={1.6} className={loading ? 'spin' : ''} />
                </button>
            </div>

            {showWorkflows && (
                <div className="pp-workflows">
                    {!workflows && !error && <div className="panel-note pp-note"><LoaderCircle size={12} className="spin" /> Loading the workflows…</div>}
                    {workflows && workflowRef && workflowRef !== branch && workflows.some(item => item.dispatchable) && (
                        <div className="panel-note pp-note">The workflows of {workflowRef}. {branch ? `${branch} is not on GitHub, or it has no workflow to start.` : ''}</div>
                    )}
                    {workflows?.filter(item => item.dispatchable).length === 0 && (
                        <div className="panel-note pp-note">No workflow of this branch can start by hand. A workflow needs a <code>workflow_dispatch</code> trigger.</div>
                    )}
                    {workflows?.filter(item => item.dispatchable).map(workflow => (
                        <button key={workflow.id} className="pp-workflow" title={workflow.path} onClick={() => startRun(workflow)}>
                            <Play size={12} strokeWidth={1.8} />
                            <span className="pp-workflow-name">{workflow.name}</span>
                            <span className="pp-workflow-path">{workflow.path.replace('.github/workflows/', '')}</span>
                        </button>
                    ))}
                </div>
            )}

            {error && <div className="form-error pp-error">{error}</div>}
            <div className="pp-runs">
                {!runs && !error && <div className="panel-message"><LoaderCircle size={14} className="spin" /> Loading the runs…</div>}
                {runs?.length === 0 && <div className="panel-note pp-note">The repository has no workflow runs.</div>}
                {runs?.map(run => (
                    <RunRow key={run.id} root={root} run={run} ownBranch={!!branch && run.branch === branch} onOpenLog={onOpenLog} onChanged={() => void load()} />
                ))}
            </div>

            {running && (
                <RunDialog
                    repo={root}
                    workflow={running}
                    branches={branches}
                    onClose={() => setRunning(undefined)}
                    onStarted={() => {
                        setRunning(undefined);
                        setShowWorkflows(false);
                        // GitHub needs a moment before the new run is in the list.
                        setTimeout(() => void load(), 2500);
                    }}
                />
            )}
        </div>
    );
}
