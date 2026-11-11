import type { AppKeyAction } from '@shared/shortcuts';
import type { Services } from '../services';
import { registerAppIpc } from './app';
import { registerAskIpc } from './ask';
import { registerAutomationIpc } from './automations';
import { registerBrowserIpc } from './browser';
import { registerCodeIpc } from './code';
import { registerFileIpc } from './files';
import { registerGitIpc } from './git';
import { registerGitHubIpc } from './github';
import { registerNotesIpc } from './notes';
import { registerPlanIpc } from './plans';
import { registerProjectIpc } from './projects';
import { registerRemoteIpc } from './remote';
import { registerSettingsIpc } from './settings';
import { registerTaskIpc } from './tasks';
import { registerTerminalIpc } from './terminals';
import { registerWorktreeIpc } from './worktrees';

/** Registers all IPC handlers of the main process. Call it one time, after the app is ready. */
export function registerIpc(services: Services, runAppKey: (action: AppKeyAction) => void): void {
    registerProjectIpc(services);
    registerWorktreeIpc(services);
    registerFileIpc(services);
    registerGitHubIpc(services);
    registerBrowserIpc(services);
    registerTaskIpc(services);
    registerCodeIpc(services);
    registerTerminalIpc(services);
    registerAskIpc(services);
    registerSettingsIpc(services);
    registerNotesIpc(services);
    registerAutomationIpc(services);
    registerPlanIpc(services);
    registerRemoteIpc(services);
    registerGitIpc(services);
    registerAppIpc({ ...services, runAppKey });
}
