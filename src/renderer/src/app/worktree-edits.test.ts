import { describe, expect, it } from 'vitest';
import type { Worktree } from '@shared/worktrees';
import {
    errorText,
    linkWorktreeChoice,
    linkWorktreeMenuItems,
    removeWorktreeDialog,
    sameRepoRef,
    snoozeChoice,
    teardownFailure,
    withHiddenWorktree,
    withRepoScripts,
    withWorktreeName,
    worktreeMenuItems
} from './worktree-edits';

const worktree = (fields: Partial<Worktree>): Worktree => ({ path: '/w', head: 'abc1234', isMain: false, ...fields }) as Worktree;

/** Returns the IDs of the menu items. A separator gives "-", and a submenu gives its label. */
const ids = (items: ReturnType<typeof worktreeMenuItems>) => items.map(item => ('type' in item ? '-' : 'id' in item ? item.id : item.label));

describe('errorText', () => {
    it('removes the prefix of an IPC error', () => {
        expect(errorText(new Error("Error invoking remote method 'worktrees:list': Error: not a git repository"))).toBe('not a git repository');
        expect(errorText(new Error("Error invoking remote method 'x': failed"))).toBe('failed');
    });

    it('accepts a value that is not an error', () => {
        expect(errorText('plain text')).toBe('plain text');
    });
});

describe('withWorktreeName', () => {
    it('sets a name and keeps the other names', () => {
        expect(withWorktreeName({ '/a': 'A' }, '/b', 'B')).toEqual({ '/a': 'A', '/b': 'B' });
        expect(withWorktreeName(undefined, '/b', 'B')).toEqual({ '/b': 'B' });
    });

    it('removes the name for an empty or missing name', () => {
        expect(withWorktreeName({ '/a': 'A', '/b': 'B' }, '/b', '')).toEqual({ '/a': 'A' });
        expect(withWorktreeName({ '/a': 'A' }, '/a', undefined)).toEqual({});
    });
});

describe('withHiddenWorktree', () => {
    const now = 1_000;

    it('hides a worktree and removes the snoozes that ended', () => {
        expect(withHiddenWorktree({ '/old': { until: 500 }, '/later': { until: 2_000 } }, '/w', {}, now)).toEqual({ '/later': { until: 2_000 }, '/w': {} });
    });

    it('shows a worktree again', () => {
        expect(withHiddenWorktree({ '/w': {} }, '/w', undefined, now)).toEqual({});
        expect(withHiddenWorktree(undefined, '/w', undefined, now)).toEqual({});
    });
});

describe('withRepoScripts', () => {
    const script = { id: 'test', name: 'Test', command: 'npm test' };

    it('sets the scripts and keeps the other settings of the repository', () => {
        expect(withRepoScripts({ '/r': { color: 'red' } }, '/r', [script])).toEqual({ '/r': { color: 'red', scripts: [script] } });
    });

    it('removes the scripts for an empty list, and removes an empty entry', () => {
        expect(withRepoScripts({ '/r': { color: 'red', scripts: [script] } }, '/r', [])).toEqual({ '/r': { color: 'red' } });
        expect(withRepoScripts({ '/r': { scripts: [script] }, '/s': {} }, '/r', [])).toEqual({ '/s': {} });
    });
});

describe('sameRepoRef', () => {
    it('ignores the case of the letters', () => {
        expect(sameRepoRef({ owner: 'Acme', name: 'App' }, { owner: 'acme', name: 'app' })).toBe(true);
    });

    it('is false for another repository or no repository', () => {
        expect(sameRepoRef({ owner: 'acme', name: 'web' }, { owner: 'acme', name: 'app' })).toBe(false);
        expect(sameRepoRef(null, { owner: 'acme', name: 'app' })).toBe(false);
    });
});

describe('removeWorktreeDialog', () => {
    it('tells that git keeps the branch', () => {
        const dialog = removeWorktreeDialog('feature', undefined, false);
        expect(dialog.title).toBe('Remove the worktree "feature"?');
        expect(dialog.message.startsWith('Git keeps the branch.')).toBe(true);
        expect(dialog.confirmLabel).toBe('Remove worktree');
    });

    it('tells about the branch delete and the teardown script', () => {
        const dialog = removeWorktreeDialog('feature', 'feature', true);
        expect(dialog.message).toContain('git deletes the local branch "feature"');
        expect(dialog.message.endsWith('The teardown script of the repository runs first.')).toBe(true);
        expect(dialog.confirmLabel).toBe('Remove and delete branch');
    });
});

describe('teardownFailure', () => {
    it('gives the exit code and the last 15 lines', () => {
        const output = Array.from({ length: 20 }, (_item, index) => `line ${index + 1}`).join('\n');
        const failure = teardownFailure({ code: 2, timedOut: false, output });
        expect(failure.title).toBe('The teardown script failed with exit code 2.');
        expect(failure.tail.split('\n')).toHaveLength(15);
        expect(failure.tail.startsWith('line 6\n')).toBe(true);
    });

    it('tells about a time-out', () => {
        expect(teardownFailure({ code: null, timedOut: true, output: '' }).title).toBe('The teardown script did not finish in 5 minutes.');
    });
});

