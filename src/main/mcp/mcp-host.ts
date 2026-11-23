import { promises as fs } from 'fs';
import { join } from 'path';
import { geminiHookSettings, hookAgentOf } from '@shared/agents';
import { geminiMcpSettings, mcpConfig, type McpApprovals } from '@shared/mcp';
import { McpApprovalGate, McpApprovalStore, type ApprovalRequest } from './approvals';
import { McpHttpServer, type McpServerAddress } from './server';
import { McpTokens, type IssuedToken, type McpConfigContent } from './tokens';
import { McpTools, type McpToolService } from './tools';

/** The text that the client gets in the answer to initialize. The agent shows it to the model. */
const INSTRUCTIONS =
    'ShipWarden runs this agent in a git worktree. The tools act on this worktree: its task, its overlap with other worktrees, and questions to the agents of other worktrees. ask_agent and set_task_status need the approval of the user the first time.';

export interface McpHostOptions {
    userData: string;
    version: string;
    /** The Gemini CLI hook settings file. The MCP config file of a Gemini CLI session starts from it. */
    geminiHookSettingsPath: string;
    service: Omit<McpToolService, 'approve'>;
    /** Asks the user to approve a write tool. The signal aborts when the time is over. */
    askUser(request: ApprovalRequest, signal: AbortSignal): Promise<boolean>;
    onApprovalsChanged(approvals: McpApprovals): void;
}

/**
 * The ShipWarden MCP server in the main process: the HTTP server, the tokens of the agent sessions, and the approvals
 * of the write tools. Settings › Agents turns it on and off.
 */
export class McpHost {
    readonly approvals: McpApprovalStore;
    private readonly tokens: McpTokens;
    private readonly server: McpHttpServer;
    private address: Promise<McpServerAddress | undefined> = Promise.resolve(undefined);
    private readonly geminiHookSettingsPath: string;

    constructor(options: McpHostOptions) {
        this.geminiHookSettingsPath = options.geminiHookSettingsPath;
        this.approvals = new McpApprovalStore(join(options.userData, 'mcp-approvals.json'), options.onApprovalsChanged);
        this.tokens = new McpTokens(join(options.userData, 'mcp-tokens.json'), join(options.userData, 'mcp'));
        const gate = new McpApprovalGate({ store: this.approvals, ask: options.askUser });
        const tools = new McpTools({
            ...options.service,
            approve: (worktree, tool, summary, signal) => gate.approve({ worktree, tool, summary }, signal)
        });
        this.server = new McpHttpServer({
            worktreeOf: token => this.tokens.worktreeOf(token),
            tools,
            info: { name: 'shipwarden', title: 'ShipWarden', version: options.version, instructions: INSTRUCTIONS }
        });
    }

    /** Starts or stops the server. A start that fails leaves the server off, and agents start without it. */
    async apply(enabled: boolean): Promise<void> {
        const current = await this.address;
        if (enabled === !!current) return;
        if (!enabled) {
            this.server.stop();
            this.address = Promise.resolve(undefined);
            return;
        }
        this.address = (async () => {
            try {
                const address = await this.server.start(await this.tokens.savedPort());
                await this.tokens.savePort(address.port);
                return address;
            } catch (error) {
                console.warn(`[mcp] The MCP server did not start: ${error instanceof Error ? error.message : String(error)}`);
                return undefined;
            }
        })();
        await this.address;
    }

    /**
     * Makes the token and the MCP config file of a new agent session in a worktree. Returns undefined when the server
     * is off, or when the agent program does not get the server.
     * - Claude Code gets a file for --mcp-config.
     * - Gemini CLI gets a copy of the hook settings file with the server. The copy replaces the hook settings file.
     * - Codex and opencode get no file. They read the token from the environment of the session.
     */
    async issue(command: string | undefined, worktree: string | undefined): Promise<IssuedToken | undefined> {
        const program = command ? hookAgentOf(command) : undefined;
        if (!worktree || !program) return undefined;
        const address = await this.address;
        if (!address) return undefined;
        let content: McpConfigContent;
        switch (program) {
            case 'claude':
                content = mcpConfig;
                break;
            case 'gemini': {
                const hookSettings = await this.geminiHookSettings();
                content = (url, token) => geminiMcpSettings(hookSettings, url, token);
                break;
            }
            default:
                content = () => undefined;
        }
        return this.tokens.issue(worktree, address.url, content);
    }

    /** Reads the Gemini CLI hook settings file. A missing or broken file gives the hooks without the system defaults. */
    private async geminiHookSettings(): Promise<unknown> {
        try {
            return JSON.parse(await fs.readFile(this.geminiHookSettingsPath, 'utf8'));
        } catch {
            return geminiHookSettings();
        }
    }

    bindSession(id: string, sessionId: string): Promise<void> {
        return this.tokens.bindSession(id, sessionId);
    }

    revokeSession(sessionId: string): Promise<void> {
        return this.tokens.revokeSession(sessionId);
    }

    /** Removes the tokens that are older than the maximum age. */
    prune(): Promise<void> {
        return this.tokens.prune();
    }

    stop(): void {
        this.server.stop();
        this.address = Promise.resolve(undefined);
    }
}
