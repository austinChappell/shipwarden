import { describe, expect, it } from 'vitest';
import type { TaskLink } from '@shared/tasks';
import { withTaskLink } from './task-links';

const link: TaskLink = { connectionId: 'c', pluginId: 'clickup', taskId: '1', title: 'Fix the login' };

describe('withTaskLink', () => {
    it('adds or replaces the link of a worktree', () => {
        expect(withTaskLink({}, '/w1', link)).toEqual({ '/w1': link });
        expect(withTaskLink({ '/w1': { ...link, taskId: '2' } }, '/w1', link)).toEqual({ '/w1': link });
    });

    it('removes the link with null and keeps the other links', () => {
        const before = { '/w1': link, '/w2': link };
        expect(withTaskLink(before, '/w1', null)).toEqual({ '/w2': link });
        expect(before).toEqual({ '/w1': link, '/w2': link });
    });
});
