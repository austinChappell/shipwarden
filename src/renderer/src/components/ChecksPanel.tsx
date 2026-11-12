import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bot, CircleCheck, CircleDot, CircleMinus, CircleX, ExternalLink, LoaderCircle, Play, RefreshCw, RotateCw } from 'lucide-react';
import { hostLabel, summarizeChecks, type BranchStatus, type CheckRun, type RepoTarget } from '@shared/github';
import { formatDuration, optionalErrorText } from '../util';
import { confirmDialog } from './ConfirmDialog';
import { openLink } from '../links';
import { itemKeys, moveListFocus } from '../keyboard/list-nav';
import { LogView } from './LogView';
import { Button, IconButton } from './ui';
import { checksQuery, ciActions, isFailedConclusion, useCiAction, workflowsQuery } from '../github/ci-queries';

interface Props {
    target: RepoTarget;
    status: BranchStatus | null | undefined;
    /** Opens the log of a check outside the panel. Without it, the log shows in the panel, in place of the list. */
    onOpenLog?(check: CheckRun): void;
    /** Sends a failed log to the agent of the worktree. Without it (in the Review view), the button does not show. */
    onSendLogToAgent?(check: CheckRun): void;
}

/** The time between two loads of the checks while a check waits or runs. */
const POLL_PENDING_MS = 10_000;

export function CheckIcon({ check }: { check: Pick<CheckRun, 'status' | 'conclusion'> }) {
    const props = { size: 15, strokeWidth: 1.8 };
    if (check.status !== 'completed') {
        return check.status === 'in_progress' ? (
            <LoaderCircle {...props} className="check-icon running spin" />
        ) : (
            <CircleDot {...props} className="check-icon queued" />
        );
    }
    if (check.conclusion === 'success') return <CircleCheck {...props} className="check-icon success" />;
    if (isFailedConclusion(check.conclusion)) return <CircleX {...props} className="check-icon failure" />;
    return <CircleMinus {...props} className="check-icon skipped" />;
}

