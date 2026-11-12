import { useEffect, useRef, useState, type AnimationEvent, type CSSProperties, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
    AlertTriangle,
    ArrowLeft,
    ArrowRight,
    CheckCircle2,
    ChevronRight,
    CircleHelp,
    ExternalLink,
    FolderDown,
    FolderPlus,
    ListTodo,
    LoaderCircle,
    Palette,
    Play,
    RefreshCw,
    XCircle
} from 'lucide-react';
import type { RepoRef } from '@shared/github';
import { repoDisplayName, type AppSettings } from '@shared/settings';
import type { Mode } from '@shared/themes';
import {
    notificationsCheckResult,
    repositoryCheckResult,
    type SetupCheckId,
    type SetupCheckResult,
    type SetupCheckState,
    type SetupFix
} from '@shared/setup-checks';
import { TOOL_CHECK_IDS, WELCOME_STATE_LABELS, WELCOME_STEP_IDS, welcomeStepStates, type WelcomeStepId } from '@shared/welcome';
import { markCheckPending, patchSetupCheck, takePendingChecks, useSetupChecks } from '../app/setup-checks-query';
import { errorText } from '../util';
import { AppearanceSettings } from './AppearanceSettings';
import { CloneRepoDialog } from './CloneRepoDialog';
import { CopyButton } from './CopyButton';
import { SettingsRow } from './settings-ui';
import { TaskManagersSettings } from './TaskManagersSettings';
import { Button } from './ui';

interface Props {
    settings: AppSettings;
    /** The mode that applies now. With the scheme "system", it follows macOS. */
    mode: Mode;
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
    /** Closes the page for all time and opens no dialog. The user starts the first agent later. */
    onLater(): void;
    /** Closes the page for all time. */
    onSkip(): void;
}

/** The title and the first sentence of each step. */
const STEP_TEXT: Record<WelcomeStepId, { title: string; lead: string }> = {
    welcome: {
        title: 'Welcome to ShipWarden',
        lead: 'Run many coding agents at the same time. Each agent works in its own git worktree, so two agents never change the same files.'
    },
    tools: { title: 'Check your tools', lead: 'ShipWarden needs git and an agent. Pull requests and checks need GitHub access.' },
    repository: { title: 'Add a repository', lead: 'Add a git repository from your Mac, or clone one from GitHub.' },
    agent: { title: 'Choose your agent', lead: 'The Agent button starts this agent in a worktree. You can change it later in Settings › Agents.' },
    optional: { title: 'Make it yours', lead: 'These settings are optional. You can change them now, or later in Settings.' },
    start: { title: 'Start your first agent', lead: 'Create a worktree for a new branch. ShipWarden starts your agent in it.' }
};

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

/**
 * The step that shows. It stays when the page closes for a fix in the settings page, so the user comes back to the same
 * step. It goes back to 0 when the user starts or skips the setup.
 */
let lastStep = 0;

type Direction = 'forward' | 'back';

/** The icon of a check result. */
function CheckIcon({ state, busy }: { state: SetupCheckState | undefined; busy?: boolean }) {
    if (busy || !state) return <LoaderCircle size={16} className="spin welcome-icon" aria-label="Checking" />;
    const label = CHECK_STATE_LABELS[state];
    if (state === 'ok') return <CheckCircle2 size={16} strokeWidth={1.8} className="welcome-icon ok" aria-label={label} />;
    if (state === 'missing') return <XCircle size={16} strokeWidth={1.8} className="welcome-icon problem" aria-label={label} />;
    if (state === 'warning') return <AlertTriangle size={16} strokeWidth={1.8} className="welcome-icon warning" aria-label={label} />;
    return <CircleHelp size={16} strokeWidth={1.8} className="welcome-icon" aria-label={label} />;
}

/** Returns true when the key event comes from a control that uses the arrow keys. */
function usesArrowKeys(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return target.isContentEditable || !!target.closest('input, textarea, select, [role="radiogroup"], [role="slider"], [role="listbox"], [role="menu"]');
}

