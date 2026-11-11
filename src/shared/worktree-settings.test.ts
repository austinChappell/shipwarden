import { describe, expect, it } from 'vitest';
import {
    matchesCopyPattern,
    normalizeRepoWorktreeSettings,
    normalizeWorktreeSettings,
    resolveWorktreeSettings,
    ignoredUnits,
    selectCopyEntries,
    setupCommand,
    shellQuote
} from './worktree-settings';

describe('matchesCopyPattern', () => {
    it('matches a name without "/" at any depth', () => {
        expect(matchesCopyPattern('.env', '.env')).toBe(true);
        expect(matchesCopyPattern('apps/web/.env.local', '.env.*')).toBe(true);
        expect(matchesCopyPattern('.envrc', '.env.*')).toBe(false);
        expect(matchesCopyPattern('src/.env.example.ts', '*.ts')).toBe(true);
    });

    it('matches a pattern with "/" from the repository root', () => {
        expect(matchesCopyPattern('config/master.key', 'config/*.key')).toBe(true);
        expect(matchesCopyPattern('apps/config/master.key', 'config/*.key')).toBe(false);
        expect(matchesCopyPattern('apps/web/.env', '**/.env')).toBe(true);
        expect(matchesCopyPattern('.env', '**/.env')).toBe(true);
        expect(matchesCopyPattern('certs/', '/certs/')).toBe(true);
        expect(matchesCopyPattern('certs', 'certs/')).toBe(false);
    });
});

describe('worktree settings', () => {
    it('closes stale shells by default and keeps the switch off when the user turns it off', () => {
        expect(normalizeWorktreeSettings(undefined).closeStaleShells).toBe(true);
        expect(normalizeWorktreeSettings({ closeStaleShells: 'no' }).closeStaleShells).toBe(true);
        expect(normalizeWorktreeSettings({ closeStaleShells: false }).closeStaleShells).toBe(false);
    });

    it('gives defaults and keeps valid values', () => {
        expect(normalizeWorktreeSettings(undefined).copyIgnored).toMatchObject({ enabled: true, mode: 'matching', patterns: ['.env', '.env.*'] });
        expect(
            normalizeWorktreeSettings({ directory: ' ~/wt ', copyIgnored: { enabled: false, mode: 'allExcept', patterns: [' a ', 'a', '', 4], exclude: [] } })
        ).toEqual({
            directory: '~/wt',
            copyIgnored: { enabled: false, mode: 'allExcept', patterns: ['a'], exclude: [] },
            sort: { by: 'created', direction: 'asc' },
            closeStaleShells: true
        });
        // Settings from before the mode keep their patterns and get the default exclusions.
        expect(normalizeWorktreeSettings({ copyIgnored: { enabled: true, patterns: ['.env'] } }).copyIgnored.exclude).toContain('node_modules/');
        expect(normalizeRepoWorktreeSettings({ setupScript: 'npm ci\n\n', teardownScript: '  ' })).toEqual({ setupScript: 'npm ci' });
        expect(normalizeRepoWorktreeSettings({ directory: '' })).toBeUndefined();
    });

    it('uses the repository settings, else the global settings', () => {
        const global = normalizeWorktreeSettings({ directory: '~/wt/' });
        expect(resolveWorktreeSettings(global, undefined, '/r/api', '/h/.shipwarden/worktrees', '/h')).toEqual({
            parentFolder: '/h/wt/api',
            copyIgnored: global.copyIgnored
        });
        const off = { enabled: false, mode: 'matching' as const, patterns: [], exclude: [] };
        const repo = { directory: '~/api-trees', copyIgnored: off, setupScript: 'npm ci' };
        expect(resolveWorktreeSettings(normalizeWorktreeSettings({}), repo, '/r/api', '/h/.shipwarden/worktrees', '/h')).toEqual({
            parentFolder: '/h/api-trees',
            copyIgnored: off,
            setupScript: 'npm ci'
        });
        expect(resolveWorktreeSettings(normalizeWorktreeSettings({}), undefined, '/r/api', '/h/.shipwarden/worktrees', '/h').parentFolder).toBe(
            '/h/.shipwarden/worktrees/api'
        );
    });

    it('builds the setup command with quoted variables', () => {
        expect(shellQuote("it's")).toBe(`'it'\\''s'`);
        expect(setupCommand('npm ci', { rootPath: '/r/api', worktreePath: '/w/x', branch: 'feat/a', repoName: 'api' })).toBe(
            "export SHIPWARDEN_ROOT_PATH='/r/api'; export SHIPWARDEN_WORKTREE_PATH='/w/x'; export SHIPWARDEN_BRANCH='feat/a'; export SHIPWARDEN_REPO_NAME='api'; " +
                "export YARDMASTER_ROOT_PATH='/r/api'; export YARDMASTER_WORKTREE_PATH='/w/x'; export YARDMASTER_BRANCH='feat/a'; export YARDMASTER_REPO_NAME='api'; npm ci"
        );
    });
});

describe('selectCopyEntries', () => {
    const entries = ['.env', 'apps/web/.env.local', 'apps/web/node_modules/', 'dist/', 'node_modules/', 'secrets/', 'tmp.log'];
    const base = { enabled: true, patterns: ['.env', '.env.*'], exclude: ['node_modules/', 'dist/'] };

    it('copies the matching entries in "matching" mode', () => {
        expect(selectCopyEntries(entries, { ...base, mode: 'matching' })).toEqual(['.env', 'apps/web/.env.local']);
    });

    it('copies all entries except the excluded ones, also nested folders, in "all except" mode', () => {
        expect(selectCopyEntries(entries, { ...base, mode: 'allExcept' })).toEqual(['.env', 'apps/web/.env.local', 'secrets/', 'tmp.log']);
        expect(selectCopyEntries(entries, { ...base, mode: 'allExcept', exclude: [] })).toEqual(entries);
    });

    it('copies nothing when the copy is off', () => {
        expect(selectCopyEntries(entries, { ...base, mode: 'allExcept', enabled: false })).toEqual([]);
    });
});

describe('ignoredUnits', () => {
    it('removes the folders that only contain other listed entries', () => {
        const output = ['.env', 'apps/', 'apps/web/', 'apps/web/.env.local', 'apps/web/node_modules/', 'node_modules/', 'secret.key'];
        expect(ignoredUnits(output)).toEqual(['.env', 'apps/web/.env.local', 'apps/web/node_modules/', 'node_modules/', 'secret.key']);
    });
});
