import { describe, expect, it } from 'vitest';
import type { ConfirmRequest } from '@shared/api';
import { nativeConfirmOptions } from './confirm-options';
import { quitAndStopSessions, stopSessionsQuestion } from './quit';

describe('stopSessionsQuestion', () => {
    it.each([
        [[{ isAgent: true }], 'Stop 1 agent and quit?'],
        [[{ isAgent: true }, { isAgent: true }], 'Stop 2 agents and quit?'],
        [[{ isAgent: false }], 'Stop 1 shell and quit?'],
        [[{ isAgent: true }, { isAgent: true }, {}, {}, {}], 'Stop 2 agents and 3 shells and quit?']
    ])('names the sessions in the title of %j', (sessions, title) => {
        expect(stopSessionsQuestion(sessions).title).toBe(title);
    });

    it('asks with a danger button', () => {
        expect(stopSessionsQuestion([{ isAgent: true }])).toMatchObject({ confirmLabel: 'Stop and Quit', danger: true });
    });
});

describe('quitAndStopSessions', () => {
    /** Returns the dependencies with fake sessions, and the steps that occurred. */
    function fakes(sessions: { exited?: boolean; isAgent?: boolean }[], answer: boolean) {
        const steps: string[] = [];
        const questions: ConfirmRequest[] = [];
        const deps = {
            sessions: async () => sessions,
            confirm: async (request: ConfirmRequest) => { questions.push(request); return answer; },
            shutdownHost: async () => { steps.push('shutdown'); },
            quit: () => { steps.push('quit'); }
        };
        return { deps, steps, questions };
    }

    it('quits without a question when no session runs', async () => {
        const { deps, steps, questions } = fakes([{ exited: true, isAgent: true }], false);
        await quitAndStopSessions(deps);
        expect(questions).toEqual([]);
        expect(steps).toEqual(['shutdown', 'quit']);
    });

    it('asks first and counts only the running sessions', async () => {
        const { deps, steps, questions } = fakes([{ isAgent: true }, { exited: true }, {}], true);
        await quitAndStopSessions(deps);
        expect(questions.map(question => question.title)).toEqual(['Stop 1 agent and 1 shell and quit?']);
        expect(steps).toEqual(['shutdown', 'quit']);
    });

    it('does nothing when the user cancels', async () => {
        const { deps, steps } = fakes([{ isAgent: true }], false);
        await quitAndStopSessions(deps);
        expect(steps).toEqual([]);
    });
});

describe('nativeConfirmOptions', () => {
    it('uses the labels of the request', () => {
        expect(nativeConfirmOptions({ title: 'Quit?', message: 'Details', confirmLabel: 'Quit', cancelLabel: 'Stay' })).toEqual({
            type: 'warning',
            message: 'Quit?',
            detail: 'Details',
            buttons: ['Quit', 'Stay'],
            defaultId: 1,
            cancelId: 1
        });
    });

    it('gives OK and Cancel without labels', () => {
        expect(nativeConfirmOptions({ title: 'Quit?' }).buttons).toEqual(['OK', 'Cancel']);
    });
});
