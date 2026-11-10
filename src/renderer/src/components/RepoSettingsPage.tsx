import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { agentForRepo, REPO_COLORS, repoDisplayName, type AppSettings, type RepoColor, type RepoSettings } from '@shared/settings';
import type { CopyIgnoredSettings, RepoWorktreeSettings } from '@shared/worktree-settings';
import { CopyEditor, CopyPreview, FolderField } from './WorktreeSettings';
import { errorText } from '../util';
import { SettingsGroup, SettingsRow } from './settings-ui';
import { radioGroupKeys } from './keyboard';

interface Props {
    repo: string;
    settings: AppSettings;
    onSave(change: Partial<AppSettings>): Promise<void>;
}

function folderName(repo: string): string {
    return repo.split('/').filter(Boolean).pop() ?? repo;
}

/** The settings of one repository: its name, its default agent and its color. */
export function RepoSettingsPage({ repo, settings, onSave }: Props) {
    const current = settings.repos[repo] ?? {};
    const [name, setName] = useState(current.name ?? '');
    const [error, setError] = useState<string>();
    useEffect(() => setName(settings.repos[repo]?.name ?? ''), [repo, settings.repos]);

    /** Saves a change. A value that is undefined or empty goes back to the default. */
    const update = async (change: Partial<RepoSettings>) => {
        const next: RepoSettings = { ...current, ...change };
        for (const key of Object.keys(next) as (keyof RepoSettings)[]) {
            if (next[key] === undefined || next[key] === '') delete next[key];
        }
        const repos = { ...settings.repos };
        if (Object.keys(next).length > 0) {
            repos[repo] = next;
        } else {
            delete repos[repo];
        }
        setError(undefined);
        try {
            await onSave({ repos });
        } catch (err) {
            setError(errorText(err));
        }
    };

    const defaultAgent = agentForRepo({ ...settings, repos: {} }, undefined);
    const commitName = () => {
        const trimmed = name.trim();
        if (trimmed !== (current.name ?? '')) {
            update({ name: trimmed && trimmed !== folderName(repo) ? trimmed : undefined });
        }
    };

    return (
        <>
        <SettingsGroup title={repoDisplayName(settings, repo)} description={<span className="mono">{repo}</span>} card>
            <SettingsRow
                label="Name"
                description="The name in the sidebar and the other views. Empty means the folder name."
                control={(
                    <input
                        className="settings-input"
                        value={name}
                        placeholder={folderName(repo)}
                        onChange={event => setName(event.target.value)}
                        onBlur={commitName}
                        onKeyDown={event => event.key === 'Enter' && (event.target as HTMLInputElement).blur()}
                    />
                )}
            />
            <SettingsRow
                label="Default agent"
                description="The agent that the Agent button and Start in worktree start in this repository. Add agents in Settings > Agents."
                control={(
                    <select className="tasks-select" value={current.agentId ?? ''} onChange={event => update({ agentId: event.target.value || undefined })}>
                        <option value="">Global default ({defaultAgent.name})</option>
                        {settings.agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                    </select>
                )}
            />
            <SettingsRow
                label="Color"
                description="A color marker for the repository in the sidebar and the Agents view."
                control={(
                    <div className="color-picker" role="radiogroup" aria-label="Repository color" onKeyDown={radioGroupKeys}>
                        <button
                            className={`color-swatch none${current.color ? '' : ' selected'}`}
                            role="radio"
                            aria-checked={!current.color}
                            title="No color"
                            onClick={() => update({ color: undefined })}
                        />
                        {(Object.keys(REPO_COLORS) as RepoColor[]).map(color => (
                            <button
                                key={color}
                                className={`color-swatch${current.color === color ? ' selected' : ''}`}
                                role="radio"
                                aria-checked={current.color === color}
                                title={color[0].toUpperCase() + color.slice(1)}
                                style={{ background: REPO_COLORS[color] }}
                                onClick={() => update({ color })}
                            >
                                {current.color === color && <Check size={12} strokeWidth={3} />}
                            </button>
                        ))}
                    </div>
                )}
            />
            {error && <SettingsRow label={<span className="form-error">{error}</span>} />}
        </SettingsGroup>
        <RepoWorktreeGroup repo={repo} settings={settings} current={current.worktrees} onChange={worktrees => update({ worktrees })} />
        </>
    );
}

type CopyMode = 'global' | 'custom' | 'off';

/** A script field. It saves when the field loses focus. */
function ScriptField({ value, placeholder, onSave }: { value: string | undefined; placeholder: string; onSave(value: string | undefined): void }) {
    const [text, setText] = useState(value ?? '');
    useEffect(() => setText(value ?? ''), [value]);
    return (
        <textarea
            className="settings-input mono script-field"
            value={text}
            spellCheck={false}
            placeholder={placeholder}
            onChange={event => setText(event.target.value)}
            onBlur={() => {
                const next = text.trim() ? text.replace(/\s+$/, '') : undefined;
                if ((next ?? '') !== (value ?? '')) onSave(next);
            }}
        />
    );
}

/** The worktree settings of one repository: folder, copied files, and the setup and teardown scripts. */
function RepoWorktreeGroup({ repo, settings, current, onChange }: {
    repo: string;
    settings: AppSettings;
    current: RepoWorktreeSettings | undefined;
    onChange(value: RepoWorktreeSettings | undefined): void;
}) {
    const [defaultFolder, setDefaultFolder] = useState('~/.shipwarden/worktrees');
    useEffect(() => {
        window.shipwarden.worktrees.defaultFolder().then(setDefaultFolder, () => undefined);
    }, []);
    const global = settings.worktrees;
    const copy = current?.copyIgnored;
    const mode: CopyMode = !copy ? 'global' : copy.enabled ? 'custom' : 'off';
    const effective = copy ?? global.copyIgnored;

    /** Saves a change. Empty values are removed, so the global setting applies again. */
    const save = (change: Partial<RepoWorktreeSettings>) => {
        const next: RepoWorktreeSettings = { ...current, ...change };
        for (const key of Object.keys(next) as (keyof RepoWorktreeSettings)[]) {
            if (next[key] === undefined) delete next[key];
        }
        onChange(Object.keys(next).length > 0 ? next : undefined);
    };
    const setMode = (value: CopyMode) => {
        // "Custom" starts from the global values, so the user changes only what differs.
        const base = copy ?? global.copyIgnored;
        const copyIgnored: CopyIgnoredSettings | undefined = value === 'global' ? undefined : { ...base, enabled: value === 'custom' };
        save({ copyIgnored });
    };
    const globalFolder = `${global.directory ?? defaultFolder}/${repo.split('/').filter(Boolean).pop()}`;

    return (
        <SettingsGroup
            title="Worktrees"
            description="The worktree settings of this repository. An empty value uses the global setting in Settings › Worktrees."
            card
        >
            <SettingsRow label="Folder" description={<>New worktrees of this repository go to <code>{current?.directory ?? globalFolder}/&lt;branch&gt;</code>.</>}>
                <FolderField value={current?.directory} placeholder={globalFolder} onSave={directory => save({ directory })} />
            </SettingsRow>
            <SettingsRow
                label="Copy ignored files"
                description="Git-ignored files from the main worktree that each new worktree of this repository gets."
            >
                {/* The choice is below the label, so the label and the description keep the full width. */}
                <div className="segmented compact copy-source" role="radiogroup" aria-label="Copy settings" onKeyDown={radioGroupKeys}>
                    {(['global', 'custom', 'off'] as CopyMode[]).map(item => (
                        <button key={item} role="radio" aria-checked={mode === item} className={mode === item ? 'selected' : ''} onClick={() => setMode(item)}>
                            {item === 'global' ? 'Global' : item === 'custom' ? 'Custom' : 'Off'}
                        </button>
                    ))}
                </div>
                {mode === 'global' && (
                    <div className="panel-note copy-summary">
                        {!global.copyIgnored.enabled
                            ? 'The global setting is off.'
                            : global.copyIgnored.mode === 'allExcept'
                                ? <>Global: all ignored files except {global.copyIgnored.exclude.map(item => <code key={item}>{item}</code>)}</>
                                : <>Global: only {global.copyIgnored.patterns.map(item => <code key={item}>{item}</code>)}</>}
                    </div>
                )}
                {mode === 'custom' && copy && <CopyEditor copy={copy} repo={repo} onSave={next => save({ copyIgnored: { ...next, enabled: true } })} />}
                {mode === 'global' && effective.enabled && <CopyPreview repo={repo} copy={effective} />}
            </SettingsRow>
            <SettingsRow
                label="Setup script"
                description={(
                    <>
                        Runs in a &quot;Setup&quot; terminal tab of each new worktree, for example <code>npm ci</code>. The script gets
                        {' '}<code>SHIPWARDEN_ROOT_PATH</code> (the main worktree), <code>SHIPWARDEN_WORKTREE_PATH</code>, <code>SHIPWARDEN_BRANCH</code> and <code>SHIPWARDEN_REPO_NAME</code>.
                    </>
                )}
            >
                <ScriptField value={current?.setupScript} placeholder={'npm ci\ncp "$SHIPWARDEN_ROOT_PATH/.env" .'} onSave={setupScript => save({ setupScript })} />
            </SettingsRow>
            <SettingsRow
                label="Teardown script"
                description="Runs in the worktree before ShipWarden removes it, for example to stop containers. It has the same variables and a limit of 5 minutes. When it fails, ShipWarden shows the output and asks before it removes the worktree."
            >
                <ScriptField value={current?.teardownScript} placeholder="docker compose down" onSave={teardownScript => save({ teardownScript })} />
            </SettingsRow>
        </SettingsGroup>
    );
}
