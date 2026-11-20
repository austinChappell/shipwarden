import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/api';
import type { Services } from '../services';

/** Registers the IPC handlers of the agent comparisons. */
export function registerCompareIpc({ compare, stats }: Pick<Services, 'compare' | 'stats'>): void {
    ipcMain.handle(IpcChannels.compareList, () => compare.list());
    ipcMain.handle(IpcChannels.compareSave, async (_event, group: unknown) => {
        const id = group && typeof group === 'object' ? (group as { id?: unknown }).id : undefined;
        const before = (await compare.list()).find(item => item.id === id)?.keptPath;
        const saved = await compare.save(group);
        // "Keep this one" sets the kept run. The agent stats count the wins.
        if (saved.keptPath && saved.keptPath !== before) stats.kept(saved);
        return saved;
    });
    ipcMain.handle(IpcChannels.compareRemove, (_event, id: unknown) => compare.remove(String(id)));
}
