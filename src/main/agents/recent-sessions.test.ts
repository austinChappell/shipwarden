import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RecentSessions } from './recent-sessions';

const NOW = Date.UTC(2026, 10, 19, 12);
const HOUR = 60 * 60 * 1000;
const ID_A = '1c9b47cc-a11d-4e49-a0f7-78590b290474';
const ID_B = '2c9b47cc-a11d-4e49-a0f7-78590b290474';
const ID_C = '3c9b47cc-a11d-4e49-a0f7-78590b290474';
const ID_D = '4c9b47cc-a11d-4e49-a0f7-78590b290474';

function transcript(prompt: string, extra: { entrypoint?: string; title?: string; padding?: number } = {}): string {
    const lines = [
        { type: 'user', message: { role: 'user', content: prompt }, cwd: '/w/app', gitBranch: 'main', entrypoint: extra.entrypoint ?? 'cli' },
        ...Array.from({ length: extra.padding ?? 0 }, (_, index) => ({ type: 'assistant', uuid: `a${index}`, message: { content: 'x'.repeat(1000) } })),
        { type: 'user', message: { role: 'user', content: 'later' }, cwd: '/w/app', gitBranch: 'feature' },
        ...(extra.title ? [{ type: 'ai-title', aiTitle: extra.title }] : [])
    ];
    return `${lines.map(line => JSON.stringify(line)).join('\n')}\n`;
}

describe('RecentSessions', () => {
    let dir: string;
    let root: string;
    let folder: string;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shipwarden-recent-'));
        root = path.join(dir, '.claude');
        folder = path.join(root, 'projects', '-w-app');
        await fs.mkdir(folder, { recursive: true });
    });
    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    async function write(id: string, content: string, ageMs: number, into = folder): Promise<string> {
        const file = path.join(into, `${id}.jsonl`);
        await fs.writeFile(file, content);
        const time = new Date(NOW - ageMs);
        await fs.utimes(file, time, time);
        return file;
    }

    it('lists the interactive sessions of the last 3 days, the newest first', async () => {
        await write(ID_A, transcript('First task', { title: 'Fix the login test' }), 2 * HOUR);
        await write(ID_B, transcript('Second task', { padding: 600 }), HOUR);
        await write(ID_C, transcript('Old task'), 4 * 24 * HOUR);
        await write(ID_D, transcript('Print run', { entrypoint: 'sdk-cli' }), HOUR);
        const recent = new RecentSessions({ roots: () => [root], now: () => NOW });
        const list = await recent.list();
        expect(list.map(item => [item.sessionId, item.name, item.branch])).toEqual([
            [ID_B, 'Second task', 'feature'],
            [ID_A, 'Fix the login test', 'feature']
        ]);
        expect(list[0]?.cwd).toBe('/w/app');
    });

    it('shows a session one time when a resume made a copy in another folder', async () => {
        const other = path.join(root, 'projects', '-w-other');
        await fs.mkdir(other, { recursive: true });
        await write(ID_A, transcript('Task'), 2 * HOUR);
        const copy = await write(ID_A, transcript('Task'), HOUR, other);
        const list = await new RecentSessions({ roots: () => [root], now: () => NOW }).list();
        expect(list).toHaveLength(1);
        expect(list[0]?.transcript).toBe(copy);
    });

    it('copies the transcript into the Claude Code folder of the target for a resume', async () => {
        const source = await write(ID_A, transcript('Task'), HOUR);
        const recent = new RecentSessions({ roots: () => [root], now: () => NOW });
        const destination = await recent.prepareResume(source, '/w/other');
        expect(destination).toBe(path.join(root, 'projects', '-w-other', `${ID_A}.jsonl`));
        expect(await fs.readFile(destination, 'utf8')).toBe(await fs.readFile(source, 'utf8'));
        await expect(recent.prepareResume(path.join(dir, 'outside.jsonl'), '/w/other')).rejects.toThrow('not in an agent data folder');
    });
});
