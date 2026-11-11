import { describe, expect, it } from 'vitest';
import {
    branchValues,
    cleanBranchName,
    exampleValues,
    fallbackShortDescription,
    parseShortDescription,
    renderBranchTemplate,
    shortDescriptionPrompt,
    shortKebabCase,
    unknownVariables,
    usesVariable
} from './branch-template';

const task = { id: '86b2x9q4f', key: 'ENG-11684', title: 'Fix the login redirect on Safari' };

describe('renderBranchTemplate', () => {
    it('puts the task values into the template', () => {
        const values = branchValues(task, 'jsmith', 'fix-login-redirect');
        expect(renderBranchTemplate('{username}/{taskKey}-{taskShortDescription}', values)).toBe('jsmith/ENG-11684-fix-login-redirect');
        expect(renderBranchTemplate('feature/{taskId}/{taskTitle}', values)).toBe('feature/86b2x9q4f/fix-the-login-redirect-on-safari');
    });

    it('uses the title when the agent gave no short description', () => {
        expect(renderBranchTemplate('{taskShortDescription}', branchValues(task, 'jsmith'))).toBe('fix-login-redirect-safari');
    });

    it('uses the ID for a task without a key, and drops the "#" of an issue number', () => {
        expect(branchValues({ id: 'abc', title: 'x' }, '').taskKey).toBe('abc');
        expect(branchValues({ id: '1', key: '#42', title: 'x' }, '').taskKey).toBe('42');
    });

    it('leaves out unknown variables and an empty username', () => {
        expect(renderBranchTemplate('{username}/{nope}-{taskKey}', branchValues(task, ''))).toBe('ENG-11684');
    });
});

describe('cleanBranchName', () => {
    it('removes the characters and the parts that git does not allow', () => {
        expect(cleanBranchName('a b~c^d:e?f*g[h\\i')).toBe('a-b-c-d-e-f-g-h-i');
        expect(cleanBranchName('/.hidden//x..y/z.lock/')).toBe('hidden/x.y/z');
        expect(cleanBranchName('a@{b}')).toBe('a-b}');
        expect(cleanBranchName('-a-/')).toBe('a');
    });
});

describe('shortKebabCase', () => {
    it('joins lowercase words with hyphens', () => {
        expect(shortKebabCase('Fix the LOGIN page')).toBe('fix-the-login-page');
        expect(shortKebabCase('fix_login  redirect')).toBe('fix-login-redirect');
    });

    it('splits a camelCase answer', () => {
        expect(shortKebabCase('FixLoginRedirect')).toBe('fix-login-redirect');
    });

    it('returns empty text for text without letters or digits', () => {
        expect(shortKebabCase(' -- ')).toBe('');
    });
});

describe('fallbackShortDescription', () => {
    it('uses the first words of the title without small words', () => {
        expect(fallbackShortDescription('Add a dark mode to the settings page')).toBe('add-dark-mode-settings');
    });
});

describe('parseShortDescription', () => {
    it('reads the last line and removes quotes and code marks', () => {
        expect(parseShortDescription('Here it is:\n\n`fix-login-redirect`\n')).toBe('fix-login-redirect');
        expect(parseShortDescription('"add dark mode"')).toBe('add-dark-mode');
    });

    it('returns undefined for an empty answer', () => {
        expect(parseShortDescription('  \n ')).toBeUndefined();
    });
});

describe('the template helpers', () => {
    it('finds unknown and used variables', () => {
        expect(unknownVariables('{taskKey}-{ticket}-{ticket}')).toEqual(['ticket']);
        expect(usesVariable('{taskKey}', 'taskShortDescription')).toBe(false);
        expect(usesVariable('x/{taskShortDescription}', 'taskShortDescription')).toBe(true);
    });

    it('makes an example with the login name', () => {
        expect(renderBranchTemplate('{username}/{taskKey}', exampleValues('ana'))).toBe('ana/ENG-1234');
        expect(exampleValues('').username).toBe('jsmith');
    });

    it('puts the title and the description in the prompt', () => {
        const prompt = shortDescriptionPrompt({ title: 'Fix it', description: 'The page breaks.' });
        expect(prompt).toContain('Title: Fix it');
        expect(prompt).toContain('The page breaks.');
        expect(shortDescriptionPrompt({ title: 'Fix it' })).not.toContain('Description:');
    });
});
