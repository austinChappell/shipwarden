import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { CreateWorktreeProgress } from '@shared/worktrees';

let emitProgress: (id: string, progress: CreateWorktreeProgress) => void = () => undefined;
vi.stubGlobal('window', {
    shipwarden: {
        worktrees: {
            onProgress: (listener: typeof emitProgress) => {
                emitProgress = listener;
                return () => undefined;
            }
        }
    }
});

let mod: typeof import('./worktree-progress');
beforeAll(async () => {
    mod = await import('./worktree-progress');
});

const worktree = { path: '/w/feature', branch: 'feature', head: 'abc', isMain: false } as never;

describe('withStep', () => {
    it('adds a new step and replaces the counts of the same step', () => {
        const steps = mod.withStep(mod.withStep([{ step: 'checkout' }], { step: 'copy', done: 0, total: 3 }), { step: 'copy', done: 2, total: 3 });
        expect(steps).toEqual([{ step: 'checkout' }, { step: 'copy', done: 2, total: 3 }]);
    });
});

describe('stepLabel', () => {
    it('counts the item that the copy works on now', () => {
        expect(mod.stepLabel({ step: 'copy', done: 1, total: 4 }, true)).toBe('Copying the ignored files (2 of 4)…');
        expect(mod.stepLabel({ step: 'copy', done: 4, total: 4 }, false)).toBe('Copied the ignored files (4)');
    });
});

describe('worktreeProgress', () => {
    it('removes a creation with the dialog at the end', () => {
        mod.worktreeProgress.start('a', '/repo', 'feature');
        emitProgress('a', { step: 'checkout' });
        mod.worktreeProgress.finish('a', worktree);
        expect(mod.worktreeProgress.isBackground('a')).toBe(false);
    });

    it('keeps a creation in the background until the user closes its notice', () => {
        mod.worktreeProgress.start('b', '/repo', 'feature');
        mod.worktreeProgress.moveToBackground('b');
        expect(mod.worktreeProgress.isBackground('b')).toBe(true);
        mod.worktreeProgress.finish('b', worktree);
        expect(mod.worktreeProgress.isBackground('b')).toBe(true);
        mod.worktreeProgress.dismiss('b');
        expect(mod.worktreeProgress.isBackground('b')).toBe(false);
    });
});
