import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { isValidCliAlias, type CliInstallState } from '@shared/cli';
import type { AppSettings } from '@shared/settings';
import { keyRoots } from '../query-client';
import { errorText } from '../util';
import { SettingsGroup, SettingsRow } from './settings-ui';
import { Button, Input, Switch } from './ui';

const api = window.shipwarden.cli;

/** The text under "Install the shipwarden command": where the link is, and if the shell finds it. */
function stateText(state: CliInstallState | undefined): string {
    if (!state) return 'Checking the link.';
    if (!state.installed) return 'Adds a link in /usr/local/bin. When that folder is not writable, the link goes to ~/.local/bin.';
    const where = `Installed in ${state.installed}.`;
    return state.inPath ? where : `${where} Add the folder of the link to the PATH of your shell, or type the full path.`;
}

/** The text under "Short name": what the alias does, and the state of its link. */
function aliasText(state: CliInstallState | undefined, alias: AppSettings['cliAlias']): string {
    const what = `Type “${alias.name}” in place of “shipwarden”.`;
    if (!alias.enabled) return 'Off. Only the shipwarden command is available.';
    if (state?.aliasConflict) return `${state.aliasConflict} exists, and it is not a link of ShipWarden. ShipWarden does not replace it. Choose another name.`;
    if (state?.alias) return `${what} Installed in ${state.alias}.`;
    return `${what} Install adds the link next to the shipwarden link.`;
}

/** The `shipwarden` command (Settings › Agents): the link in a bin folder, its short name, and the skill file for agents. */
export function CliSettingsGroup({ settings, onSave }: { settings: AppSettings; onSave(change: Partial<AppSettings>): Promise<void> }) {
    const queryClient = useQueryClient();
    const [error, setError] = useState<string>();
    const [busy, setBusy] = useState(false);
    const [aliasName, setAliasName] = useState(settings.cliAlias.name);
    const state = useQuery({ queryKey: keyRoots.cliInstall, queryFn: () => api.installState() });
    useEffect(() => setAliasName(settings.cliAlias.name), [settings.cliAlias.name]);

    const change = async (action: () => Promise<CliInstallState>) => {
        setError(undefined);
        setBusy(true);
        try {
            queryClient.setQueryData<CliInstallState>(keyRoots.cliInstall, await action());
        } catch (err) {
            setError(errorText(err));
        } finally {
            setBusy(false);
        }
    };
    const installed = !!state.data?.installed;

    // The main process changes the alias link with the setting. The page then reads the new state of the links.
    const saveAlias = async (cliAlias: AppSettings['cliAlias']) => {
        await onSave({ cliAlias });
        await queryClient.invalidateQueries({ queryKey: keyRoots.cliInstall });
    };
    const trimmed = aliasName.trim();
    const aliasValid = isValidCliAlias(trimmed);
    const commitName = () => {
        if (!aliasValid) {
            setAliasName(settings.cliAlias.name);
            return;
        }
        if (trimmed !== settings.cliAlias.name) void saveAlias({ ...settings.cliAlias, name: trimmed });
    };

    return (
        <SettingsGroup
            title="Command line"
            description="The shipwarden command controls ShipWarden from a terminal: list worktrees, create and remove them, start agents, send prompts, wait for a turn, move tasks, and run automations. ShipWarden must be open. The commands that change something ask you the first time in each worktree, as the MCP tools do."
            card
        >
            <SettingsRow
                label="Install the shipwarden command"
                description={stateText(state.data)}
                control={
                    <Button size="sm" disabled={busy || !state.data} onClick={() => void change(installed ? api.remove : api.install)}>
                        {installed ? 'Remove' : 'Install'}
                    </Button>
                }
            >
                {error && <div className="form-error">{error}</div>}
            </SettingsRow>
            <SettingsRow
                label="Short name"
                description={aliasText(state.data, settings.cliAlias)}
                control={
                    <div className="cli-alias-control">
                        <Input
                            size="sm"
                            mono
                            aria-label="Short name"
                            value={aliasName}
                            invalid={!aliasValid}
                            disabled={!settings.cliAlias.enabled}
                            spellCheck={false}
                            autoComplete="off"
                            title="1 to 32 letters, digits, “.”, “_”, or “-”"
                            onChange={event => setAliasName(event.target.value)}
                            onBlur={commitName}
                            onKeyDown={event => event.key === 'Enter' && (event.target as HTMLInputElement).blur()}
                        />
                        <Switch
                            checked={settings.cliAlias.enabled}
                            title="Add a short name for the shipwarden command"
                            onChange={enabled => void saveAlias({ ...settings.cliAlias, enabled })}
                        />
                    </div>
                }
            />
            <SettingsRow
                label="Agent skill"
                description="Run “shipwarden skill install” to give Claude Code a skill that explains the command. For another agent, run “shipwarden skill install --dir <skills folder>”, or “shipwarden skill” to print the file."
            />
        </SettingsGroup>
    );
}
