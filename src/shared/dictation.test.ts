import { describe, expect, it } from 'vitest';
import { dictationErrorText, insertDictatedText, isDictationEnded, LineSplitter, parseHelperLine } from './dictation';

describe('parseHelperLine', () => {
    it('reads the events of the helper', () => {
        expect(parseHelperLine('{"type":"listening"}')).toEqual({ type: 'listening' });
        expect(parseHelperLine('{"type":"partial","text":"hello"}')).toEqual({ type: 'partial', text: 'hello' });
        expect(parseHelperLine('{"text":"Hello world.","type":"final"}')).toEqual({ type: 'final', text: 'Hello world.' });
        expect(parseHelperLine('{"type":"error","code":"onDeviceUnavailable","message":"No model."}')).toEqual({
            type: 'error',
            code: 'onDeviceUnavailable',
            message: 'No model.'
        });
    });

    it('takes an empty final text and spaces around the line', () => {
        expect(parseHelperLine('  {"type":"final","text":""}\r')).toEqual({ type: 'final', text: '' });
    });

    it('gives an unknown error code the code "helperFailed"', () => {
        expect(parseHelperLine('{"type":"error","code":"other"}')).toEqual({ type: 'error', code: 'helperFailed', message: '' });
    });

    it('ignores lines that are not events', () => {
        for (const line of ['', 'log text', '{', '[1]', 'null', '{"type":"partial"}', '{"type":"final","text":3}', '{"type":"other"}']) {
            expect(parseHelperLine(line), line).toBeUndefined();
        }
    });
});

describe('LineSplitter', () => {
    it('keeps a part of a line until the next chunk', () => {
        const lines = new LineSplitter();
        expect(lines.push('{"type":"list')).toEqual([]);
        expect(lines.push('ening"}\n{"type":"partial","text":"a"}\r\n{"ty')).toEqual(['{"type":"listening"}', '{"type":"partial","text":"a"}']);
        expect(lines.flush()).toEqual(['{"ty']);
        expect(lines.flush()).toEqual([]);
    });
});

describe('isDictationEnded', () => {
    it('is true for done, error, and cancelled', () => {
        expect(['starting', 'listening', 'stopping', 'done', 'error', 'cancelled'].filter(state => isDictationEnded(state as never))).toEqual([
            'done',
            'error',
            'cancelled'
        ]);
    });
});

describe('dictationErrorText', () => {
    it('tells the user that no audio goes to a server', () => {
        expect(dictationErrorText('onDeviceUnavailable')).toContain('does not send audio to a server');
    });

    it('adds the detail with an end mark', () => {
        expect(dictationErrorText('recognitionFailed', 'Busy')).toBe('The speech recognition stopped with an error. Busy.');
        expect(dictationErrorText('helperFailed', 'Stopped.')).toBe('The dictation helper stopped with an error. Stopped.');
        expect(dictationErrorText('audioFailed', '  ')).toBe('The recording did not start.');
    });
});

describe('insertDictatedText', () => {
    it('inserts the text at the cursor with spaces between words', () => {
        expect(insertDictatedText('Fix the bug', 11, 11, 'in the parser')).toEqual({ value: 'Fix the bug in the parser', cursor: 25 });
        expect(insertDictatedText('Fix bug', 3, 3, 'the')).toEqual({ value: 'Fix the bug', cursor: 7 });
        expect(insertDictatedText('', 0, 0, ' Hello. ')).toEqual({ value: 'Hello.', cursor: 6 });
    });

    it('replaces the selection', () => {
        expect(insertDictatedText('Fix the bug now', 4, 7, 'a')).toEqual({ value: 'Fix a bug now', cursor: 5 });
    });

    it('adds no space after a space or a new line', () => {
        expect(insertDictatedText('Line one\n', 9, 9, 'two')).toEqual({ value: 'Line one\ntwo', cursor: 12 });
    });

    it('keeps the value for an empty text, and limits the positions', () => {
        expect(insertDictatedText('abc', 1, 2, '  ')).toEqual({ value: 'abc', cursor: 2 });
        expect(insertDictatedText('abc', 10, 20, 'd')).toEqual({ value: 'abc d', cursor: 5 });
    });
});
