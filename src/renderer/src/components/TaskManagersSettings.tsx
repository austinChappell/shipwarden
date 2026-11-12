import { useEffect, useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, LoaderCircle, Plus, Trash2 } from 'lucide-react';
import type { ConnectionChange, ConnectionInfo, PluginInfo } from '@shared/tasks';
import { optionalErrorText } from '../util';
import { SettingsGroup } from './settings-ui';
import { Button, Card, CardBody, CardFooter, Checkbox, Field, Input, Radio, Select, Switch } from './ui';
import { confirmDialog } from './ConfirmDialog';
import { connectionAdded, connectionChanged, connectionRemoved, connectionSettingsSaved, taskManagerKeys } from './task-managers-cache';

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
    const label = connection.scopeLabel ?? 'scope';
    // The scopes come from the task manager. A save of the settings marks them as stale.
    const scopesQuery = useQuery({
        queryKey: taskManagerKeys.scopes(connection.id),
        queryFn: () => api.scopes(connection.id),
        enabled: connection.configured
    });
    const scopes = scopesQuery.data;
    const error = optionalErrorText(scopesQuery.error);

    if (!connection.configured) {
        return <p className="panel-note">Add the settings above first. Then you can select the {plural(label)}.</p>;
    }
    const mode = value ? 'some' : 'all';
    return (
        <div className="scope-picker">
            <Radio checked={mode === 'all'} onSelect={() => onChange(undefined)} label={`All ${plural(label)}, also new ones`} />
            <Radio checked={mode === 'some'} onSelect={() => onChange(value ?? (scopes ?? []).map(scope => scope.id))} label={`Only these ${plural(label)}:`} />
            {error && <div className="form-error">{error}</div>}
            {!scopes && !error && (
                <div className="panel-note">
                    <LoaderCircle size={12} className="spin" /> Loading the {plural(label)}…
                </div>
            )}
            {scopes && (
                <div className="scope-list">
                    {scopes.map(scope => (
                        <Checkbox
                            key={scope.id}
                            disabled={mode !== 'some'}
                            checked={mode === 'some' && !!value?.includes(scope.id)}
                            onChange={checked => {
                                const current = value ?? [];
                                onChange(checked ? [...current, scope.id] : current.filter(id => id !== scope.id));
                            }}
                            label={
                                <>
                                    {scope.name}
                                    {scope.detail && <span className="scope-detail"> {scope.detail}</span>}
                                </>
                            }
                        />
                    ))}
                    {scopes.length === 0 && <span className="panel-note">This connection has no {plural(label)}.</span>}
                </div>
            )}
        </div>
    );
}

/** The settings fields of a connection. Secret values never come back from the main process, so a saved secret shows as "Saved". */
function ConnectionSettingsForm({ connection }: { connection: ConnectionInfo }) {
    const queryClient = useQueryClient();
    const [values, setValues] = useState<Record<string, string | boolean>>({ ...connection.publicSettings });
    const formId = useId();
    const saveMutation = useMutation({
        mutationFn: (settings: Record<string, string | boolean>) => api.saveConnectionSettings(connection.id, settings),
        onSuccess: () => connectionSettingsSaved(queryClient, connection.id)
    });
    if (connection.settings.length === 0) {
        return null;
    }
    const busy = saveMutation.isPending;
    const error = optionalErrorText(saveMutation.error);
    const save = () => saveMutation.mutate(values);
    return (
        <div className="connection-form">
            {connection.settings.map(setting =>
                setting.type === 'boolean' ? (
                    <Checkbox
                        key={setting.key}
                        label={`${setting.label}${setting.required ? ' *' : ''}`}
                        description={setting.description}
                        checked={!!values[setting.key]}
                        onChange={checked => setValues(v => ({ ...v, [setting.key]: checked }))}
                    />
                ) : (
                    <Field
                        key={setting.key}
                        label={`${setting.label}${setting.required ? ' *' : ''}`}
                        htmlFor={`${formId}-${setting.key}`}
                        hint={setting.description}
                    >
                        <Input
                            id={`${formId}-${setting.key}`}
                            type={setting.type === 'secret' ? 'password' : 'text'}
                            value={typeof values[setting.key] === 'string' ? (values[setting.key] as string) : ''}
                            placeholder={
                                setting.type === 'secret' && connection.settingsWithValue.includes(setting.key) ? 'Saved. Type a new value to change it.' : ''
                            }
                            spellCheck={false}
                            onChange={event => setValues(v => ({ ...v, [setting.key]: event.target.value }))}
                        />
                    </Field>
                )
            )}
            {error && <div className="form-error">{error}</div>}
            <div className="row-buttons">
                <Button disabled={busy} onClick={save}>
                    Save settings
                </Button>
            </div>
        </div>
    );
}

