import { mkdtemp, rm, writeFile, appendFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FIRST_READ_BYTES, readTranscript } from './transcript-reader';

describe('readTranscript', () => {
    let root: string;
    let file: string;

    beforeEach(async () => {
        root = await mkdtemp(path.join(os.tmpdir(), 'transcript-'));
        file = path.join(root, 'session.jsonl');
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it('refuses a file outside the Claude Code data folders', async () => {
        await expect(readTranscript(path.join(os.tmpdir(), 'x.jsonl'), -1, [root])).rejects.toThrow('Claude Code data folder');
        await expect(readTranscript(path.join(root, 'x.json'), -1, [root])).rejects.toThrow('Claude Code data folder');
    });

    it('gives no lines for a missing file', async () => {
        expect(await readTranscript(file, -1, [root])).toEqual({ lines: [], offset: 0, truncated: false });
    });

    it('reads complete lines, and keeps an incomplete last line for the next read', async () => {
        await writeFile(file, '{"a":1}\n{"b":"é"}\n{"c":');
        const first = await readTranscript(file, -1, [root]);
        expect(first.lines).toEqual(['{"a":1}', '{"b":"é"}']);
        await appendFile(file, '3}\n');
        const second = await readTranscript(file, first.offset, [root]);
        expect(second.lines).toEqual(['{"c":3}']);
        expect(await readTranscript(file, second.offset, [root])).toMatchObject({ lines: [] });
    });

    it('reads only the end of a long file at the first read', async () => {
        const long = `${'x'.repeat(FIRST_READ_BYTES)}\n`;
        await writeFile(file, `${long}{"last":true}\n`);
        const chunk = await readTranscript(file, -1, [root]);
        expect(chunk).toMatchObject({ lines: ['{"last":true}'], truncated: true });
    });

    it('reads a file again when it is shorter than the offset', async () => {
        await writeFile(file, '{"new":1}\n');
        expect((await readTranscript(file, 500, [root])).lines).toEqual(['{"new":1}']);
    });
});
