import { useEffect, useState } from 'react';
import { CircleAlert, CircleCheck, Plus, Trash2 } from 'lucide-react';
import { AGENT_MODES, modesOf, type AgentMode } from '@shared/agent-modes';
import { agentProgramOf } from '@shared/agent-programs';
import { hookAgentOf } from '@shared/agents';
import { cleanCommand, commandProgram, missingDefaultAgents, type AgentDefinition, type AppSettings, type CommandCheck } from '@shared/settings';
import { errorText } from '../util';
import { Button, Chip, IconButton, Input, Select, Switch } from './ui';
import { SettingsGroup, SettingsRow } from './settings-ui';
import { AGENT_CHAT_ENABLED } from '../terminal/agent-view-store';
import { DraftSettingsGroup } from './DraftSettings';

const api = window.shipwarden;

/** The time after the last key press before the page checks a command. */
const CHECK_DELAY_MS = 300;

/** Checks the program of a command in the login shell PATH, after the user stops typing. */
function useCommandCheck(command: string): CommandCheck | undefined {
    const [check, setCheck] = useState<CommandCheck>();
    useEffect(() => {
        let current = true;
        const timer = setTimeout(() => {
            api.settings.checkCommand(command).then(
                result => current && setCheck(result),
                () => current && setCheck(undefined)
            );
        }, CHECK_DELAY_MS);
        return () => {
            current = false;
            clearTimeout(timer);
        };
    }, [command]);
    return command.trim() ? check : undefined;
}

function CommandCheckLine({ command }: { command: string }) {
    const check = useCommandCheck(command);
    if (!check) return null;
    const agent = hookAgentOf(commandProgram(command));
    const hooks =
        agent === 'claude'
            ? ' ShipWarden shows its state from Claude Code hooks.'
            : agent === 'gemini'
              ? ' ShipWarden shows its state from Gemini CLI hooks.'
              : agent === 'opencode'
                ? ' ShipWarden shows its state from an opencode plugin.'
                : ' ShipWarden shows only that it runs.';
    return check.path ? (
        <span className="settings-check ok">
            <CircleCheck size={13} strokeWidth={2} /> {check.path}.{hooks}
        </span>
    ) : (
        <span className="settings-check warn">
            <CircleAlert size={13} strokeWidth={2} /> "{check.program}" is not in the PATH of your login shell. It can still work if it is a shell alias or
            function.
        </span>
    );
}

interface RowProps {
    agent: AgentDefinition;
    isDefault: boolean;
    canRemove: boolean;
    onChange(agent: AgentDefinition): void;
    onMakeDefault(): void;
    onRemove(): void;
}

/** One agent: the default choice, the name, the command, and the mode. A text change saves when the field loses focus. */
function AgentRow({ agent, isDefault, canRemove, onChange, onMakeDefault, onRemove }: RowProps) {
    const [name, setName] = useState(agent.name);
    const [command, setCommand] = useState(agent.command);
    useEffect(() => setName(agent.name), [agent.name]);
    useEffect(() => setCommand(agent.command), [agent.command]);

    const commit = () => {
        const cleaned = cleanCommand(command);
        if (!cleaned) {
            setCommand(agent.command);
            return;
        }
        const nextName = name.trim() || agent.name;
        if (nextName !== agent.name || cleaned !== agent.command) {
            // A new program can lack the mode of the old program. Then the agent uses its own setting.
            const keepMode = agent.mode && modesOf(agentProgramOf(cleaned)).includes(agent.mode);
            const { mode: _mode, ...rest } = agent;
            onChange({ ...rest, name: nextName, command: cleaned, ...(keepMode ? { mode: agent.mode } : {}) });
        }
    };

    const modes = modesOf(agentProgramOf(agent.command));
    const changeMode = (value: AgentMode | '') => {
        const { mode: _mode, ...rest } = agent;
        onChange(value ? { ...rest, mode: value } : rest);
    };

    return (
        <div className="settings-row agent-setting">
            <div className="agent-setting-main">
                <label className="agent-default" title={isDefault ? 'The default agent' : 'Make this the default agent'}>
                    <input type="radio" name="default-agent" checked={isDefault} onChange={onMakeDefault} />
                    {isDefault && <Chip tone="info">Default</Chip>}
                </label>
                <Input
                    className="agent-name-field"
                    aria-label="Agent name"
                    value={name}
                    onChange={event => setName(event.target.value)}
                    onBlur={commit}
                    onKeyDown={event => event.key === 'Enter' && (event.target as HTMLInputElement).blur()}
                />
                <Input
                    className="agent-command-field"
                    mono
                    aria-label="Agent command"
                    value={command}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={event => setCommand(event.target.value)}
                    onBlur={commit}
                    onKeyDown={event => event.key === 'Enter' && (event.target as HTMLInputElement).blur()}
                />
                <Select<AgentMode | ''>
                    className="agent-mode-select"
                    aria-label="Agent mode"
                    title={
                        modes.length > 0
                            ? 'The permission mode of a new session. An automation can set another mode.'
                            : 'ShipWarden sets a mode only for Claude Code, Codex, Gemini CLI, and opencode.'
                    }
                    disabled={modes.length === 0}
                    value={agent.mode ?? ''}
                    options={[
                        { value: '', label: 'Own setting' },
                        ...AGENT_MODES.filter(item => modes.includes(item.mode)).map(item => ({ value: item.mode, label: item.label }))
                    ]}
                    onChange={changeMode}
                />
                <IconButton
                    icon={<Trash2 size={14} strokeWidth={1.6} />}
                    label={canRemove ? 'Remove this agent' : 'ShipWarden needs at least one agent'}
                    tone="danger"
                    disabled={!canRemove}
                    onClick={onRemove}
                />
            </div>
            <CommandCheckLine command={command} />
        </div>
    );
}

