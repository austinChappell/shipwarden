import { describe, expect, it } from 'vitest';
import { parsePatchFiles } from '@pierre/diffs';
import { unifiedPatch } from './patch';

const parse = (patch: string) => parsePatchFiles(patch).flatMap(item => item.files);

describe('unifiedPatch', () => {
    it('makes a patch that the diff renderer reads, for a changed file', () => {
        const patch = unifiedPatch({ path: 'src/a.ts', status: 'modified', patch: '@@ -1,2 +1,2 @@\n line\n-old\n+new' })!;
        const [file] = parse(patch);
        expect(file.name).toBe('src/a.ts');
        expect(file.hunks).toHaveLength(1);
    });

    it('marks new, removed and renamed files', () => {
        const added = parse(unifiedPatch({ path: 'b.ts', status: 'added', patch: '@@ -0,0 +1,1 @@\n+hello' })!)[0];
        expect(added.type).toBe('new');
        const removed = parse(unifiedPatch({ path: 'c.ts', status: 'removed', patch: '@@ -1,1 +0,0 @@\n-bye' })!)[0];
        expect(removed.type).toBe('deleted');
        const renamed = parse(unifiedPatch({ path: 'new.ts', previousPath: 'old.ts', status: 'renamed', patch: '@@ -1,1 +1,1 @@\n-a\n+b' })!)[0];
        expect(renamed.name).toBe('new.ts');
        expect(renamed.prevName).toBe('old.ts');
    });

    it('returns undefined without hunks', () => {
        expect(unifiedPatch({ path: 'big.bin', status: 'modified' })).toBeUndefined();
    });
});
