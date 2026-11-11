import { describe, expect, it } from 'vitest';
import type { TaskLink } from '@shared/tasks';
import { otherWorktreesOfTask, taskLinkOf, withTaskLink } from './task-links';

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

describe('taskLinkOf', () => {
    it('copies the key, title and URL of the task', () => {
        expect(taskLinkOf({ id: '1', key: 'ENG-1', title: 'Fix the login', url: 'https://x/1' }, 'c', 'clickup')).toEqual({
            connectionId: 'c',
            pluginId: 'clickup',
            taskId: '1',
            key: 'ENG-1',
            title: 'Fix the login',
            url: 'https://x/1'
        });
    });
});

describe('otherWorktreesOfTask', () => {
    it('finds the other worktrees with a link to the same task', () => {
        const links = { '/w1': link, '/w2': link, '/w3': { ...link, taskId: '2' }, '/w4': { ...link, connectionId: 'd' } };
        expect(otherWorktreesOfTask(links, link, '/w1')).toEqual(['/w2']);
    });

    it('matches an old link without a connection by its plugin', () => {
        const old: TaskLink = { pluginId: 'c', taskId: '1', title: 'Fix the login' };
        expect(otherWorktreesOfTask({ '/w2': old }, link, '/w1')).toEqual(['/w2']);
    });
});
