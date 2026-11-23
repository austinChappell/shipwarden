import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TokenCounter } from './token-counter';

function line(id: string, at: string, usage: Record<string, number>): string {
    return `${JSON.stringify({ type: 'assistant', timestamp: at, message: { id, usage } })}\n`;
}

describe('TokenCounter', () => {
    let root: string;
    let file: string;
    let counter: TokenCounter;

    beforeEach(async () => {
        root = await mkdtemp(path.join(os.tmpdir(), 'tokens-'));
        file = path.join(root, 'project', 'session.jsonl');
        await mkdir(path.dirname(file), { recursive: true });
        counter = new TokenCounter([root]);
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it('counts input, cache writes and output once for each message, in the time window', async () => {
        const usage = { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 5000, output_tokens: 20 };
        await writeFile(
            file,
            [
                line('a', '2026-11-10T10:00:00Z', usage),
                // Claude Code writes one line for each content block of a message, with the same usage.
                line('a', '2026-11-10T10:00:00Z', usage),
                line('b', '2026-11-10T11:00:00Z', usage),
                '{"type":"user","message":{"content":"hi"}}\n',
                'not json\n'
            ].join('')
        );
        expect(await counter.count(file, Date.parse('2026-11-10T09:00:00Z'))).toEqual({ tokens: 260, cacheReads: 10_000 });
        expect(await counter.count(file, Date.parse('2026-11-10T09:00:00Z'), Date.parse('2026-11-10T10:30:00Z'))).toEqual({ tokens: 130, cacheReads: 5000 });
    });

    it('reads only the new end of a file, also a line that was incomplete', async () => {
        const full = line('a', '2026-11-10T10:00:00Z', { output_tokens: 5 });
        await writeFile(file, full.slice(0, 20));
        expect((await counter.count(file, 0)).tokens).toBe(0);
        await appendFile(file, full.slice(20) + line('b', '2026-11-10T10:01:00Z', { output_tokens: 7 }));
        expect((await counter.count(file, 0)).tokens).toBe(12);
    });

    it('gives the same sum for two counts at the same time, also with an incomplete line', async () => {
        const next = line('c', '2026-11-10T10:02:00Z', { output_tokens: 11 });
        await writeFile(file, line('a', '2026-11-10T10:00:00Z', { input_tokens: 4, output_tokens: 6 }) + next.slice(0, 15));
        expect((await Promise.all([counter.count(file, 0), counter.count(file, 0)])).map(item => item.tokens)).toEqual([10, 10]);
        await appendFile(file, next.slice(15));
        expect((await Promise.all([counter.count(file, 0), counter.count(file, Date.parse('2026-11-10T10:01:00Z'))])).map(item => item.tokens)).toEqual([
            21, 11
        ]);
    });

    it('adds the transcripts of the subagents', async () => {
        await writeFile(file, line('a', '2026-11-10T10:00:00Z', { output_tokens: 5 }));
        const subagents = path.join(root, 'project', 'session', 'subagents');
        await mkdir(subagents, { recursive: true });
        await writeFile(path.join(subagents, 'agent-1.jsonl'), line('s', '2026-11-10T10:00:01Z', { input_tokens: 3 }));
        expect((await counter.count(file, 0)).tokens).toBe(8);
    });

    it('refuses a file outside the Claude Code folder', async () => {
        await expect(counter.count('/etc/passwd.jsonl', 0)).rejects.toThrow(/Claude Code or Codex data folder/);
        await expect(counter.count(path.join(root, 'x.txt'), 0)).rejects.toThrow(/Claude Code or Codex data folder/);
    });
});

describe('TokenCounter with Codex session files', () => {
    let root: string;
    let file: string;
    let counter: TokenCounter;

    /** One "token_count" event with the total of the session. */
    function total(at: string, input: number, cached: number, output: number): string {
        const usage = { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output };
        return `${JSON.stringify({ timestamp: at, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage, last_token_usage: usage } } })}\n`;
    }

    beforeEach(async () => {
        root = await mkdtemp(path.join(os.tmpdir(), 'codex-tokens-'));
        file = path.join(root, 'sessions', '2026', '11', '10', 'rollout-2026-11-10T10-00-00-01a2.jsonl');
        await mkdir(path.dirname(file), { recursive: true });
        counter = new TokenCounter([root]);
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it('counts the change of the total in the time window, without cache reads', async () => {
        await writeFile(
            file,
            [
                '{"timestamp":"2026-11-10T10:00:00Z","type":"session_meta","payload":{"id":"01a2","cwd":"/w"}}\n',
                total('2026-11-10T10:00:01Z', 1000, 800, 50),
                // A plan usage update writes the same total again. It adds nothing.
                total('2026-11-10T10:00:02Z', 1000, 800, 50),
                `${JSON.stringify({ timestamp: '2026-11-10T10:00:03Z', type: 'event_msg', payload: { type: 'token_count', info: null } })}\n`,
                total('2026-11-10T11:00:00Z', 3000, 2500, 80),
                'not json\n'
            ].join('')
        );
        // The first response: 200 new input and 50 output. The second: 300 new input and 30 output.
        expect(await counter.count(file, 0)).toEqual({ tokens: 580, cacheReads: 2500 });
        expect(await counter.count(file, Date.parse('2026-11-10T10:30:00Z'))).toEqual({ tokens: 330, cacheReads: 1700 });
    });

    it('reads only the new end of the file', async () => {
        await writeFile(file, total('2026-11-10T10:00:01Z', 100, 0, 10));
        expect((await counter.count(file, 0)).tokens).toBe(110);
        await appendFile(file, total('2026-11-10T10:01:00Z', 300, 100, 20));
        expect((await counter.count(file, 0)).tokens).toBe(220);
    });
});
