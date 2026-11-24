import { describe, expect, it } from 'vitest';
import type { DictationUpdate } from '@shared/dictation';
import { DictationStore } from './dictation-store';

function setup() {
    const calls: string[] = [];
    const writes: [string, string][] = [];
    let listener: ((update: DictationUpdate) => void) | undefined;
    let next = 0;
    const store = new DictationStore(
        {
            start: id => calls.push(`start ${id}`),
            stop: id => calls.push(`stop ${id}`),
            cancel: id => calls.push(`cancel ${id}`),
            onUpdate: fn => {
                listener = fn;
                return () => undefined;
            },
            write: (sessionId, data) => writes.push([sessionId, data])
        },
        () => `d${++next}`
    );
    const update = (value: Partial<DictationUpdate> & Pick<DictationUpdate, 'id' | 'state'>) => listener?.({ partial: '', ...value });
    return { store, calls, writes, update };
}

describe('DictationStore', () => {
    it('shows the partial text and types the final text into the terminal without Enter', () => {
        const { store, calls, writes, update } = setup();
        store.toggle('s1');
        expect(calls).toEqual(['start d1']);
        expect(store.getSnapshot()).toMatchObject({ id: 'd1', sessionId: 's1', state: 'starting' });
        update({ id: 'd1', state: 'listening', partial: 'fix the' });
        expect(store.getSnapshot()).toMatchObject({ state: 'listening', partial: 'fix the' });
        store.toggle('s1');
        expect(calls).toEqual(['start d1', 'stop d1']);
        update({ id: 'd1', state: 'done', partial: 'fix the', text: ' Fix the bug. ' });
        expect(store.getSnapshot()).toBeUndefined();
        expect(writes).toEqual([['s1', '\x1b[200~Fix the bug.\x1b[201~']]);
    });

    it('gives the final text to the registered text field of the session', () => {
        const { store, writes, update } = setup();
        const inserted: string[] = [];
        const remove = store.registerInput('s1', text => {
            inserted.push(text);
            return true;
        });
        store.start('s1');
        update({ id: 'd1', state: 'done', text: 'Hello.' });
        expect(inserted).toEqual(['Hello.']);
        expect(writes).toEqual([]);
        remove();
        store.start('s1');
        update({ id: 'd2', state: 'done', text: 'Again.' });
        expect(writes).toEqual([['s1', '\x1b[200~Again.\x1b[201~']]);
    });

    it('sends nothing for an empty text', () => {
        const { store, writes, update } = setup();
        store.start('s1');
        update({ id: 'd1', state: 'done', text: '  ' });
        expect(writes).toEqual([]);
    });

    it('keeps an error until the user closes it', () => {
        const { store, calls, update } = setup();
        store.start('s1');
        update({ id: 'd1', state: 'error', error: { code: 'microphoneDenied', message: '' } });
        expect(store.running()).toBe(false);
        expect(store.getSnapshot()?.error).toContain('Privacy & Security › Microphone');
        store.cancel();
        expect(store.getSnapshot()).toBeUndefined();
        // The dictation ended already, so the main process gets no cancel.
        expect(calls).toEqual(['start d1']);
    });

    it('cancels the running dictation for a new session and ignores its late updates', () => {
        const { store, calls, writes, update } = setup();
        store.start('s1');
        update({ id: 'd1', state: 'listening' });
        store.toggle('s2');
        expect(calls).toEqual(['start d1', 'cancel d1', 'start d2']);
        update({ id: 'd1', state: 'done', text: 'old' });
        expect(writes).toEqual([]);
        expect(store.getSnapshot()).toMatchObject({ id: 'd2', sessionId: 's2' });
    });

    it('cancels without a text', () => {
        const { store, calls, writes, update } = setup();
        store.start('s1');
        store.cancel();
        expect(calls).toEqual(['start d1', 'cancel d1']);
        update({ id: 'd1', state: 'cancelled' });
        expect(writes).toEqual([]);
        expect(store.getSnapshot()).toBeUndefined();
    });
});
