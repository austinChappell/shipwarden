import { describe, expect, it } from 'vitest';
import { matchLine } from './files';

describe('matchLine', () => {
    it('keeps a short start', () => {
        expect(matchLine('   router.use(requireAuth)', 'requireAuth')).toBe('router.use(requireAuth)');
    });

    it('cuts a long start, so the match shows', () => {
        const line = '      - run: node --check src/some/long/folder/path/greeting.js';
        expect(matchLine(line, 'greeting')).toBe('…ong/folder/path/greeting.js');
    });
});