export function ChecksPanel({ target, status, onOpenLog, onSendLogToAgent }: Props) {
    const [showWorkflows, setShowWorkflows] = useState(false);
    /** The check whose log shows in the panel. Only without onOpenLog. */
    const [logCheck, setLogCheck] = useState<CheckRun>();
    const sha = status?.sha;
    const checksQueryResult = useQuery(checksQuery(target, sha, POLL_PENDING_MS));
    const checks = sha ? checksQueryResult.data : undefined;
    // The workflows load when the user opens the list for the first time.
    const workflowsQueryResult = useQuery({ ...workflowsQuery(target, status?.branch), enabled: showWorkflows && !!status });
    const workflows = status ? workflowsQueryResult.data : undefined;
    const action = useCiAction();
    const busy = action.isPending;
    const error = optionalErrorText(action.error ?? checksQueryResult.error ?? workflowsQueryResult.error);

    const run = async (confirmText: string, perform: () => Promise<void>) => {
        if (!(await confirmDialog({ title: confirmText }))) {
            return;
        }
        action.mutate(perform);
    };

    if (status === undefined) {
        return <div className="panel-message">Loading…</div>;
    }
    if (status === null) {
        return <div className="panel-message">This worktree has no GitHub or Azure Repos remote named "origin".</div>;
    }

    if (logCheck) {
        // The newest state of the check, so that the log loads again when the job completes.
        const live = checks?.find(check => check.isActions && check.id === logCheck.id) ?? logCheck;
        return (
            <div className="checks-log">
                <LogView key={live.id} target={target} check={live} onSendToAgent={onSendLogToAgent} onBack={() => setLogCheck(undefined)} />
            </div>
        );
    }

    const failedRuns = [
        ...new Set((checks ?? []).filter(check => check.isActions && check.runId && isFailedConclusion(check.conclusion)).map(check => check.runId!))
    ];
    const counts = {
        passed: checks?.filter(check => check.conclusion === 'success').length ?? 0,
        failed: checks?.filter(check => isFailedConclusion(check.conclusion)).length ?? 0,
        running: checks?.filter(check => check.status !== 'completed').length ?? 0
    };
    const summary = summarizeChecks(checks ?? []);

    return (
        <div className="checks-panel">
            <div className="checks-header">
                <div className={`checks-summary ${summary}`}>
                    {checks === undefined
                        ? 'Loading checks…'
                        : checks.length === 0
                          ? 'No checks for this commit.'
                          : [
                                counts.failed && `${counts.failed} failing`,
                                counts.running && `${counts.running} running`,
                                counts.passed && `${counts.passed} passing`
                            ]
                                .filter(Boolean)
                                .join(', ')}
                </div>
                <div className="checks-subtitle">
                    {status.pullRequest?.state === 'OPEN' ? `PR #${status.pullRequest.number} head` : status.branch} · <code>{status.sha.slice(0, 7)}</code>
                    <IconButton size="sm" icon={<RefreshCw size={14} strokeWidth={1.6} />} label="Refresh" onClick={() => void checksQueryResult.refetch()} />
                </div>
                <div className="row-buttons">
                    {failedRuns.length > 0 && (
                        <Button
                            size="sm"
                            icon={<RotateCw size={14} strokeWidth={1.8} />}
                            disabled={busy}
                            onClick={() =>
                                run(`Run the failed jobs again in ${failedRuns.length} workflow run(s)?`, async () => {
                                    for (const runId of failedRuns) {
                                        await ciActions.rerunFailedJobs(target, runId);
                                    }
                                })
                            }
                        >
                            Re-run failed
                        </Button>
                    )}
                    <Button
                        size="sm"
                        active={showWorkflows}
                        icon={<Play size={14} strokeWidth={1.8} />}
                        aria-expanded={showWorkflows}
                        onClick={() => setShowWorkflows(open => !open)}
                    >
                        Run workflow
                    </Button>
                </div>
                {showWorkflows && (
                    <div className="workflow-list">
                        {!workflows && <div className="panel-note">Loading workflows…</div>}
                        {workflows?.length === 0 && <div className="panel-note">This repository has no active workflows.</div>}
                        {workflows?.map(workflow => (
                            <button
                                key={workflow.id}
                                className="workflow-row"
                                disabled={!workflow.dispatchable || busy}
                                title={workflow.dispatchable ? `Run on ${status.branch}` : 'This workflow has no workflow_dispatch trigger.'}
                                onClick={() =>
                                    run(`Run the workflow "${workflow.name}" on ${status.branch}?`, () =>
                                        ciActions.dispatchWorkflow(target, workflow.id, status.branch)
                                    )
                                }
                            >
                                <Play size={13} strokeWidth={1.8} />
                                <span>{workflow.name}</span>
                                <span className="tree-detail">{workflow.path.replace('.github/workflows/', '')}</span>
                            </button>
                        ))}
                    </div>
                )}
                {error && <div className="form-error">{error}</div>}
            </div>

            <div className="checks-list" onKeyDown={moveListFocus}>
                {checks?.map(check => {
                    const failed = isFailedConclusion(check.conclusion);
                    const open = () => check.isActions && (onOpenLog ? onOpenLog(check) : setLogCheck(check));
                    return (
                        // biome-ignore lint/a11y/useAriaPropsSupportedByRole: the row has the aria-label only when it has the role "button".
                        <div
                            key={`${check.isStatus ? 's' : 'c'}${check.id}`}
                            className={`check-row${check.isActions ? ' clickable' : ''}`}
                            title={check.isActions ? 'Show the log' : check.name}
                            tabIndex={0}
                            role={check.isActions ? 'button' : undefined}
                            aria-label={check.isActions ? check.name : undefined}
                            data-nav-item
                            onClick={open}
                            onKeyDown={itemKeys(open)}
                        >
                            <CheckIcon check={check} />
                            <span className="check-name">{check.name}</span>
                            <span className="check-duration">{formatDuration(check.startedAt, check.completedAt)}</span>
                            <span className="check-actions">
                                {check.isActions && failed && onSendLogToAgent && (
                                    <IconButton
                                        size="sm"
                                        icon={<Bot size={14} strokeWidth={1.6} />}
                                        label="Send the log to the agent"
                                        onClick={event => {
                                            event.stopPropagation();
                                            onSendLogToAgent(check);
                                        }}
                                    />
                                )}
                                {check.isActions && check.status === 'completed' && (
                                    <IconButton
                                        size="sm"
                                        icon={<RotateCw size={14} strokeWidth={1.6} />}
                                        label="Run this job again"
                                        disabled={busy}
                                        onClick={event => {
                                            event.stopPropagation();
                                            run(`Run the job "${check.name}" again?`, () => ciActions.rerunJob(target, check.id, check.runId));
                                        }}
                                    />
                                )}
                                {check.url && (
                                    <IconButton
                                        size="sm"
                                        icon={<ExternalLink size={14} strokeWidth={1.6} />}
                                        label={`Open on ${hostLabel(status.host)}`}
                                        onClick={event => {
                                            event.stopPropagation();
                                            openLink(check.url!, event);
                                        }}
                                    />
                                )}
                            </span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
