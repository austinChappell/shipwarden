import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, ExternalLink, LoaderCircle, Play, RefreshCw, RotateCw, Square } from 'lucide-react';
import type { CheckRun, Workflow } from '@shared/github';
import { runIsActive, type WorkflowRun } from '@shared/pipelines';
import { formatDuration, optionalErrorText, timeAgo } from '../util';
import { CheckIcon } from './ChecksPanel';
import { LogView } from './LogView';
import { Button, IconButton } from './ui';
import { confirmDialog } from './ConfirmDialog';
import { RunDialog, RunIcon } from './PipelinesView';
import { openLink } from '../links';
import { moveListFocus } from '../keyboard/list-nav';
import { branchesQuery, ciActions, runJobsQuery, useCiAction, workflowRunsQuery, workflowsQuery } from '../github/ci-queries';

/** The time between two reads of the runs and the jobs while a run or a job waits or runs. */
const POLL_ACTIVE_MS = 10_000;

interface Props {
    /** The worktree. Its repository gives the workflows and runs. */
    root: string;
    /** The branch of the worktree. Undefined for a detached HEAD. */
    branch: string | undefined;
    /** Sends the log of a job to the agent of the worktree. */
    onSendLogToAgent?(job: CheckRun): void;
}

/** One run: a row that opens its jobs, with Cancel or Run again, and a link to GitHub. */
function RunRow({
    root,
    run,
    ownBranch,
    onOpenLog
}: {
    root: string;
    run: WorkflowRun;
    /** True when the run is of the branch of the worktree. Its branch name shows as a tag. */
    ownBranch: boolean;
    onOpenLog(job: CheckRun): void;
}) {
    const [open, setOpen] = useState(false);
    const active = runIsActive(run);
    // The jobs load when the row opens.
    const jobsQuery = useQuery({ ...runJobsQuery(root, run.id, active, POLL_ACTIVE_MS), enabled: open });
    const jobs = jobsQuery.data;
    const action = useCiAction();
    const error = optionalErrorText(action.error ?? jobsQuery.error);

    const act = async (title: string, label: string, perform: () => Promise<void>) => {
        if (!(await confirmDialog({ title, confirmLabel: label }))) return;
        action.mutate(perform);
    };

    return (
        <div className={`pp-run${open ? ' open' : ''}`}>
            <div className="pp-run-head" onClick={() => setOpen(value => !value)} title={run.title}>
                <button className="row-toggle" data-nav-item aria-expanded={open}>
                    <ChevronRight size={12} strokeWidth={1.8} className={`group-chevron${open ? ' open' : ''}`} />
                    <RunIcon run={run} />
                    <span className="pp-run-main">
                        <span className="pp-run-title">{run.title}</span>
                        <span className="pp-run-meta">
                            {run.workflowName} #{run.runNumber}
                            {run.branch &&
                                (ownBranch ? (
                                    <>
                                        {' '}
                                        ·{' '}
                                        <span className="pp-own-branch" title="The branch of this worktree">
                                            {run.branch}
                                        </span>
                                    </>
                                ) : (
                                    ` · ${run.branch}`
                                ))}
                            {` · ${timeAgo(run.createdAt)}`}
                            {run.startedAt ? ` · ${formatDuration(run.startedAt, active ? null : run.updatedAt)}` : ''}
                        </span>
                    </span>
                </button>
                <span className="pp-run-actions" onClick={event => event.stopPropagation()}>
                    {active ? (
                        <IconButton
                            size="sm"
                            icon={<Square size={12} strokeWidth={2} />}
                            label="Cancel the run"
                            onClick={() => void act(`Cancel the run "${run.title}"?`, 'Cancel run', () => ciActions.cancelRun(root, run.id))}
                        />
                    ) : (
                        <IconButton
                            size="sm"
                            icon={<RotateCw size={13} strokeWidth={1.8} />}
                            label="Run all jobs again"
                            onClick={() => void act(`Run "${run.title}" again?`, 'Run again', () => ciActions.rerunRun(root, run.id))}
                        />
                    )}
                    <IconButton
                        size="sm"
                        icon={<ExternalLink size={13} strokeWidth={1.7} />}
                        label="Open on GitHub"
                        onClick={event => openLink(run.url, event)}
                    />
                </span>
            </div>
            {open && (
                <div className="pp-jobs">
                    {error && <div className="form-error">{error}</div>}
                    {!jobs && !error && (
                        <div className="panel-note pp-note">
                            <LoaderCircle size={12} className="spin" /> Loading the jobs…
                        </div>
                    )}
                    {jobs?.length === 0 && <div className="panel-note pp-note">The run has no jobs yet.</div>}
                    {jobs?.map(job => (
                        <button key={job.id} className="pp-job" data-nav-item title={`Open the log of ${job.name}`} onClick={() => onOpenLog(job)}>
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
export function PipelinesPanel({ root, branch, onSendLogToAgent }: Props) {
    /** The job whose log shows on top of the list. The list stays below it, so its open runs and scroll stay. */
    const [logJob, setLogJob] = useState<CheckRun>();
    // The newest state of the job, so that the log loads again when the job completes. The run row shares this cache.
    const logJobsQuery = useQuery({ ...runJobsQuery(root, logJob?.runId, false, POLL_ACTIVE_MS), enabled: !!logJob?.runId });
    const liveJob = logJob && (logJobsQuery.data?.find(job => job.id === logJob.id) ?? logJob);
    const [running, setRunning] = useState<Workflow>();
    const [showWorkflows, setShowWorkflows] = useState(false);
    const runsQuery = useQuery(workflowRunsQuery(root, undefined, POLL_ACTIVE_MS));
    const runs = runsQuery.data;

    // The workflows of the branch of the worktree: its workflow files can differ from the default branch. A branch
    // that is not on GitHub yet has no files there, so then the workflows of the default branch show.
    // The workflows load when the user opens the list for the first time.
    const branchesResult = useQuery({ ...branchesQuery(root), enabled: showWorkflows });
    const list = branchesResult.data;
    const defaultBranch = list?.[0];
    const ownRef = list && (branch && list.includes(branch) ? branch : defaultBranch);
    const ownResult = useQuery({ ...workflowsQuery(root, ownRef), enabled: showWorkflows && !!ownRef });
    const useDefault = !!ownResult.data && !ownResult.data.some(item => item.dispatchable) && !!defaultBranch && ownRef !== defaultBranch;
    const defaultResult = useQuery({ ...workflowsQuery(root, defaultBranch), enabled: showWorkflows && useDefault });
    /** The branch that the workflow list (and the inputs) came from. The Run dialog starts on it. */
    const workflowRef = useDefault ? defaultBranch : ownRef;
    const workflows: Workflow[] | undefined = list && !ownRef ? [] : useDefault ? defaultResult.data : ownResult.data;
    const branches = list && (workflowRef ? [workflowRef, ...list.filter(item => item !== workflowRef)] : list);
    const error = optionalErrorText(runsQuery.error ?? branchesResult.error ?? ownResult.error ?? defaultResult.error);

    const startRun = (workflow: Workflow) => setRunning(workflow);

    return (
        <div className="pipelines-panel">
            <div className="pp-header">
                <span className="pp-title">Newest runs</span>
                <span className="header-spacer" />
                <Button
                    size="sm"
                    active={showWorkflows}
                    icon={<Play size={13} strokeWidth={1.8} />}
                    title="Run a workflow"
                    aria-expanded={showWorkflows}
                    onClick={() => setShowWorkflows(value => !value)}
                >
                    <span className="pp-run-label">Run</span>
                </Button>
                <IconButton
                    size="sm"
                    icon={<RefreshCw size={14} strokeWidth={1.6} className={runsQuery.isFetching ? 'spin' : ''} />}
                    label="Refresh"
                    onClick={() => void runsQuery.refetch()}
                />
            </div>

            {showWorkflows && (
                <div className="pp-workflows">
                    {!workflows && !error && (
                        <div className="panel-note pp-note">
                            <LoaderCircle size={12} className="spin" /> Loading the workflows…
                        </div>
                    )}
                    {workflows && workflowRef && workflowRef !== branch && workflows.some(item => item.dispatchable) && (
                        <div className="panel-note pp-note">
                            The workflows of {workflowRef}. {branch ? `${branch} is not on GitHub, or it has no workflow to start.` : ''}
                        </div>
                    )}
                    {workflows?.filter(item => item.dispatchable).length === 0 && (
                        <div className="panel-note pp-note">
                            No workflow of this branch can start by hand. A workflow needs a <code>workflow_dispatch</code> trigger.
                        </div>
                    )}
                    {workflows
                        ?.filter(item => item.dispatchable)
                        .map(workflow => (
                            <button key={workflow.id} className="pp-workflow" title={workflow.path} onClick={() => startRun(workflow)}>
                                <Play size={12} strokeWidth={1.8} />
                                <span className="pp-workflow-name">{workflow.name}</span>
                                <span className="pp-workflow-path">{workflow.path.replace('.github/workflows/', '')}</span>
                            </button>
                        ))}
                </div>
            )}

            {error && <div className="form-error pp-error">{error}</div>}
            <div className="pp-runs" onKeyDown={moveListFocus}>
                {!runs && !error && (
                    <div className="panel-message">
                        <LoaderCircle size={14} className="spin" /> Loading the runs…
                    </div>
                )}
                {runs?.length === 0 && <div className="panel-note pp-note">The repository has no workflow runs.</div>}
                {runs?.map(run => (
                    <RunRow key={run.id} root={root} run={run} ownBranch={!!branch && run.branch === branch} onOpenLog={setLogJob} />
                ))}
            </div>

            {liveJob && (
                <div className="pp-log">
                    <LogView key={liveJob.id} target={root} check={liveJob} onSendToAgent={onSendLogToAgent} onBack={() => setLogJob(undefined)} />
                </div>
            )}

            {running && (
                <RunDialog
                    repo={root}
                    workflow={running}
                    branches={branches}
                    onClose={() => setRunning(undefined)}
                    onStarted={() => {
                        setRunning(undefined);
                        setShowWorkflows(false);
                    }}
                />
            )}
        </div>
    );
}
