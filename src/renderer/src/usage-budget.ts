import { useEffect, useState, useSyncExternalStore } from 'react';
import { agentForRepo, DEFAULT_SETTINGS, type AgentDefinition, type AppSettings } from '@shared/settings';
import { agentBudgetBlock, budgetWaitText, type BudgetBlock, type ProviderUsage } from '@shared/usage';
import { useUsage } from './usage-query';

/**
 * The usage budget of Settings › Agents for the start paths outside React: the queue, the plans, and the automations.
 * App gives the newest settings and usage at each render. A start path asks `budgetWait` before it starts an agent.
 */
interface BudgetContext {
    settings: AppSettings;
    usage: readonly ProviderUsage[];
}

let context: BudgetContext = { settings: DEFAULT_SETTINGS, usage: [] };
const listeners = new Set<() => void>();

/** Gives the newest settings and usage. App calls it at each render. */
export function setBudgetContext(next: BudgetContext): void {
    if (next.settings === context.settings && next.usage === context.usage) return;
    context = next;
    for (const listener of listeners) listener();
}

/** The agent that a start uses: the agent of the start, else the agent of the repository. */
export function startAgentOf(settings: AppSettings, agentId: string | undefined, repo: string | undefined): AgentDefinition {
    return settings.agents.find(agent => agent.id === agentId) ?? agentForRepo(settings, repo);
}

/** Returns why the budget stops a new agent now, or undefined. `agentId` undefined: the agent of the repository. */
export function budgetBlockFor(agentId: string | undefined, repo: string | undefined, now = Date.now()): BudgetBlock | undefined {
    const agent = startAgentOf(context.settings, agentId, repo);
    return agentBudgetBlock(context.usage, context.settings.usageBudget, [agent.command], now);
}

/**
 * Returns the wait text when the budget stops a new agent now, else undefined. The text has the clock time of the reset.
 * With `relative`, it also has the time until the reset. A saved text must not have it, because it changes each minute.
 */
export function budgetWait(agentId: string | undefined, repo: string | undefined, relative = false): string | undefined {
    const now = Date.now();
    const block = budgetBlockFor(agentId, repo, now);
    return block && budgetWaitText(block, relative ? now : undefined);
}

/** Returns the wait text when the budget stops a start of these agents now, else undefined. It has the time until the reset. */
export function budgetWaitForAgents(agents: readonly Pick<AgentDefinition, 'command'>[]): string | undefined {
    const now = Date.now();
    const block = agentBudgetBlock(
        context.usage,
        context.settings.usageBudget,
        agents.map(agent => agent.command),
        now
    );
    return block && budgetWaitText(block, now);
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** The time now. It changes every 30 seconds, so a passed reset time shows without a new usage request. */
function useNow(): number {
    const [now, setNow] = useState(Date.now);
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 30_000);
        return () => clearInterval(timer);
    }, []);
    return now;
}

/**
 * Returns the wait text when the budget stops a start of these agents now, else undefined. For a React view, for
 * example the Compare agents dialog. The text changes when the usage, the settings, or the time changes.
 */
export function useBudgetWait(agents: readonly Pick<AgentDefinition, 'command'>[]): string | undefined {
    const usage = useUsage();
    const settings = useSyncExternalStore(subscribe, () => context.settings);
    const now = useNow();
    const block = agentBudgetBlock(
        usage,
        settings.usageBudget,
        agents.map(agent => agent.command),
        now
    );
    return block && budgetWaitText(block, now);
}

/** Like `budgetWait`, for a React view. `agentId` undefined: the agent of the repository. */
export function useBudgetWaitFor(agentId: string | undefined, repo: string | undefined): string | undefined {
    const settings = useSyncExternalStore(subscribe, () => context.settings);
    return useBudgetWait([startAgentOf(settings, agentId, repo)]);
}
