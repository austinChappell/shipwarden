import { describe, expect, it } from 'vitest';
import type { ForkTarget, RepoRef } from '@shared/github';
import { cloneUrlLike, headOf, resolvePullTarget, selectedRepo, setPullRequestInto, type RunGit } from './fork-target';

/** A fake git with remotes and a config. It records the commands that change the repository. */
function fakeGit(remotes: Record<string, string>, config: Record<string, string> = {}) {
    const changes: string[][] = [];
    const git: RunGit = async (_cwd, args) => {
        const [command, ...rest] = args;
        if (command === 'remote' && rest.length === 0) return Object.keys(remotes).join('\n');
        if (command === 'remote' && rest[0] === 'get-url') {
            const url = remotes[rest[1]];
            if (!url) throw new Error(`No remote ${rest[1]}`);
            return url;
        }
        if (command === 'remote' && rest[0] === 'add') {
            changes.push(args);
            remotes[rest[1]] = rest[2];
            return '';
        }
        if (command === 'config' && rest[0] === '--get-regexp') {
            const lines = Object.entries(config).filter(([key]) => key.endsWith('.gh-resolved'));
            if (lines.length === 0) throw new Error('exit 1');
            return lines.map(([key, value]) => `${key} ${value}`).join('\n');
        }
        if (command === 'config' && rest[0] === '--unset-all') {
            if (!(rest[1] in config)) throw new Error('exit 5');
            changes.push(args);
            delete config[rest[1]];
            return '';
        }
        if (command === 'config') {
            changes.push(args);
            config[rest[0]] = rest[1];
            return '';
        }
        throw new Error(`Unexpected git ${args.join(' ')}`);
    };
    return { git, changes, config };
}

const fork: RepoRef = { owner: 'me', name: 'api' };
const parent: RepoRef = { owner: 'acme', name: 'api' };
const parentOf = async (repo: RepoRef) => (repo.owner === 'me' ? parent : null);

describe('resolvePullTarget', () => {
    it('sends the pull requests to "origin" when it is not a fork', async () => {
        const { git } = fakeGit({ origin: 'git@github.com:acme/api.git' });
        expect(await resolvePullTarget(git, '/w', parentOf)).toEqual({ repo: parent, headOwner: 'acme' });
    });

    it('sends the pull requests of a fork to the parent by default', async () => {
        const { git } = fakeGit({ origin: 'git@github.com:me/api.git' });
        expect(await resolvePullTarget(git, '/w', parentOf)).toEqual({ repo: parent, headOwner: 'me', fork: { origin: fork, parent, into: 'parent' } });
    });

    it('sends the pull requests to the fork when gh selected the fork', async () => {
        const { git } = fakeGit({ origin: 'git@github.com:me/api.git', upstream: 'git@github.com:acme/api.git' }, { 'remote.origin.gh-resolved': 'base' });
        const target = await resolvePullTarget(git, '/w', parentOf);
        expect(target?.repo).toEqual(fork);
        expect(target?.fork?.into).toBe('origin');
    });

    it('returns null for a remote that is not on GitHub', async () => {
        const { git } = fakeGit({ origin: 'git@gitlab.com:me/api.git' });
        expect(await resolvePullTarget(git, '/w', parentOf)).toBeNull();
    });
});

describe('selectedRepo', () => {
    it('reads the "owner/name" value of an old gh', async () => {
        const { git } = fakeGit({ origin: 'git@github.com:me/api.git' }, { 'remote.origin.gh-resolved': 'acme/api' });
        expect(await selectedRepo(git, '/w')).toEqual(parent);
    });
});

describe('headOf', () => {
    it('adds the owner for a branch in a fork', () => {
        expect(headOf({ repo: parent, headOwner: 'me' }, 'fix')).toBe('me:fix');
        expect(headOf({ repo: parent, headOwner: 'ACME' }, 'fix')).toBe('fix');
    });
});

describe('setPullRequestInto', () => {
    const target: ForkTarget = { origin: fork, parent, into: 'parent' };

    it('adds an "upstream" remote for the parent with the protocol of "origin" and selects it', async () => {
        const { git, changes } = fakeGit({ origin: 'https://github.com/me/api.git' });
        await setPullRequestInto(git, '/w', target, 'parent');
        expect(changes).toEqual([
            ['remote', 'add', 'upstream', 'https://github.com/acme/api.git'],
            ['config', 'remote.upstream.gh-resolved', 'base']
        ]);
    });

    it('selects the fork and removes the selection of the parent', async () => {
        const { git, changes } = fakeGit(
            { origin: 'git@github.com:me/api.git', upstream: 'git@github.com:acme/api.git' },
            { 'remote.upstream.gh-resolved': 'base' }
        );
        await setPullRequestInto(git, '/w', target, 'origin');
        expect(changes).toEqual([
            ['config', '--unset-all', 'remote.upstream.gh-resolved'],
            ['config', 'remote.origin.gh-resolved', 'base']
        ]);
    });

    it('uses another name when "upstream" is a different repository', async () => {
        const { git, changes } = fakeGit({ origin: 'git@github.com:me/api.git', upstream: 'git@github.com:someone/api.git' });
        await setPullRequestInto(git, '/w', target, 'parent');
        expect(changes[0]).toEqual(['remote', 'add', 'parent', 'git@github.com:acme/api.git']);
    });
});

describe('cloneUrlLike', () => {
    it('keeps the SSH protocol', () => {
        expect(cloneUrlLike('ssh://git@github.com/me/api', parent)).toBe('git@github.com:acme/api.git');
    });
});