/**
 * The welcome page for a new user. It covers the full window and shows one setup step at a time. A new step slides in
 * from the right. The steps are: the words of ShipWarden, the tool checks, a repository, the default agent, optional
 * settings and the first worktree. The fix buttons can open the settings page. The close button of the settings page
 * comes back here, to the same step.
 */
export function WelcomeView({ settings, mode, repos, projectName, onSave, onOpenSettings, onAddRepo, onCloneRepo, onStart, onLater, onSkip }: Props) {
    const queryClient = useQueryClient();
    const { checks, error, loading, checking, recheck, recheckAll } = useSetupChecks();
    const [cloneOpen, setCloneOpen] = useState(false);
    const [saveError, setSaveError] = useState<string>();
    const [index, setIndex] = useState(lastStep);
    const [direction, setDirection] = useState<Direction>('forward');
    /** The step that slides out. It stays in the page until its animation ends. */
    const [leaving, setLeaving] = useState<number>();
    const headingRef = useRef<HTMLHeadingElement>(null);
    const states = welcomeStepStates(checks, repos.length);
    const byId = new Map((checks ?? []).map(check => [check.id, check]));
    const last = WELCOME_STEP_IDS.length - 1;

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

    // A screen reader reads the title of the new step. The focus does not scroll the slide.
    // biome-ignore lint/correctness/useExhaustiveDependencies: The focus moves when the step changes.
    useEffect(() => {
        headingRef.current?.focus({ preventScroll: true });
    }, [index]);

    /** Shows a step. The new step comes from the right when it is after the current step. */
    const go = (to: number) => {
        const next = Math.max(0, Math.min(last, to));
        if (next === index) return;
        setDirection(next > index ? 'forward' : 'back');
        setLeaving(index);
        setIndex(next);
        lastStep = next;
    };

    // The arrow keys move between the steps. Controls that use the arrow keys keep them.
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (cloneOpen || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || usesArrowKeys(event.target)) return;
            if (event.key === 'ArrowRight') go(index + 1);
            else if (event.key === 'ArrowLeft') go(index - 1);
            else return;
            event.preventDefault();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    });

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
                        <Button
                            key={fix.label}
                            iconEnd={fix.kind === 'link' ? <ExternalLink size={12} strokeWidth={1.8} aria-hidden="true" /> : undefined}
                            onClick={() => runFix(check.id, fix)}
                        >
                            {fix.label}
                        </Button>
                    )
                )}
                {check.fixes.some(fix => fix.kind === 'command') && (
                    <Button onClick={() => void recheck(check.id)} disabled={checking.has(check.id)}>
                        Check again
                    </Button>
                )}
            </div>
        );
    };

    const agentCheck = byId.get('agent');

    /** The content of a step, under its title. */
    const content = (id: WelcomeStepId): ReactNode => {
        switch (id) {
            case 'welcome':
                return (
                    <dl className="welcome-terms welcome-panel">
                        <dt>Project</dt>
                        <dd>A named list of repositories. The sidebar shows the repositories of the active project.</dd>
                        <dt>Repository</dt>
                        <dd>A git repository on your Mac.</dd>
                        <dt>Worktree</dt>
                        <dd>A separate folder of a repository, with its own branch. Each agent works in a worktree.</dd>
                    </dl>
                );
            case 'tools':
                return (
                    <div className="welcome-panel welcome-checks" aria-live="polite" aria-busy={loading}>
                        {error && <div className="form-error">ShipWarden cannot check your tools. {errorText(error)}</div>}
                        {TOOL_CHECK_IDS.map(checkId => {
                            const check = byId.get(checkId);
                            return (
                                <SettingsRow
                                    key={checkId}
                                    label={CHECK_LABELS[checkId]}
                                    description={check?.message ?? 'Checking…'}
                                    control={<CheckIcon state={check?.state} busy={(loading && !check) || checking.has(checkId)} />}
                                >
                                    {check && fixes(check)}
                                </SettingsRow>
                            );
                        })}
                        <div className="welcome-panel-footer">
                            <Button
                                icon={<RefreshCw size={12} strokeWidth={1.8} className={loading ? 'spin' : undefined} aria-hidden="true" />}
                                onClick={recheckAll}
                                disabled={loading}
                            >
                                Check again
                            </Button>
                        </div>
                    </div>
                );
            case 'repository':
                return (
                    <>
                        <p className="welcome-note">The repository goes into the project “{projectName ?? 'Default'}”.</p>
                        {repos.length > 0 && (
                            <ul className="welcome-repos welcome-panel">
                                {repos.map(repo => (
                                    <li key={repo} title={repo}>
                                        <CheckCircle2 size={14} strokeWidth={1.8} className="welcome-icon ok" aria-hidden="true" />
                                        {repoDisplayName(settings, repo)}
                                    </li>
                                ))}
                            </ul>
                        )}
                        <div className="welcome-choices">
                            <button className="welcome-choice" onClick={onAddRepo}>
                                <FolderPlus size={22} strokeWidth={1.5} aria-hidden="true" />
                                <span className="welcome-choice-title">Add a repository</span>
                                <span className="welcome-choice-text">Select a folder on your Mac.</span>
                            </button>
                            <button className="welcome-choice" onClick={() => setCloneOpen(true)}>
                                <FolderDown size={22} strokeWidth={1.5} aria-hidden="true" />
                                <span className="welcome-choice-title">Clone a repository</span>
                                <span className="welcome-choice-text">Download a repository from GitHub.</span>
                            </button>
                        </div>
                    </>
                );
            case 'agent':
                return (
                    <>
                        <fieldset className="welcome-agents">
                            <legend className="visually-hidden">Default agent</legend>
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
                    </>
                );
            case 'optional':
                return (
                    <div className="welcome-optional-list">
                        {/* The settings open on this page, so the user stays on the welcome page. */}
                        <details className="welcome-optional">
                            <summary>
                                <ChevronRight size={14} strokeWidth={1.8} className="welcome-optional-chevron" aria-hidden="true" />
                                <Palette size={14} strokeWidth={1.7} aria-hidden="true" />
                                Choose a theme
                            </summary>
                            <div className="welcome-optional-body">
                                <AppearanceSettings appearance={settings.appearance} mode={mode} onChange={appearance => void save({ appearance })} />
                            </div>
                        </details>
                        <details className="welcome-optional">
                            <summary>
                                <ChevronRight size={14} strokeWidth={1.8} className="welcome-optional-chevron" aria-hidden="true" />
                                <ListTodo size={14} strokeWidth={1.7} aria-hidden="true" />
                                Connect a task tracker
                            </summary>
                            <div className="welcome-optional-body">
                                <TaskManagersSettings />
                            </div>
                        </details>
                    </div>
                );
            case 'start':
                return (
                    <>
                        <div className="welcome-actions">
                            <Button
                                variant="primary"
                                size="lg"
                                icon={<Play size={16} strokeWidth={2} aria-hidden="true" />}
                                onClick={() => {
                                    lastStep = 0;
                                    onStart();
                                }}
                                disabled={repos.length === 0}
                                aria-describedby="welcome-start-note"
                            >
                                Create a worktree and start an agent
                            </Button>
                            <Button
                                variant="ghost"
                                size="lg"
                                onClick={() => {
                                    lastStep = 0;
                                    onLater();
                                }}
                            >
                                Do this later
                            </Button>
                        </div>
                        <p id="welcome-start-note" className="welcome-note">
                            {repos.length === 0 ? (
                                <>
                                    Add a repository first.{' '}
                                    <Button variant="link" onClick={() => go(WELCOME_STEP_IDS.indexOf('repository'))}>
                                        Go to “Add a repository”
                                    </Button>
                                </>
                            ) : (
                                'Help › Show Welcome opens this page again. Help › Take the Tour shows the parts of the app.'
                            )}
                        </p>
                    </>
                );
        }
    };

    /** One step as a slide. The slide that leaves is inert, so the keyboard and screen readers skip it. */
    const slide = (stepIndex: number, phase: 'entering' | 'leaving') => {
        const id = WELCOME_STEP_IDS[stepIndex];
        const text = STEP_TEXT[id];
        const onAnimationEnd = (event: AnimationEvent<HTMLElement>) => {
            if (phase === 'leaving' && event.target === event.currentTarget) setLeaving(undefined);
        };
        return (
            <section
                key={`${phase}-${stepIndex}`}
                className={`welcome-slide ${phase} ${direction} step-${id}`}
                aria-labelledby={phase === 'entering' ? 'welcome-slide-title' : undefined}
                aria-hidden={phase === 'leaving' || undefined}
                inert={phase === 'leaving'}
                onAnimationEnd={onAnimationEnd}
            >
                <div className="welcome-slide-inner">
                    <p className="welcome-eyebrow">
                        Step {stepIndex + 1} of {WELCOME_STEP_IDS.length}
                    </p>
                    <h1 id={phase === 'entering' ? 'welcome-slide-title' : undefined} ref={phase === 'entering' ? headingRef : undefined} tabIndex={-1}>
                        {text.title}
                    </h1>
                    <p className="welcome-lead">{text.lead}</p>
                    <div className="welcome-slide-content">{content(id)}</div>
                </div>
            </section>
        );
    };

    return (
        <div className="welcome-view" style={{ '--welcome-step': index } as CSSProperties}>
            <div className="welcome-backdrop" aria-hidden="true">
                <div className="welcome-glow one" />
                <div className="welcome-glow two" />
                <div className="welcome-glow three" />
            </div>
            <div className="welcome-grain" aria-hidden="true" />

            <header className="welcome-topbar">
                <nav className="welcome-progress" aria-label="Setup steps">
                    {WELCOME_STEP_IDS.map((id, i) => (
                        <button
                            key={id}
                            className={`welcome-dot ${states[id]}${i === index ? ' current' : ''}`}
                            onClick={() => go(i)}
                            aria-current={i === index ? 'step' : undefined}
                            aria-label={`Step ${i + 1}: ${STEP_TEXT[id].title}. ${WELCOME_STATE_LABELS[states[id]]}`}
                            title={STEP_TEXT[id].title}
                        />
                    ))}
                </nav>
                <Button
                    variant="ghost"
                    size="sm"
                    className="welcome-skip"
                    onClick={() => {
                        lastStep = 0;
                        onSkip();
                    }}
                >
                    Skip setup
                </Button>
            </header>

            {saveError && (
                <div className="form-error welcome-error" role="alert">
                    {saveError}
                </div>
            )}

            <div className="welcome-stage">
                {leaving !== undefined && leaving !== index && slide(leaving, 'leaving')}
                {slide(index, 'entering')}
            </div>

            <footer className="welcome-footer">
                <Button
                    variant="ghost"
                    size="lg"
                    className="welcome-back"
                    icon={<ArrowLeft size={16} strokeWidth={1.8} aria-hidden="true" />}
                    onClick={() => go(index - 1)}
                    disabled={index === 0}
                >
                    Back
                </Button>
                {index < last && (
                    <Button variant="primary" size="lg" iconEnd={<ArrowRight size={16} strokeWidth={2} aria-hidden="true" />} onClick={() => go(index + 1)}>
                        {index === 0 ? 'Get started' : 'Continue'}
                    </Button>
                )}
            </footer>

            {cloneOpen && <CloneRepoDialog projectName={projectName ?? 'Default'} onClose={() => setCloneOpen(false)} onClone={onCloneRepo} />}
        </div>
    );
}
