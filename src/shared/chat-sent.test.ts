import { describe, expect, it } from 'vitest';
import { unsettledPrompts } from './chat-sent';

describe('unsettledPrompts', () => {
    it('keeps a prompt until the transcript has a user prompt with its text', () => {
        const sent = [{ text: 'Fix the test', users: 2 }];
        expect(unsettledPrompts(sent, ['a', 'b'])).toEqual(sent);
        expect(unsettledPrompts(sent, ['a', 'b', 'Fix the test'])).toEqual([]);
    });

    it('does not let a stuck prompt keep a later prompt pending', () => {
        const stuck = { text: 'Never in the transcript', users: 1 };
        const later = { text: 'Here is a message', users: 2 };
        expect(unsettledPrompts([stuck, later], ['a', 'b', 'Here is a message'])).toEqual([stuck]);
    });

    it('ignores user prompts from before the send', () => {
        const sent = [{ text: 'yes', users: 1 }];
        expect(unsettledPrompts(sent, ['yes'])).toEqual(sent);
        expect(unsettledPrompts(sent, ['yes', 'yes'])).toEqual([]);
    });

    it('settles each prompt with its own user prompt when two prompts have the same text', () => {
        const first = { text: 'yes', users: 0 };
        const second = { text: 'yes', users: 0 };
        expect(unsettledPrompts([first, second], ['yes'])).toEqual([second]);
        expect(unsettledPrompts([first, second], ['yes', 'yes'])).toEqual([]);
    });

    it('settles prompts that Claude Code joined into one, and ignores differences in white space', () => {
        const sent = [
            { text: 'Another one', users: 0 },
            { text: 'One  more', users: 0 }
        ];
        expect(unsettledPrompts(sent, ['Another one\n\nOne more'])).toEqual([]);
    });

    it('settles a prompt with only images at the next user prompt', () => {
        expect(unsettledPrompts([{ text: '', users: 1 }], ['a'])).toHaveLength(1);
        expect(unsettledPrompts([{ text: '', users: 1 }], ['a', ''])).toEqual([]);
    });
});
