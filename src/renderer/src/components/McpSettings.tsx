import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { writeToolLabel, type McpApprovals } from '@shared/mcp';
import { WORKER_MAX_DEPTH_MAX, WORKER_MAX_DEPTH_MIN, type AppSettings } from '@shared/settings';
import { keyRoots } from '../query-client';
import { errorText } from '../util';
import { SettingsGroup, SettingsRow } from './settings-ui';
import { Button, Select, Switch, type SelectOption } from './ui';

const api = window.shipwarden.mcp;

/** The choices of the worker depth: 1 to 5 levels of workers. */
const DEPTH_OPTIONS: SelectOption<string>[] = Array.from({ length: WORKER_MAX_DEPTH_MAX - WORKER_MAX_DEPTH_MIN + 1 }, (_, index) => {
    const depth = WORKER_MAX_DEPTH_MIN + index;
    return { value: String(depth), label: depth === 1 ? '1: workers cannot start workers' : `${depth} levels` };
});

/** The MCP server switch and the approved write tools of each worktree (Settings › Agents). */
export function McpSettingsGroup({ settings, onSave }: { settings: AppSettings; onSave(change: Partial<AppSettings>): Promise<void> }) {
    const queryClient = useQueryClient();
    const [error, setError] = useState<string>();
    const approvals = useQuery({ queryKey: keyRoots.mcpApprovals, queryFn: () => api.approvals() });
    // The main process sends each change, also an approval in the dialog. The page writes it into the cache.
    useEffect(() => api.onApprovalsChanged(next => queryClient.setQueryData<McpApprovals>(keyRoots.mcpApprovals, next)), [queryClient]);

    const revoke = async (worktree: string) => {
        setError(undefined);
        try {
            queryClient.setQueryData<McpApprovals>(keyRoots.mcpApprovals, await api.revoke(worktree));
        } catch (err) {
            setError(errorText(err));
        }
    };
    const entries = Object.entries(approvals.data ?? {}).sort(([a], [b]) => a.localeCompare(b));

    return (
        <SettingsGroup
            title="MCP server"
            description="ShipWarden runs a local MCP server. A new agent tab of Claude Code, Codex, Gemini CLI, or opencode gets its tools, for example list_worktrees, ask_agent, get_task, create_pull_request, and start_worker. The tools act on the worktree of the agent. Your own MCP servers stay."
            card
        >
            <SettingsRow
                label="Give agents the ShipWarden tools"
                description="The change applies to new agent tabs. Agents that run now keep their tools until they stop."
                control={<Switch checked={settings.mcpServer} title="Give agents the ShipWarden tools" onChange={mcpServer => void onSave({ mcpServer })} />}
            />
            <SettingsRow
                label="Worker depth"
                description="An agent can split a large task and start worker agents with start_worker. Each worker gets its own worktree. This is the most levels of workers below the agent that you started. With 2, the workers can start their own workers too."
                control={
                    <Select<string>
                        aria-label="Worker depth"
                        value={String(settings.workerMaxDepth)}
                        options={DEPTH_OPTIONS}
                        onChange={value => void onSave({ workerMaxDepth: Number(value) })}
                    />
                }
            />
            <SettingsRow
                label="Approved tools"
                description="The write tools ask you the first time in each worktree: they create and change pull requests, reply to comments, control the browser, change the task, ask other agents, and start workers. The write commands of the shipwarden command use the same approvals. Allow applies to the tool in that worktree until you revoke it. The read tools need no approval."
            >
                {entries.length === 0 ? (
                    <div className="settings-row-description">No worktree has approved tools.</div>
                ) : (
                    <div className="mcp-approvals">
                        {entries.map(([worktree, tools]) => (
                            <div key={worktree} className="mcp-approval">
                                <div className="mcp-approval-text">
                                    <div className="mcp-approval-path" title={worktree}>
                                        {worktree}
                                    </div>
                                    <div className="settings-row-description">{tools.map(writeToolLabel).join(', ')}</div>
                                </div>
                                <Button size="sm" onClick={() => void revoke(worktree)}>
                                    Revoke
                                </Button>
                            </div>
                        ))}
                    </div>
                )}
                {error && <div className="form-error">{error}</div>}
            </SettingsRow>
        </SettingsGroup>
    );
}
