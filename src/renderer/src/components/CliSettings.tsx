import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { CliInstallState } from '@shared/cli';
import { keyRoots } from '../query-client';
import { errorText } from '../util';
import { SettingsGroup, SettingsRow } from './settings-ui';
import { Button } from './ui';

const api = window.shipwarden.cli;

/** The text under "Install the shipwarden command": where the link is, and if the shell finds it. */
function stateText(state: CliInstallState | undefined): string {
    if (!state) return 'Checking the link.';
    if (!state.installed) return 'Adds a link in /usr/local/bin. When that folder is not writable, the link goes to ~/.local/bin.';
    const where = `Installed in ${state.installed}.`;
    return state.inPath ? where : `${where} Add the folder of the link to the PATH of your shell, or type the full path.`;
}

/** The `shipwarden` command (Settings › Agents): the link in a bin folder, and the skill file for agents. */
export function CliSettingsGroup() {
    const queryClient = useQueryClient();
    const [error, setError] = useState<string>();
    const [busy, setBusy] = useState(false);
    const state = useQuery({ queryKey: keyRoots.cliInstall, queryFn: () => api.installState() });

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
                label="Agent skill"
                description="Run “shipwarden skill install” to give Claude Code a skill that explains the command. For another agent, run “shipwarden skill install --dir <skills folder>”, or “shipwarden skill” to print the file."
            />
        </SettingsGroup>
    );
}
