import { agentProgramOf, type AgentProgram } from './agent-programs';
import { shellQuote } from './agents';

/** A model that an agent program can use now. The program gives the list. */
export interface AgentModel {
    /** The value of the `--model` option, for example "opus" or "gpt-6.2-sol". */
    id: string;
    label: string;
    description?: string;
}

/**
 * The programs that ShipWarden can set a model for. Each one has a `--model` option and a command that lists its models.
 * - Gemini CLI has a `--model` option, but no command that lists the models.
 * - opencode lists its models, but its interactive mode has no `--model` option.
 */
const MODEL_PROGRAMS: readonly AgentProgram[] = ['claude', 'codex'];

/** The `initialize` request of the Claude Code stream-json mode. The answer has the models of the account. */
export const CLAUDE_INITIALIZE_REQUEST = `${JSON.stringify({ type: 'control_request', request_id: 'models', request: { subtype: 'initialize' } })}\n`;

/** True when ShipWarden can set a model for the program. */
export function canSetModel(program: AgentProgram | undefined): boolean {
    return !!program && MODEL_PROGRAMS.includes(program);
}

/** True when the command already has a model option, for example `claude --model opus` or `codex -m gpt-6`. */
export function commandSetsModel(command: string): boolean {
    return /(^|\s)(--model|-m)(\s|=|$)/.test(command);
}

/**
 * Returns the commands that list the models of an agent command, the preferred command first. Returns an empty list
 * when ShipWarden cannot list the models of the program.
 * - Claude Code: the `initialize` request in print mode. `--safe-mode` stops the hooks and the MCP servers of the user.
 *   An old Claude Code does not know `--safe-mode`, so the second command does not have it. The request sends no prompt
 *   to the model.
 * - Codex: `debug models` writes the model catalog as JSON.
 */
export function modelListCommands(command: string): { command: string; input: string }[] {
    const trimmed = command.trim();
    const stream = '-p --input-format stream-json --output-format stream-json --verbose --no-session-persistence';
    switch (agentProgramOf(trimmed)) {
        case 'claude':
            return [
                { command: `${trimmed} ${stream} --safe-mode`, input: CLAUDE_INITIALIZE_REQUEST },
                { command: `${trimmed} ${stream}`, input: CLAUDE_INITIALIZE_REQUEST }
            ];
        case 'codex':
            return [{ command: `${trimmed} debug models`, input: '' }];
        default:
            return [];
    }
}

function text(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Reads the models from the answer of Claude Code to the `initialize` request. The output has one JSON object on each
 * line. The "default" entry is not a model. It is the same as "Own setting" in ShipWarden.
 */
export function parseClaudeModels(output: string): AgentModel[] {
    for (const line of output.split('\n')) {
        const start = line.indexOf('{');
        if (start === -1 || !line.includes('"control_response"')) continue;
        try {
            const message = JSON.parse(line.slice(start)) as { response?: { response?: { models?: unknown } } };
            const models = message.response?.response?.models;
            if (!Array.isArray(models)) continue;
            return models.flatMap(item => {
                const id = text(item?.value);
                if (!id || id === 'default') return [];
                const description = text(item.description);
                return [{ id, label: text(item.displayName) ?? id, ...(description ? { description } : {}) }];
            });
        } catch {
            // Another line can have the answer.
        }
    }
    throw new Error('Claude Code did not send its list of models.');
}

/** Reads the models from the output of `codex debug models`. A model with the visibility "hide" is not in the list. */
export function parseCodexModels(output: string): AgentModel[] {
    const start = output.indexOf('{');
    let catalog: { models?: unknown };
    try {
        catalog = JSON.parse(output.slice(start)) as { models?: unknown };
    } catch {
        throw new Error('Codex did not send its list of models.');
    }
    if (start === -1 || !Array.isArray(catalog.models)) {
        throw new Error('Codex did not send its list of models.');
    }
    return catalog.models.flatMap(item => {
        const id = text(item?.slug);
        if (!id || item.visibility === 'hide') return [];
        const description = text(item.description);
        return [{ id, label: text(item.display_name) ?? id, ...(description ? { description } : {}) }];
    });
}

/** Reads the models from the output of a command from `modelListCommands`. */
export function parseModelList(command: string, output: string): AgentModel[] {
    switch (agentProgramOf(command)) {
        case 'claude':
            return parseClaudeModels(output);
        case 'codex':
            return parseCodexModels(output);
        default:
            throw new Error('ShipWarden can list the models only of Claude Code and Codex.');
    }
}

/** Returns the command that starts the agent with the model. The option goes after the command of the agent. */
export function commandWithModel(command: string, model: string): string {
    return `${command.trim()} --model ${shellQuote(model)}`;
}

/**
 * Selects the model of a new session.
 * - Without a saved model, the agent uses its own setting.
 * - Without a model list (the list did not load), ShipWarden cannot check the model. The session uses the saved model.
 * - A saved model that is not in the list is not available now. The session uses the agent's own setting, and
 *   `unavailable` has the saved model, so that the caller can tell the user.
 */
export function resolveModel(saved: string | undefined, available: readonly AgentModel[] | undefined): { model?: string; unavailable?: string } {
    if (!saved) return {};
    if (!available || available.some(item => item.id === saved)) return { model: saved };
    return { unavailable: saved };
}

/** The text that tells the user that a session started without its saved model. */
export function unavailableModelNotice(agentName: string, model: string): string {
    return `The model "${model}" of the agent "${agentName}" is not available now. The agent started with its own default model. Select another model in Settings › Agents.`;
}
