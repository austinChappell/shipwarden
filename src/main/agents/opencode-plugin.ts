import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';

/**
 * The opencode plugin that sends the agent state to ShipWarden's hook server.
 * opencode has no command hooks. A plugin is a JavaScript module that runs in the opencode process.
 * The plugin sends Claude Code event names with Claude Code fields, so `agentStateFromHook` reads them:
 * - SessionStart when opencode starts.
 * - UserPromptSubmit for a prompt (the "chat.message" hook).
 * - PreToolUse for a tool call (the "tool.execute.before" hook), and again when the user answers a permission or a question.
 * - Notification for a permission ("permission.asked") or a question ("question.asked").
 * - Stop when the session becomes idle after a prompt. The message is the last text of the agent.
 * The events of a subagent session (a session with a parentID) do not end the turn and do not set the prompt.
 * Without the SHIPWARDEN_* variables (for example outside ShipWarden), the plugin does nothing.
 * A failed request must not block the agent, so the plugin ignores all errors.
 */
export const OPENCODE_PLUGIN = `// ShipWarden agent state plugin for opencode. ShipWarden writes this file. Do not edit it.
const MAX_TEXT = 2000;

export const ShipWardenAgentState = async () => {
    const url = process.env.SHIPWARDEN_HOOK_URL;
    const token = process.env.SHIPWARDEN_HOOK_TOKEN;
    const sessionId = process.env.SHIPWARDEN_SESSION_ID;
    if (!url || !token || !sessionId) {
        return {};
    }
    const send = (event, payload = {}) => {
        fetch(url + '/hook/' + encodeURIComponent(sessionId) + '/' + event, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-ShipWarden-Token': token },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(2000)
        }).catch(() => {});
    };
    // The subagent sessions. Their idle state does not end the turn.
    const children = new Set();
    // The messages of the agent in the current turn, and the last text of them.
    const replies = new Set();
    let lastText;
    let lastTool;
    let busy = false;

    const finish = sessionID => {
        if (!busy || children.has(sessionID)) {
            return;
        }
        busy = false;
        send('Stop', lastText ? { last_assistant_message: lastText.slice(0, MAX_TEXT) } : {});
    };

    send('SessionStart');
    return {
        'chat.message': async (input, output) => {
            if (children.has(input.sessionID)) {
                return;
            }
            const prompt = (output.parts || [])
                .filter(part => part.type === 'text' && !part.synthetic && typeof part.text === 'string')
                .map(part => part.text)
                .join('\\n');
            busy = true;
            lastText = undefined;
            lastTool = undefined;
            replies.clear();
            send('UserPromptSubmit', { prompt: prompt.slice(0, MAX_TEXT) });
        },
        'tool.execute.before': async (input, output) => {
            busy = true;
            lastTool = { tool_name: input.tool, tool_input: output && typeof output.args === 'object' ? output.args : {} };
            send('PreToolUse', lastTool);
        },
        event: async ({ event }) => {
            const properties = event.properties || {};
            switch (event.type) {
                case 'session.created':
                case 'session.updated':
                    if (properties.info && properties.info.parentID) {
                        children.add(properties.info.id);
                    }
                    break;
                case 'message.updated':
                    if (properties.info && properties.info.role === 'assistant' && !children.has(properties.info.sessionID)) {
                        replies.add(properties.info.id);
                    }
                    break;
                case 'message.part.updated': {
                    const part = properties.part;
                    if (part && part.type === 'text' && replies.has(part.messageID) && typeof part.text === 'string' && part.text.trim()) {
                        lastText = part.text.trim();
                    }
                    break;
                }
                case 'permission.asked': {
                    const patterns = Array.isArray(properties.patterns) ? properties.patterns.join(', ') : '';
                    const message = properties.permission
                        ? 'opencode asks for permission: ' + properties.permission + (patterns ? ' (' + patterns + ')' : '')
                        : 'opencode asks for permission.';
                    send('Notification', { notification_type: 'permission_prompt', message: message.slice(0, MAX_TEXT) });
                    break;
                }
                case 'question.asked': {
                    const first = Array.isArray(properties.questions) ? properties.questions[0] : undefined;
                    const message = first && typeof first.question === 'string' ? first.question : 'opencode asks a question.';
                    send('Notification', { notification_type: 'question', message: message.slice(0, MAX_TEXT) });
                    break;
                }
                case 'permission.replied':
                case 'question.replied':
                case 'question.rejected':
                    if (busy) {
                        send('PreToolUse', lastTool || { tool_name: 'opencode' });
                    }
                    break;
                case 'session.status':
                    if (properties.status && properties.status.type === 'idle') {
                        finish(properties.sessionID);
                    }
                    break;
                case 'session.idle':
                    finish(properties.sessionID);
                    break;
            }
        }
    };
};
`;

/** Writes ShipWarden's opencode plugin to `target`. */
export function writeOpencodePlugin(target: string): void {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, OPENCODE_PLUGIN);
}
