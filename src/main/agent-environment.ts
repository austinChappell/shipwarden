/**
 * Environment variables that mark a running agent session.
 * If ShipWarden starts from an agent terminal, the main process gets these variables.
 * All ShipWarden terminals then get them, and each agent thinks that it is a child session.
 * This list contains only session markers. It does not contain user settings such as CLAUDE_CODE_USE_BEDROCK.
 */
export const AGENT_SESSION_VARIABLES: readonly string[] = [
    'CLAUDECODE',
    'CLAUDE_CODE_CHILD_SESSION',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_EXECPATH',
    'CLAUDE_CODE_MESSAGING_SOCKET',
    'CLAUDE_CODE_MESSAGING_TOKEN',
    'CLAUDE_CODE_SESSION_ATTENDED',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_EFFORT',
    'CLAUDE_PID'
];

/** Removes the agent session variables from the environment. Returns the names of the removed variables. */
export function removeAgentSessionVariables(env: NodeJS.ProcessEnv): string[] {
    const removed: string[] = [];
    for (const name of AGENT_SESSION_VARIABLES) {
        if (name in env) {
            delete env[name];
            removed.push(name);
        }
    }
    return removed;
}
