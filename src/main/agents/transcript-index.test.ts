import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SNIPPET_END, SNIPPET_START } from '@shared/transcript-search';
import { TranscriptIndex } from './transcript-index';

const SESSION_A = 'aaaaaaaa-1111-2222-3333-444444444444';
const SESSION_B = 'bbbbbbbb-1111-2222-3333-444444444444';
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-19T12:00:00Z');

const at = (ms: number) => new Date(ms).toISOString();

function prompt(text: string, time: number, cwd = '/w/app'): string {
    return JSON.stringify({ type: 'user', cwd, gitBranch: 'main', entrypoint: 'cli', timestamp: at(time), message: { role: 'user', content: text } });
}

function reply(parts: unknown[], time: number, model = 'claude-sonnet-4-5'): string {
    return JSON.stringify({ type: 'assistant', timestamp: at(time), message: { role: 'assistant', model, content: parts } });
}

function toolResult(text: string, time: number): string {
    return JSON.stringify({
        type: 'user',
        timestamp: at(time),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: text }] }
    });
}

const lines = (...items: string[]) => `${items.join('\n')}\n`;

describe('TranscriptIndex', () => {
    let root: string;
    let folder: string;
    let index: TranscriptIndex;
    let dbFile: string;

    beforeEach(async () => {
        root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'transcript-index-')));
        folder = path.join(root, 'claude', 'projects', '-w-app');
        await mkdir(folder, { recursive: true });
        dbFile = path.join(root, 'data', 'transcript-index.db');
        index = new TranscriptIndex({ file: dbFile, roots: () => [path.join(root, 'claude')] });
    });

    afterEach(async () => {
        index.close();
        await rm(root, { recursive: true, force: true });
    });

    it('finds prompts, agent text, and tool call file paths, but not tool output', async () => {
        await writeFile(
            path.join(folder, `${SESSION_A}.jsonl`),
            lines(
                prompt('Fix the login bug', NOW - 3 * DAY),
                reply(
                    [
                        { type: 'text', text: 'The token check in auth.ts is wrong.' },
                        { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/w/app/src/auth.ts', old_string: 'secretword' } }
                    ],
                    NOW - 3 * DAY + 1000
                ),
                toolResult('The file contains outputonlyword', NOW - 3 * DAY + 2000)
            )
        );
        await index.scan();

        const login = await index.search({ text: 'login' });
        expect(login.hits).toHaveLength(1);
        expect(login.hits[0]).toMatchObject({ sessionId: SESSION_A, name: 'Fix the login bug', cwd: '/w/app', kind: 'prompt', model: 'claude-sonnet-4-5' });
        expect(login.hits[0].snippet).toContain(`${SNIPPET_START}login${SNIPPET_END}`);

        const file = await index.search({ text: 'src/auth.ts' });
        expect(file.hits[0]).toMatchObject({ sessionId: SESSION_A, kind: 'file' });

        const both = await index.search({ text: 'auth.ts' });
        expect(both.hits[0].matches).toBe(2);

        expect((await index.search({ text: 'outputonlyword' })).hits).toEqual([]);
        expect((await index.search({ text: 'secretword' })).hits).toEqual([]);
        expect(login.models).toEqual(['claude-sonnet-4-5']);
    });

    it('matches the start of the last word and needs all words', async () => {
        await writeFile(path.join(folder, `${SESSION_A}.jsonl`), lines(prompt('Refactor the payment service', NOW)));
        await index.scan();
        expect((await index.search({ text: 'paym' })).hits).toHaveLength(1);
        expect((await index.search({ text: 'payment serv' })).hits).toHaveLength(1);
        expect((await index.search({ text: 'payment login' })).hits).toHaveLength(0);
        expect((await index.search({ text: '  "  ' })).hits).toHaveLength(0);
    });

    it('filters by folder, model, and date', async () => {
        await writeFile(
            path.join(folder, `${SESSION_A}.jsonl`),
            lines(prompt('Change the cache', NOW - 10 * DAY), reply([{ type: 'text', text: 'ok' }], NOW - 10 * DAY))
        );
        const other = path.join(root, 'claude', 'projects', '-w-api');
        await mkdir(other, { recursive: true });
        await writeFile(
            path.join(other, `${SESSION_B}.jsonl`),
            lines(prompt('Change the cache too', NOW - DAY, '/w/api/sub'), reply([{ type: 'text', text: 'ok' }], NOW - DAY, 'claude-opus-4-5'))
        );
        await index.scan();

        const all = await index.search({ text: 'cache' });
        expect(all.hits.map(hit => hit.sessionId)).toEqual([SESSION_B, SESSION_A]);
        expect(all.models).toEqual(['claude-opus-4-5', 'claude-sonnet-4-5']);
        expect((await index.search({ text: 'cache', folders: ['/w/api'] })).hits.map(hit => hit.sessionId)).toEqual([SESSION_B]);
        expect((await index.search({ text: 'cache', folders: ['/w/ap'] })).hits).toEqual([]);
        expect((await index.search({ text: 'cache', model: 'claude-sonnet-4-5' })).hits.map(hit => hit.sessionId)).toEqual([SESSION_A]);
        expect((await index.search({ text: 'cache', since: NOW - 7 * DAY })).hits.map(hit => hit.sessionId)).toEqual([SESSION_B]);
    });

    it('reads only the new lines of a changed transcript', async () => {
        const file = path.join(folder, `${SESSION_A}.jsonl`);
        await writeFile(file, lines(prompt('First prompt about routers', NOW)));
        await index.scan();
        // The second line is not complete yet.
        await appendFile(file, `${prompt('Second prompt about queues', NOW + 1000)}`);
        index.update(file);
        await index.idle();
        expect((await index.search({ text: 'queues' })).hits).toEqual([]);

        await appendFile(file, '\n');
        index.update(file);
        await index.idle();
        expect((await index.search({ text: 'queues' })).hits).toHaveLength(1);
        await index.scan();
        index.close();

        // Each line is in the index one time: no line was read twice.
        const db = new DatabaseSync(dbFile);
        try {
            const rows = db.prepare('SELECT text FROM entries ORDER BY rowid').all() as { text: string }[];
            expect(rows.map(row => row.text)).toEqual(['First prompt about routers', 'Second prompt about queues']);
            const fileRow = db.prepare('SELECT offset FROM files').get() as { offset: number };
            expect(fileRow.offset).toBe(Buffer.byteLength(lines(prompt('First prompt about routers', NOW), prompt('Second prompt about queues', NOW + 1000))));
        } finally {
            db.close();
        }
    });

    it('reads a transcript again when it gets shorter, and removes a transcript that is gone', async () => {
        const file = path.join(folder, `${SESSION_A}.jsonl`);
        await writeFile(file, lines(prompt('Old text about lanterns', NOW), prompt('More old text about lanterns', NOW)));
        await index.scan();
        await writeFile(file, lines(prompt('New text about kettles', NOW)));
        index.update(file);
        await index.idle();
        expect((await index.search({ text: 'lanterns' })).hits).toEqual([]);
        expect((await index.search({ text: 'kettles' })).hits).toHaveLength(1);

        await rm(file);
        await index.scan();
        expect((await index.search({ text: 'kettles' })).hits).toEqual([]);
    });

    it('keeps the index in its file for the next start', async () => {
        await writeFile(path.join(folder, `${SESSION_A}.jsonl`), lines(prompt('Persisted prompt about walrus', NOW)));
        await index.scan();
        index.close();
        index = new TranscriptIndex({ file: dbFile, roots: () => [path.join(root, 'claude')] });
        expect((await index.search({ text: 'walrus' })).hits).toHaveLength(1);
    });

    it('ignores files outside the Claude Code data folders and subagent lines', async () => {
        index.update(path.join(os.tmpdir(), `${SESSION_A}.jsonl`));
        await writeFile(
            path.join(folder, `${SESSION_A}.jsonl`),
            lines(prompt('Main prompt', NOW), JSON.stringify({ type: 'user', isSidechain: true, timestamp: at(NOW), message: { content: 'sidechainword' } }))
        );
        await index.scan();
        expect((await index.search({ text: 'sidechainword' })).hits).toEqual([]);
        expect((await index.search({ text: 'main' })).hits).toHaveLength(1);
    });
});
