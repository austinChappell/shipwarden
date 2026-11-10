import { describe, expect, it } from 'vitest';
import { OutputActivity } from './output-activity';

describe('OutputActivity', () => {
    it('records the time of the last output of each session', () => {
        let listener: ((id: string, data: string, seq: number) => void) | undefined;
        let subscriptions = 0;
        const source = {
            onData(next: (id: string, data: string, seq: number) => void) {
                subscriptions++;
                listener = next;
                return () => undefined;
            }
        };
        let now = 100;
        const activity = new OutputActivity();
        activity.start(source, () => now);
        activity.start(source, () => now);

        listener!('a', 'x', 1);
        now = 250;
        listener!('a', 'y', 2);
        listener!('b', 'z', 1);

        expect(subscriptions).toBe(1);
        expect(activity.get('a')).toBe(250);
        expect(activity.get('b')).toBe(250);
        expect(activity.get('c')).toBeUndefined();
    });

    it('forgets a session', () => {
        const activity = new OutputActivity();
        activity.record('a', 5);
        activity.delete('a');
        expect(activity.get('a')).toBeUndefined();
    });
});