/** The agents that the Agent button can start, and the default agent. A repository can select another agent in its settings. */
export function AgentsSettings({ settings, onSave }: { settings: AppSettings; onSave(change: Partial<AppSettings>): Promise<void> }) {
    const [newName, setNewName] = useState('');
    const [newCommand, setNewCommand] = useState('');
    const [error, setError] = useState<string>();

    const save = async (change: Partial<AppSettings>) => {
        setError(undefined);
        try {
            await onSave(change);
        } catch (err) {
            setError(errorText(err));
        }
    };

    const replace = (agent: AgentDefinition) => save({ agents: settings.agents.map(item => (item.id === agent.id ? agent : item)) });

    const remove = (agent: AgentDefinition) => {
        const agents = settings.agents.filter(item => item.id !== agent.id);
        save({ agents, defaultAgentId: settings.defaultAgentId === agent.id ? agents[0].id : settings.defaultAgentId });
    };

    const add = () => {
        const command = cleanCommand(newCommand);
        if (!command) {
            setError('Type the command that starts the agent, for example "aider" or "claude --model opus".');
            return;
        }
        const id = `agent-${Date.now().toString(36)}`;
        save({ agents: [...settings.agents, { id, name: newName.trim() || commandProgram(command), command }] });
        setNewName('');
        setNewCommand('');
    };

    return (
        <>
            <SettingsGroup
                title="Agents"
                description={
                    'The agents that the Agent button can start. Each one runs in your login shell, so your PATH applies. A repository can use another agent than the default in its repository settings. The mode is the permission mode of a new session. With "Own setting", the agent uses its own configuration.'
                }
                card
            >
                {settings.agents.map(agent => (
                    <AgentRow
                        key={agent.id}
                        agent={agent}
                        isDefault={agent.id === settings.defaultAgentId}
                        canRemove={settings.agents.length > 1}
                        onChange={replace}
                        onMakeDefault={() => save({ defaultAgentId: agent.id })}
                        onRemove={() => remove(agent)}
                    />
                ))}
                <form
                    className="settings-row agent-add agent-add-form"
                    onSubmit={event => {
                        event.preventDefault();
                        add();
                    }}
                >
                    <span className="agent-add-label">Add</span>
                    <Input
                        className="agent-name-field"
                        placeholder="Name"
                        aria-label="New agent name"
                        value={newName}
                        onChange={event => setNewName(event.target.value)}
                    />
                    <Input
                        className="agent-command-field"
                        mono
                        placeholder="Command, for example aider"
                        aria-label="New agent command"
                        spellCheck={false}
                        autoComplete="off"
                        value={newCommand}
                        onChange={event => setNewCommand(event.target.value)}
                    />
                    <Button type="submit" icon={<Plus size={13} strokeWidth={1.8} />} disabled={!newCommand.trim()}>
                        Add
                    </Button>
                </form>
                {missingDefaultAgents(settings.agents).length > 0 && (
                    <div className="settings-row agent-add">
                        <span className="agent-add-label">Built-in</span>
                        {missingDefaultAgents(settings.agents).map(agent => (
                            <Button
                                key={agent.id}
                                icon={<Plus size={13} strokeWidth={1.8} />}
                                title={`Add ${agent.name} (${agent.command}) to the list`}
                                onClick={() => save({ agents: [...settings.agents, agent] })}
                            >
                                {agent.name}
                            </Button>
                        ))}
                    </div>
                )}
                {error && (
                    <div className="settings-row">
                        <div className="form-error">{error}</div>
                    </div>
                )}
            </SettingsGroup>
            {AGENT_CHAT_ENABLED && (
                <SettingsGroup title="Agent tabs" card>
                    <SettingsRow
                        label="Show agent tabs as a chat"
                        description="A Claude Code tab shows its messages as a chat, with a prompt field at the bottom. The agent still runs in the terminal. Each tab can show the terminal at any time. Other agents always show the terminal."
                        control={<Switch checked={settings.agentChat} title="Show agent tabs as a chat" onChange={agentChat => void save({ agentChat })} />}
                    />
                </SettingsGroup>
            )}
            <DraftSettingsGroup settings={settings} onSave={save} />
        </>
    );
}
