import { describe, expect, it } from 'vitest';
import { bracketedPaste, checkLine, countImageMarks, checksPrompt, logPrompt, repoFolderName, showsAgentDialog } from './agent-text';

describe('showsAgentDialog', () => {
    it('finds a dialog in text with or without spaces', () => {
        expect(showsAgentDialog('Do you trust this folder?')).toBe(true);
        expect(showsAgentDialog('Doyouwanttoproceed?')).toBe(true);
        expect(showsAgentDialog('Press Enter to\nconfirm')).toBe(true);
    });

    it('ignores the case of the letters', () => {
        expect(showsAgentDialog('ENTER TO CONFIRM')).toBe(true);
    });

    it('is false for a normal prompt screen', () => {
        expect(showsAgentDialog('> Type a message')).toBe(false);
        expect(showsAgentDialog('')).toBe(false);
    });
});

describe('bracketedPaste', () => {
    it('puts the paste marks around the prompt', () => {
        expect(bracketedPaste('line 1\nline 2')).toBe('\x1b[200~line 1\nline 2\x1b[201~');
    });
});

describe('logPrompt', () => {
    it('names the job and the path of the log', () => {
        expect(logPrompt('test', '/tmp/log.txt')).toBe(
            'The CI job "test" failed on this branch. The full log is in /tmp/log.txt. Find the cause of the failure and fix it.'
        );
    });
});

describe('checkLine', () => {
    it('gives the path of a saved log', () => {
        expect(checkLine({ name: 'build', url: 'https://ci' }, '/tmp/build.log')).toBe('- "build": the full log is in /tmp/build.log');
    });

    it('gives the link of a check without a log, or only the name', () => {
        expect(checkLine({ name: 'lint', url: 'https://ci/lint' })).toBe('- "lint": the details are at https://ci/lint');
        expect(checkLine({ name: 'lint', url: '' })).toBe('- "lint"');
    });
});

describe('checksPrompt', () => {
    it('uses the singular form for one check', () => {
        expect(checksPrompt(['- "a"']).split('\n')[0]).toBe('A CI check failed on the pull request of this branch:');
    });

    it('counts the checks and puts each line between the first and the last line', () => {
        expect(checksPrompt(['- "a"', '- "b"'])).toBe(
            [
                '2 CI checks failed on the pull request of this branch:',
                '- "a"',
                '- "b"',
                'Find the cause of each failure and fix it. Run the tests, and then commit the fix.'
            ].join('\n')
        );
    });
});

describe('repoFolderName', () => {
    it('returns the last part of the path', () => {
        expect(repoFolderName('/Users/me/dev/app')).toBe('app');
        expect(repoFolderName('/Users/me/dev/app/')).toBe('app');
    });

    it('returns the path when it has no parts', () => {
        expect(repoFolderName('/')).toBe('/');
    });
});

describe('countImageMarks', () => {
    it('counts the image marks of Claude Code, also without spaces', () => {
        expect(countImageMarks('> [Image #1] [Image #2] What is this?')).toBe(2);
        expect(countImageMarks('>[Image#3]text')).toBe(1);
        expect(countImageMarks('> no images')).toBe(0);
    });
});
