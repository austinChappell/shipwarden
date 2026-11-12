import { describe, expect, it } from 'vitest';
import { addTranscriptLines, promptText, type ChatToolItem } from './agent-chat';

const line = (entry: Record<string, unknown>) => JSON.stringify({ timestamp: '2026-11-12T10:00:00.000Z', ...entry });

describe('promptText', () => {
    it('keeps the text of the user', () => {
        expect(promptText('  Fix the bug  ')).toBe('Fix the bug');
    });

    it('shows a slash command with its arguments', () => {
        expect(promptText('<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>12</command-args>')).toBe(
            '/review 12'
        );
        expect(promptText('<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>')).toBe('/clear');
    });

    it('hides the messages that Claude Code adds', () => {
        expect(promptText('<local-command-stdout>done</local-command-stdout>')).toBeUndefined();
        expect(promptText('<system-reminder>x</system-reminder>')).toBeUndefined();
        expect(promptText('   ')).toBeUndefined();
    });
});

describe('addTranscriptLines', () => {
    it('makes user, agent, and tool items, and sets the tool result', () => {
        const items = addTranscriptLines(
            [],
            [
                line({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'Run the tests' } }),
                line({
                    type: 'assistant',
                    uuid: 'a1',
                    message: { content: [{ type: 'thinking', thinking: 'hm' }] }
                }),
                line({
                    type: 'assistant',
                    uuid: 'a2',
                    message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test', description: 'Run the tests' } }] }
                }),
                line({
                    type: 'user',
                    uuid: 'u2',
                    message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '3 passed' }] }] }
                }),
                line({ type: 'assistant', uuid: 'a3', message: { content: [{ type: 'text', text: 'All **3** tests pass.' }] } })
            ]
        );
        expect(items.map(item => item.kind)).toEqual(['user', 'tool', 'agent']);
        expect(items[0]).toMatchObject({ text: 'Run the tests', at: Date.parse('2026-11-12T10:00:00.000Z') });
        expect(items[1]).toMatchObject({ summary: 'Run the tests', detail: 'npm test', status: 'ok', result: '3 passed' });
        expect(items[2]).toMatchObject({ text: 'All **3** tests pass.' });
    });

    it('updates a tool call of an earlier read, and does not change the old list', () => {
        const first = addTranscriptLines(
            [],
            [line({ type: 'assistant', uuid: 'a1', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x/App.tsx' } }] } })]
        );
        const second = addTranscriptLines(first, [
            line({ type: 'user', uuid: 'u1', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'No such file' }] } })
        ]);
        expect((first[0] as ChatToolItem).status).toBe('running');
        expect(second[0]).toMatchObject({ summary: 'Reading App.tsx', status: 'error', result: 'No such file' });
    });

    it('ignores meta, sidechain, other entry types, bad JSON, and lines that it already has', () => {
        const prompt = line({ type: 'user', uuid: 'u1', message: { content: 'Hello' } });
        const items = addTranscriptLines(
            [],
            [
                prompt,
                prompt,
                'not json "message"',
                line({ type: 'user', uuid: 'u2', isMeta: true, message: { content: 'Caveat' } }),
                line({ type: 'assistant', uuid: 'a1', isSidechain: true, message: { content: [{ type: 'text', text: 'sub' }] } }),
                line({ type: 'attachment', uuid: 'x', message: { content: 'x' } }),
                line({ type: 'user', uuid: 'u3', message: { content: '<local-command-stdout></local-command-stdout>' } })
            ]
        );
        expect(items).toEqual([{ kind: 'user', id: 'u1', text: 'Hello', at: Date.parse('2026-11-12T10:00:00.000Z') }]);
    });

    it('keeps the images of a prompt as data URLs, and removes the image marks from the text', () => {
        const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } };
        const bad = { type: 'image', source: { type: 'base64', media_type: 'text/html', data: 'PGI+' } };
        const items = addTranscriptLines(
            [],
            [
                line({ type: 'user', uuid: 'u1', message: { content: [{ type: 'text', text: '[Image #1]\n\nLook at this' }, image] } }),
                line({ type: 'user', uuid: 'u2', message: { content: [{ type: 'text', text: '[Image #2]' }, image] } }),
                line({ type: 'user', uuid: 'u3', message: { content: [{ type: 'text', text: 'Bad' }, bad] } })
            ]
        );
        expect(items[0]).toMatchObject({ kind: 'user', text: 'Look at this', images: ['data:image/png;base64,iVBORw0KGgo='] });
        expect(items[1]).toMatchObject({ kind: 'user', text: '', images: ['data:image/png;base64,iVBORw0KGgo='] });
        expect(items[2]).toMatchObject({ text: 'Bad' });
        expect(items[2]).not.toHaveProperty('images');
    });
});
