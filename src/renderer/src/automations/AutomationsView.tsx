import { useState } from 'react';
import { ArrowUpRight, Check, ChevronDown, ChevronLeft, FolderOpen, MoreHorizontal, Pencil, Play, Plus, Upload, X, Zap } from 'lucide-react';
import {
    AUTOMATION_TEMPLATES,
    automationFromTemplate,
    bindingProblems,
    DEFAULT_AUTOMATION_SETTINGS,
    describeTrigger,
    importedAutomation,
    isOpenRun,
    parseAutomationImport,
    usageAboveLimit,
    USAGE_LIMIT_MAX,
    USAGE_LIMIT_MIN,
    USAGE_LIMIT_STEP,
    TOKEN_LIMIT_MAX,
    TOKEN_LIMIT_MIN,
    TOKEN_LIMIT_STEP,
    formatTokens,
    tokensToday,
    type Automation,
    type AutomationRun,
    type AutomationSettings,
    type AutomationStatus,
    type RunStatus
} from '@shared/automations';
import type { AppSettings } from '@shared/settings';
import { confirmDialog } from '../components/ConfirmDialog';
import { Age, Button, ButtonGroup, Chip, IconButton, PageHeader, Switch, type ChipTone } from '../components/ui';
import { showContextMenu } from '../components/ContextMenu';
import { SettingsGroup, SettingsRow } from '../components/settings-ui';
import { radioGroupKeys } from '../components/keyboard';
import { useUsage } from '../usage-query';
import { errorText } from '../util';
import { AutomationEditor, STATUS_OPTIONS } from './AutomationEditor';
import { LimitField } from './LimitField';
import { patchRunState, removeAutomation, saveAutomation, useAutomationList, useAutomationRuns } from './automation-queries';
import { automationEngine, describeActions } from './engine';
import { pickManualRun } from './manual-run';
import { InlineTip } from '../components/Tips';

const api = window.shipwarden.automations;

/** The history shows this number of runs. */
const HISTORY_SIZE = 60;

/** The number that the token field shows when the user turns the limit on. */
export const DEFAULT_DAILY_TOKENS = 5_000_000;

const RUN_STATUS_LABELS: Record<RunStatus, string> = {
    pending: 'Waits for approval',
    held: 'Waits',
    running: 'Runs',
    done: 'Done',
    failed: 'Failed',
    skipped: 'Skipped',
    'dry-run': 'Dry run'
};

/** The tone of the chip of each run status. */
const RUN_STATUS_TONES: Record<RunStatus, ChipTone> = {
    pending: 'warning',
    held: 'warning',
    running: 'info',
    done: 'success',
    failed: 'danger',
    skipped: 'neutral',
    'dry-run': 'neutral'
};

interface Props {
    settings: AppSettings;
    onSaveSettings(change: Partial<AppSettings>): Promise<void>;
    /** The repositories of all projects. */
    repos: string[];
    repoLabel(repo: string): string;
    onOpenWorktree(path: string, sessionId?: string): void;
    onOpenNotes(): void;
}

/** The state of the editor: the automation, the ID of its saved file, and whether it comes from an import. */
interface Editing {
    automation: Automation;
    previousId?: string;
    imported?: boolean;
}

