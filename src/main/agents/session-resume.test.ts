import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { claudeProjectFolder, MAX_PROJECT_FOLDER } from '@shared/pinned-sessions';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyTranscriptFor } from './session-resume';

const SESSION_ID = '1c9b47cc-a11d-4e49-a0f7-78590b290474';
const NOW = Date.UTC(2026, 10, 19, 12);
const HOUR = 60 * 60 * 1000;
const SOURCE_CWD = '/w/app';
const TARGET_CWD = '/w/app-worktree';
// This path makes a folder name that is longer than MAX_PROJECT_FOLDER.
const LONG_CWD = `/w/${'a'.repeat(MAX_PROJECT_FOLDER)}`;

describe('copyTranscriptFor', () => {
    let dir: string;
    let projects: string;
    let source: string;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shipwarden-resume-'));
        projects = path.join(dir, '.claude', 'projects');
        source = path.join(projects, claudeProjectFolder(SOURCE_CWD) as string, `${SESSION_ID}.jsonl`);
    });
    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    /** Writes a file and sets its modified time to NOW minus ageMs. */
    async function write(file: string, content: string, ageMs: number): Promise<void> {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, content);
        const time = new Date(NOW - ageMs);
        await fs.utimes(file, time, time);
    }

    function targetOf(cwd: string): string {
        return path.join(projects, claudeProjectFolder(cwd) as string, `${SESSION_ID}.jsonl`);
    }

    it('throws an error when the source transcript is missing', async () => {
        await expect(copyTranscriptFor(source, SESSION_ID, TARGET_CWD)).rejects.toThrow('ShipWarden cannot find the transcript of the session.');
    });

    it('returns the source path and does not copy when the source is in the folder of cwd', async () => {
        await write(source, 'source', HOUR);
        await expect(copyTranscriptFor(source, SESSION_ID, SOURCE_CWD)).resolves.toBe(source);
        expect(await fs.readdir(projects)).toEqual([claudeProjectFolder(SOURCE_CWD)]);
        expect(await fs.readFile(source, 'utf8')).toBe('source');
    });

    it('makes the target folder and copies the transcript when the target folder has no transcript', async () => {
        await write(source, 'source', HOUR);
        const target = targetOf(TARGET_CWD);
        await expect(copyTranscriptFor(source, SESSION_ID, TARGET_CWD)).resolves.toBe(target);
        expect(await fs.readFile(target, 'utf8')).toBe('source');
    });

    it('copies the source over a target transcript that is older', async () => {
        await write(source, 'source', HOUR);
        const target = targetOf(TARGET_CWD);
        await write(target, 'old target', 2 * HOUR);
        await expect(copyTranscriptFor(source, SESSION_ID, TARGET_CWD)).resolves.toBe(target);
        expect(await fs.readFile(target, 'utf8')).toBe('source');
    });

    it('keeps a target transcript that is newer than the source', async () => {
        await write(source, 'source', 2 * HOUR);
        const target = targetOf(TARGET_CWD);
        await write(target, 'new target', HOUR);
        await expect(copyTranscriptFor(source, SESSION_ID, TARGET_CWD)).resolves.toBe(target);
        expect(await fs.readFile(target, 'utf8')).toBe('new target');
    });

    describe('with a very long cwd', () => {
        const start = `${LONG_CWD.replace(/[^A-Za-z0-9]/g, '-').slice(0, MAX_PROJECT_FOLDER)}-`;

        it('has no folder name from claudeProjectFolder', () => {
            expect(claudeProjectFolder(LONG_CWD)).toBeUndefined();
        });

        it('uses the only folder with the same start', async () => {
            await write(source, 'source', HOUR);
            const folder = `${start}abc123`;
            await fs.mkdir(path.join(projects, folder));
            const target = path.join(projects, folder, `${SESSION_ID}.jsonl`);
            await expect(copyTranscriptFor(source, SESSION_ID, LONG_CWD)).resolves.toBe(target);
            expect(await fs.readFile(target, 'utf8')).toBe('source');
        });

        it('throws an error when no folder has the same start', async () => {
            await write(source, 'source', HOUR);
            await expect(copyTranscriptFor(source, SESSION_ID, LONG_CWD)).rejects.toThrow('The path of the worktree is very long.');
        });

        it('throws an error when 2 folders have the same start', async () => {
            await write(source, 'source', HOUR);
            await fs.mkdir(path.join(projects, `${start}abc123`));
            await fs.mkdir(path.join(projects, `${start}def456`));
            await expect(copyTranscriptFor(source, SESSION_ID, LONG_CWD)).rejects.toThrow('The path of the worktree is very long.');
        });
    });
});
