import { EventEmitter } from 'events';
import type { BrowserWindow } from 'electron';
import { describe, expect, it } from 'vitest';
import type { CliPageRequest } from '@shared/cli';
import { CliPageBridge } from './page-bridge';

/** A fake window. It records the messages to the page. */
function fakeWindow() {
    const sent: unknown[][] = [];
    const emitter = new EventEmitter();
    const window = Object.assign(emitter, {
        isDestroyed: () => false,
        webContents: { isLoading: () => false, send: (...args: unknown[]) => sent.push(args) }
    });
    return { window: window as unknown as BrowserWindow, sent, emitter };
}

const request: CliPageRequest = { action: 'agent.send', repoPath: '/r', worktreePath: '/w', prompt: 'Hi' };

describe('CliPageBridge', () => {
    it('fails at once without a window', async () => {
        const bridge = new CliPageBridge(() => undefined);
        await expect(bridge.request(request, new AbortController().signal)).rejects.toMatchObject({ code: 'noWindow' });
    });

    it('sends the request to the page and gives its answer', async () => {
        const { window, sent } = fakeWindow();
        const bridge = new CliPageBridge(() => window);
        const pending = bridge.request(request, new AbortController().signal);
        expect(sent).toEqual([['cli:pageRequest', 1, request]]);
        bridge.answer(1, { message: 'Sent.', sessionId: 's1' }, undefined);
        expect(await pending).toEqual({ message: 'Sent.', sessionId: 's1' });
    });

    it('gives the error of the page, and ignores an unknown id', async () => {
        const { window } = fakeWindow();
        const bridge = new CliPageBridge(() => window);
        const pending = bridge.request(request, new AbortController().signal);
        bridge.answer(99, { message: 'Other.' }, undefined);
        bridge.answer(1, undefined, 'The agent tab closed.');
        await expect(pending).rejects.toMatchObject({ code: 'failed', message: 'The agent tab closed.' });
    });

    it('fails when the window closes, when the CLI stops, and at the timeout', async () => {
        const { window, emitter } = fakeWindow();
        const bridge = new CliPageBridge(() => window, 20);
        const closed = bridge.request(request, new AbortController().signal);
        emitter.emit('closed');
        await expect(closed).rejects.toMatchObject({ code: 'noWindow' });

        const controller = new AbortController();
        const cancelled = bridge.request(request, controller.signal);
        controller.abort();
        await expect(cancelled).rejects.toThrow('cancelled');

        await expect(bridge.request(request, new AbortController().signal)).rejects.toMatchObject({ code: 'timeout' });
    });
});
