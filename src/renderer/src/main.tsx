import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';
import './components/ui/ui.css';
import './styles.css';
import { App } from './App';
import { confirmDialog, DialogHost } from './components/ConfirmDialog';
import { PromptFillHost } from './prompts/PromptFillDialog';
import { ContextMenuHost } from './components/ContextMenu';
import { UpdateNotice } from './components/UpdateNotice';
import { ToastHost } from './components/Toast';
import { applyLastPalette } from './theme/appearance';
import { outputActivity } from './terminal/output-activity';
import { appKeyAction } from '@shared/shortcuts';
import { queryClient } from './query-client';
import { patchCachedTask } from './components/tasks/use-task-list';

/** The page settings of Yardmaster (the old app name) have the prefix "yardmaster.". Copy them one time to the new prefix. */
function migrateLegacyStorage(): void {
    try {
        const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).filter(
            (key): key is string => !!key?.startsWith('yardmaster.')
        );
        for (const key of keys) {
            const next = `shipwarden.${key.slice('yardmaster.'.length)}`;
            const value = localStorage.getItem(key);
            if (value !== null && localStorage.getItem(next) === null) localStorage.setItem(next, value);
        }
    } catch {
        // Without storage, the page uses its defaults.
    }
}

migrateLegacyStorage();
applyLastPalette();
// Record the time of the last output of each terminal from the start. The Agents view shows it.
outputActivity.start(window.shipwarden.terminals);

// The app keys (⌘Q, ⇧⌥⌘Q, ⌘, ⇧⌘U, ⌘H and ⇧⌘N), in the capture phase, before a terminal takes them. The main process normally
// reads these keys first (before-input-event). This is the second way, when it does not.
window.addEventListener(
    'keydown',
    event => {
        const action = appKeyAction({
            type: 'keyDown',
            meta: event.metaKey,
            shift: event.shiftKey,
            control: event.ctrlKey,
            alt: event.altKey,
            key: event.key,
            code: event.code
        });
        if (action) {
            event.preventDefault();
            event.stopPropagation();
            window.shipwarden.app.runKey(action);
        }
    },
    true
);

// The main process asks some questions (for example "Stop and Quit") in the dialog of the page.
// A question can end without an answer, for example the approval of an MCP tool after its timeout.
const confirmAborts = new Map<number, AbortController>();
window.shipwarden.app.onConfirmRequest((id, request) => {
    const controller = new AbortController();
    confirmAborts.set(id, controller);
    void confirmDialog(request, controller.signal).then(confirmed => {
        confirmAborts.delete(id);
        window.shipwarden.app.answerConfirm(id, confirmed);
    });
});
window.shipwarden.app.onConfirmCancel(id => confirmAborts.get(id)?.abort());
// A task change from the main process (the MCP tool set_task_status) goes into the cached lists and details.
window.shipwarden.tasks.onTaskChanged((connectionId, taskId, patch) => patchCachedTask(queryClient, connectionId, taskId, patch));

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <QueryClientProvider client={queryClient}>
            <App />
            <UpdateNotice />
            <ToastHost />
            <DialogHost />
            <PromptFillHost />
            <ContextMenuHost />
        </QueryClientProvider>
    </StrictMode>
);
