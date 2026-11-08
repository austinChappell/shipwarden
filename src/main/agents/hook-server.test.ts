import { execFileSync } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeHookSettings } from '@shared/agents';
import { HookServer } from './hook-server';

describe('HookServer', () => {
    let server: HookServer | undefined;

    afterEach(() => server?.stop());

    it('receives an event from the real hook command and rejects a wrong token', async () => {
        const events: [string, string, Record<string, unknown>][] = [];
        server = new HookServer((sessionId, event, payload) => events.push([sessionId, event, payload]));
        const { url, token } = await server.start();

        // Run the same shell command that Claude Code runs for the Stop hook.
        const stop = (claudeHookSettings().hooks.Stop[0] as { hooks: { command: string }[] }).hooks[0].command;
        const run = (hookToken: string) => execFileSync('/bin/sh', ['-c', stop], {
            input: JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: 'Done.' }),
            env: { ...process.env, SHIPWARDEN_HOOK_URL: url, SHIPWARDEN_HOOK_TOKEN: hookToken, SHIPWARDEN_SESSION_ID: 'session-1' }
        });

        run('wrong-token');
        run(token);
        await new Promise(resolve => setTimeout(resolve, 100));

        expect(events).toEqual([['session-1', 'Stop', { hook_event_name: 'Stop', last_assistant_message: 'Done.' }]]);
    });
});
