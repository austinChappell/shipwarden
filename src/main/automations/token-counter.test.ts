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
        expect(await counter.count(file, Date.parse('2026-11-10T09:00:00Z'))).toBe(260);
        expect(await counter.count(file, Date.parse('2026-11-10T09:00:00Z'), Date.parse('2026-11-10T10:30:00Z'))).toBe(130);
    });

    it('reads only the new end of a file, also a line that was incomplete', async () => {
        const full = line('a', '2026-11-10T10:00:00Z', { output_tokens: 5 });
        await writeFile(file, full.slice(0, 20));
        expect(await counter.count(file, 0)).toBe(0);
        await appendFile(file, full.slice(20) + line('b', '2026-11-10T10:01:00Z', { output_tokens: 7 }));
        expect(await counter.count(file, 0)).toBe(12);
    });

    it('adds the transcripts of the subagents', async () => {
        await writeFile(file, line('a', '2026-11-10T10:00:00Z', { output_tokens: 5 }));
        const subagents = path.join(root, 'project', 'session', 'subagents');
        await mkdir(subagents, { recursive: true });
        await writeFile(path.join(subagents, 'agent-1.jsonl'), line('s', '2026-11-10T10:00:01Z', { input_tokens: 3 }));
        expect(await counter.count(file, 0)).toBe(8);
    });

    it('refuses a file outside the Claude Code folder', async () => {
        await expect(counter.count('/etc/passwd.jsonl', 0)).rejects.toThrow(/Claude Code data folder/);
        await expect(counter.count(path.join(root, 'x.txt'), 0)).rejects.toThrow(/Claude Code data folder/);
    });
});