/** One global connection: a summary row that opens to its name, settings and scope. */
function ConnectionCard({ connection, open, onToggle }: { connection: ConnectionInfo; open: boolean; onToggle(): void }) {
    const queryClient = useQueryClient();
    const [name, setName] = useState(connection.name);
    const [startStatus, setStartStatus] = useState(connection.startStatus ?? '');
    useEffect(() => setName(connection.name), [connection.name]);
    useEffect(() => setStartStatus(connection.startStatus ?? ''), [connection.startStatus]);

    const updateMutation = useMutation({
        mutationFn: (change: ConnectionChange) => api.updateConnection(connection.id, change),
        onSuccess: (_result, change) => connectionChanged(queryClient, connection.id, change)
    });
    const removeMutation = useMutation({
        mutationFn: () => api.removeConnection(connection.id),
        onSuccess: () => connectionRemoved(queryClient, connection.id)
    });
    const error = optionalErrorText(updateMutation.error ?? removeMutation.error);
    const update = (change: ConnectionChange) => updateMutation.mutate(change);
    const nameId = useId();
    const statusId = useId();

    const remove = async () => {
        if (
            !(await confirmDialog({
                title: `Remove the task manager "${connection.name}"?`,
                message: 'ShipWarden forgets its settings and its token. Worktrees that are linked to its tasks keep their links.',
                confirmLabel: 'Remove',
                danger: true
            }))
        ) {
            return;
        }
        removeMutation.mutate();
    };

    return (
        <Card tone={open ? 'accent' : 'default'}>
            <div className="card-header">
                <Switch checked={connection.enabled} title={connection.enabled ? 'On in all projects' : 'Off'} onChange={enabled => update({ enabled })} />
                <button className="connection-summary" aria-expanded={open} onClick={onToggle}>
                    <span className="connection-name">{connection.name}</span>
                    <span className="connection-meta">
                        {connection.pluginName !== connection.name && `${connection.pluginName} · `}
                        {scopeSummary(connection.scope, connection.scopeLabel)}
                        {!connection.configured && <span className="connection-warning"> · needs settings</span>}
                    </span>
                    <ChevronRight size={14} strokeWidth={1.8} className={`group-chevron${open ? ' open' : ''}`} />
                </button>
            </div>
            {open && (
                <CardBody className="connection-body">
                    <Field label="Name" htmlFor={nameId}>
                        <Input
                            id={nameId}
                            value={name}
                            onChange={event => setName(event.target.value)}
                            onBlur={() => name.trim() && name !== connection.name && update({ name })}
                        />
                    </Field>
                    <Field
                        label="Status when a worktree starts"
                        htmlFor={statusId}
                        hint="When you start a worktree from a task, the task moves to the status with this name, if its list has one. ShipWarden ignores case. Empty: the status does not change."
                    >
                        <Input
                            id={statusId}
                            value={startStatus}
                            placeholder="for example: in progress"
                            spellCheck={false}
                            onChange={event => setStartStatus(event.target.value)}
                            onBlur={() => startStatus.trim() !== (connection.startStatus ?? '') && update({ startStatus: startStatus.trim() || null })}
                            onKeyDown={event => event.key === 'Enter' && (event.target as HTMLInputElement).blur()}
                        />
                    </Field>
                    <ConnectionSettingsForm key={connection.settingsWithValue.join(',')} connection={connection} />
                    <Field label={plural(connection.scopeLabel).replace(/^./, letter => letter.toUpperCase())}>
                        <ScopePicker connection={connection} value={connection.scope} onChange={scope => update({ scope: scope ?? null })} />
                    </Field>
                    {error && <div className="form-error">{error}</div>}
                </CardBody>
            )}
            {open && (
                <CardFooter>
                    <Button variant="danger" icon={<Trash2 size={13} strokeWidth={1.8} />} onClick={remove}>
                        Remove
                    </Button>
                </CardFooter>
            )}
        </Card>
    );
}

/**
 * The task manager settings: the connections (for example two ClickUp accounts and GitHub), each with an on/off
 * switch, its settings and an optional scope. All projects use the connections that are on.
 */
export function TaskManagersSettings() {
    const queryClient = useQueryClient();
    const [openId, setOpenId] = useState<string>();
    const [adding, setAdding] = useState('');

    // The settings page shows the current state. The cached lists show first, and new lists load each time that the page opens.
    const pluginsQuery = useQuery({ queryKey: taskManagerKeys.plugins, queryFn: () => api.plugins(), staleTime: 0 });
    const connectionsQuery = useQuery({ queryKey: taskManagerKeys.allConnections, queryFn: () => api.connections(), staleTime: 0 });
    const plugins = pluginsQuery.data ?? [];
    const connections = connectionsQuery.data;

    const addMutation = useMutation({
        mutationFn: (plugin: PluginInfo) => {
            const existing = (connections ?? []).filter(item => item.pluginId === plugin.id).length;
            return api.addConnection(plugin.id, existing ? `${plugin.name} ${existing + 1}` : plugin.name);
        },
        onSuccess: created => {
            setAdding('');
            setOpenId(created.id);
            connectionAdded(queryClient, created);
        }
    });
    const error = optionalErrorText(addMutation.error ?? pluginsQuery.error ?? connectionsQuery.error);

    const add = () => {
        const plugin = plugins.find(item => item.id === adding);
        if (plugin) addMutation.mutate(plugin);
    };

    return (
        <div className="task-managers">
            <SettingsGroup
                title="Connected task managers"
                description="All projects use the task managers that are on. Open one to change its settings and the workspaces or organizations it includes."
                actions={
                    <div className="add-connection">
                        <Select
                            value={adding}
                            aria-label="Task manager to add"
                            options={[{ value: '', label: 'Add a task manager…' }, ...plugins.map(plugin => ({ value: plugin.id, label: plugin.name }))]}
                            onChange={setAdding}
                        />
                        <Button icon={<Plus size={13} strokeWidth={1.8} />} disabled={!adding} onClick={add}>
                            Add
                        </Button>
                    </div>
                }
            >
                <div className="connection-list">
                    {connections?.map(connection => (
                        <ConnectionCard
                            key={connection.id}
                            connection={connection}
                            open={openId === connection.id}
                            onToggle={() => setOpenId(id => (id === connection.id ? undefined : connection.id))}
                        />
                    ))}
                    {connections?.length === 0 && <p className="panel-note">No task managers yet. Add ClickUp or GitHub above.</p>}
                </div>
            </SettingsGroup>

            {error && <div className="form-error">{error}</div>}
        </div>
    );
}
