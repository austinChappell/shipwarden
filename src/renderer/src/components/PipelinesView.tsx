import { useMemo, useRef, useState, type CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, ListTree, LoaderCircle, Play, RefreshCw, RotateCw, ScrollText, Square, Workflow as WorkflowIcon, X } from 'lucide-react';
import { EmptyState } from './EmptyState';
import {
    hostLabel,
    parseRepoId,
    pipelinesWebUrl,
    repoId,
    type CheckConclusion,
    type CheckRun,
    type CheckStatus,
    type RepoRef,
    type RepoTarget,
    type SourceHostKind,
    type Workflow
} from '@shared/github';
import type { NavQuery, ViewRoute } from '@shared/nav-history';
import { dispatchInputs, runIsActive, type WorkflowInput, type WorkflowRun } from '@shared/pipelines';
import { formatAgo } from '@shared/format';
import { formatDuration, optionalErrorText } from '../util';
import { CheckIcon } from './ChecksPanel';
import { LogView } from './LogView';
import { Age, Button, Chip, type ChipTone, Combobox, IconButton, Input, PageHeader, Select, SkeletonRows, Switch } from './ui';
import { ResizeHandle, usePanelWidth } from './ResizeHandle';
import { confirmDialog } from './ConfirmDialog';
import { useModal } from './use-modal';
import { openLink } from '../links';
import { moveListFocus } from '../keyboard/list-nav';
import { repoGroups } from '../github/repo-choices';
import { branchesQuery, ciActions, repositoriesQuery, runJobsQuery, sortWorkflows, useCiAction, workflowRunsQuery, workflowsQuery } from '../github/ci-queries';

const REPO_KEY = 'shipwarden.pipelinesRepo';
/** The runs and the jobs refresh at this interval while a run or a job waits or runs. */
const ACTIVE_POLL_MS = 8_000;

interface Props {
    /** A key for the providers of Settings › Code review. Undefined: not loaded yet. Null: no provider is on. */
    reviewKey: string | null | undefined;
    onOpenSettings(): void;
    /** The selections of the view in the query: `repo`, `workflow`, `run` and `job`. */
    route: ViewRoute;
    /** Changes the selections. The change replaces the current history entry. */
    onRoute(route: ViewRoute): void;
}

