import { describe, expect, it } from 'vitest';
import {
    cleanDraft,
    commitDraftPrompt,
    DEFAULT_DRAFT_SETTINGS,
    normalizeDraftSettings,
    normalizeRepoDraftSettings,
    pullRequestDraftPrompt,
    resolveDraftSettings
} from './drafts';
import { normalizeSettings } from './settings';

describe('draft settings', () => {
    it('turns Conventional Commits on by default', () => {
        expect(normalizeDraftSettings(undefined)).toEqual(DEFAULT_DRAFT_SETTINGS);
        expect(normalizeDraftSettings({ conventionalCommits: false }).conventionalCommits).toBe(false);
        expect(normalizeSettings({}).drafts.conventionalCommits).toBe(true);
    });

    it('trims the instructions and removes empty ones', () => {
        expect(normalizeDraftSettings({ commitInstructions: '  Be short. ', pullRequestInstructions: '  ' })).toEqual({
            commitInstructions: 'Be short.',
            conventionalCommits: true
        });
    });

    it('keeps only the repository values that differ from the global settings', () => {
        expect(normalizeRepoDraftSettings({})).toBeUndefined();
        expect(normalizeRepoDraftSettings({ conventionalCommits: 'yes', commitInstructions: '' })).toBeUndefined();
        expect(normalizeRepoDraftSettings({ conventionalCommits: false })).toEqual({ conventionalCommits: false });
        expect(normalizeSettings({ repos: { '/repo': { drafts: { prInstructions: 'x', pullRequestInstructions: 'Add risks.' } } } }).repos['/repo']).toEqual({
            drafts: { pullRequestInstructions: 'Add risks.' }
        });
    });

    it('adds the repository instructions after the global ones, and lets the repository change the switch', () => {
        const global = { commitInstructions: 'Global.', conventionalCommits: true };
        expect(resolveDraftSettings(global, undefined)).toEqual({ commitInstructions: ['Global.'], pullRequestInstructions: [], conventionalCommits: true });
        expect(resolveDraftSettings(global, { commitInstructions: 'Repo.', conventionalCommits: false })).toEqual({
            commitInstructions: ['Global.', 'Repo.'],
            pullRequestInstructions: [],
            conventionalCommits: false
        });
    });
});

describe('draft prompts', () => {
    const settings = resolveDraftSettings(DEFAULT_DRAFT_SETTINGS, undefined);

    it('asks for Conventional Commits only when the switch is on', () => {
        const input = { stat: ' a.txt | 1 +', diff: '+one', recentSubjects: ['feat: x'], settings };
        expect(commitDraftPrompt(input)).toContain('Conventional Commits format: "<type>');
        expect(commitDraftPrompt({ ...input, settings: { ...settings, conventionalCommits: false } })).toContain('Do not use the Conventional Commits format');
    });

    it('puts the user instructions in the commit prompt', () => {
        const prompt = commitDraftPrompt({ stat: '', diff: '+one', recentSubjects: [], settings: { ...settings, commitInstructions: ['Global.', 'Repo.'] } });
        expect(prompt).toContain('Global.\n\nRepo.');
    });

    it('tells the agent to fill in the pull request template', () => {
        const input = { branch: 'feature', base: 'origin/main', commits: ['Change a'], stat: '', diff: '+two', settings };
        expect(pullRequestDraftPrompt(input)).not.toContain('pull request template');
        const prompt = pullRequestDraftPrompt({ ...input, template: { path: '.github/pull_request_template.md', text: '## Summary' } });
        expect(prompt).toContain('pull request template (.github/pull_request_template.md)');
        expect(prompt).toContain('## Summary');
    });
});

describe('cleanDraft', () => {
    it('removes a fence around all of the answer', () => {
        expect(cleanDraft('```\nfeat: x\n\nbody\n```')).toBe('feat: x\n\nbody');
        expect(cleanDraft('```markdown\n## Summary\n```\n')).toBe('## Summary');
    });

    it('keeps a fence inside the text', () => {
        const text = '## Summary\n\n```ts\ncode\n```';
        expect(cleanDraft(text)).toBe(text);
        const twoBlocks = '```ts\na\n```\n\nText\n\n```ts\nb\n```';
        expect(cleanDraft(twoBlocks)).toBe(twoBlocks);
    });
});
