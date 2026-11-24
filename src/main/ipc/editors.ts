import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/api';
import { NO_EDITOR_TEXT, selectedEditor, type EditorList } from '@shared/editors';
import { detectEditors, openInEditor } from '../editors/editors';
import type { Services } from '../services';

/** Registers the IPC handlers of the external code editors. */
export function registerEditorIpc({ settings, projectWorktrees }: Pick<Services, 'settings' | 'projectWorktrees'>): void {
    ipcMain.handle(IpcChannels.editorsList, async (): Promise<EditorList> => {
        const editors = await detectEditors();
        return { editors, selected: selectedEditor(editors, (await settings.get()).externalEditor)?.appPath };
    });
    // The page sends only a worktree and a file. The main process selects the app, so the page cannot start other programs.
    ipcMain.handle(IpcChannels.editorsOpen, async (_event, root: string, file?: string, line?: number) => {
        // A file tab of the Terminal view has the home folder as its root. Then the editor opens the worktree of the file.
        const located = file ? await projectWorktrees.locate(root, file) : undefined;
        const folder = located?.worktree ?? (await projectWorktrees.check(String(root)));
        const editor = selectedEditor(await detectEditors(), (await settings.get()).externalEditor);
        if (!editor) {
            throw new Error(NO_EDITOR_TEXT);
        }
        await openInEditor(editor, {
            folder,
            ...(located ? { file: located.absolute } : {}),
            ...(typeof line === 'number' && Number.isFinite(line) ? { line } : {})
        });
    });
}
