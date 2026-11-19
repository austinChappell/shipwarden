import { useQuery } from '@tanstack/react-query';
import { canSetModel, commandSetsModel, resolveModel, type AgentModel } from '@shared/agent-models';
import { agentProgramOf } from '@shared/agent-programs';
import type { AgentDefinition } from '@shared/settings';
import { keyRoots, queryClient, STALE_MS } from '../query-client';

const api = window.shipwarden;

/**
 * The query of the models of an agent command. Each load starts the agent program, so the list does not load again on
 * a timer. It loads again when it is older than STALE_MS and a view or a session start needs it.
 */
export function agentModelsQuery(command: string) {
    const trimmed = command.trim();
    return {
        queryKey: [...keyRoots.agentModels, trimmed],
        queryFn: (): Promise<AgentModel[]> => api.settings.listModels(trimmed),
        staleTime: STALE_MS,
        refetchInterval: false as const
    };
}

/** True when ShipWarden can set the model of the agent: Claude Code or Codex, and no model option in the command. */
export function hasModelChoice(command: string): boolean {
    return canSetModel(agentProgramOf(command)) && !commandSetsModel(command);
}

/** The models of an agent command, for Settings › Agents. The list loads only for a command with a model choice. */
export function useAgentModels(command: string) {
    return useQuery({ ...agentModelsQuery(command), enabled: hasModelChoice(command) });
}

/**
 * Returns the agent with the model for a new session. A saved model that is not available now goes away, so that the
 * agent uses its own setting. Then `unavailable` has the saved model. When the list does not load, the session keeps
 * the saved model, because ShipWarden cannot check it.
 */
export async function withAvailableModel(agent: AgentDefinition): Promise<{ agent: AgentDefinition; unavailable?: string }> {
    if (!agent.model || !hasModelChoice(agent.command)) {
        return { agent };
    }
    const available = await queryClient.fetchQuery(agentModelsQuery(agent.command)).catch(() => undefined);
    const { model, unavailable } = resolveModel(agent.model, available);
    const { model: _saved, ...rest } = agent;
    return { agent: model ? { ...rest, model } : rest, unavailable };
}
