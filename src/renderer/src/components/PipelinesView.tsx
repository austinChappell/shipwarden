import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ExternalLink, LoaderCircle, Play, RefreshCw, RotateCw, Square, Workflow as WorkflowIcon, X } from 'lucide-react';
import type { CheckConclusion, CheckRun, CheckStatus, GitHubRepoInfo, RepoRef, RepoTarget, Workflow } from '@shared/github';
import { dispatchInputs, runIsActive, type WorkflowInput, type WorkflowRun } from '@shared/pipelines';
import { errorText, formatDuration, timeAgo } from '../util';
import { CheckIcon } from './ChecksPanel';
import { Combobox, sortedGroups } from './Combobox';
import { LogView } from './LogView';
import { ResizeHandle, usePanelWidth } from './ResizeHandle';
import { confirmDialog } from './ConfirmDialog';
import { openLink } from '../links';
import { cacheKey, cached, remember } from '../data-cache';

const github = window.shipwarden.github;
const REPO_KEY = 'shipwarden.pipelinesRepo';
/** The runs refresh at this interval while a run waits or runs, else at the slow interval. */
const ACTIVE_POLL_MS = 8_000;
const IDLE_POLL_MS = 60_000;

/** The cache keys. The view shows cached data immediately and loads new data in the background. */
const reposKey = (githubKey: string) => cacheKey('pipelines.repos', githubKey);
const branchesKey = (repo: string) => cacheKey('pipelines.branches', repo);
const workflowsKey = (repo: string) => cacheKey('pipelines.workflows', repo);
const runsKey = (repo: string, workflowId: number | undefined) => cacheKey('pipelines.runs', repo, workflowId);
const jobsKey = (repo: string, runId: number) => cacheKey('pipelines.jobs', repo, runId);

interface Props {
    /** A key for the GitHub providers of Settings › Code review. Undefined: not loaded yet. Null: no GitHub provider is on. */
    githubKey: string | null | undefined;
    onOpenSettings(): void;
}

function readRepo(): string | undefined {
    try {
        return localStorage.getItem(REPO_KEY) ?? undefined;
    } catch {
        return undefined;
    }
}

function writeRepo(value: string): void {
    try {
        localStorage.setItem(REPO_KEY, value);
    } catch {
        // The choice stays for this session only.
    }
}

export function RunIcon({ run }: { run: WorkflowRun }) {
    const status = (run.status === 'completed' ? 'completed' : run.status === 'in_progress' ? 'in_progress' : 'queued') as CheckStatus;
    return <CheckIcon check={{ status, conclusion: run.conclusion as CheckConclusion }} />;
}

/** The value field of one workflow input: a switch, a choice, or text. */
function InputField({ input, value, onChange }: { input: WorkflowInput; value: string; onChange(value: string): void }) {
    if (input.type === 'boolean') {
        return (
            <label className="switch">
                <input type="checkbox" checked={value === 'true'} onChange={event => onChange(String(event.target.checked))} />
                <span />
            </label>
        );
    }
    if (input.type === 'choice' && input.options?.length) {
        return (
            <select className="settings-input" value={value} onChange={event => onChange(event.target.value)}>
                {!input.required && <option value="">—</option>}
                {input.options.map(option => <option key={option} value={option}>{option}</option>)}
            </select>
        );
    }
    return (
        <input
            className="settings-input"
            type={input.type === 'number' ? 'number' : 'text'}
            value={value}
            spellCheck={false}
            onChange={event => onChange(event.target.value)}
        />
    );
}

interface RunDialogProps {
    /** The repository: a worktree path, or the owner and name. */
    repo: RepoTarget;
    workflow: Workflow;
    branches: string[] | undefined;
    onClose(): void;
    onStarted(): void;
}

/**
 * The dialog that starts a workflow: the branch and the inputs of its `workflow_dispatch` trigger.
 * Each branch can have another version of the workflow file, so the inputs load again for another branch.
 */
