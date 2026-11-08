import { useCallback, useEffect, useState } from 'react';
import { ChevronRight, LoaderCircle, Plus, Trash2 } from 'lucide-react';
import type { ConnectionChange, ConnectionInfo, PluginInfo, TaskScope } from '@shared/tasks';
import { errorText } from '../util';
import { SettingsGroup } from './settings-ui';
import { confirmDialog } from './ConfirmDialog';

const api = window.shipwarden.tasks;

function plural(label: string | undefined): string {
    const word = label ?? 'scope';
    return word.endsWith('y') ? `${word.slice(0, -1)}ies` : `${word}s`;
}

/** A short text for a scope, for example "All workspaces" or "2 organizations". */
function scopeSummary(scope: string[] | undefined, label: string | undefined): string {
    if (!scope) return `All ${plural(label)}`;
    if (scope.length === 1) return `1 ${label ?? 'scope'}`;
    return `${scope.length} ${plural(label)}`;
}

interface ScopePickerProps {
    connection: ConnectionInfo;
    /** The selected scope. Undefined means all scopes. */
    value: string[] | undefined;
    onChange(scope: string[] | undefined): void;
}

/**
 * Selects the scopes of a connection, for example the ClickUp workspaces or GitHub organizations to include.
 * The list comes from the plugin, so the connection must have its settings first.
 */
function ScopePicker({ connection, value, onChange }: ScopePickerProps) {
    const [scopes, setScopes] = useState<TaskScope[]>();
    const [error, setError] = useState<string>();
    const label = connection.scopeLabel ?? 'scope';

    useEffect(() => {
        if (!connection.configured) return;
        let cancelled = false;
        setScopes(undefined);
        setError(undefined);
        api.scopes(connection.id).then(list => !cancelled && setScopes(list), err => !cancelled && setError(errorText(err)));
        return () => {
            cancelled = true;
        };
    }, [connection.id, connection.configured]);

    if (!connection.configured) {
        return <p className="panel-note">Add the settings above first. Then you can select the {plural(label)}.</p>;
    }
    const mode = value ? 'some' : 'all';
    return (
        <div className="scope-picker">
            <label className="scope-option">
                <input type="radio" checked={mode === 'all'} onChange={() => onChange(undefined)} />
                All {plural(label)}, also new ones
            </label>
            <label className="scope-option">
                <input type="radio" checked={mode === 'some'} onChange={() => onChange(value ?? (scopes ?? []).map(scope => scope.id))} />
                Only these {plural(label)}:
            </label>
            {error && <div className="form-error">{error}</div>}
            {!scopes && !error && <div className="panel-note"><LoaderCircle size={12} className="spin" /> Loading the {plural(label)}…</div>}
            {scopes && (
                <div className={`scope-list${mode === 'some' ? '' : ' disabled'}`}>
                    {scopes.map(scope => (
                        <label key={scope.id} className="scope-item">
                            <input
                                type="checkbox"
                                disabled={mode !== 'some'}
                                checked={mode === 'some' && !!value?.includes(scope.id)}
                                onChange={event => {
                                    const current = value ?? [];
                                    onChange(event.target.checked ? [...current, scope.id] : current.filter(id => id !== scope.id));
                                }}
                            />
                            <span>{scope.name}</span>
                            {scope.detail && <span className="scope-detail">{scope.detail}</span>}
                        </label>
                    ))}
                    {scopes.length === 0 && <span className="panel-note">This connection has no {plural(label)}.</span>}
                </div>
            )}
        </div>
    );
}

/** The settings fields of a connection. Secret values never come back from the main process, so a saved secret shows as "Saved". */
function ConnectionSettingsForm({ connection, onSaved }: { connection: ConnectionInfo; onSaved(): void }) {
    const [values, setValues] = useState<Record<string, string | boolean>>({ ...connection.publicSettings });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();
    if (connection.settings.length === 0) {
        return null;
    }
    const save = async () => {
        setBusy(true);
        setError(undefined);
        try {
            await api.saveConnectionSettings(connection.id, values);
            onSaved();
        } catch (err) {
            setError(errorText(err));
        } finally {
            setBusy(false);
        }
    };
    return (
        <div className="connection-form">
            {connection.settings.map(setting => (
                <label key={setting.key} className="setting-row">
                    <span className="setting-label">{setting.label}{setting.required ? ' *' : ''}</span>
                    {setting.type === 'boolean' ? (
                        <input type="checkbox" checked={!!values[setting.key]} onChange={event => setValues(v => ({ ...v, [setting.key]: event.target.checked }))} />
                    ) : (
                        <input
                            type={setting.type === 'secret' ? 'password' : 'text'}
                            value={typeof values[setting.key] === 'string' ? values[setting.key] as string : ''}
                            placeholder={setting.type === 'secret' && connection.settingsWithValue.includes(setting.key) ? 'Saved. Type a new value to change it.' : ''}
                            spellCheck={false}
                            onChange={event => setValues(v => ({ ...v, [setting.key]: event.target.value }))}
                        />
                    )}
                    {setting.description && <span className="panel-note">{setting.description}</span>}
                </label>
            ))}
            {error && <div className="form-error">{error}</div>}
            <div className="row-buttons">
                <button className="button" disabled={busy} onClick={save}>Save settings</button>
            </div>
        </div>
    );
}

