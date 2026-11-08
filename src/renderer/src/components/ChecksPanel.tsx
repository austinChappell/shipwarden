import { useCallback, useEffect, useState } from 'react';
import { Bot, CircleCheck, CircleDot, CircleMinus, CircleX, ExternalLink, LoaderCircle, Play, RefreshCw, RotateCw } from 'lucide-react';
import { summarizeChecks, type BranchStatus, type CheckRun, type RepoTarget, type Workflow } from '@shared/github';
import { errorText, formatDuration } from '../util';
import { confirmDialog } from './ConfirmDialog';

interface Props {
    target: RepoTarget;
    status: BranchStatus | null | undefined;
    onOpenLog(check: CheckRun): void;
    /** Sends a failed log to the agent of the worktree. Without it (in the Review view), the button does not show. */
    onSendLogToAgent?(check: CheckRun): void;
}

const POLL_PENDING_MS = 10_000;
const POLL_IDLE_MS = 60_000;
const FAILED = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'error']);

export function CheckIcon({ check }: { check: Pick<CheckRun, 'status' | 'conclusion'> }) {
    const props = { size: 15, strokeWidth: 1.8 };
    if (check.status !== 'completed') {
        return check.status === 'in_progress' ? <LoaderCircle {...props} className="check-icon running spin" /> : <CircleDot {...props} className="check-icon queued" />;
    }
    if (check.conclusion === 'success') return <CircleCheck {...props} className="check-icon success" />;
    if (FAILED.has(check.conclusion ?? '')) return <CircleX {...props} className="check-icon failure" />;
    return <CircleMinus {...props} className="check-icon skipped" />;
}

export function ChecksPanel({ target, status, onOpenLog, onSendLogToAgent }: Props) {
    const [checks, setChecks] = useState<CheckRun[]>();
    const [workflows, setWorkflows] = useState<Workflow[]>();
    const [showWorkflows, setShowWorkflows] = useState(false);
    const [error, setError] = useState<string>();
    const [busy, setBusy] = useState(false);
    const sha = status?.sha;

    const load = useCallback(async () => {
        if (!sha) {
            return;
        }
        try {
            setChecks(await window.shipwarden.github.checks(target, sha));
            setError(undefined);
        } catch (err) {
            setError(errorText(err));
        }
    }, [target, sha]);

    useEffect(() => {
        setChecks(undefined);
        load();
    }, [load]);

    // Poll often while checks run, and seldom when all checks are done.
    const pending = checks?.some(check => check.status !== 'completed') ?? false;
    useEffect(() => {
        const timer = setInterval(load, pending ? POLL_PENDING_MS : POLL_IDLE_MS);
        return () => clearInterval(timer);
    }, [load, pending]);

    const run = async (confirmText: string, action: () => Promise<void>) => {
        if (!(await confirmDialog({ title: confirmText }))) {
            return;
        }
        setBusy(true);
        setError(undefined);
        try {
            await action();
            setTimeout(load, 2000);
        } catch (err) {
            setError(errorText(err));
        } finally {
            setBusy(false);
        }
    };

    const toggleWorkflows = async () => {
        setShowWorkflows(open => !open);
        if (!workflows && status) {
            try {
                setWorkflows(await window.shipwarden.github.workflows(target, status.branch));
            } catch (err) {
                setError(errorText(err));
            }
        }
    };

    if (status === undefined) {
        return <div className="panel-message">Loading…</div>;
    }
    if (status === null) {
        return <div className="panel-message">This worktree has no GitHub remote named "origin".</div>;
    }

    const failedRuns = [...new Set((checks ?? []).filter(check => check.isActions && check.runId && FAILED.has(check.conclusion ?? '')).map(check => check.runId!))];
    const counts = {
        passed: checks?.filter(check => check.conclusion === 'success').length ?? 0,
        failed: checks?.filter(check => FAILED.has(check.conclusion ?? '')).length ?? 0,
        running: checks?.filter(check => check.status !== 'completed').length ?? 0
    };
    const summary = summarizeChecks(checks ?? []);

    return (
        <div className="checks-panel">
            <div className="checks-header">
                <div className={`checks-summary ${summary}`}>
                    {checks === undefined ? 'Loading checks…' : checks.length === 0 ? 'No checks for this commit.' :
                        [counts.failed && `${counts.failed} failing`, counts.running && `${counts.running} running`, counts.passed && `${counts.passed} passing`].filter(Boolean).join(', ')}
                </div>
                <div className="checks-subtitle">
                    {status.pullRequest?.state === 'OPEN' ? `PR #${status.pullRequest.number} head` : status.branch} · <code>{status.sha.slice(0, 7)}</code>
                    <button className="icon-button" title="Refresh" onClick={load}><RefreshCw size={14} strokeWidth={1.6} /></button>
                </div>
                <div className="row-buttons">
                    {failedRuns.length > 0 && (
                        <button
                            className="button"
                            disabled={busy}
                            onClick={() => run(`Run the failed jobs again in ${failedRuns.length} workflow run(s)?`, async () => {
                                for (const runId of failedRuns) {
                                    await window.shipwarden.github.rerunFailedJobs(target, runId);
                                }
                            })}
                        >
                            <RotateCw size={14} strokeWidth={1.8} />Re-run failed
                        </button>
                    )}
                    <button className="button" onClick={toggleWorkflows}><Play size={14} strokeWidth={1.8} />Run workflow</button>
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
                                onClick={() => run(`Run the workflow "${workflow.name}" on ${status.branch}?`, () => window.shipwarden.github.dispatchWorkflow(target, workflow.id, status.branch))}
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

            <div className="checks-list">
                {checks?.map(check => {
                    const failed = FAILED.has(check.conclusion ?? '');
                    return (
                        <div
                            key={`${check.isStatus ? 's' : 'c'}${check.id}`}
                            className={`check-row${check.isActions ? ' clickable' : ''}`}
                            title={check.isActions ? 'Show the log' : check.name}
                            onClick={() => check.isActions && onOpenLog(check)}
                        >
                            <CheckIcon check={check} />
                            <span className="check-name">{check.name}</span>
                            <span className="check-duration">{formatDuration(check.startedAt, check.completedAt)}</span>
                            <span className="check-actions">
                                {check.isActions && failed && onSendLogToAgent && (
                                    <button className="icon-button" title="Send the log to the agent" onClick={event => { event.stopPropagation(); onSendLogToAgent(check); }}>
                                        <Bot size={14} strokeWidth={1.6} />
                                    </button>
                                )}
                                {check.isActions && check.status === 'completed' && (
                                    <button
                                        className="icon-button"
                                        title="Run this job again"
                                        disabled={busy}
                                        onClick={event => { event.stopPropagation(); run(`Run the job "${check.name}" again?`, () => window.shipwarden.github.rerunJob(target, check.id)); }}
                                    >
                                        <RotateCw size={14} strokeWidth={1.6} />
                                    </button>
                                )}
                                {check.url && (
                                    <button className="icon-button" title="Open on GitHub" onClick={event => { event.stopPropagation(); window.shipwarden.github.openInBrowser(check.url!); }}>
                                        <ExternalLink size={14} strokeWidth={1.6} />
                                    </button>
                                )}
                            </span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
