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
 * The plugin sends the events through the Unix socket in SHIPWARDEN_HOOK_SOCKET, not over TCP. See hook-server.ts.
 * opencode runs on Bun, and Bun's fetch can use a Unix socket. In Node.js, the plugin uses the http module.
 * A PTY host of an older build sets SHIPWARDEN_HOOK_URL in place of the socket. The plugin then uses the URL.
 * Without the SHIPWARDEN_* variables (for example outside ShipWarden), the plugin does nothing.
 * A failed request must not block the agent, so the plugin ignores all errors.
 */
export const OPENCODE_PLUGIN = `// ShipWarden agent state plugin for opencode. ShipWarden writes this file. Do not edit it.
const MAX_TEXT = 2000;

const TIMEOUT_MS = 2000;

// Sends a POST request through a Unix socket with the http module of Node.js.
const postToSocket = async (socketPath, path, headers, body) => {
    const http = await import('node:http');
    await new Promise(resolve => {
        const request = http.request({ socketPath, path, method: 'POST', headers, timeout: TIMEOUT_MS }, response => {
            response.resume();
            response.on('end', resolve);
        });
        request.on('error', resolve);
        request.on('timeout', () => request.destroy());
        request.end(body);
    });
};

export const ShipWardenAgentState = async () => {
    const socket = process.env.SHIPWARDEN_HOOK_SOCKET;
    const url = process.env.SHIPWARDEN_HOOK_URL;
    const token = process.env.SHIPWARDEN_HOOK_TOKEN;
    const sessionId = process.env.SHIPWARDEN_SESSION_ID;
    if ((!socket && !url) || !token || !sessionId) {
        return {};
    }
    const post = (path, body) => {
        const headers = { 'Content-Type': 'application/json', 'X-ShipWarden-Token': token };
        if (!socket) {
            return fetch(url + path, { method: 'POST', headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
        }
        if (typeof Bun !== 'undefined') {
            return fetch('http://localhost' + path, { method: 'POST', headers, body, unix: socket, signal: AbortSignal.timeout(TIMEOUT_MS) });
        }
        return postToSocket(socket, path, headers, body);
    };
    const send = (event, payload = {}) => {
        post('/hook/' + encodeURIComponent(sessionId) + '/' + event, JSON.stringify(payload)).catch(() => {});
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
                        ? 'opencode is asking for permission: ' + properties.permission + (patterns ? ' (' + patterns + ')' : '')
                        : 'opencode is asking for permission.';
                    send('Notification', { notification_type: 'permission_prompt', message: message.slice(0, MAX_TEXT) });
                    break;
                }
                case 'question.asked': {
                    const first = Array.isArray(properties.questions) ? properties.questions[0] : undefined;
                    const message = first && typeof first.question === 'string' ? first.question : 'opencode is asking a question.';
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
