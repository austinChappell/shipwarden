import { describe, expect, it } from 'vitest';
import type { SavedAnswer } from '@shared/ask-agent';
import type { RepoRef } from '@shared/github';
import { addLoaded, answerOutdated, answerQuestion, changeQuestion, failQuestion, fromSaved, toSaved, type AgentQuestion } from './agent-questions';

const repo = { owner: 'o', name: 'r' } as RepoRef;

const question = (id: string, parts: Partial<AgentQuestion> = {}): AgentQuestion =>
    ({ id, path: 'a.ts', side: 'RIGHT', startLine: 2, line: 4, question: 'Why?', status: 'running', ...parts });

const saved: SavedAnswer = {
    id: 'q1', repo, number: 7, path: 'a.ts', side: 'LEFT', startLine: 2, line: 4,
    question: 'Why?', agent: 'Claude', answer: 'Because.', commit: 'abc', answeredAt: 1000
};

describe('fromSaved and toSaved', () => {
    it('makes a collapsed card from a saved answer', () => {
        expect(fromSaved(saved)).toEqual({
            id: 'q1', path: 'a.ts', side: 'LEFT', startLine: 2, line: 4, question: 'Why?', status: 'done',
            agent: 'Claude', answer: 'Because.', commit: 'abc', answeredAt: 1000, collapsed: true
        });
    });

    it('makes the same saved answer from a card', () => {
        const card = question('q1', { side: 'LEFT' });
        expect(toSaved(card, repo, 7, { agent: 'Claude', answer: 'Because.' }, 'abc', 1000)).toEqual(saved);
    });
});

describe('addLoaded', () => {
    it('puts the loaded answers first and keeps the questions of the list', () => {
        const list = [question('new'), question('q1', { status: 'error' })];
        const result = addLoaded(list, [fromSaved(saved), fromSaved({ ...saved, id: 'q2' })]);
        expect(result.map(item => item.id)).toEqual(['q2', 'new', 'q1']);
        expect(result[2].status).toBe('error');
    });
});

describe('changeQuestion', () => {
    it('changes only the question with the ID', () => {
        const result = changeQuestion([question('a'), question('b')], 'b', { collapsed: true });
        expect(result.map(item => item.collapsed)).toEqual([undefined, true]);
    });
});

describe('answerQuestion', () => {
    it('puts the answer on a running question and opens the card', () => {
        const [result] = answerQuestion([question('a', { collapsed: true })], 'a', { agent: 'Codex', answer: 'Yes.' }, 'abc', 5);
        expect(result).toMatchObject({ status: 'done', agent: 'Codex', answer: 'Yes.', commit: 'abc', answeredAt: 5, collapsed: false });
    });

    it('does not change a question that does not run', () => {
        const list = [question('a', { status: 'error', error: 'Stopped' })];
        expect(answerQuestion(list, 'a', { agent: 'Codex', answer: 'Yes.' }, 'abc', 5)).toEqual(list);
    });
});

describe('failQuestion', () => {
    it('puts the error on a running question', () => {
        expect(failQuestion([question('a')], 'a', 'No agent')[0]).toMatchObject({ status: 'error', error: 'No agent' });
    });

    it('does not change a question that does not run', () => {
        const list = [question('a', { status: 'done', answer: 'Yes.' })];
        expect(failQuestion(list, 'a', 'No agent')).toEqual(list);
    });
});

describe('answerOutdated', () => {
    it('is true when the agent answered on an older commit', () => {
        expect(answerOutdated(question('a', { status: 'done', answer: 'Yes.', commit: 'old' }), 'new')).toBe(true);
    });

    it('is false on the current commit, without a commit, or without an answer', () => {
        expect(answerOutdated(question('a', { status: 'done', answer: 'Yes.', commit: 'new' }), 'new')).toBe(false);
        expect(answerOutdated(question('a', { status: 'done', answer: 'Yes.' }), 'new')).toBe(false);
        expect(answerOutdated(question('a', { status: 'done', commit: 'old' }), 'new')).toBe(false);
        expect(answerOutdated(question('a', { commit: 'old' }), 'new')).toBe(false);
    });
});
