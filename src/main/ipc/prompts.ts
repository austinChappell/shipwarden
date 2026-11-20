import { ipcMain, shell } from 'electron';
import { IpcChannels } from '@shared/api';
import { isPromptTemplateId } from '@shared/prompt-templates';
import type { Services } from '../services';
import { optionalString } from './args';

/** Registers the IPC handlers of the prompt templates, and starts to watch the prompts folder. */
export function registerPromptIpc({ prompts, window }: Pick<Services, 'prompts' | 'window'>): void {
    ipcMain.handle(IpcChannels.promptsList, () => prompts.list());
    ipcMain.handle(IpcChannels.promptsSave, (_event, template: unknown, previousId: unknown) => prompts.save(template, optionalString(previousId)));
    ipcMain.handle(IpcChannels.promptsRemove, (_event, id: unknown) => prompts.remove(String(id)));
    ipcMain.on(IpcChannels.promptsReveal, (_event, id: unknown) => {
        if (isPromptTemplateId(id)) {
            shell.showItemInFolder(prompts.fileOf(id));
        } else {
            void shell.openPath(prompts.folder);
        }
    });
    void prompts
        .watch(() => window.send(IpcChannels.promptsChanged))
        .catch(error => console.warn(`[prompts] The prompts folder is not watched: ${error instanceof Error ? error.message : String(error)}`));
}
