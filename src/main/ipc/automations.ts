import { writeFile, readFile } from 'fs/promises';
import { clipboard, dialog, ipcMain, shell } from 'electron';
import { IpcChannels } from '@shared/api';
import { isAutomationId, type AutomationRun } from '@shared/automations';
import type { Services } from '../services';
import type { RunChange } from '../automations/automation-store';
import { TokenCounter } from '../automations/token-counter';
import { sendHttpRequest } from '../automations/http-request';
import { showOpenDialog } from './dialogs';
import { onlyStrings, optionalString } from './args';

/** An import file larger than this is not an automation. */
const MAX_IMPORT_BYTES = 256 * 1024;

/** Registers the IPC handlers of the automations and their runs, and starts to watch the automations folder. */
export function registerAutomationIpc({ automations, window, networkReady }: Pick<Services, 'automations' | 'window' | 'networkReady'>): void {
    ipcMain.handle(IpcChannels.automationsList, () => automations.list());
    ipcMain.handle(IpcChannels.automationsSave, (_event, automation: unknown, previousId: unknown) => automations.save(automation, optionalString(previousId)));
    ipcMain.handle(IpcChannels.automationsRemove, (_event, id: unknown) => automations.remove(String(id)));
    ipcMain.on(IpcChannels.automationsReveal, (_event, id: unknown) => {
        if (isAutomationId(id)) {
            shell.showItemInFolder(automations.fileOf(id));
        } else {
            void shell.openPath(automations.folder);
        }
    });
    ipcMain.handle(IpcChannels.automationsExportText, (_event, id: unknown) => automations.exportText(String(id)));
    ipcMain.handle(IpcChannels.automationsExportToFile, async (_event, id: unknown) => {
        const text = await automations.exportText(String(id));
        const current = window.get();
        const options: Electron.SaveDialogOptions = {
            title: 'Export the Automation',
            buttonLabel: 'Export',
            defaultPath: `${String(id)}.json`,
            filters: [{ name: 'JSON', extensions: ['json'] }]
        };
        const result = current ? await dialog.showSaveDialog(current, options) : await dialog.showSaveDialog(options);
        if (result.canceled || !result.filePath) return false;
        await writeFile(result.filePath, text, 'utf8');
        return true;
    });
    ipcMain.handle(IpcChannels.automationsImportFromFile, async () => {
        const result = await showOpenDialog(window.get(), {
            title: 'Import an Automation',
            buttonLabel: 'Import',
            properties: ['openFile'],
            filters: [
                { name: 'JSON', extensions: ['json'] },
                { name: 'All Files', extensions: ['*'] }
            ]
        });
        const file = result.canceled ? undefined : result.filePaths[0];
        if (!file) return undefined;
        const content = await readFile(file);
        if (content.byteLength > MAX_IMPORT_BYTES) throw new Error('The file is too large to be an automation.');
        return content.toString('utf8');
    });
    ipcMain.handle(IpcChannels.automationsCopyExport, async (_event, id: unknown) => clipboard.writeText(await automations.exportText(String(id))));
    ipcMain.handle(IpcChannels.automationsReadClipboard, async () => (await clipboard.readText()).slice(0, MAX_IMPORT_BYTES));
    const tokens = new TokenCounter();
    ipcMain.handle(IpcChannels.automationsCountTokens, (_event, transcript: unknown, from: unknown, to: unknown) =>
        tokens.count(String(transcript), Number(from), typeof to === 'number' ? to : undefined)
    );
    ipcMain.handle(IpcChannels.automationsRuns, () => automations.runState());
    ipcMain.handle(IpcChannels.automationsClaim, (_event, run: AutomationRun) => automations.claim(run));
    ipcMain.handle(IpcChannels.automationsUpdateRun, (_event, id: unknown, change: RunChange) => automations.updateRun(String(id), runChangeOf(change)));
    ipcMain.handle(IpcChannels.automationsSeed, (_event, automationId: unknown, keys: unknown, scope: unknown) =>
        automations.seed(String(automationId), onlyStrings(keys), typeof scope === 'string' ? scope : undefined)
    );
    ipcMain.handle(IpcChannels.automationsSetScheduleRun, (_event, automationId: unknown, at: unknown) =>
        automations.setScheduleRun(String(automationId), typeof at === 'number' && Number.isFinite(at) ? at : Date.now())
    );
    ipcMain.handle(IpcChannels.automationsClearHistory, () => automations.clearHistory());
    ipcMain.handle(IpcChannels.automationsHttp, (_event, request: unknown) => sendHttpRequest(request, networkReady));
    void automations
        .watch(() => window.send(IpcChannels.automationsChanged))
        .catch(error => console.warn(`[automations] The automations folder is not watched: ${error instanceof Error ? error.message : String(error)}`));
}

/** Keeps only the fields of a run change that the page can set, with the correct types. */
export function runChangeOf(value: unknown): RunChange {
    const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    const change: RunChange = {};
    const statuses = ['pending', 'held', 'running', 'done', 'failed', 'skipped', 'dry-run'];
    if (typeof raw.status === 'string' && statuses.includes(raw.status)) change.status = raw.status as RunChange['status'];
    for (const key of ['detail', 'worktreePath', 'sessionId', 'noteName'] as const) {
        if (typeof raw[key] === 'string') change[key] = raw[key];
    }
    for (const key of ['tokens', 'cacheReads'] as const) {
        const value = raw[key];
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) change[key] = Math.round(value);
    }
    const turn = raw.turn && typeof raw.turn === 'object' ? (raw.turn as Record<string, unknown>) : undefined;
    if (turn && typeof turn.sessionId === 'string' && typeof turn.from === 'number') {
        change.turn = {
            sessionId: turn.sessionId,
            from: turn.from,
            ...(typeof turn.to === 'number' ? { to: turn.to } : {}),
            ...(turn.counted === true ? { counted: true } : {})
        };
    }
    return change;
}
