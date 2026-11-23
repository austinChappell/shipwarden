import { readFileSync } from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { addTranscriptLines, chatFormatOf } from './agent-chat';

/** A Codex 0.170 session file with each item type that the chat reads, and entries that the chat ignores. */
const FIXTURE = readFileSync(path.join(__dirname, 'fixtures', 'codex-session.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean);

const at = (second: number) => Date.parse(`2026-11-23T10:00:${String(second).padStart(2, '0')}.000Z`);

describe('chatFormatOf', () => {
    it('finds the format from the file name', () => {
        expect(chatFormatOf('/h/.codex/sessions/2026/11/23/rollout-2026-11-23T10-00-00-abc.jsonl')).toBe('codex');
        expect(chatFormatOf('/h/.claude/projects/x/0b1c.jsonl')).toBe('claude');
        expect(chatFormatOf('/h/.gemini/chat.json')).toBeUndefined();
        expect(chatFormatOf(undefined)).toBeUndefined();
    });
});

describe('Codex adapter', () => {
    const items = addTranscriptLines([], FIXTURE, 'codex');

    it('makes one item for each user, agent, and tool item, in order', () => {
        expect(items.map(item => item.id)).toEqual([
            'um1',
            'msg1',
            'exec-1',
            'exec-2',
            'exec-3',
            'exec-4',
            'exec-5',
            'exec-6',
            'call_m1',
            'exec-7',
            'exec-8',
            'exec-9',
            'exec-10',
            'msg2'
        ]);
    });

    it('reads the prompt of the user and keeps its image marks', () => {
        expect(items[0]).toEqual({ kind: 'user', id: 'um1', text: '[Image #1]\n\nFix the failing test', at: at(2) });
    });

    it('reads the agent text of the commentary and of the final answer', () => {
        expect(items[1]).toMatchObject({ kind: 'agent', text: 'I will look at the test first.', at: at(4) });
        expect(items[13]).toMatchObject({ kind: 'agent', text: 'The test **passes** now.' });
    });

    it('describes the commands from the parts that Codex parsed', () => {
        expect(items[2]).toMatchObject({
            kind: 'tool',
            summary: 'Reading app.test.ts',
            detail: "sed -n '1,80p' src/app.test.ts",
            status: 'ok',
            result: "import { it } from 'vitest';"
        });
        expect(items[3]).toMatchObject({ summary: 'Searching for "sum"', detail: "rg -n 'sum' src" });
        expect(items[4]).toMatchObject({ summary: 'Reading the code' });
    });

    it('marks a failed command as an error and shows its exit code when it has no output', () => {
        expect(items[5]).toMatchObject({ summary: 'Running npm test', detail: 'npm test', status: 'error', result: 'Exit code 1' });
    });

    it('describes file changes and shows the diff', () => {
        expect(items[6]).toMatchObject({ name: 'apply_patch', summary: 'Editing app.ts', detail: '/w/app/src/app.ts', result: '@@ -1 +1 @@\n-a\n+b' });
        expect(items[7]).toMatchObject({ summary: 'Editing 2 files', detail: '/w/app/src/new.ts\n/w/app/src/old.ts' });
    });

    it('reads an MCP tool call and its error', () => {
        expect(items[8]).toMatchObject({
            name: 'mcp__shipwarden__get_task',
            summary: 'Using get task (shipwarden)',
            status: 'error',
            result: 'No task'
        });
    });

    it('reads the built-in tools: web search, open page, sleep, and image view', () => {
        expect(items[9]).toMatchObject({ summary: 'Searching the web for "vitest each"', result: 'https://vitest.dev/api/' });
        expect(items[10]).toMatchObject({ summary: 'Reading vitest.dev', detail: 'https://vitest.dev/api/' });
        expect(items[11]).toMatchObject({ summary: 'Waiting', status: 'ok' });
        expect(items[12]).toMatchObject({ summary: 'Looking at shot.png', detail: '/tmp/shot.png' });
    });

    it('adds only the new items at a later read, and ignores a line that it already has', () => {
        const first = addTranscriptLines([], FIXTURE.slice(0, 6), 'codex');
        const second = addTranscriptLines(first, FIXTURE, 'codex');
        expect(first.map(item => item.id)).toEqual(['um1']);
        expect(second).toEqual(items);
    });

    it('does not read Codex lines as Claude Code lines', () => {
        expect(addTranscriptLines([], FIXTURE)).toEqual([]);
    });
});
