import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/api';
import { selectedEditor, type EditorList } from '@shared/editors';
import { detectEditors, openInEditor } from '../editors/editors';
import { resolveInside } from '../files/file-service';
import type { Services } from '../services';

/** Registers the IPC handlers of the external code editors. */
export function registerEditorIpc({ settings, projectWorktrees }: Pick<Services, 'settings' | 'projectWorktrees'>): void {
    ipcMain.handle(IpcChannels.editorsList, async (): Promise<EditorList> => {
        const editors = await detectEditors();
        return { editors, selected: selectedEditor(editors, (await settings.get()).externalEditor)?.appPath };
    });
    // The page sends only a worktree and a file. The main process selects the app, so the page cannot start other programs.
    ipcMain.handle(IpcChannels.editorsOpen, async (_event, root: string, file?: string, line?: number) => {
        const folder = await projectWorktrees.check(String(root));
        const editor = selectedEditor(await detectEditors(), (await settings.get()).externalEditor);
        if (!editor) {
            throw new Error('ShipWarden found no code editor. Install VS Code, Cursor, Zed, or a JetBrains IDE in the Applications folder.');
        }
        await openInEditor(editor, {
            folder,
            ...(file ? { file: resolveInside(folder, String(file)) } : {}),
            ...(typeof line === 'number' && Number.isFinite(line) ? { line } : {})
        });
    });
}