describe('worktreeMenuItems', () => {
    it('offers to close the open shells', () => {
        const item = (shells: number) =>
            worktreeMenuItems(worktree({ branch: 'b' }), undefined, false, undefined, 0, shells).find(entry => 'id' in entry && entry.id === 'closeShells');
        expect(item(0)).toMatchObject({ label: 'Close Shells', enabled: false });
        expect(item(1)).toMatchObject({ label: 'Close 1 Shell…', enabled: true });
        expect(item(3)).toMatchObject({ label: 'Close 3 Shells…', enabled: true });
    });

    it('offers to open, change or unlink the task of a worktree with a task', () => {
        expect(ids(worktreeMenuItems(worktree({ branch: 'b' }), 'ENG-1', true, undefined, 0)).slice(0, 4)).toEqual(['task', 'linkTask', 'unlinkTask', '-']);
    });

    it('offers to link a worktree without a task', () => {
        const items = worktreeMenuItems(worktree({ branch: 'b' }), undefined, false, undefined, 0);
        expect(items[0]).toEqual({ id: 'linkTask', label: 'Link to Task…' });
    });

    it('offers to hide or snooze a visible worktree', () => {
        expect(ids(worktreeMenuItems(worktree({ branch: 'b' }), undefined, false, undefined, 0))).toEqual([
            'linkTask',
            '-',
            'rename',
            'closeShells',
            '-',
            'hide',
            'Snooze',
            '-',
            'remove',
            'removeBranch'
        ]);
    });

    it('offers to show a hidden worktree or to stop its snooze', () => {
        const hidden = worktreeMenuItems(worktree({ branch: 'b' }), undefined, false, {}, 0);
        expect(hidden).toContainEqual({ id: 'show', label: 'Show in Sidebar' });
        const snoozed = worktreeMenuItems(worktree({ branch: 'b' }), undefined, false, { until: 100 }, 0);
        expect(snoozed).toContainEqual({ id: 'show', label: 'Stop Snooze' });
    });

    it('disables the removal of the main worktree and of a worktree without a branch', () => {
        const main = worktreeMenuItems(worktree({ branch: 'main', isMain: true }), undefined, false, undefined, 0);
        // "Close Shells" is off too, because the worktree has no open shells.
        expect(main.filter(item => 'enabled' in item && item.enabled === false)).toHaveLength(3);
        const detached = worktreeMenuItems(worktree({}), undefined, false, undefined, 0);
        expect(detached).toContainEqual({ id: 'removeBranch', label: 'Remove Worktree and Delete Branch…', enabled: false, danger: true });
    });
});

describe('snoozeChoice', () => {
    it('returns the option of a snooze choice', () => {
        expect(snoozeChoice('snooze:hour')).toBe('hour');
        expect(snoozeChoice('snooze:nextWeek')).toBe('nextWeek');
    });

    it('returns undefined for other choices', () => {
        expect(snoozeChoice('snooze:never')).toBeUndefined();
        expect(snoozeChoice('hide')).toBeUndefined();
        expect(snoozeChoice(undefined)).toBeUndefined();
    });
});

describe('linkWorktreeMenuItems', () => {
    const link = { connectionId: 'c', pluginId: 'clickup', taskId: '1', key: 'ENG-1', title: 'Fix the login' };
    const label = (repo: string) => repo.toUpperCase();
    const projects = [
        { id: 'p1', name: 'One', repos: ['/r', '/s'] },
        { id: 'p2', name: 'Two', repos: ['/t'] },
        { id: 'p3', name: 'Empty', repos: [] }
    ];

    it('puts the worktrees under their project and repository, with the active project first', () => {
        const items = linkWorktreeMenuItems(
            projects,
            'p2',
            { '/r': [worktree({ path: '/r/a', branch: 'a' }), worktree({ path: '/r/b', branch: 'b' })], '/t': [worktree({ path: '/t/c', branch: 'c' })] },
            { '/r/b': 'Bee' },
            { '/r/a': link },
            label
        );
        expect(items).toEqual([
            { label: 'Two', submenu: [{ label: '/T', submenu: [{ id: 'link:/t/c', label: 'c' }] }] },
            {
                label: 'One',
                submenu: [
                    {
                        label: '/R',
                        submenu: [
                            { id: 'link:/r/a', label: 'a (ENG-1)' },
                            { id: 'link:/r/b', label: 'Bee' }
                        ]
                    }
                ]
            }
        ]);
    });

    it('shows a disabled item when no project has worktrees', () => {
        expect(linkWorktreeMenuItems(projects, 'p1', {}, undefined, {}, label)).toEqual([{ id: 'none', label: 'No project has worktrees', enabled: false }]);
    });
});

describe('linkWorktreeChoice', () => {
    it('returns the worktree path of a link choice', () => {
        expect(linkWorktreeChoice('link:/r/a')).toBe('/r/a');
        expect(linkWorktreeChoice('none')).toBeUndefined();
        expect(linkWorktreeChoice(undefined)).toBeUndefined();
    });
});
