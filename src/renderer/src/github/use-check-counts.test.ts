import { describe, expect, it } from 'vitest';
import type { CheckRun } from '@shared/github';
import { countChecks } from './use-check-counts';

const run = (id: number, name: string, status: CheckRun['status'], conclusion: CheckRun['conclusion']): CheckRun => ({
    id,
    name,
    status,
    conclusion,
    startedAt: null,
    completedAt: null,
    url: null,
    isActions: true
});

describe('countChecks', () => {
    it('lists the newest failed run of each check', () => {
        const counts = countChecks([
            run(1, 'test', 'completed', 'failure'),
            run(2, 'test', 'completed', 'success'),
            run(3, 'lint', 'completed', 'failure'),
            run(4, 'build', 'in_progress', null)
        ]);
        expect(counts.failedChecks.map(check => check.id)).toEqual([3]);
        expect(counts).toMatchObject({ total: 3, passed: 1, failed: 1, running: 1 });
    });
});