export function RunDialog({ repo, workflow, branches, onClose, onStarted }: RunDialogProps) {
    const [branch, setBranch] = useState(branches?.[0] ?? '');
    const [inputs, setInputs] = useState<WorkflowInput[] | undefined>(workflow.inputs);
    const [values, setValues] = useState<Record<string, string>>({});
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();

    useEffect(() => {
        if (!branch || branch === branches?.[0]) {
            setInputs(workflow.inputs);
            return;
        }
        let current = true;
        setInputs(undefined);
        github.workflows(repo, branch).then(list => {
            if (!current) return;
            const found = list.find(item => item.id === workflow.id);
            if (!found?.dispatchable) {
                setError(`The workflow on "${branch}" cannot start by hand: it has no workflow_dispatch trigger.`);
                setInputs([]);
            } else {
                setError(undefined);
                setInputs(found.inputs);
            }
        }, err => current && setError(errorText(err)));
        return () => {
            current = false;
        };
    }, [branch]);

    const value = (input: WorkflowInput) => values[input.name] ?? input.default ?? (input.type === 'choice' && input.required ? input.options?.[0] ?? '' : '');
    const run = async () => {
        if (!inputs) return;
        const prepared = dispatchInputs(inputs, Object.fromEntries(inputs.map(input => [input.name, value(input)])));
        if ('error' in prepared) {
            setError(prepared.error);
            return;
        }
        setBusy(true);
        setError(undefined);
        try {
            await github.dispatchWorkflow(repo, workflow.id, branch, prepared.inputs);
            onStarted();
        } catch (err) {
            setError(errorText(err));
            setBusy(false);
        }
    };

    return (
        <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}>
            <div className="modal run-dialog" role="dialog" aria-label={`Run ${workflow.name}`} onKeyDown={event => event.key === 'Escape' && onClose()}>
                <header className="modal-header">
                    <Play size={15} strokeWidth={1.8} />
                    <h2>Run {workflow.name}</h2>
                    <span className="header-spacer" />
                    <button className="icon-button" title="Close" onClick={onClose}><X size={15} strokeWidth={1.8} /></button>
                </header>
                <div className="modal-body">
                    <label className="run-field">
                        <span className="setting-label">Branch</span>
                        <Combobox
                            value={branch}
                            groups={[{ label: '', items: (branches ?? []).map(name => ({ value: name, label: name })) }]}
                            placeholder={branches ? 'Select a branch' : 'Loading branches…'}
                            searchPlaceholder="Search branches"
                            disabled={!branches}
                            onChange={setBranch}
                        />
                    </label>
                    {!inputs && <div className="panel-note"><LoaderCircle size={12} className="spin" /> Loading the inputs of the workflow on this branch…</div>}
                    {inputs?.map(input => (
                        <label key={input.name} className="run-field">
                            <span className="setting-label">{input.name}{input.required ? ' *' : ''}</span>
                            {input.description && <span className="panel-note">{input.description}</span>}
                            <InputField input={input} value={value(input)} onChange={next => setValues(map => ({ ...map, [input.name]: next }))} />
                        </label>
                    ))}
                    {inputs?.length === 0 && !error && <div className="panel-note">This workflow has no inputs.</div>}
                    {error && <div className="form-error">{error}</div>}
                </div>
                <footer className="modal-footer">
                    <span className="panel-note">GitHub starts the workflow on <code>{workflow.path}</code> of the branch.</span>
                    <button className="button" onClick={onClose}>Cancel</button>
                    <button className="button primary" disabled={busy || !inputs || !branch} onClick={() => void run()}>
                        {busy ? <LoaderCircle size={13} className="spin" /> : <Play size={13} strokeWidth={2} />} Run workflow
                    </button>
                </footer>
            </div>
        </div>
    );
}

/**
 * The Pipelines view: the workflows of a GitHub repository, their runs, the jobs and logs of a run, and a dialog
 * that starts a workflow with a `workflow_dispatch` trigger. Other providers (GitLab, Azure DevOps) can come later.
 */
