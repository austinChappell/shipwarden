import { mkdir } from 'fs/promises';
import { join } from 'path';
import { modelListCommands, parseModelList, type AgentModel } from '@shared/agent-models';
import type { AskAgentRunner } from './ask-agent';

/** The time that an agent can take to list its models. */
const LIST_TIMEOUT_MS = 30_000;

export interface ModelListDependencies {
    runner: AskAgentRunner;
    /** An empty folder for the list command. The command does not need a repository. */
    tempFolder: string;
    /** The environment for the network: the trusted certificates of Settings › Network. */
    env(): Promise<Record<string, string>>;
}

/**
 * Asks the agent program for the models that the user can use now. The command runs in the login shell, the same as
 * an agent tab. The first command that works gives the list. Throws an error with a message when no command works.
 */
export async function listAgentModels(command: string, deps: ModelListDependencies): Promise<AgentModel[]> {
    const commands = modelListCommands(command);
    if (commands.length === 0) {
        throw new Error('ShipWarden can list the models only of Claude Code and Codex.');
    }
    const cwd = join(deps.tempFolder, 'shipwarden-models');
    await mkdir(cwd, { recursive: true });
    const env = await deps.env();
    let failure: unknown;
    for (const item of commands) {
        try {
            const output = await deps.runner.run(`models:${command}`, { command: item.command, prompt: item.input, cwd, env, timeoutMs: LIST_TIMEOUT_MS });
            return parseModelList(command, output);
        } catch (error) {
            failure = error;
        }
    }
    throw failure instanceof Error ? failure : new Error('The agent did not send its list of models.');
}
