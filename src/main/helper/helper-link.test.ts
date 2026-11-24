import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { ResponseError } from 'vscode-jsonrpc/node';
import { HttpError, type RemoteServer } from '../remote/remote-server';
import { connectHelper, type HelperConnection } from './helper-link';
import { HelperServer } from './helper-server';

describe('the start requests between the helper and the app', () => {
    const cleanups: (() => void)[] = [];
    afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()));

    async function connect(startAgent: (body: unknown) => Promise<never>): Promise<{ server: HelperServer; link: HelperConnection }> {
        const folder = mkdtempSync(join(tmpdir(), 'sw-link-'));
        const server = new HelperServer({ socketPath: join(folder, 'h.sock'), buildId: 'b', remote: {} as RemoteServer, onResize: () => undefined });
        await server.start();
        const link = await connectHelper(join(folder, 'h.sock'), {
            snapshot: async () => ({ projects: [], agents: [] }),
            approvePullRequest: async () => undefined,
            answerRun: async () => undefined,
            startOptions: async () => ({ repos: [], agents: [], tasks: [] }),
            startAgent,
            statusChanged: () => undefined
        });
        cleanups.push(() => {
            link?.close();
            server.stop();
            rmSync(folder, { recursive: true, force: true });
        });
        await link!.hello();
        return { server, link: link! };
    }

    it('gives the HTTP status of an error of the app to the helper', async () => {
        const { server } = await connect(async () => {
            throw new HttpError(503, 'The ShipWarden window is closed.');
        });
        const error = await server.appStartAgent({ repoPath: '/repo', prompt: 'x' }).catch(caught => caught);
        expect(error).toBeInstanceOf(ResponseError);
        expect((error as ResponseError<unknown>).code).toBe(503);
        expect((error as Error).message).toBe('The ShipWarden window is closed.');
        expect(await server.appStartOptions()).toEqual({ repos: [], agents: [], tasks: [] });
    });
});
