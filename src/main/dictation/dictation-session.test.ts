import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DictationUpdate } from '@shared/dictation';
import { DictationSession, DictationStartError } from './dictation-session';
import { FakeHelper } from './fake-helper';

function setup(spawn?: () => FakeHelper) {
    const helper = new FakeHelper();
    const updates: DictationUpdate[] = [];
    const session = new DictationSession({ id: 'd1', spawn: spawn ?? (() => helper), onUpdate: update => updates.push(update), stopTimeoutMs: 1000 });
    return { helper, updates, session, states: () => updates.map(update => update.state) };
}

describe('DictationSession', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('goes from starting to listening to done with the final text', () => {
        const { helper, updates, session, states } = setup();
        session.start();
        helper.send({ type: 'listening' });
        helper.send({ type: 'partial', text: 'fix the' });
        helper.send({ type: 'partial', text: 'fix the' });
        helper.send({ type: 'partial', text: 'fix the bug' });
        session.stop();
        expect(helper.stdinText).toBe('stop\n');
        helper.send({ type: 'final', text: 'Fix the bug.' });
        helper.exit(0);
        expect(states()).toEqual(['starting', 'listening', 'listening', 'listening', 'stopping', 'done']);
        expect(updates.map(update => update.partial)).toEqual(['', '', 'fix the', 'fix the bug', 'fix the bug', 'fix the bug']);
        expect(updates.at(-1)).toMatchObject({ id: 'd1', state: 'done', text: 'Fix the bug.' });
        expect(session.ended()).toBe(true);
    });

    it('reads events that come in parts', () => {
        const { helper, updates, session } = setup();
        session.start();
        helper.say('{"type":"listening"}\n{"type":"par');
        helper.say('tial","text":"hi"}\nnot json\n');
        expect(updates.at(-1)).toMatchObject({ state: 'listening', partial: 'hi' });
    });

    it('ends with an error of the helper and stops the helper', () => {
        const { helper, updates, session } = setup();
        session.start();
        helper.send({ type: 'error', code: 'onDeviceUnavailable', message: 'No model.' });
        helper.exit(1);
        expect(updates.at(-1)).toMatchObject({ state: 'error', error: { code: 'onDeviceUnavailable', message: 'No model.' } });
        expect(updates.filter(update => update.state === 'error')).toHaveLength(1);
    });

    it('reports a helper that stops without a line', () => {
        const { helper, updates, session } = setup();
        session.start();
        helper.send({ type: 'listening' });
        helper.exit(null, 'SIGKILL');
        expect(updates.at(-1)).toMatchObject({ state: 'error', error: { code: 'helperFailed', message: 'The helper stopped with the signal SIGKILL.' } });
    });

    it('keeps the partial text when the helper stops after "stop" without a final text', () => {
        const { helper, updates, session } = setup();
        session.start();
        helper.send({ type: 'listening' });
        helper.send({ type: 'partial', text: 'almost' });
        session.stop();
        helper.exit(0);
        expect(updates.at(-1)).toMatchObject({ state: 'done', text: 'almost' });
    });

    it('takes the partial text after the stop timeout and stops the helper', () => {
        const { helper, updates, session } = setup();
        session.start();
        helper.send({ type: 'listening' });
        helper.send({ type: 'partial', text: 'slow' });
        session.stop();
        vi.advanceTimersByTime(999);
        expect(session.ended()).toBe(false);
        vi.advanceTimersByTime(1);
        expect(updates.at(-1)).toMatchObject({ state: 'done', text: 'slow' });
        expect(helper.killed).toEqual(['SIGTERM']);
        // A late final text changes nothing.
        helper.send({ type: 'final', text: 'slow text' });
        expect(updates.filter(update => update.state === 'done')).toHaveLength(1);
    });

    it('cancels without a text and ignores the helper after that', () => {
        const { helper, updates, session, states } = setup();
        session.start();
        helper.send({ type: 'listening' });
        session.cancel();
        expect(helper.stdinText).toBe('cancel\n');
        expect(helper.stdinEnded).toBe(true);
        expect(helper.killed).toEqual(['SIGTERM']);
        helper.send({ type: 'final', text: 'late' });
        helper.exit(0);
        expect(states()).toEqual(['starting', 'listening', 'cancelled']);
        expect(updates.at(-1)?.text).toBeUndefined();
    });

    it('sends "stop" one time only', () => {
        const { helper, session } = setup();
        session.start();
        session.stop();
        session.stop();
        expect(helper.stdinText).toBe('stop\n');
    });

    it('reports a failed start with the code of the error', () => {
        const { updates, session } = setup(() => {
            throw new DictationStartError('unsupportedPlatform', '');
        });
        session.start();
        expect(updates.map(update => update.state)).toEqual(['starting', 'error']);
        expect(updates.at(-1)?.error?.code).toBe('unsupportedPlatform');
    });

    it('reports a spawn error of the process as a missing helper', () => {
        const { helper, updates, session } = setup();
        session.start();
        helper.emit('error', new Error('spawn ENOENT'));
        expect(updates.at(-1)).toMatchObject({ state: 'error', error: { code: 'helperMissing', message: 'spawn ENOENT' } });
    });
});
