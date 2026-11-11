import { describe, expect, it } from 'vitest';
import { checklistDoneCount, CHECKLIST_STEPS, shouldShowChecklist, updatedChecklist, type ChecklistFacts } from './checklist';

const none: ChecklistFacts = { hasRepository: false, hasWorktree: false, hasAgent: false, agentsViewOpen: false, hasPullRequest: false };

describe('updatedChecklist', () => {
    it('returns undefined when nothing changes', () => {
        expect(updatedChecklist(undefined, none)).toBeUndefined();
        expect(updatedChecklist({ addRepository: true }, { ...none, hasRepository: true })).toBeUndefined();
    });

    it('marks the steps of the facts done', () => {
        expect(updatedChecklist(undefined, { ...none, hasRepository: true, agentsViewOpen: true })).toEqual({ addRepository: true, openAgents: true });
        expect(updatedChecklist({ addRepository: true }, { ...none, hasWorktree: true, hasAgent: true, hasPullRequest: true })).toEqual({
            addRepository: true,
            createWorktree: true,
            startAgent: true,
            openPullRequest: true
        });
    });

    it('keeps a step done when its fact goes away', () => {
        expect(updatedChecklist({ createWorktree: true }, { ...none, hasRepository: true })).toEqual({ createWorktree: true, addRepository: true });
    });
});

describe('checklistDoneCount', () => {
    it('counts only the known steps that are done', () => {
        expect(checklistDoneCount(undefined)).toBe(0);
        expect(checklistDoneCount({ addRepository: true, startAgent: true, unknown: true })).toBe(2);
        expect(checklistDoneCount(Object.fromEntries(CHECKLIST_STEPS.map(step => [step.id, true])))).toBe(CHECKLIST_STEPS.length);
    });
});

describe('shouldShowChecklist', () => {
    it('shows the card after the welcome page until the user closes it', () => {
        expect(shouldShowChecklist({ welcome: 'done' })).toBe(true);
        expect(shouldShowChecklist({ welcome: 'skipped' })).toBe(true);
        expect(shouldShowChecklist({ welcome: 'new' })).toBe(false);
        expect(shouldShowChecklist({ welcome: 'done', checklistClosed: true })).toBe(false);
        expect(shouldShowChecklist(undefined)).toBe(false);
    });
});
