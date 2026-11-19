import { promises as fs } from 'fs';
import * as path from 'path';
import { claudeProjectFolder, MAX_PROJECT_FOLDER } from '@shared/pinned-sessions';

/**
 * Makes a session available to Claude Code in a target folder and returns the transcript path there. Claude Code finds
 * a session only in the folder of the current working folder, so a different folder gets a copy of the transcript. A
 * transcript of the same session in the target folder stays when it is newer than the source.
 * Throws an error when the source transcript is missing.
 */
export async function copyTranscriptFor(source: string, sessionId: string, cwd: string): Promise<string> {
    const sourceTime = await modifiedAt(source);
    if (sourceTime === undefined) {
        throw new Error('ShipWarden cannot find the transcript of the session. Claude Code can delete old transcripts (the setting "cleanupPeriodDays").');
    }
    // <root>/projects/<folder>/<session ID>.jsonl
    const projects = path.dirname(path.dirname(source));
    const destination = path.join(projects, await projectFolderOf(projects, cwd), `${sessionId}.jsonl`);
    if (destination !== source) {
        const destinationTime = await modifiedAt(destination);
        if (destinationTime === undefined || destinationTime < sourceTime) {
            await fs.mkdir(path.dirname(destination), { recursive: true });
            await fs.copyFile(source, destination);
        }
    }
    return destination;
}

/**
 * Returns the name of the Claude Code folder of a working folder. A long path gets a name with a hash from Claude Code.
 * ShipWarden cannot make that hash, so it uses the folder that Claude Code made before: the only folder with the
 * same start.
 */
async function projectFolderOf(projects: string, cwd: string): Promise<string> {
    const name = claudeProjectFolder(cwd);
    if (name) return name;
    const start = `${cwd.replace(/[^A-Za-z0-9]/g, '-').slice(0, MAX_PROJECT_FOLDER)}-`;
    const matches = (await fs.readdir(projects).catch(() => [] as string[])).filter(entry => entry.startsWith(start));
    if (matches.length === 1) return matches[0] as string;
    throw new Error('The path of the worktree is very long. Start Claude Code in the worktree one time, then resume the session again.');
}

async function modifiedAt(file: string): Promise<number | undefined> {
    return fs.stat(file).then(
        stat => stat.mtimeMs,
        () => undefined
    );
}