export function PipelinesView({ githubKey, onOpenSettings }: Props) {
    const [repos, setRepos] = useState<GitHubRepoInfo[]>();
    const [repo, setRepo] = useState<string | undefined>(readRepo);
    const [workflows, setWorkflows] = useState<Workflow[]>();
    const [branches, setBranches] = useState<string[]>();
    const [workflowId, setWorkflowId] = useState<number>();
    const [runs, setRuns] = useState<WorkflowRun[]>();
    const [runId, setRunId] = useState<number>();
    const [jobs, setJobs] = useState<CheckRun[]>();
    const [job, setJob] = useState<CheckRun>();
    const [dialog, setDialog] = useState<Workflow>();
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string>();
    const [actionError, setActionError] = useState<string>();
    const workflowWidth = usePanelWidth('shipwarden.width.pipelineWorkflows', 230, 180, 400);
    const runsWidth = usePanelWidth('shipwarden.width.pipelineRuns', 380, 260, 640);

    const repoRef = useMemo<RepoRef | undefined>(() => {
        if (!repo) return undefined;
        const [owner, name] = repo.split('/');
        return { owner, name };
    }, [repo]);

    useEffect(() => {
        if (!githubKey) return;
        let current = true;
        setRepos(cached(reposKey(githubKey)));
        github.repositories().then(list => {
            if (!current) return;
            setRepos(remember(reposKey(githubKey), list));
            setRepo(value => (value && list.some(item => `${item.owner}/${item.name}` === value) ? value : list[0] && `${list[0].owner}/${list[0].name}`));
        }, err => current && setError(errorText(err)));
        return () => {
            current = false;
        };
    }, [githubKey]);

    // The workflows and branches of the repository. The workflows come from the default branch.
    useEffect(() => {
        if (!repoRef) return;
        let current = true;
        const id = `${repoRef.owner}/${repoRef.name}`;
        setWorkflows(cached(workflowsKey(id)));
        setBranches(cached(branchesKey(id)));
        setWorkflowId(undefined);
        setRunId(undefined);
        setError(undefined);
        github.branches(repoRef).then(async list => {
            if (!current) return;
            setBranches(remember(branchesKey(id), list));
            const found = await github.workflows(repoRef, list[0]);
            if (current) setWorkflows(remember(workflowsKey(id), found.sort((a, b) => a.name.localeCompare(b.name))));
        }).catch(err => current && setError(errorText(err)));
        return () => {
            current = false;
        };
    }, [repoRef]);

    const request = useRef(0);
    const loadRuns = useCallback(async () => {
        if (!repoRef) return;
        const id = ++request.current;
        setLoading(true);
        try {
            const list = await github.workflowRuns(repoRef, workflowId);
            if (id === request.current) setRuns(remember(runsKey(`${repoRef.owner}/${repoRef.name}`, workflowId), list));
        } catch (err) {
            if (id === request.current) setError(errorText(err));
        } finally {
            if (id === request.current) setLoading(false);
        }
    }, [repoRef, workflowId]);

    // The runs show their cached list immediately, and load the new list in the background.
    useEffect(() => {
        setRuns(repoRef ? cached(runsKey(`${repoRef.owner}/${repoRef.name}`, workflowId)) : undefined);
        void loadRuns();
    }, [loadRuns]);

    const selectedRun = runs?.find(item => item.id === runId);
    const active = !!runs?.some(runIsActive);
    useEffect(() => {
        const timer = setInterval(() => void loadRuns(), active ? ACTIVE_POLL_MS : IDLE_POLL_MS);
        return () => clearInterval(timer);
    }, [loadRuns, active]);

    // The jobs of the selected run. They load again when the run changes its status or time.
    const loadJobs = useCallback(async () => {
        if (!repoRef || !runId) return;
        try {
            setJobs(remember(jobsKey(`${repoRef.owner}/${repoRef.name}`, runId), await github.runJobs(repoRef, runId)));
        } catch (err) {
            setActionError(errorText(err));
        }
    }, [repoRef, runId]);
    useEffect(() => {
        setJobs(repoRef && runId ? cached(jobsKey(`${repoRef.owner}/${repoRef.name}`, runId)) : undefined);
        setJob(undefined);
        setActionError(undefined);
        void loadJobs();
    }, [loadJobs]);
    useEffect(() => {
        if (selectedRun) void loadJobs();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedRun?.status, selectedRun?.updatedAt]);

    const act = async (label: string, action: () => Promise<void>) => {
        if (!(await confirmDialog({ title: label }))) return;
        setActionError(undefined);
        try {
            await action();
            setTimeout(() => void loadRuns(), 1500);
        } catch (err) {
            setActionError(errorText(err));
        }
    };

    if (githubKey === undefined) {
        return <div className="pipelines-view" />;
    }
    if (githubKey === null) {
        return (
            <div className="pipelines-view">
                <div className="review-empty">
                    <WorkflowIcon size={30} strokeWidth={1.3} />
                    <h2>Pipelines</h2>
                    <p>Add a GitHub provider to see the workflows of its repositories. The Review view uses the same providers.</p>
                    <button className="button primary" onClick={onOpenSettings}>Open Settings › Code review</button>
                </div>
            </div>
        );
    }

    const groups = sortedGroups(repos ?? [], item => item.owner, item => ({ value: `${item.owner}/${item.name}`, label: item.name }));
    const workflowName = (id: number) => workflows?.find(item => item.id === id)?.name;
    const style = { '--pipeline-workflows-width': `${workflowWidth.width}px`, '--pipeline-runs-width': `${runsWidth.width}px` } as CSSProperties;

    return (
        <div className="pipelines-view">
            <header className="tasks-header">
                <div className="tasks-header-group where">
                    <Combobox
                        className="review-repo-select"
                        value={repo}
                        groups={groups}
                        placeholder={!repos ? 'Loading repositories…' : 'Select a repository'}
                        searchPlaceholder="Search repositories"
                        disabled={!repos?.length}
                        title="Repository"
                        onChange={value => {
                            setRepo(value);
                            writeRepo(value);
                        }}
                    />
                </div>
                <div className="tasks-header-group how">
                    <span className="header-spacer" />
                    {repoRef && (
                        <button className="icon-button" title="Open the Actions of the repository on GitHub" onClick={event => openLink(`https://github.com/${repoRef.owner}/${repoRef.name}/actions`, event)}>
                            <ExternalLink size={15} strokeWidth={1.6} />
                        </button>
                    )}
                    <button className="icon-button" title="Refresh" onClick={() => void loadRuns()}>
                        <RefreshCw size={15} strokeWidth={1.6} className={loading ? 'spin' : ''} />
                    </button>
                </div>
            </header>
            {error && <div className="form-error task-list-error">{error}</div>}

            <div className="pipelines-body" style={style}>
                <nav className="pipeline-workflows">
                    <div className="section-title">Workflows</div>
                    <button className={`pipeline-workflow${workflowId === undefined ? ' selected' : ''}`} onClick={() => setWorkflowId(undefined)}>
                        <span className="pipeline-workflow-name">All workflows</span>
                    </button>
                    {!workflows && !error && <div className="panel-note"><LoaderCircle size={12} className="spin" /> Loading…</div>}
                    {workflows?.length === 0 && <div className="panel-note">This repository has no workflows in .github/workflows.</div>}
                    {workflows?.map(workflow => (
                        <div key={workflow.id} className={`pipeline-workflow${workflowId === workflow.id ? ' selected' : ''}`} onClick={() => setWorkflowId(workflow.id)}>
                            <span className="pipeline-workflow-name" title={workflow.path}>{workflow.name}</span>
                            {workflow.dispatchable && (
                                <button
                                    className="icon-button pipeline-run-button"
                                    title={`Run ${workflow.name}`}
                                    onClick={event => {
                                        event.stopPropagation();
                                        setDialog(workflow);
                                    }}
                                >
                                    <Play size={13} strokeWidth={1.9} />
                                </button>
                            )}
                        </div>
                    ))}
                </nav>
                <ResizeHandle panel={workflowWidth} edge="right" label="Resize the workflow list" />

                <div className="pipeline-runs">
                    {(() => {
                        const selectedWorkflow = workflows?.find(item => item.id === workflowId);
                        return selectedWorkflow?.dispatchable ? (
                            <div className="pipeline-runs-header">
                                <span className="pipeline-runs-title">{selectedWorkflow.name}</span>
                                <button className="button primary" onClick={() => setDialog(selectedWorkflow)}><Play size={13} strokeWidth={2} /> Run workflow</button>
                            </div>
                        ) : null;
                    })()}
                    {!runs && !error && <div className="panel-message">Loading runs…</div>}
                    {runs?.length === 0 && <div className="panel-message">No runs.</div>}
                    {runs?.map(item => (
                        <button key={item.id} className={`pipeline-run${item.id === runId ? ' selected' : ''}`} onClick={() => setRunId(item.id)}>
                            <RunIcon run={item} />
                            <span className="pipeline-run-main">
                                <span className="pipeline-run-title">{item.title}</span>
                                <span className="pipeline-run-meta">
                                    {workflowName(item.workflowId) ?? item.workflowName} #{item.runNumber}
                                    {item.branch && <> · <code>{item.branch}</code></>} · {item.event} · {timeAgo(item.createdAt)}
                                    {item.status === 'completed' && item.startedAt && <> · {formatDuration(item.startedAt, item.updatedAt)}</>}
                                </span>
                            </span>
                        </button>
                    ))}
                </div>
                <ResizeHandle panel={runsWidth} edge="right" label="Resize the run list" />

                <div className="pipeline-detail">
                    {!selectedRun && <div className="panel-message">Select a run to see its jobs and logs.</div>}
                    {selectedRun && repoRef && (
                        <>
                            <div className="pipeline-detail-header">
                                <div className="pipeline-detail-title">
                                    <RunIcon run={selectedRun} />
                                    <span>{selectedRun.title}</span>
                                </div>
                                <div className="pipeline-detail-meta">
                                    {selectedRun.workflowName} #{selectedRun.runNumber} · {selectedRun.status === 'completed' ? selectedRun.conclusion : selectedRun.status.replace('_', ' ')}
                                    {selectedRun.actor && <> · {selectedRun.actor}</>} · <code>{selectedRun.headSha.slice(0, 7)}</code>
                                </div>
                                <div className="row-buttons pipeline-actions">
                                    {runIsActive(selectedRun) && (
                                        <button className="button" onClick={() => void act(`Cancel run #${selectedRun.runNumber} of ${selectedRun.workflowName}?`, () => github.cancelRun(repoRef, selectedRun.id))}>
                                            <Square size={12} strokeWidth={2} /> Cancel run
                                        </button>
                                    )}
                                    {!runIsActive(selectedRun) && selectedRun.conclusion === 'failure' && (
                                        <button className="button" onClick={() => void act(`Run the failed jobs of run #${selectedRun.runNumber} again?`, () => github.rerunFailedJobs(repoRef, selectedRun.id))}>
                                            <RotateCw size={12} strokeWidth={2} /> Re-run failed jobs
                                        </button>
                                    )}
                                    {!runIsActive(selectedRun) && (
                                        <button className="button" onClick={() => void act(`Run all jobs of run #${selectedRun.runNumber} again?`, () => github.rerunRun(repoRef, selectedRun.id))}>
                                            <RotateCw size={12} strokeWidth={2} /> Re-run all jobs
                                        </button>
                                    )}
                                    <button className="button" onClick={event => openLink(selectedRun.url, event)}><ExternalLink size={12} strokeWidth={2} /> GitHub</button>
                                </div>
                                {actionError && <div className="form-error">{actionError}</div>}
                            </div>
                            <div className="pipeline-jobs">
                                {!jobs && <div className="panel-note"><LoaderCircle size={12} className="spin" /> Loading jobs…</div>}
                                {jobs?.length === 0 && <div className="panel-note">No jobs yet.</div>}
                                {jobs?.map(item => (
                                    <button key={item.id} className={`check-row clickable pipeline-job${item.id === job?.id ? ' selected' : ''}`} onClick={() => setJob(item)}>
                                        <CheckIcon check={item} />
                                        <span className="check-name">{item.name}</span>
                                        <span className="check-duration">{formatDuration(item.startedAt, item.completedAt)}</span>
                                    </button>
                                ))}
                            </div>
                            <div className="pipeline-log">
                                {job
                                    ? <LogView key={job.id} target={repoRef} check={job} />
                                    : <div className="panel-message">Select a job to read its log.</div>}
                            </div>
                        </>
                    )}
                </div>
            </div>

            {dialog && repoRef && (
                <RunDialog
                    repo={repoRef}
                    workflow={dialog}
                    branches={branches}
                    onClose={() => setDialog(undefined)}
                    onStarted={() => {
                        setDialog(undefined);
                        setWorkflowId(dialog.id);
                        // GitHub makes the run some seconds after the dispatch.
                        setTimeout(() => void loadRuns(), 2500);
                        setTimeout(() => void loadRuns(), 7000);
                    }}
                />
            )}
        </div>
    );
}
