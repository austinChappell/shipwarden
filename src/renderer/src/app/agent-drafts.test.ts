import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { DraftRequest } from '@shared/drafts';

const pending = new Map<string, { resolve(text: string): void; reject(err: Error): void }>();
const cancel = vi.fn(async (id: string) => {
    pending.get(id)?.reject(new Error('Stopped.'));
});
vi.stubGlobal('window', {
    shipwarden: {
        ask: {
            draft: (request: DraftRequest) =>
                new Promise((resolve, reject) => {
                    pending.set(request.id, { resolve: text => resolve({ agent: 'Claude', text }), reject });
                }),
            cancel
        }
    }
});

let drafts: typeof import('./agent-drafts');
let texts: typeof import('./text-drafts');
beforeAll(async () => {
    drafts = await import('./agent-drafts');
    texts = await import('./text-drafts');
});

const lastId = () => [...pending.keys()].at(-1) ?? '';

describe('startDraft', () => {
    it('puts the draft into the text draft of the key, with no open box', async () => {
        const run = drafts.startDraft('a', { worktree: '/w', kind: 'commit' });
        expect(drafts.isDraftRunning('a')).toBe(true);
        pending.get(lastId())?.resolve('Fix the bug');
        await run;
        expect(drafts.isDraftRunning('a')).toBe(false);
        expect(texts.hasTextDraft('a')).toBe(true);
    });

    it('keeps the error of a failed run', async () => {
        const run = drafts.startDraft('b', { worktree: '/w', kind: 'commit' });
        pending.get(lastId())?.reject(new Error('No agent.'));
        await run;
        expect(drafts.isDraftRunning('b')).toBe(false);
        expect(texts.hasTextDraft('b')).toBe(false);
    });

    it('does not keep an error or a text after a stop', async () => {
        const run = drafts.startDraft('c', { worktree: '/w', kind: 'pullRequest' });
        const id = lastId();
        drafts.stopDraft('c');
        await run;
        expect(cancel).toHaveBeenCalledWith(id);
        expect(drafts.isDraftRunning('c')).toBe(false);
        expect(texts.hasTextDraft('c')).toBe(false);
    });

    it('does not keep a draft that is the same as the fallback', async () => {
        const run = drafts.startDraft('d', { worktree: '/w', kind: 'pullRequest' }, 'Old text');
        pending.get(lastId())?.resolve('Old text');
        await run;
        expect(texts.hasTextDraft('d')).toBe(false);
    });
});
