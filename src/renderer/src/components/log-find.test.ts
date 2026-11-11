import { afterEach, describe, expect, it } from 'vitest';
import { claimLogFind, isFindShortcut, type LogFindOwner, openLogFind, releaseLogFind } from './log-find';

/** A small copy of a KeyboardEvent. The tests run in Node, which has no KeyboardEvent. */
function key(init: Partial<KeyboardEvent> = {}) {
    const event = {
        key: 'f',
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        defaultPrevented: false,
        stopped: false,
        preventDefault() {
            event.defaultPrevented = true;
        },
        stopPropagation() {
            event.stopped = true;
        },
        ...init
    };
    return event;
}

const asEvent = (event: ReturnType<typeof key>) => event as unknown as KeyboardEvent;

function owner(result: boolean): LogFindOwner & { opens: number } {
    return {
        opens: 0,
        open() {
            this.opens += 1;
            return result;
        }
    };
}

const owners: LogFindOwner[] = [];
afterEach(() => {
    for (const log of owners.splice(0)) releaseLogFind(log);
});

function claim(log: LogFindOwner) {
    owners.push(log);
    claimLogFind(log);
}

describe('isFindShortcut', () => {
    it('accepts ⌘F only', () => {
        expect(isFindShortcut(asEvent(key()))).toBe(true);
        expect(isFindShortcut(asEvent(key({ key: 'F' })))).toBe(true);
        expect(isFindShortcut(asEvent(key({ shiftKey: true })))).toBe(false);
        expect(isFindShortcut(asEvent(key({ metaKey: false, ctrlKey: true })))).toBe(false);
        expect(isFindShortcut(asEvent(key({ key: 'g' })))).toBe(false);
    });
});

describe('openLogFind', () => {
    it('returns false when no log owns ⌘F', () => {
        const event = key();
        expect(openLogFind(asEvent(event))).toBe(false);
        expect(event.defaultPrevented).toBe(false);
    });

    it('opens the search bar of the owner and stops the key', () => {
        const log = owner(true);
        claim(log);
        const event = key();
        expect(openLogFind(asEvent(event))).toBe(true);
        expect(log.opens).toBe(1);
        expect(event.defaultPrevented).toBe(true);
        expect(event.stopped).toBe(true);
    });

    it('returns false when the owner cannot show its search bar', () => {
        claim(owner(false));
        const event = key();
        expect(openLogFind(asEvent(event))).toBe(false);
        expect(event.defaultPrevented).toBe(false);
    });

    it('opens one search bar for a key that a different handler stopped', () => {
        const log = owner(true);
        claim(log);
        const event = key();
        event.preventDefault();
        expect(openLogFind(asEvent(event))).toBe(true);
        expect(log.opens).toBe(0);
    });

    it('keeps the newest owner when an older log releases', () => {
        const older = owner(true);
        const newer = owner(true);
        claim(older);
        claim(newer);
        releaseLogFind(older);
        expect(openLogFind(asEvent(key()))).toBe(true);
        expect(newer.opens).toBe(1);
        releaseLogFind(newer);
        expect(openLogFind(asEvent(key()))).toBe(false);
    });
});
