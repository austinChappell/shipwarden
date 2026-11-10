import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SavedAnswer, SavedCodeAnswer } from '@shared/ask-agent';
import { AnswersStore, CodeAnswersStore } from './answers-store';

const answer = (id: string, number = 7): SavedAnswer => ({
    id,
    repo: { owner: 'Acme', name: 'App' },
    number,
    path: 'src/a.ts',
    side: 'RIGHT',
    startLine: 3,
    line: 5,
    question: 'Why?',
    agent: 'Claude Code',
    answer: 'Because.',
    commit: 'c'.repeat(40),
    answeredAt: 1000
});

describe('AnswersStore', () => {
    let dir: string;
    let file: string;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shipwarden-answers-'));
        file = path.join(dir, 'agent-answers.json');
    });

    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('keeps the answers of each pull request on disk', async () => {
        await new AnswersStore(file).save(answer('a'));
        await new AnswersStore(file).save(answer('b', 8));
        const store = new AnswersStore(file);
        expect((await store.list({ owner: 'acme', name: 'app' }, 7)).map(item => item.id)).toEqual(['a']);
        expect((await store.list({ owner: 'Acme', name: 'App' }, 8)).map(item => item.id)).toEqual(['b']);
    });

    it('replaces an answer with the same ID and removes an answer', async () => {
        const store = new AnswersStore(file);
        await store.save(answer('a'));
        await store.save({ ...answer('a'), answer: 'New.' });
        expect((await store.list({ owner: 'Acme', name: 'App' }, 7)).map(item => item.answer)).toEqual(['New.']);
        await store.remove('a');
        expect(await new AnswersStore(file).list({ owner: 'Acme', name: 'App' }, 7)).toEqual([]);
    });

    it('rejects an answer that is not correct', async () => {
        const store = new AnswersStore(file);
        await expect(store.save({ ...answer('a'), side: 'UP' })).rejects.toThrow('not correct');
        await expect(store.save({ ...answer('a'), startLine: 9 })).rejects.toThrow('not correct');
    });
});

describe('CodeAnswersStore', () => {
    let dir: string;
    let file: string;
    const codeAnswer = (id: string, filePath = 'src/a.ts'): SavedCodeAnswer => ({
        id,
        worktree: '/w',
        path: filePath,
        startLine: 1,
        line: 2,
        code: 'a\nb',
        question: 'Why?',
        agent: 'Claude Code',
        answer: 'Because.',
        answeredAt: 1
    });

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shipwarden-code-answers-'));
        file = path.join(dir, 'agent-code-answers.json');
    });

    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('keeps the answers of each file on disk, and removes them', async () => {
        await new CodeAnswersStore(file).save(codeAnswer('a'));
        await new CodeAnswersStore(file).save(codeAnswer('b', 'src/b.ts'));
        const store = new CodeAnswersStore(file);
        expect(await store.list('/w', 'src/a.ts')).toEqual([codeAnswer('a')]);
        await store.remove('a');
        expect(await store.list('/w', 'src/a.ts')).toEqual([]);
        expect((await store.list('/w', 'src/b.ts')).map(item => item.id)).toEqual(['b']);
    });

    it('rejects an answer that is not correct', async () => {
        await expect(new CodeAnswersStore(file).save({ id: 'x' })).rejects.toThrow('not correct');
    });
});
