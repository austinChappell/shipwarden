import { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, CircleCheck, CircleDashed, CircleMinus, CircleX, ExternalLink, LoaderCircle, RefreshCw, RotateCw } from 'lucide-react';
import type { CheckRun, JobProgress, JobStep, RepoTarget } from '@shared/github';
import { monaco } from '../editor/monaco';
import { errorText, formatDuration } from '../util';
import { confirmDialog } from './ConfirmDialog';
import { openLink } from '../links';

interface Props {
    target: RepoTarget;
    check: CheckRun;
    /** Sends the log to the agent of the worktree. Without it (in the Review view), the button does not show. */
    onSendToAgent?(check: CheckRun): void;
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
const FAILED = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'error']);

function StepIcon({ step }: { step: Pick<JobStep, 'status' | 'conclusion'> }) {
    const props = { size: 14, strokeWidth: 1.8 };
    if (step.status === 'in_progress') return <LoaderCircle {...props} className="step-icon running spin" />;
    if (step.status !== 'completed') return <CircleDashed {...props} className="step-icon pending" />;
    if (step.conclusion === 'success') return <CircleCheck {...props} className="step-icon success" />;
    if (FAILED.has(step.conclusion ?? '')) return <CircleX {...props} className="step-icon failure" />;
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
export function LogView({ target, check, onSendToAgent }: Props) {
    const containerRef = useRef<HTMLDivElement>(null);
    const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
    const [message, setMessage] = useState('Loading the log…');
    const [busy, setBusy] = useState(false);
    /** True when the log shows. Until then, the live steps show. */
    const [logReady, setLogReady] = useState(false);
    /** True when GitHub has no log for the job yet (it runs, or it just completed). Then the steps refresh. */
    const [logMissing, setLogMissing] = useState(false);
    const [progress, setProgress] = useState<JobProgress>();
    const [progressError, setProgressError] = useState<string>();

    // biome-ignore lint/correctness/useExhaustiveDependencies: A new check status gives a new load function. Then the log loads again, for example when the job completes.
    const load = useCallback(async () => {
        const editor = editorRef.current;
        if (!editor) {
            return;
        }
        setMessage('Loading the log…');
        try {
            const log = await window.shipwarden.github.jobLog(target, check.id);
            editor.getModel()?.setValue(log);
            // The error is usually near the end of a failed log.
            const model = editor.getModel();
            const lines = model?.getLinesContent() ?? [];
            const firstError = lines.findIndex(line => line.startsWith('##[error]'));
            editor.revealLineInCenter(firstError >= 0 ? firstError + 1 : lines.length);
            setMessage('');
            setLogReady(true);
            setLogMissing(false);
        } catch (err) {
            const text = errorText(err);
            // A running job has no log yet (404). The live steps show instead.
            setMessage(text.includes('404') ? '' : text);
            setLogReady(false);
            setLogMissing(text.includes('404'));
        }
    }, [target, check.id, check.status]);

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
        load();
        return () => {
            editor.dispose();
            model.dispose();
            editorRef.current = undefined;
        };
    }, [load]);

    // While the log is not ready, read the steps now and every 5 seconds (only while the window shows). When the job
    // completes, load the log. GitHub can need some seconds to store it, so the next read tries again.
    useEffect(() => {
        if (logReady || !logMissing) return;
        let stopped = false;
        const read = async () => {
            if (document.visibilityState !== 'visible') return;
            try {
                const next = await window.shipwarden.github.jobProgress(target, check.id);
                if (stopped) return;
                setProgress(next);
                setProgressError(undefined);
                if (next.status === 'completed') void load();
            } catch (err) {
                if (!stopped) setProgressError(errorText(err));
            }
        };
        void read();
        const timer = setInterval(() => void read(), STEP_POLL_MS);
        return () => {
            stopped = true;
            clearInterval(timer);
        };
    }, [logReady, logMissing, target, check.id, load]);

    const rerun = async () => {
        if (!(await confirmDialog({ title: `Run the job "${check.name}" again?`, confirmLabel: 'Run again' }))) {
            return;
        }
        setBusy(true);
        try {
            await window.shipwarden.github.rerunJob(target, check.id);
            setMessage('GitHub started the job again. Refresh the Checks panel to see its state.');
        } catch (err) {
            setMessage(errorText(err));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="editor">
            <div className="diff-header">
                <span className={`check-dot ${check.conclusion ?? check.status}`} />
                <span className="diff-path">{check.name}</span>
                <span className="check-duration">{formatDuration(check.startedAt, check.completedAt)}</span>
                <span className="header-spacer" />
                <button className="icon-button" title="Load the log again" onClick={load}>
                    <RefreshCw size={14} strokeWidth={1.6} />
                </button>
                {check.status === 'completed' && (
                    <button className="icon-button" title="Run this job again" disabled={busy} onClick={rerun}>
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
            {logMissing && !logReady && <JobSteps progress={progress} error={progressError} />}
            <div className="editor-monaco" ref={containerRef} style={logReady ? undefined : { display: 'none' }} />
        </div>
    );
}
