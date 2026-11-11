import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Bot, CircleCheck, CircleDashed, CircleMinus, CircleX, ExternalLink, LoaderCircle, RefreshCw, RotateCw } from 'lucide-react';
import type { CheckRun, JobProgress, JobStep, RepoTarget } from '@shared/github';
import { monaco } from '../editor/monaco';
import { errorText, formatDuration, optionalErrorText } from '../util';
import { confirmDialog } from './ConfirmDialog';
import { openLink } from '../links';
import { ciActions, ciKeys, isFailedConclusion, useCiAction } from '../github/ci-queries';
import { claimLogFind, isFindShortcut, type LogFindOwner, openLogFind, releaseLogFind } from './log-find';

interface Props {
    target: RepoTarget;
    check: CheckRun;
    /** Sends the log to the agent of the worktree. Without it (in the Review view), the button does not show. */
    onSendToAgent?(check: CheckRun): void;
    /** Closes the log. Without it, the header has no back button. */
    onBack?(): void;
}

let languageRegistered = false;

/** A small syntax for GitHub Actions logs: errors, warnings, groups and commands. The colors are in the "shipwarden" theme. */
function registerLogLanguage(): void {
    if (languageRegistered) {
        return;
    }
    languageRegistered = true;
    monaco.languages.register({ id: 'ci-log' });
    monaco.languages.setMonarchTokensProvider('ci-log', {
        tokenizer: {
            root: [
                [/^##\[error\].*$/, 'ci-error'],
                [/^.*\b(?:Error|ERROR|FAIL|Failed|failed)\b.*$/, 'ci-error'],
                [/^##\[warning\].*$/, 'ci-warning'],
                [/^##\[group\].*$/, 'ci-group'],
                [/^##\[endgroup\].*$/, 'ci-muted'],
                [/^\[command\].*$/, 'ci-command'],
                [/^Post job cleanup\..*$/, 'ci-muted']
            ]
        }
    });
}

/** The time between two reads of the steps of a running job. */
const STEP_POLL_MS = 5000;

function StepIcon({ step }: { step: Pick<JobStep, 'status' | 'conclusion'> }) {
    const props = { size: 14, strokeWidth: 1.8 };
    if (step.status === 'in_progress') return <LoaderCircle {...props} className="step-icon running spin" />;
    if (step.status !== 'completed') return <CircleDashed {...props} className="step-icon pending" />;
    if (step.conclusion === 'success') return <CircleCheck {...props} className="step-icon success" />;
    if (isFailedConclusion(step.conclusion)) return <CircleX {...props} className="step-icon failure" />;
    return <CircleMinus {...props} className="step-icon skipped" />;
}

/**
 * The steps of a running job, as GitHub reports them while the job runs. GitHub gives the log only when the job
 * completes, so this list stands in for the log until then.
 */
function JobSteps({ progress, error }: { progress: JobProgress | undefined; error?: string }) {
    // The time of the running step counts up each second.
    const [, setTick] = useState(0);
    const running = progress?.steps.some(step => step.status === 'in_progress');
    useEffect(() => {
        if (!running) return;
        const timer = setInterval(() => setTick(value => value + 1), 1000);
        return () => clearInterval(timer);
    }, [running]);

    const done = progress?.steps.filter(step => step.status === 'completed').length ?? 0;
    return (
        <div className="job-steps">
            <div className="job-steps-head">
                <span>Steps{progress && progress.steps.length > 0 ? ` · ${done} of ${progress.steps.length} done` : ''}</span>
                <span className="job-steps-note">Live. GitHub shows the full log when the job completes.</span>
            </div>
            {error && <div className="form-error">{error}</div>}
            {!progress && !error && <div className="panel-note job-steps-empty">Loading the steps…</div>}
            {progress && progress.steps.length === 0 && (
                <div className="panel-note job-steps-empty">
                    {progress.status === 'queued' ? 'The job waits for a runner.' : 'GitHub has not reported steps yet.'}
                </div>
            )}
            {progress?.steps.map(step => (
                <div key={step.number} className={`job-step ${step.status}`}>
                    <StepIcon step={step} />
                    <span className="job-step-name">{step.name}</span>
                    <span className="job-step-time">{formatDuration(step.startedAt, step.status === 'completed' ? step.completedAt : null)}</span>
                </div>
            ))}
        </div>
    );
}

/** Shows the log of one GitHub Actions job. While the job runs, it shows the live steps of the job instead. */
export function LogView({ target, check, onSendToAgent, onBack }: Props) {
    const rootRef = useRef<HTMLDivElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
    const action = useCiAction();

    // The log of a job does not change after the job completes, so it does not load again by itself.
    // The refresh button loads it again. A failed load (for example a 404 while the job runs) loads again on the next mount.
    const logQuery = useQuery({
        queryKey: ciKeys.jobLog(target, check.id),
        queryFn: () => window.shipwarden.github.jobLog(target, check.id),
        staleTime: Number.POSITIVE_INFINITY,
        refetchInterval: false
    });
    const log = logQuery.data;
    /** True when the log shows. Until then, the live steps show. */
    const logReady = log !== undefined;
    const logError = optionalErrorText(logQuery.error);
    /** True when GitHub has no log for the job yet (it runs, or it just completed). Then the steps refresh. */
    const logMissing = !logReady && !!logError?.includes('404');

    // The steps are live data. While the log is not ready, they load every 5 seconds (only while the window shows).
    const progressQuery = useQuery({
        queryKey: ciKeys.jobProgress(target, check.id),
        queryFn: () => window.shipwarden.github.jobProgress(target, check.id),
        enabled: logMissing,
        staleTime: 0,
        refetchInterval: STEP_POLL_MS
    });
    const progress = logMissing ? progressQuery.data : undefined;

    // When the job completes, load the log. GitHub can need a few seconds to store it, so the next completed read
    // of the steps tries again.
    // biome-ignore lint/correctness/useExhaustiveDependencies: Each new read of the steps must run the effect. The refetch function does not change.
    useEffect(() => {
        if (logMissing && progressQuery.data?.status === 'completed') void logQuery.refetch();
    }, [logMissing, progressQuery.dataUpdatedAt]);

    // A new status of the check loads the log again, for example when the job completes.
    const shownStatus = useRef(check.status);
    // biome-ignore lint/correctness/useExhaustiveDependencies: Only a new status of the check must run the effect. The refetch function does not change.
    useEffect(() => {
        if (shownStatus.current === check.status) return;
        shownStatus.current = check.status;
        void logQuery.refetch();
    }, [check.status]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) {
            return;
        }
        registerLogLanguage();
        const model = monaco.editor.createModel('', 'ci-log');
        const editor = monaco.editor.create(container, {
            model,
            theme: 'shipwarden',
            readOnly: true,
            automaticLayout: true,
            fontFamily: '"JetBrains Mono", Menlo, monospace',
            fontSize: 12,
            lineHeight: 18,
            minimap: { enabled: false },
            wordWrap: 'on',
            scrollBeyondLastLine: false,
            folding: false
        });
        editorRef.current = editor;
        return () => {
            editor.dispose();
            model.dispose();
            editorRef.current = undefined;
        };
    }, []);

    // ⌘F opens the search bar of the editor. The log owns ⌘F when it opens and after each click or focus in it.
    // A click or a focus in a different place removes the ownership. The capture phase gets the key before the editor.
    useEffect(() => {
        const finder: LogFindOwner = {
            open() {
                const editor = editorRef.current;
                const container = containerRef.current;
                // The editor is hidden while the live steps show, or while a different panel covers the log.
                if (!editor || !container || container.getClientRects().length === 0) return false;
                editor.focus();
                void editor.getAction('actions.find')?.run();
                return true;
            }
        };
        claimLogFind(finder);
        const onTouch = (event: Event) => {
            if (event.target instanceof Node && rootRef.current?.contains(event.target)) claimLogFind(finder);
            else releaseLogFind(finder);
        };
        const onKey = (event: KeyboardEvent) => {
            if (isFindShortcut(event)) openLogFind(event);
        };
        window.addEventListener('pointerdown', onTouch, true);
        window.addEventListener('focusin', onTouch, true);
        window.addEventListener('keydown', onKey, true);
        return () => {
            releaseLogFind(finder);
            window.removeEventListener('pointerdown', onTouch, true);
            window.removeEventListener('focusin', onTouch, true);
            window.removeEventListener('keydown', onKey, true);
        };
    }, []);

    // The editor shows each new log. This effect comes after the effect that makes the editor.
    useEffect(() => {
        const editor = editorRef.current;
        const model = editor?.getModel();
        if (!editor || !model || log === undefined) {
            return;
        }
        model.setValue(log);
        // The error is usually near the end of a failed log.
        const lines = model.getLinesContent();
        const firstError = lines.findIndex(line => line.startsWith('##[error]'));
        editor.revealLineInCenter(firstError >= 0 ? firstError + 1 : lines.length);
    }, [log]);

    const actionMessage = action.isSuccess
        ? 'GitHub started the job again. The Checks panel shows its state.'
        : action.error
          ? errorText(action.error)
          : undefined;
    // A running job has no log yet (404). The live steps show instead of the error.
    const message = actionMessage ?? (logQuery.isFetching && !logReady && !logMissing ? 'Loading the log…' : logMissing ? undefined : logError);

    const rerun = async () => {
        if (!(await confirmDialog({ title: `Run the job "${check.name}" again?`, confirmLabel: 'Run again' }))) {
            return;
        }
        action.mutate(() => ciActions.rerunJob(target, check.id, check.runId));
    };

    return (
        <div className="editor" ref={rootRef}>
            <div className="diff-header">
                {onBack && (
                    <button className="icon-button" title="Back to the checks" onClick={onBack}>
                        <ArrowLeft size={14} strokeWidth={1.6} />
                    </button>
                )}
                <span className={`check-dot ${check.conclusion ?? check.status}`} />
                <span className="diff-path">{check.name}</span>
                <span className="check-duration">{formatDuration(check.startedAt, check.completedAt)}</span>
                <span className="header-spacer" />
                <button className="icon-button" title="Load the log again" onClick={() => void logQuery.refetch()}>
                    <RefreshCw size={14} strokeWidth={1.6} />
                </button>
                {check.status === 'completed' && (
                    <button className="icon-button" title="Run this job again" disabled={action.isPending} onClick={() => void rerun()}>
                        <RotateCw size={14} strokeWidth={1.6} />
                    </button>
                )}
                {onSendToAgent && (
                    <button className="icon-button" title="Send the log to the agent" onClick={() => onSendToAgent(check)}>
                        <Bot size={14} strokeWidth={1.6} />
                    </button>
                )}
                {check.url && (
                    <button className="icon-button" title="Open on GitHub" onClick={event => openLink(check.url!, event)}>
                        <ExternalLink size={14} strokeWidth={1.6} />
                    </button>
                )}
            </div>
            {message && <div className="editor-failure">{message}</div>}
            {logMissing && !logReady && <JobSteps progress={progress} error={optionalErrorText(progressQuery.error)} />}
            <div className="editor-monaco" ref={containerRef} style={logReady ? undefined : { display: 'none' }} />
        </div>
    );
}