/** The Automations view: the runs that wait for approval, the automations, the files with problems and the run history. */
export function AutomationsView({ settings, onSaveSettings, repos, repoLabel, onOpenWorktree, onOpenNotes }: Props) {
    const { list } = useAutomationList();
    const { state } = useAutomationRuns();
    const usage = useUsage();
    const [editing, setEditing] = useState<Editing>();
    const [error, setError] = useState<string>();
    const [notice, setNotice] = useState<string>();
    const automationSettings = settings.automations;
    const ids = list.automations.map(item => item.id);

    if (editing) {
        return (
            <div className="automations-view">
                <header className="form-page-back">
                    <Button variant="ghost" size="lg" className="view-back" icon={<ChevronLeft size={16} />} onClick={() => setEditing(undefined)}>
                        Automations
                    </Button>
                </header>
                <div className="automations-scroll">
                    <AutomationEditor
                        initial={editing.automation}
                        previousId={editing.previousId}
                        imported={editing.imported}
                        repos={repos}
                        repoLabel={repoLabel}
                        agents={settings.agents}
                        onCancel={() => setEditing(undefined)}
                        onSave={async (automation, previousId) => {
                            // A new automation must not replace the file of another automation with the same ID.
                            if (!previousId && ids.includes(automation.id)) {
                                throw new Error(`An automation with the ID "${automation.id}" exists already. Change the name.`);
                            }
                            await saveAutomation(automation, previousId);
                            setEditing(undefined);
                            setNotice(editing.imported ? `Imported "${automation.name}". It is off. Turn it on when you are ready.` : undefined);
                        }}
                    />
                </div>
            </div>
        );
    }

    const act = async (work: () => Promise<unknown>) => {
        setError(undefined);
        setNotice(undefined);
        try {
            await work();
        } catch (err) {
            setError(errorText(err));
        }
    };

    const newMenu = async (anchor: Element) => {
        const choice = await showContextMenu(
            [{ id: 'blank', label: 'Empty automation' }, ...AUTOMATION_TEMPLATES.map(template => ({ id: template.id, label: template.name }))],
            anchor
        );
        if (!choice) return;
        const template =
            AUTOMATION_TEMPLATES.find(item => item.id === choice) ??
            ({
                id: 'blank',
                name: 'New automation',
                description: '',
                definition: {
                    name: 'New automation',
                    trigger: { type: 'ci.failed' },
                    actions: [{ type: 'sendToAgent', prompt: '' }],
                    limits: { approval: 'ask', maxRunsPerTarget: 3, maxRunning: 2 }
                }
            } as const);
        setEditing({ automation: automationFromTemplate(template, ids) });
    };

    const importMenu = async (anchor: Element) => {
        const choice = await showContextMenu(
            [
                { id: 'file', label: 'From a file…' },
                { id: 'clipboard', label: 'From the clipboard' }
            ],
            anchor
        );
        if (!choice) return;
        await act(async () => {
            const text = choice === 'file' ? await api.importFromFile() : await api.readClipboard();
            if (text === undefined) return;
            setEditing({ automation: importedAutomation(parseAutomationImport(text), ids), imported: true });
        });
    };

    const moreMenu = async (automation: Automation, anchor: Element) => {
        const choice = await showContextMenu(
            [
                { id: 'export', label: 'Export to a file…' },
                { id: 'copy', label: 'Copy as JSON' },
                { id: 'duplicate', label: 'Duplicate' },
                { id: 'reveal', label: 'Show the file in Finder' },
                { id: 'delete', label: 'Delete…', danger: true }
            ],
            anchor
        );
        if (choice === 'export') await act(async () => (await api.exportToFile(automation.id)) && setNotice(`Exported "${automation.name}".`));
        if (choice === 'copy')
            await act(async () => {
                await api.copyExport(automation.id);
                setNotice(`Copied "${automation.name}". The JSON text has no paths of this Mac.`);
            });
        if (choice === 'duplicate') {
            const name = `${automation.name} (copy)`.slice(0, 80);
            setEditing({ automation: { ...structuredClone(automation), name, id: importedAutomation({ ...automation, name }, ids).id, status: 'off' } });
        }
        if (choice === 'reveal') api.reveal(automation.id);
        if (
            choice === 'delete' &&
            (await confirmDialog({
                title: `Delete "${automation.name}"?`,
                message: 'The file goes to the Trash. Its runs stay in the history.',
                confirmLabel: 'Delete',
                danger: true
            }))
        ) {
            await act(() => removeAutomation(automation.id));
        }
    };

    const setStatus = (automation: Automation, status: AutomationStatus) =>
        act(async () => {
            const problems = bindingProblems(automation, repos);
            if (status !== 'off' && problems.length > 0) throw new Error(`"${automation.name}": ${problems.join(' ')} Edit the automation first.`);
            await saveAutomation({ ...automation, status }, automation.id);
        });

    const runNow = (automation: Automation, anchor: Element) =>
        act(async () => {
            const problems = bindingProblems(automation, repos);
            if (problems.length > 0) throw new Error(`"${automation.name}": ${problems.join(' ')} Edit the automation first.`);
            const picked = await pickManualRun(automation, repos, repoLabel, anchor);
            if (!picked) return;
            const dryRun = automation.status === 'dry-run';
            const ok = await confirmDialog({
                title: `Run "${automation.name}" now?`,
                message: [
                    `Target: ${picked.event.label}.`,
                    dryRun ? 'The automation is a dry run. It records what it would do, and does nothing.' : `It will: ${describeActions(automation.actions)}.`,
                    'A manual run does not ask for approval, and the limits do not stop it.'
                ].join('\n\n'),
                confirmLabel: 'Run'
            });
            if (!ok) return;
            await automationEngine.runNow(automation.id, picked.event, picked.place);
            setNotice(`Started "${automation.name}". The history shows the result.`);
        });

    const saveAutomationSettings = (change: Partial<AutomationSettings>) => act(() => onSaveSettings({ automations: { ...automationSettings, ...change } }));

    const pending = state.runs.filter(run => run.status === 'pending');
    const history = state.runs.filter(run => run.status !== 'pending').slice(0, HISTORY_SIZE);
    const overUsage = usageAboveLimit(usage, automationSettings.pauseAtUsage);
    const now = Date.now();
    const usedToday = tokensToday(state.runs, now);
    const tokensOf = (id: string) => tokensToday(state.runs, now, id);
    const overTokens =
        automationSettings.dailyTokens !== null && usedToday >= automationSettings.dailyTokens
            ? `All automations used ${formatTokens(usedToday)} tokens today. The limit is ${formatTokens(automationSettings.dailyTokens)}. They start again tomorrow.`
            : undefined;
    const onCount = list.automations.filter(item => item.status === 'on').length;
    const masterMeta = `${onCount} on${automationSettings.paused ? ' · paused' : ''}`;
    const nameOf = (run: AutomationRun) => list.automations.find(item => item.id === run.automationId)?.name ?? run.automationName;

    return (
        <div className="automations-view">
            <PageHeader
                icon={Zap}
                title="Automations"
                meta={masterMeta}
                actions={
                    <>
                        <IconButton
                            size="lg"
                            label="Show in Finder"
                            title="Show the folder of the automation files in Finder"
                            icon={<FolderOpen size={16} />}
                            onClick={() => api.reveal()}
                        />
                        <Button
                            size="lg"
                            icon={<Upload size={14} />}
                            iconEnd={<ChevronDown size={14} />}
                            onClick={event => void importMenu(event.currentTarget)}
                        >
                            Import
                        </Button>
                    </>
                }
                primary={
                    <Button
                        size="lg"
                        variant="primary"
                        icon={<Plus size={14} />}
                        iconEnd={<ChevronDown size={14} />}
                        onClick={event => void newMenu(event.currentTarget)}
                    >
                        New automation
                    </Button>
                }
            />
            <div className="automations-scroll">
                <div className="settings-page automations-page">
                    <p className="settings-group-description automations-intro">
                        Rules of the form "when this occurs, do that". They run while ShipWarden is open. Each automation is a JSON file in
                        ~/.shipwarden/automations that you can export and share.
                    </p>

                    <InlineTip id="automations" />
                    {error && <div className="form-error">{error}</div>}
                    {notice && <div className="automation-notice">{notice}</div>}

                    <SettingsGroup title="Run automations" card>
                        <SettingsRow
                            label="Automations run"
                            description="Off pauses all automations. Events that occur during the pause do not run later."
                            control={
                                <Switch
                                    title={automationSettings.paused ? 'Paused' : 'On'}
                                    checked={!automationSettings.paused}
                                    onChange={on => void saveAutomationSettings({ paused: !on })}
                                />
                            }
                        />
                        <SettingsRow
                            label="Pause at plan usage"
                            description={
                                overUsage ??
                                'Automations start no runs while the plan usage of Claude or Codex is at or above this percent. Select "No limit" when you use the API.'
                            }
                            control={
                                <LimitField
                                    value={automationSettings.pauseAtUsage}
                                    fallback={DEFAULT_AUTOMATION_SETTINGS.pauseAtUsage}
                                    min={USAGE_LIMIT_MIN}
                                    max={USAGE_LIMIT_MAX}
                                    step={USAGE_LIMIT_STEP}
                                    unit="%"
                                    label="Pause at plan usage, in percent"
                                    onSave={pauseAtUsage => void saveAutomationSettings({ pauseAtUsage })}
                                />
                            }
                        />
                        <SettingsRow
                            label="Tokens each day"
                            description={
                                overTokens ??
                                `All automations together, from midnight. Today: ${formatTokens(usedToday)} tokens. Input, output and cache writes count. Cache reads do not count. Only Claude Code reports tokens.`
                            }
                            control={
                                <LimitField
                                    value={automationSettings.dailyTokens}
                                    fallback={DEFAULT_DAILY_TOKENS}
                                    min={TOKEN_LIMIT_MIN}
                                    max={TOKEN_LIMIT_MAX}
                                    step={TOKEN_LIMIT_STEP}
                                    unit="tokens"
                                    label="Tokens each day for all automations"
                                    onSave={dailyTokens => void saveAutomationSettings({ dailyTokens })}
                                />
                            }
                        />
                    </SettingsGroup>

                    {pending.length > 0 && (
                        <SettingsGroup title="Waiting for approval" description="These runs start when you approve them." card>
                            {pending.map(run => (
                                <div key={run.id} className="settings-row automation-run">
                                    <div className="settings-row-main">
                                        <div className="settings-row-text">
                                            <div className="settings-row-label">{nameOf(run)}</div>
                                            <div className="settings-row-description">
                                                {run.event.label} · <Age date={new Date(run.createdAt).toISOString()} format="prose" />
                                            </div>
                                        </div>
                                        <div className="settings-row-control automation-run-actions">
                                            <Button icon={<X size={14} />} onClick={() => void act(() => automationEngine.skip(run.id))}>
                                                Skip
                                            </Button>
                                            <Button
                                                variant="accent"
                                                icon={<Check size={14} />}
                                                onClick={() => void act(() => automationEngine.approve(run.id))}
                                            >
                                                Approve
                                            </Button>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </SettingsGroup>
                    )}

                    <SettingsGroup
                        title="Automations"
                        description={list.automations.length === 0 ? 'No automations yet. Select "New automation" to start from a template.' : undefined}
                        card={list.automations.length > 0}
                    >
                        {list.automations.map(automation => {
                            const problems = bindingProblems(automation, repos);
                            return (
                                <div key={automation.id} className="settings-row automation-row">
                                    <div className="settings-row-main">
                                        <div className="settings-row-text">
                                            <div className="settings-row-label">{automation.name}</div>
                                            <div className="settings-row-description">
                                                {describeTrigger(automation.trigger)}
                                                {automation.limits.approval === 'ask' ? ' · asks first' : ''}
                                                {automation.binding.collections?.length
                                                    ? ` · ${automation.binding.collections.map(item => item.name ?? item.id).join(', ')}`
                                                    : ''}
                                                {automation.binding.repos?.length ? ` · ${automation.binding.repos.map(repoLabel).join(', ')}` : ''}
                                                {tokensOf(automation.id) > 0 ? ` · ${formatTokens(tokensOf(automation.id))} tokens today` : ''}
                                                {automation.limits.dailyTokens !== undefined ? ` (limit ${formatTokens(automation.limits.dailyTokens)})` : ''}
                                                {automation.limits.pauseAtUsage !== undefined
                                                    ? ` · pauses at ${automation.limits.pauseAtUsage}% plan usage`
                                                    : ''}
                                            </div>
                                            {automation.description && <div className="settings-row-description">{automation.description}</div>}
                                            {problems.length > 0 && <div className="automation-warning">{problems.join(' ')}</div>}
                                        </div>
                                        <div className="settings-row-control automation-row-actions">
                                            <ButtonGroup role="radiogroup" label={`The status of "${automation.name}"`} onKeyDown={radioGroupKeys}>
                                                {STATUS_OPTIONS.map(option => (
                                                    <Button
                                                        key={option.id}
                                                        title={option.title}
                                                        role="radio"
                                                        aria-checked={automation.status === option.id}
                                                        onClick={() => void setStatus(automation, option.id)}
                                                    >
                                                        {option.label}
                                                    </Button>
                                                ))}
                                            </ButtonGroup>
                                            <IconButton
                                                label={`Run "${automation.name}" now`}
                                                title="Run now"
                                                icon={<Play size={14} />}
                                                onClick={event => void runNow(automation, event.currentTarget)}
                                            />
                                            <IconButton
                                                label="Edit"
                                                icon={<Pencil size={14} />}
                                                onClick={() => setEditing({ automation: structuredClone(automation), previousId: automation.id })}
                                            />
                                            <IconButton
                                                label="More"
                                                icon={<MoreHorizontal size={14} />}
                                                onClick={event => void moreMenu(automation, event.currentTarget)}
                                            />
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </SettingsGroup>

                    {list.problems.length > 0 && (
                        <SettingsGroup title="Files with problems" description="ShipWarden does not run these files. Correct them in a text editor." card>
                            {list.problems.map(problem => (
                                <SettingsRow
                                    key={problem.file}
                                    label={<code>{problem.file}</code>}
                                    description={problem.error}
                                    control={<Button onClick={() => api.reveal(problem.file.replace(/\.json$/, ''))}>Show</Button>}
                                />
                            ))}
                        </SettingsGroup>
                    )}

                    <SettingsGroup
                        title="History"
                        description={history.length === 0 ? 'The runs show here.' : undefined}
                        card={history.length > 0}
                        actions={
                            history.some(run => !isOpenRun(run)) ? (
                                <Button
                                    onClick={() =>
                                        void act(async () => {
                                            await api.clearHistory();
                                            patchRunState(current => ({ ...current, runs: current.runs.filter(isOpenRun) }));
                                        })
                                    }
                                >
                                    Clear
                                </Button>
                            ) : undefined
                        }
                    >
                        {history.map(run => (
                            <div key={run.id} className="settings-row automation-run">
                                <div className="settings-row-main">
                                    <div className="settings-row-text">
                                        <div className="settings-row-label">
                                            <Chip tone={RUN_STATUS_TONES[run.status]}>{RUN_STATUS_LABELS[run.status]}</Chip> {nameOf(run)}
                                        </div>
                                        <div className="settings-row-description">
                                            {run.event.label} · <Age date={new Date(run.updatedAt).toISOString()} format="prose" />
                                            {run.tokens !== undefined ? ` · ${formatTokens(run.tokens)} tokens` : ''}
                                            {run.cacheReads ? (
                                                <span title="Tokens that the agent read from the prompt cache. They cost much less than new input, and the limits do not count them.">
                                                    {` · ${formatTokens(run.cacheReads)} cache reads`}
                                                </span>
                                            ) : (
                                                ''
                                            )}
                                        </div>
                                        {run.detail && <div className="automation-detail">{run.detail}</div>}
                                    </div>
                                    <div className="settings-row-control automation-run-actions">
                                        {run.status === 'held' && <Button onClick={() => void act(() => automationEngine.skip(run.id))}>Skip</Button>}
                                        {run.noteName && <Button onClick={onOpenNotes}>Notes</Button>}
                                        {run.worktreePath && (
                                            <Button
                                                title={run.worktreePath}
                                                icon={<ArrowUpRight size={14} />}
                                                onClick={() => onOpenWorktree(run.worktreePath as string, run.sessionId)}
                                            >
                                                Open
                                            </Button>
                                        )}
                                    </div>
                                </div>
                            </div>
                        ))}
                    </SettingsGroup>
                </div>
            </div>
        </div>
    );
}
