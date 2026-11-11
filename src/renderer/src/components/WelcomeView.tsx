import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, CircleHelp, ExternalLink, FolderDown, FolderPlus, Info, LoaderCircle, Play, RefreshCw, XCircle } from 'lucide-react';
import type { RepoRef } from '@shared/github';
import { repoDisplayName, type AppSettings } from '@shared/settings';
import {
    notificationsCheckResult,
    repositoryCheckResult,
    type SetupCheckId,
    type SetupCheckResult,
    type SetupCheckState,
    type SetupFix
} from '@shared/setup-checks';
import { TOOL_CHECK_IDS, WELCOME_STATE_LABELS, welcomeStepStates, type WelcomeStepState } from '@shared/welcome';
import { markCheckPending, patchSetupCheck, takePendingChecks, useSetupChecks } from '../app/setup-checks-query';
import { errorText } from '../util';
import { CloneRepoDialog } from './CloneRepoDialog';
import { CopyButton } from './CopyButton';
import { SettingsGroup, SettingsRow } from './settings-ui';

interface Props {
    settings: AppSettings;
    /** The repositories of the active project. */
    repos: string[];
    /** The name of the active project. */
    projectName: string | undefined;
    onSave(change: Partial<AppSettings>): Promise<void>;
    /** Opens a section of the settings page. The close button of the settings page comes back to this page. */
    onOpenSettings(section: string): void;
    onAddRepo(): void;
    /** Clones a GitHub repository into the active project. Resolves false when the user cancels the folder dialog. */
    onCloneRepo(repo: RepoRef): Promise<boolean>;
    /** Closes the page for all time and opens the New worktree dialog. */
    onStart(): void;
    /** Closes the page for all time. */
    onSkip(): void;
}

/** The names of the tool checks on the page. */
const CHECK_LABELS: Record<SetupCheckId, string> = {
    git: 'git',
    agent: 'Default agent',
    github: 'GitHub access',
    repository: 'Repository',
    notifications: 'Notifications'
};

const CHECK_STATE_LABELS: Record<SetupCheckState, string> = {
    ok: 'OK',
    missing: 'Missing',
    warning: 'Needs attention',
    unknown: 'Unknown'
};

/** The icon of a check result. */
function CheckIcon({ state, busy }: { state: SetupCheckState | undefined; busy?: boolean }) {
    if (busy || !state) return <LoaderCircle size={16} className="spin welcome-icon" aria-label="Checking" />;
    const label = CHECK_STATE_LABELS[state];
    if (state === 'ok') return <CheckCircle2 size={16} strokeWidth={1.8} className="welcome-icon ok" aria-label={label} />;
    if (state === 'missing') return <XCircle size={16} strokeWidth={1.8} className="welcome-icon problem" aria-label={label} />;
    if (state === 'warning') return <AlertTriangle size={16} strokeWidth={1.8} className="welcome-icon warning" aria-label={label} />;
    return <CircleHelp size={16} strokeWidth={1.8} className="welcome-icon" aria-label={label} />;
}

/** The marker of a step: its number, or a check mark when it is done. */
function StepMarker({ number, state }: { number: number; state: WelcomeStepState }) {
    const label = WELCOME_STATE_LABELS[state];
    if (state === 'done') return <CheckCircle2 size={22} strokeWidth={1.6} className="welcome-marker ok" aria-label={label} />;
    if (state === 'problem') return <XCircle size={22} strokeWidth={1.6} className="welcome-marker problem" aria-label={label} />;
    if (state === 'warning') return <AlertTriangle size={22} strokeWidth={1.6} className="welcome-marker warning" aria-label={label} />;
    if (state === 'info') return <Info size={22} strokeWidth={1.6} className="welcome-marker" aria-label={label} />;
    return (
        <span className={`welcome-marker number${state === 'blocked' ? ' blocked' : ''}`} role="img" aria-label={label}>
            {number}
        </span>
    );
}

interface StepProps {
    number: number;
    title: string;
    state: WelcomeStepState;
    children: ReactNode;
}

/** One step of the page: a marker, a title and the content. */
function Step({ number, title, state, children }: StepProps) {
    const id = `welcome-step-${number}`;
    return (
        <li className={`welcome-step ${state}`} aria-labelledby={id}>
            <StepMarker number={number} state={state} />
            <div className="welcome-step-body">
                <h2 id={id}>
                    <span className="visually-hidden">Step {number}: </span>
                    {title}
                </h2>
                {children}
            </div>
        </li>
    );
}

/**
 * The welcome page for a new user. It shows the setup steps in one list: the words of ShipWarden, the tool checks,
 * a repository, the default agent, optional settings and the first worktree. The fix buttons can open the settings
 * page. The close button of the settings page comes back here.
 */
