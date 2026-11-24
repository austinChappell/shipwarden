import { normalizeApprovals, type ApprovalTool, type McpApprovals } from '@shared/mcp';
import { JsonStore } from '../tasks/json-store';

/** The time that a write tool waits for the answer of the user. */
export const APPROVAL_TIMEOUT_MS = 2 * 60_000;

/** The approved write tools of each worktree, in a file of the app data folder. Settings › Agents can revoke them. */
export class McpApprovalStore {
    private readonly store: JsonStore<McpApprovals>;

    constructor(
        file: string,
        private readonly onChanged: (approvals: McpApprovals) => void = () => undefined
    ) {
        this.store = new JsonStore<McpApprovals>(file, () => ({}));
    }

    async list(): Promise<McpApprovals> {
        return normalizeApprovals(await this.store.get());
    }

    async has(worktree: string, tool: ApprovalTool): Promise<boolean> {
        return (await this.list())[worktree]?.includes(tool) ?? false;
    }

    async add(worktree: string, tool: ApprovalTool): Promise<void> {
        const next = normalizeApprovals(await this.store.update(all => normalizeApprovals({ ...all, [worktree]: [...(all[worktree] ?? []), tool] })));
        this.onChanged(next);
    }

    /** Removes the approvals of a worktree. The next write tool call in the worktree asks again. */
    async revoke(worktree: string): Promise<McpApprovals> {
        const next = normalizeApprovals(
            await this.store.update(all => {
                const copy = { ...all };
                delete copy[worktree];
                return copy;
            })
        );
        this.onChanged(next);
        return next;
    }
}

export interface ApprovalRequest {
    worktree: string;
    tool: ApprovalTool;
    /** What the tool wants to do, for example "Move ENG-1 to In review". */
    summary: string;
}

export interface ApprovalGateOptions {
    store: Pick<McpApprovalStore, 'has' | 'add'>;
    /** Asks the user. Resolves true for "Allow". The signal aborts when the time is over, and the dialog then closes. */
    ask(request: ApprovalRequest, signal: AbortSignal): Promise<boolean>;
    timeoutMs?: number;
}

/**
 * Asks the user to approve a write tool the first time in a worktree. "Allow" applies to the tool in that worktree
 * until the user revokes it. Two calls of the same tool in the same worktree share one question.
 * A question without an answer ends after `timeoutMs`, so the agent gets a clear error and does not wait forever.
 */
export class McpApprovalGate {
    private readonly pending = new Map<string, Promise<void>>();

    constructor(private readonly options: ApprovalGateOptions) {}

    async approve(request: ApprovalRequest, signal?: AbortSignal): Promise<void> {
        if (await this.options.store.has(request.worktree, request.tool)) return;
        const key = `${request.worktree}\0${request.tool}`;
        let question = this.pending.get(key);
        if (!question) {
            question = this.ask(request).finally(() => this.pending.delete(key));
            this.pending.set(key, question);
        }
        if (!signal) return question;
        // The caller can stop the wait (for example when the agent cancels the call). The question stays for the other callers.
        return new Promise<void>((resolve, reject) => {
            const onAbort = () => reject(new Error('The tool call was cancelled.'));
            if (signal.aborted) return onAbort();
            signal.addEventListener('abort', onAbort, { once: true });
            question.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
        });
    }

    private async ask(request: ApprovalRequest): Promise<void> {
        const timeoutMs = this.options.timeoutMs ?? APPROVAL_TIMEOUT_MS;
        const controller = new AbortController();
        // The timer wins even when the dialog ignores the signal, so the agent never waits forever.
        const answer = await new Promise<boolean | 'timeout'>((resolve, reject) => {
            const timer = setTimeout(() => {
                controller.abort();
                resolve('timeout');
            }, timeoutMs);
            this.options.ask(request, controller.signal).then(
                allowed => {
                    clearTimeout(timer);
                    resolve(allowed);
                },
                error => {
                    clearTimeout(timer);
                    reject(error);
                }
            );
        });
        if (answer === 'timeout') {
            throw new Error(
                `The user did not approve ${request.tool} in ${formatWait(timeoutMs)}. Tell the user that ShipWarden is waiting for approval, then call the tool again.`
            );
        }
        if (!answer) throw new Error(`The user denied ${request.tool} for this worktree.`);
        await this.options.store.add(request.worktree, request.tool);
    }
}

/** Returns "2 minutes", "1 minute" or "30 seconds". */
function formatWait(ms: number): string {
    if (ms >= 60_000 && ms % 60_000 === 0) return ms === 60_000 ? '1 minute' : `${ms / 60_000} minutes`;
    const seconds = Math.max(1, Math.round(ms / 1000));
    return seconds === 1 ? '1 second' : `${seconds} seconds`;
}
