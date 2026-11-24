import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import type { DictationUpdate } from '@shared/dictation';
import { DictationService } from './dictation-service';
import { FakeHelper } from './fake-helper';

function setup(options: { platform?: NodeJS.Platform; exists?: boolean; packaged?: boolean } = {}) {
    const helpers: FakeHelper[] = [];
    const paths: string[] = [];
    const service = new DictationService({
        helperPath: '/app/native/shipwarden-dictation',
        packaged: options.packaged ?? true,
        platform: options.platform ?? 'darwin',
        exists: () => options.exists ?? true,
        spawnHelper: path => {
            paths.push(path);
            const helper = new FakeHelper();
            helpers.push(helper);
            return helper;
        }
    });
    return { service, helpers, paths };
}

describe('DictationService', () => {
    it('starts the helper and stops the dictation of the ID', () => {
        const { service, helpers, paths } = setup();
        const updates: DictationUpdate[] = [];
        service.start('a', update => updates.push(update));
        expect(paths).toEqual(['/app/native/shipwarden-dictation']);
        service.stop('other');
        expect(helpers[0].stdinText).toBe('');
        service.stop('a');
        expect(helpers[0].stdinText).toBe('stop\n');
        helpers[0].send({ type: 'final', text: 'Done.' });
        expect(updates.at(-1)).toMatchObject({ id: 'a', state: 'done', text: 'Done.' });
    });

    it('runs one dictation at a time', () => {
        const { service, helpers } = setup();
        const first: DictationUpdate[] = [];
        service.start('a', update => first.push(update));
        service.start('b', () => undefined);
        expect(first.at(-1)?.state).toBe('cancelled');
        expect(helpers[0].killed).toEqual(['SIGTERM']);
        service.cancelAll();
        expect(helpers[1].stdinText).toBe('cancel\n');
    });

    it('reports a platform other than macOS', () => {
        const { service, helpers } = setup({ platform: 'linux' });
        const updates: DictationUpdate[] = [];
        service.start('a', update => updates.push(update));
        expect(helpers).toHaveLength(0);
        expect(updates.at(-1)?.error?.code).toBe('unsupportedPlatform');
    });

    it('tells a developer how to build a missing helper', () => {
        const { service } = setup({ exists: false, packaged: false });
        const updates: DictationUpdate[] = [];
        service.start('a', update => updates.push(update));
        expect(updates.at(-1)?.error).toEqual({ code: 'helperMissing', message: 'Run "npm run build:dictation" one time, then try again.' });
    });
});

describe('DictationService with a real process', () => {
    it('reads the lines of the process and writes "stop" to its stdin', async () => {
        const folder = mkdtempSync(join(tmpdir(), 'dictation-'));
        const script = join(folder, 'helper.sh');
        // A fake helper: it records until it reads a command, then it writes the final text of that command.
        writeFileSync(script, '#!/bin/sh\necho \'{"type":"listening"}\'\nread command\necho "{\\"type\\":\\"final\\",\\"text\\":\\"$command\\"}"\n');
        chmodSync(script, 0o755);
        try {
            const service = new DictationService({ helperPath: script, packaged: true, platform: 'darwin' });
            const updates: DictationUpdate[] = [];
            const done = new Promise<void>(resolve => {
                service.start('a', update => {
                    updates.push(update);
                    if (update.state === 'listening') service.stop('a');
                    if (update.state === 'done') resolve();
                });
            });
            await done;
            expect(updates.map(update => update.state)).toEqual(['starting', 'listening', 'stopping', 'done']);
            expect(updates.at(-1)?.text).toBe('stop');
        } finally {
            rmSync(folder, { recursive: true, force: true });
        }
    });
});
