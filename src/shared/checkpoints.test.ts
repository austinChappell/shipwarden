import { describe, expect, it } from 'vitest';
import {
    CHECKPOINT_MAX_AGE_MS,
    checkpointExpired,
    checkpointMessage,
    checkpointRef,
    checkpointTitle,
    groupCheckpoints,
    parseCheckpointMessage,
    parseNameStatus,
    parseNumstat,
    rewindNote,
    type Checkpoint,
    type CheckpointMeta
} from './checkpoints';

const meta: CheckpointMeta = { worktree: '/repo', session: 'abc-1', turn: 3, kind: 'prompt', at: 1000, prompt: 'Fix the bug', agent: 'Claude' };

function checkpoint(fields: Partial<Checkpoint>): Checkpoint {
    return { ...meta, ref: 'r', commit: 'c', files: [], ...fields };
}

describe('checkpoints', () => {
    it('writes and reads the message of a checkpoint commit', () => {
        expect(parseCheckpointMessage(checkpointMessage(meta))).toEqual(meta);
        expect(parseCheckpointMessage('Fix the bug\n\n{"worktree":"/repo"}')).toBeUndefined();
        expect(parseCheckpointMessage('ShipWarden checkpoint\n\n{broken')).toBeUndefined();
        expect(parseCheckpointMessage('ShipWarden checkpoint\n\n{"worktree":"/repo","session":"s"}')).toBeUndefined();
    });

    it('makes a ref that sorts in turn order and that git accepts', () => {
        expect(checkpointRef('abc-1', 3)).toBe('refs/shipwarden/checkpoints/abc-1/000003');
        expect(checkpointRef('a b/../c', 12)).toBe('refs/shipwarden/checkpoints/a_b____c/000012');
    });

    it('finds the checkpoints older than 7 days', () => {
        expect(checkpointExpired(0, CHECKPOINT_MAX_AGE_MS)).toBe(false);
        expect(checkpointExpired(0, CHECKPOINT_MAX_AGE_MS + 1)).toBe(true);
    });

    it('reads the name status and the numstat of git diff-tree', () => {
        expect(parseNameStatus('M\0a.txt\0A\0dir/b file.txt\0D\0c.bin\0')).toEqual([
            { path: 'a.txt', status: 'modified' },
            { path: 'dir/b file.txt', status: 'added' },
            { path: 'c.bin', status: 'deleted' }
        ]);
        const counts = parseNumstat('3\t1\ta.txt\0-\t-\tc.bin\0');
        expect(counts.get('a.txt')).toEqual({ additions: 3, deletions: 1 });
        expect(counts.get('c.bin')).toEqual({});
    });

    it('groups the checkpoints by session, the newest first', () => {
        const groups = groupCheckpoints([
            checkpoint({ session: 'a', turn: 1, at: 1 }),
            checkpoint({ session: 'b', turn: 1, at: 5, agent: 'Codex' }),
            checkpoint({ session: 'a', turn: 2, at: 3 })
        ]);
        expect(groups.map(group => [group.session, group.agent, group.checkpoints.map(item => item.turn)])).toEqual([
            ['b', 'Codex', [1]],
            ['a', 'Claude', [2, 1]]
        ]);
    });

    it('gives the title of a checkpoint and the note for the agent', () => {
        expect(checkpointTitle({ kind: 'prompt', prompt: 'Fix it' })).toBe('Fix it');
        expect(checkpointTitle({ kind: 'idle' })).toBe('Agent stopped its output');
        expect(checkpointTitle({ kind: 'rewind' })).toBe('Before a rewind');
        expect(rewindNote({ kind: 'prompt', prompt: 'Fix it' }, false)).toContain('before the prompt "Fix it"');
        expect(rewindNote({ kind: 'idle' }, true)).toContain('The branch also moved back');
    });
});