/** Reads an ID from the query. Undefined when the value is not a number. */
function queryId(value: string | undefined): number | undefined {
    const id = value ? Number(value) : Number.NaN;
    return Number.isFinite(id) ? id : undefined;
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

/** Returns the text and the chip tone of the state of a run. */
function runState(run: WorkflowRun): { text: string; tone: ChipTone } {
    if (run.status !== 'completed') return { text: run.status.replace('_', ' '), tone: run.status === 'in_progress' ? 'pending' : 'neutral' };
    switch (run.conclusion) {
        case 'success':
            return { text: 'success', tone: 'success' };
        case 'failure':
        case 'timed_out':
        case 'startup_failure':
        case 'error':
            return { text: run.conclusion.replace('_', ' '), tone: 'danger' };
        case 'action_required':
            return { text: 'action required', tone: 'warning' };
        default:
            return { text: run.conclusion?.replace('_', ' ') ?? 'completed', tone: 'neutral' };
    }
}

/** The value field of one workflow input: a switch, a choice, or text. */
function InputField({ input, value, onChange }: { input: WorkflowInput; value: string; onChange(value: string): void }) {
    if (input.type === 'boolean') {
        return <Switch title={input.name} checked={value === 'true'} onChange={checked => onChange(String(checked))} />;
    }
    if (input.type === 'choice' && input.options?.length) {
        return (
            <Select
                value={value}
                options={[...(input.required ? [] : [{ value: '', label: '—' }]), ...input.options.map(option => ({ value: option, label: option }))]}
                onChange={onChange}
            />
        );
    }
    return <Input type={input.type === 'number' ? 'number' : 'text'} value={value} spellCheck={false} onChange={event => onChange(event.target.value)} />;
}

interface RunDialogProps {
    /** The repository: a worktree path, or the owner and name. */
    repo: RepoTarget;
    /** The host of the repository. Undefined means GitHub. */
    host?: SourceHostKind;
    workflow: Workflow;
    branches: string[] | undefined;
    onClose(): void;
    onStarted(): void;
}

/**
 * The dialog that starts a workflow: the branch and the inputs of its `workflow_dispatch` trigger.
 * Each branch can have another version of the workflow file, so the inputs load again for another branch.
 */
export function RunDialog({ repo, host, workflow, branches, onClose, onStarted }: RunDialogProps) {
    const [branch, setBranch] = useState(branches?.[0] ?? '');
    const [values, setValues] = useState<Record<string, string>>({});
    /** The error of the form, for example a required input without a value. */
    const [formError, setFormError] = useState<string>();
    const dispatch = useCiAction();
    const dialog = useRef<HTMLDivElement>(null);
    useModal(dialog);

    // The workflow came from the first branch. The inputs of another branch load from that branch.
    const otherBranch = !!branch && branch !== branches?.[0];
    const branchQuery = useQuery({ ...workflowsQuery(repo, branch), enabled: otherBranch });
    const found = branchQuery.data?.find(item => item.id === workflow.id);
    const branchError =
        otherBranch && branchQuery.data && !found?.dispatchable
            ? host === 'azure'
                ? `The pipeline cannot start on "${branch}". It is possibly turned off.`
                : `The workflow on "${branch}" cannot start by hand: it has no workflow_dispatch trigger.`
            : undefined;
    const inputs: WorkflowInput[] | undefined = !otherBranch ? workflow.inputs : branchQuery.data ? (found?.dispatchable ? found.inputs : []) : undefined;
    const error = formError ?? optionalErrorText(dispatch.error) ?? branchError ?? (otherBranch ? optionalErrorText(branchQuery.error) : undefined);

    const value = (input: WorkflowInput) =>
        values[input.name] ?? input.default ?? (input.type === 'choice' && input.required ? (input.options?.[0] ?? '') : '');
    const run = () => {
        if (!inputs) return;
        const prepared = dispatchInputs(inputs, Object.fromEntries(inputs.map(input => [input.name, value(input)])));
        if ('error' in prepared) {
            setFormError(prepared.error);
            return;
        }
        setFormError(undefined);
        dispatch.mutate(() => ciActions.dispatchWorkflow(repo, workflow.id, branch, prepared.inputs), { onSuccess: onStarted });
    };

    return (
        <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}>
            <div
                ref={dialog}
                className="modal run-dialog"
                role="dialog"
                aria-modal="true"
                aria-label={`Run ${workflow.name}`}
                onKeyDown={event => event.key === 'Escape' && onClose()}
            >
                <header className="modal-header">
                    <Play size={15} strokeWidth={1.8} />
                    <h2>Run {workflow.name}</h2>
                    <span className="header-spacer" />
                    <IconButton icon={<X size={14} strokeWidth={1.8} />} label="Close" onClick={onClose} />
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
                            onChange={next => {
                                setBranch(next);
                                setFormError(undefined);
                                dispatch.reset();
                            }}
                        />
                    </label>
                    {!inputs && (
                        <div className="panel-note">
                            <LoaderCircle size={12} className="spin" /> Loading the inputs of the workflow on this branch…
                        </div>
                    )}
                    {inputs?.map(input => (
                        <label key={input.name} className="run-field">
                            <span className="setting-label">
                                {input.name}
                                {input.required ? ' *' : ''}
                            </span>
                            {input.description && <span className="panel-note">{input.description}</span>}
                            <InputField input={input} value={value(input)} onChange={next => setValues(map => ({ ...map, [input.name]: next }))} />
                        </label>
                    ))}
                    {inputs?.length === 0 && !error && <div className="panel-note">This workflow has no inputs.</div>}
                    {error && <div className="form-error">{error}</div>}
                </div>
                <footer className="modal-footer">
                    <span className="panel-note">
                        {host === 'azure' ? (
                            <>Azure DevOps queues a build of the pipeline on the branch.</>
                        ) : (
                            <>
                                GitHub starts the workflow on <code>{workflow.path}</code> of the branch.
                            </>
                        )}
                    </span>
                    <Button onClick={onClose}>Cancel</Button>
                    <Button
                        variant="primary"
                        icon={dispatch.isPending ? <LoaderCircle size={13} className="spin" /> : <Play size={13} strokeWidth={2} />}
                        disabled={dispatch.isPending || !inputs || !branch}
                        onClick={run}
                    >
                        Run workflow
                    </Button>
                </footer>
            </div>
        </div>
    );
}

/**
 * The Pipelines view: the workflows of a repository, their runs, the jobs and logs of a run, and a dialog that starts a
 * workflow. On GitHub, the workflows are GitHub Actions and a workflow starts by hand with a `workflow_dispatch` trigger.
 * On Azure DevOps, the workflows are the pipelines (build definitions) of the repository, and a run is one build.
 */