/** One global connection: a summary row that opens to its name, settings and scope. */
function ConnectionCard({ connection, open, onToggle, onChanged }: { connection: ConnectionInfo; open: boolean; onToggle(): void; onChanged(): void }) {
    const [name, setName] = useState(connection.name);
    const [startStatus, setStartStatus] = useState(connection.startStatus ?? '');
    const [error, setError] = useState<string>();
    useEffect(() => setName(connection.name), [connection.name]);
    useEffect(() => setStartStatus(connection.startStatus ?? ''), [connection.startStatus]);

    const update = async (change: ConnectionChange) => {
        setError(undefined);
        try {
            await api.updateConnection(connection.id, change);
            onChanged();
        } catch (err) {
            setError(errorText(err));
        }
    };

    const remove = async () => {
        if (!(await confirmDialog({
            title: `Remove the task manager "${connection.name}"?`,
            message: 'ShipWarden forgets its settings and its token. Worktrees that are linked to its tasks keep their links.',
            confirmLabel: 'Remove',
            danger: true
        }))) {
            return;
        }
        try {
            await api.removeConnection(connection.id);
            onChanged();
        } catch (err) {
            setError(errorText(err));
        }
    };

    return (
        <div className={`connection-card${open ? ' open' : ''}`}>
            <div className="connection-row">
                <label className="switch" title={connection.enabled ? 'On in all projects' : 'Off'}>
                    <input type="checkbox" checked={connection.enabled} onChange={event => update({ enabled: event.target.checked })} />
                    <span />
                </label>
                <button className="connection-summary" aria-expanded={open} onClick={onToggle}>
                    <span className="connection-name">{connection.name}</span>
                    <span className="connection-meta">
                        {connection.pluginName !== connection.name && `${connection.pluginName} · `}{scopeSummary(connection.scope, connection.scopeLabel)}
                        {!connection.configured && <span className="connection-warning"> · needs settings</span>}
                    </span>
                    <ChevronRight size={14} strokeWidth={1.8} className={`group-chevron${open ? ' open' : ''}`} />
                </button>
            </div>
            {open && (
                <div className="connection-body">
                    <label className="setting-row">
                        <span className="setting-label">Name</span>
                        <input value={name} onChange={event => setName(event.target.value)} onBlur={() => name.trim() && name !== connection.name && update({ name })} />
                    </label>
                    <label className="setting-row">
                        <span className="setting-label">Status when a worktree starts</span>
                        <input
                            value={startStatus}
                            placeholder="for example: in progress"
                            spellCheck={false}
                            onChange={event => setStartStatus(event.target.value)}
                            onBlur={() => startStatus.trim() !== (connection.startStatus ?? '') && update({ startStatus: startStatus.trim() || null })}
                            onKeyDown={event => event.key === 'Enter' && (event.target as HTMLInputElement).blur()}
                        />
                        <span className="panel-note">
                            When you start a worktree from a task, the task moves to the status with this name, if its list has one.
                            ShipWarden ignores case. Empty: the status does not change.
                        </span>
                    </label>
                    <ConnectionSettingsForm key={connection.settingsWithValue.join(',')} connection={connection} onSaved={onChanged} />
                    <div className="connection-section-label">{plural(connection.scopeLabel).replace(/^./, letter => letter.toUpperCase())}</div>
                    <ScopePicker connection={connection} value={connection.scope} onChange={scope => update({ scope: scope ?? null })} />
                    {error && <div className="form-error">{error}</div>}
                    <div className="row-buttons">
                        <button className="button danger" onClick={remove}><Trash2 size={13} strokeWidth={1.8} />Remove</button>
                    </div>
                </div>
            )}
        </div>
    );
}

/**
 * The task manager settings: the connections (for example two ClickUp accounts and GitHub), each with an on/off
 * switch, its settings and an optional scope. All projects use the connections that are on.
 */
export function TaskManagersSettings() {
    const [plugins, setPlugins] = useState<PluginInfo[]>([]);
    const [connections, setConnections] = useState<ConnectionInfo[]>();
    const [openId, setOpenId] = useState<string>();
    const [adding, setAdding] = useState('');
    const [error, setError] = useState<string>();

    const reload = useCallback(async () => {
        try {
            const [pluginList, connectionList] = await Promise.all([api.plugins(), api.connections()]);
            setPlugins(pluginList);
            setConnections(connectionList);
        } catch (err) {
            setError(errorText(err));
        }
    }, []);

    useEffect(() => {
        reload();
    }, [reload]);

    const add = async () => {
        const plugin = plugins.find(item => item.id === adding);
        if (!plugin) return;
        try {
            const existing = (connections ?? []).filter(item => item.pluginId === plugin.id).length;
            const created = await api.addConnection(plugin.id, existing ? `${plugin.name} ${existing + 1}` : plugin.name);
            setAdding('');
            setOpenId(created.id);
            await reload();
        } catch (err) {
            setError(errorText(err));
        }
    };


    return (
        <div className="task-managers">
            <SettingsGroup
                title="Connected task managers"
                description="All projects use the task managers that are on. Open one to change its settings and the workspaces or organizations it includes."
                actions={(
                    <div className="add-connection">
                        <select className="tasks-select" value={adding} aria-label="Task manager to add" onChange={event => setAdding(event.target.value)}>
                            <option value="">Add a task manager…</option>
                            {plugins.map(plugin => <option key={plugin.id} value={plugin.id}>{plugin.name}</option>)}
                        </select>
                        <button className="button" disabled={!adding} onClick={add}><Plus size={13} strokeWidth={1.8} />Add</button>
                    </div>
                )}
            >
                <div className="connection-list">
                    {connections?.map(connection => (
                        <ConnectionCard
                            key={connection.id}
                            connection={connection}
                            open={openId === connection.id}
                            onToggle={() => setOpenId(id => (id === connection.id ? undefined : connection.id))}
                            onChanged={reload}
                        />
                    ))}
                    {connections?.length === 0 && <p className="panel-note">No task managers yet. Add ClickUp or GitHub above.</p>}
                </div>
            </SettingsGroup>

            {error && <div className="form-error">{error}</div>}
        </div>
    );
}
