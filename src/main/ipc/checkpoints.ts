import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/api';
import { rewindNote, type RewindOptions } from '@shared/checkpoints';
import { listCheckpoints, previewRewind, rewindToCheckpoint } from '../git/checkpoints';
import type { Services } from '../services';

/** Registers the IPC handlers of the checkpoints of the agent turns. Each handler accepts only a worktree of a project. */
export function registerCheckpointsIpc({
    projectWorktrees,
    terminalSessions,
    terminals
}: Pick<Services, 'projectWorktrees' | 'terminalSessions' | 'terminals'>): void {
    const known = (worktree: unknown) => projectWorktrees.check(worktree);
    /** The running terminal session with this ID. */
    const running = async (id: string) => (await terminalSessions().catch(() => [])).find(session => session.id === id && !session.exited);

    ipcMain.handle(IpcChannels.checkpointsList, async (_event, worktree: string) => listCheckpoints(await known(worktree)));
    ipcMain.handle(IpcChannels.checkpointsPreview, async (_event, worktree: string, ref: string, session: string) =>
        previewRewind(await known(worktree), String(ref), !!(await running(String(session))))
    );
    ipcMain.handle(IpcChannels.checkpointsRewind, async (_event, worktree: string, ref: string, options: Partial<RewindOptions> | undefined) => {
        const { checkpoint, ...result } = await rewindToCheckpoint(await known(worktree), String(ref), { reset: options?.reset === true });
        if (options?.tellAgent === true) {
            const session = await running(checkpoint.session);
            if (session) {
                // A bracketed paste keeps the note in one piece. Then Enter sends it.
                terminals.write(session.id, `\x1b[200~${rewindNote(checkpoint, result.reset)}\x1b[201~`);
                setTimeout(() => terminals.write(session.id, '\r'), 200);
            }
        }
        return result;
    });
}