export function PipelinesView({ reviewKey, onOpenSettings, route, onRoute }: Props) {
    /** The repository that the user selected last. The view uses it when the query has no repository. */
    const [savedRepo] = useState<string | undefined>(readRepo);
    const query = route.query ?? {};
    const chosenRepo = query.repo ?? savedRepo;
    const workflowId = queryId(query.workflow);
    const runId = queryId(query.run);
    const jobId = queryId(query.job);
    const setQuery = (change: NavQuery) => onRoute({ query: { ...query, ...change } });
    const setWorkflowId = (id: number | undefined) => setQuery({ workflow: id?.toString() });
    const [dialog, setDialog] = useState<Workflow>();
    const workflowWidth = usePanelWidth('shipwarden.width.pipelineWorkflows', 230, 180, 400);
    const runsWidth = usePanelWidth('shipwarden.width.pipelineRuns', 380, 260, 640);

    const reposQuery = useQuery({ ...repositoriesQuery(reviewKey ?? null), enabled: !!reviewKey });
    const repos = reviewKey ? reposQuery.data : undefined;

    // The chosen repository, when the list has it. Else the first repository of the list.
    const repo = repos && !(chosenRepo && repos.some(item => repoId(item) === chosenRepo)) ? repos[0] && repoId(repos[0]) : chosenRepo;
    const repoRef = useMemo<RepoRef | undefined>(() => (repo ? parseRepoId(repo) : undefined), [repo]);
    const host = hostLabel(repoRef?.host);

    // The workflows and branches of the repository. The workflows come from the default branch.
    const branchesResult = useQuery(branchesQuery(repoRef));
    const branches = branchesResult.data;
    const workflowsResult = useQuery({
        ...workflowsQuery(repoRef, branches?.[0]),
        select: sortWorkflows
    });
    // A repository without branches has no workflow files.
    const workflows = branches?.length === 0 ? [] : workflowsResult.data;

    const runsQuery = useQuery(workflowRunsQuery(repoRef, workflowId, ACTIVE_POLL_MS));
    const runs = runsQuery.data;
    const selectedRun = runs?.find(item => item.id === runId);

    // The jobs of the selected run.
    const jobsQuery = useQuery(runJobsQuery(repoRef, runId, !!selectedRun && runIsActive(selectedRun), ACTIVE_POLL_MS));
    const jobs = runId === undefined ? undefined : jobsQuery.data;
    const job: CheckRun | undefined = jobs?.find(item => item.id === jobId);

    const action = useCiAction();
    const error = optionalErrorText(reposQuery.error ?? branchesResult.error ?? workflowsResult.error ?? runsQuery.error);
    const actionError = optionalErrorText(action.error ?? jobsQuery.error);

    const selectRun = (id: number | undefined) => {
        setQuery({ run: id?.toString(), job: undefined });
        action.reset();
    };
    const selectRepo = (value: string) => {
        writeRepo(value);
        onRoute({ query: { repo: value } });
        action.reset();
    };

    const act = async (label: string, perform: () => Promise<void>) => {
        if (!(await confirmDialog({ title: label }))) return;
        action.mutate(perform);
    };

    if (reviewKey === undefined) {
        return <div className="pipelines-view" />;
    }
    if (reviewKey === null) {
        return (
            <div className="pipelines-view">
                <EmptyState
                    icon={WorkflowIcon}
                    title="No code review account"
                    actions={
                        <Button variant="primary" onClick={onOpenSettings}>
                            Open Settings › Code review
                        </Button>
                    }
                >
                    Add a GitHub or Azure DevOps account to see the pipelines of its repositories. The Review view uses the same accounts.
                </EmptyState>
            </div>
        );
    }

    const groups = repoGroups(repos ?? []);
    const workflowName = (id: number) => workflows?.find(item => item.id === id)?.name;
    const style = { '--pipeline-workflows-width': `${workflowWidth.width}px`, '--pipeline-runs-width': `${runsWidth.width}px` } as CSSProperties;

    return (
        <div className="pipelines-view">
            <PageHeader
                icon={WorkflowIcon}
                title="Pipelines"
                meta={runsQuery.dataUpdatedAt ? `Updated ${formatAgo(new Date(runsQuery.dataUpdatedAt).toISOString())}` : undefined}
                scope={
                    <Combobox
                        className="pipelines-repo-select"
                        size="lg"
                        value={repo}
                        groups={groups}
                        placeholder={!repos ? 'Loading repositories…' : 'Select a repository'}
                        searchPlaceholder="Search repositories"
                        disabled={!repos?.length}
                        title="Repository"
                        onChange={selectRepo}
                    />
                }
                actions={
                    <>
                        {repoRef && (
                            <IconButton
                                size="lg"
                                icon={<ExternalLink size={16} strokeWidth={1.6} />}
                                label={
                                    repoRef.host === 'azure'
                                        ? 'Open the pipelines of the project on Azure DevOps'
                                        : 'Open the Actions of the repository on GitHub'
                                }
                                onClick={event => openLink(pipelinesWebUrl(repoRef), event)}
                            />
                        )}
                        <IconButton
                            size="lg"
                            icon={<RefreshCw size={16} strokeWidth={1.6} className={runsQuery.isFetching ? 'spin' : ''} />}
                            label="Refresh"
                            onClick={() => void runsQuery.refetch()}
                        />
                    </>
                }
            />
            {error && <div className="form-error task-list-error">{error}</div>}

            <div className="pipelines-body" style={style}>
                <nav className="pipeline-workflows" onKeyDown={moveListFocus}>
                    <div className="section-title">{repoRef?.host === 'azure' ? 'Pipelines' : 'Workflows'}</div>
                    <button
                        className={`pipeline-workflow${workflowId === undefined ? ' selected' : ''}`}
                        data-nav-item
                        aria-pressed={workflowId === undefined}
                        onClick={() => setWorkflowId(undefined)}
                    >
                        <span className="pipeline-workflow-name">{repoRef?.host === 'azure' ? 'All pipelines' : 'All workflows'}</span>
                    </button>
                    {!workflows && !error && (
                        <SkeletonRows count={4} dot={false} label={repoRef?.host === 'azure' ? 'Loading pipelines' : 'Loading workflows'} />
                    )}
                    {workflows?.length === 0 && (
                        <div className="panel-note">
                            {repoRef?.host === 'azure'
                                ? 'This repository has no pipelines.'
                                : 'This repository has no workflows. GitHub Actions runs the YAML files in .github/workflows when you push, and this view shows their runs.'}
                        </div>
                    )}
                    {workflows?.map(workflow => (
                        <div
                            key={workflow.id}
                            className={`pipeline-workflow${workflowId === workflow.id ? ' selected' : ''}`}
                            onClick={() => setWorkflowId(workflow.id)}
                        >
                            <button className="row-toggle" data-nav-item aria-pressed={workflowId === workflow.id}>
                                <span className="pipeline-workflow-name" title={workflow.path}>
                                    {workflow.name}
                                </span>
                            </button>
                            {workflow.dispatchable && (
                                <IconButton
                                    size="sm"
                                    icon={<Play size={13} strokeWidth={1.9} />}
                                    label={`Run ${workflow.name}`}
                                    onClick={event => {
                                        event.stopPropagation();
                                        setDialog(workflow);
                                    }}
                                />
                            )}
                        </div>
                    ))}
                </nav>
                <ResizeHandle panel={workflowWidth} edge="right" label="Resize the workflow list" />

                <div className="pipeline-runs" onKeyDown={moveListFocus}>
                    {(() => {
                        const selectedWorkflow = workflows?.find(item => item.id === workflowId);
                        return selectedWorkflow?.dispatchable ? (
                            <div className="pipeline-runs-header">
                                <span className="pipeline-runs-title">{selectedWorkflow.name}</span>
                                <Button variant="primary" icon={<Play size={13} strokeWidth={2} />} onClick={() => setDialog(selectedWorkflow)}>
                                    Run workflow
                                </Button>
                            </div>
                        ) : null;
                    })()}
                    {!runs && !error && <SkeletonRows label="Loading runs" />}
                    {runs?.length === 0 && <div className="panel-message">No runs.</div>}
                    {runs?.map(item => (
                        <button
                            key={item.id}
                            className={`pipeline-run${item.id === runId ? ' selected' : ''}`}
                            data-nav-item
                            aria-pressed={item.id === runId}
                            onClick={() => selectRun(item.id)}
                        >
                            <RunIcon run={item} />
                            <span className="pipeline-run-main">
                                <span className="pipeline-run-title">{item.title}</span>
                                <span className="pipeline-run-meta">
                                    {workflowName(item.workflowId) ?? item.workflowName} #{item.runNumber}
                                    {item.branch && (
                                        <>
                                            {' '}
                                            · <code>{item.branch}</code>
                                        </>
                                    )}{' '}
                                    · {item.event} · <Age date={item.createdAt} format="prose" />
                                    {item.status === 'completed' && item.startedAt && <> · {formatDuration(item.startedAt, item.updatedAt)}</>}
                                </span>
                            </span>
                        </button>
                    ))}
                </div>
                <ResizeHandle panel={runsWidth} edge="right" label="Resize the run list" />

                <div className="pipeline-detail">
                    {!selectedRun && (
                        <EmptyState icon={ListTree} title="No run selected">
                            Pick a run to see its jobs and logs.
                        </EmptyState>
                    )}
                    {selectedRun && repoRef && (
                        <>
                            <div className="pipeline-detail-header">
                                <div className="pipeline-detail-title">
                                    <RunIcon run={selectedRun} />
                                    <span>{selectedRun.title}</span>
                                    <Chip tone={runState(selectedRun).tone}>{runState(selectedRun).text}</Chip>
                                </div>
                                <div className="pipeline-detail-meta">
                                    {selectedRun.workflowName} #{selectedRun.runNumber}
                                    {selectedRun.actor && <> · {selectedRun.actor}</>} · <code>{selectedRun.headSha.slice(0, 7)}</code>
                                </div>
                                <div className="row-buttons pipeline-actions">
                                    {runIsActive(selectedRun) && (
                                        <Button
                                            variant="danger"
                                            icon={<Square size={12} strokeWidth={2} />}
                                            onClick={() =>
                                                void act(`Cancel run #${selectedRun.runNumber} of ${selectedRun.workflowName}?`, () =>
                                                    ciActions.cancelRun(repoRef, selectedRun.id)
                                                )
                                            }
                                        >
                                            Cancel run
                                        </Button>
                                    )}
                                    {!runIsActive(selectedRun) && selectedRun.conclusion === 'failure' && (
                                        <Button
                                            icon={<RotateCw size={12} strokeWidth={2} />}
                                            onClick={() =>
                                                void act(`Run the failed jobs of run #${selectedRun.runNumber} again?`, () =>
                                                    ciActions.rerunFailedJobs(repoRef, selectedRun.id)
                                                )
                                            }
                                        >
                                            Re-run failed jobs
                                        </Button>
                                    )}
                                    {!runIsActive(selectedRun) && (
                                        <Button
                                            icon={<RotateCw size={12} strokeWidth={2} />}
                                            onClick={() =>
                                                void act(`Run all jobs of run #${selectedRun.runNumber} again?`, () =>
                                                    ciActions.rerunRun(repoRef, selectedRun.id)
                                                )
                                            }
                                        >
                                            Re-run all jobs
                                        </Button>
                                    )}
                                    <Button icon={<ExternalLink size={12} strokeWidth={2} />} onClick={event => openLink(selectedRun.url, event)}>
                                        {host}
                                    </Button>
                                </div>
                                {actionError && <div className="form-error">{actionError}</div>}
                            </div>
                            <div className="pipeline-jobs" onKeyDown={moveListFocus}>
                                {!jobs && <SkeletonRows count={3} label="Loading jobs" />}
                                {jobs?.length === 0 && <div className="panel-note">No jobs yet.</div>}
                                {jobs?.map(item => (
                                    <button
                                        key={item.id}
                                        className={`check-row clickable pipeline-job${item.id === job?.id ? ' selected' : ''}`}
                                        data-nav-item
                                        aria-pressed={item.id === job?.id}
                                        onClick={() => setQuery({ job: item.id.toString() })}
                                    >
                                        <CheckIcon check={item} />
                                        <span className="check-name">{item.name}</span>
                                        <span className="check-duration">{formatDuration(item.startedAt, item.completedAt)}</span>
                                    </button>
                                ))}
                            </div>
                            <div className="pipeline-log">
                                {job ? (
                                    <LogView key={job.id} target={repoRef} check={job} />
                                ) : (
                                    <EmptyState icon={ScrollText} title="No job selected">
                                        Pick a job to read its log.
                                    </EmptyState>
                                )}
                            </div>
                        </>
                    )}
                </div>
            </div>

            {dialog && repoRef && (
                <RunDialog
                    repo={repoRef}
                    host={repoRef.host}
                    workflow={dialog}
                    branches={branches}
                    onClose={() => setDialog(undefined)}
                    onStarted={() => {
                        setDialog(undefined);
                        setWorkflowId(dialog.id);
                    }}
                />
            )}
        </div>
    );
}