export function WelcomeView({ settings, repos, projectName, onSave, onOpenSettings, onAddRepo, onCloneRepo, onStart, onSkip }: Props) {
    const queryClient = useQueryClient();
    const { checks, error, loading, checking, recheck, recheckAll } = useSetupChecks();
    const [cloneOpen, setCloneOpen] = useState(false);
    const [saveError, setSaveError] = useState<string>();
    const states = welcomeStepStates(checks, repos.length);
    const byId = new Map((checks ?? []).map(check => [check.id, check]));

    // A fix that opened the settings page or a web page: check again when the page shows again.
    // biome-ignore lint/correctness/useExhaustiveDependencies: The pending checks run one time, when the page mounts.
    useEffect(() => {
        for (const id of takePendingChecks()) void recheck(id);
    }, []);

    // The page knows the repositories and the notification setting. Their results need no request to the main process.
    useEffect(() => patchSetupCheck(queryClient, repositoryCheckResult(repos.length)), [queryClient, repos.length]);
    // biome-ignore lint/correctness/useExhaustiveDependencies: Only the switch matters. The other notification settings do not change the result.
    useEffect(() => patchSetupCheck(queryClient, notificationsCheckResult(settings.notifications)), [queryClient, settings.notifications.enabled]);
    // A new default agent needs a new PATH check. The first render uses the result of the first load.
    const agentId = useRef(settings.defaultAgentId);
    useEffect(() => {
        if (agentId.current === settings.defaultAgentId) return;
        agentId.current = settings.defaultAgentId;
        void recheck('agent');
    }, [settings.defaultAgentId, recheck]);

    const save = (change: Partial<AppSettings>) => onSave(change).catch(err => setSaveError(errorText(err)));

    /** Runs a fix. A fix that leaves the page marks its check to check again when the user comes back. */
    const runFix = (id: SetupCheckId, fix: SetupFix) => {
        if (fix.kind === 'settings') {
            markCheckPending(id);
            onOpenSettings(fix.section);
        } else if (fix.kind === 'link') {
            markCheckPending(id);
            window.shipwarden.github.openInBrowser(fix.url);
        } else if (fix.kind === 'repository') {
            if (fix.action === 'add') onAddRepo();
            else setCloneOpen(true);
        }
    };

    /** The fix controls of one check. A command shows with a copy button and a button that checks again. */
    const fixes = (check: SetupCheckResult) => {
        if (check.fixes.length === 0) return null;
        return (
            <div className="welcome-fixes">
                {check.fixes.map(fix =>
                    fix.kind === 'command' ? (
                        <div key={fix.command} className="welcome-command">
                            <span className="welcome-command-label">{fix.label}: run this command in a terminal.</span>
                            <span className="welcome-command-line">
                                <code>{fix.command}</code>
                                <CopyButton text={fix.command} title={`Copy “${fix.command}”`} />
                            </span>
                        </div>
                    ) : (
                        <button key={fix.label} className="button" onClick={() => runFix(check.id, fix)}>
                            {fix.label}
                            {fix.kind === 'link' && <ExternalLink size={12} strokeWidth={1.8} aria-hidden="true" />}
                        </button>
                    )
                )}
                {check.fixes.some(fix => fix.kind === 'command') && (
                    <button className="button" onClick={() => void recheck(check.id)} disabled={checking.has(check.id)}>
                        Check again
                    </button>
                )}
            </div>
        );
    };

    const agentCheck = byId.get('agent');

    return (
        <div className="settings-view welcome-view">
            <header className="settings-header">
                <h1>Welcome to ShipWarden</h1>
                <button className="link-button" onClick={onSkip}>
                    Skip setup
                </button>
            </header>
            <div className="settings-scroll">
                <div className="settings-page welcome-page">
                    {saveError && (
                        <div className="form-error" role="alert">
                            {saveError}
                        </div>
                    )}
                    <ol className="welcome-steps">
                        <Step number={1} title="Welcome" state={states.welcome}>
                            <p>
                                ShipWarden runs many coding agents at the same time. Each agent works in its own git worktree, so two agents never change the
                                same files.
                            </p>
                            <dl className="welcome-terms">
                                <dt>Project</dt>
                                <dd>A named list of repositories. The sidebar shows the repositories of the active project.</dd>
                                <dt>Repository</dt>
                                <dd>A git repository on your Mac.</dd>
                                <dt>Worktree</dt>
                                <dd>A separate folder of a repository, with its own branch. Each agent works in a worktree.</dd>
                            </dl>
                        </Step>

                        <Step number={2} title="Check your tools" state={states.tools}>
                            <SettingsGroup
                                title="Tools"
                                description="ShipWarden needs git and an agent. Pull requests and checks need GitHub access."
                                card
                                actions={
                                    <button className="button" onClick={recheckAll} disabled={loading}>
                                        <RefreshCw size={12} strokeWidth={1.8} className={loading ? 'spin' : undefined} aria-hidden="true" /> Check again
                                    </button>
                                }
                            >
                                <div aria-live="polite" aria-busy={loading}>
                                    {error && <div className="form-error">ShipWarden cannot check your tools. {errorText(error)}</div>}
                                    {TOOL_CHECK_IDS.map(id => {
                                        const check = byId.get(id);
                                        return (
                                            <SettingsRow
                                                key={id}
                                                label={CHECK_LABELS[id]}
                                                description={check?.message ?? 'Checking…'}
                                                control={<CheckIcon state={check?.state} busy={(loading && !check) || checking.has(id)} />}
                                            >
                                                {check && fixes(check)}
                                            </SettingsRow>
                                        );
                                    })}
                                </div>
                            </SettingsGroup>
                        </Step>

                        <Step number={3} title="Add a repository" state={states.repository}>
                            <p>Add a git repository from your Mac, or clone one from GitHub. It goes into the project “{projectName ?? 'Default'}”.</p>
                            {repos.length > 0 && (
                                <ul className="welcome-repos">
                                    {repos.map(repo => (
                                        <li key={repo} title={repo}>
                                            <CheckCircle2 size={14} strokeWidth={1.8} className="welcome-icon ok" aria-hidden="true" />
                                            {repoDisplayName(settings, repo)}
                                        </li>
                                    ))}
                                </ul>
                            )}
                            <div className="welcome-actions">
                                <button className={`button${repos.length === 0 ? ' primary' : ''}`} onClick={onAddRepo}>
                                    <FolderPlus size={13} strokeWidth={1.8} aria-hidden="true" /> Add a repository
                                </button>
                                <button className="button" onClick={() => setCloneOpen(true)}>
                                    <FolderDown size={13} strokeWidth={1.8} aria-hidden="true" /> Clone a repository
                                </button>
                            </div>
                        </Step>

                        <Step number={4} title="Choose your agent" state={states.agent}>
                            <fieldset className="welcome-agents">
                                <legend>The Agent button starts this agent in a worktree. You can change it later in Settings › Agents.</legend>
                                {settings.agents.map(agent => (
                                    <label key={agent.id} className={`welcome-agent${agent.id === settings.defaultAgentId ? ' selected' : ''}`}>
                                        <input
                                            type="radio"
                                            name="welcome-agent"
                                            checked={agent.id === settings.defaultAgentId}
                                            onChange={() => void save({ defaultAgentId: agent.id })}
                                        />
                                        <span className="welcome-agent-name">{agent.name}</span>
                                        <code>{agent.command}</code>
                                    </label>
                                ))}
                            </fieldset>
                            {agentCheck && agentCheck.state !== 'ok' && (
                                <div className="welcome-agent-check">
                                    <CheckIcon state={agentCheck.state} busy={checking.has('agent')} />
                                    <span>{agentCheck.message}</span>
                                </div>
                            )}
                        </Step>

                        <Step number={5} title="Optional settings" state={states.optional}>
                            <p>You can change these settings now or later.</p>
                            <div className="welcome-actions">
                                <button className="button" onClick={() => onOpenSettings('appearance')}>
                                    Choose a theme
                                </button>
                                <button className="button" onClick={() => onOpenSettings('tasks')}>
                                    Connect a task tracker
                                </button>
                            </div>
                        </Step>

                        <Step number={6} title="Start" state={states.start}>
                            <p>Create a worktree for a new branch. ShipWarden starts your agent in it.</p>
                            <div className="welcome-actions">
                                <button className="button primary" onClick={onStart} disabled={repos.length === 0} aria-describedby="welcome-start-note">
                                    <Play size={13} strokeWidth={1.8} aria-hidden="true" /> Create a worktree and start an agent
                                </button>
                            </div>
                            <p id="welcome-start-note" className="panel-note">
                                {repos.length === 0
                                    ? 'Add a repository first.'
                                    : 'Help › Show Welcome opens this page again. Help › Take the Tour shows the parts of the app.'}
                            </p>
                        </Step>
                    </ol>
                </div>
            </div>
            {cloneOpen && <CloneRepoDialog projectName={projectName ?? 'Default'} onClose={() => setCloneOpen(false)} onClone={onCloneRepo} />}
        </div>
    );
}
