import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';
import './styles.css';
import './components/ui/ui.css';
import { App } from './App';
import { confirmDialog, DialogHost } from './components/ConfirmDialog';
import { ContextMenuHost } from './components/ContextMenu';
import { UpdateNotice } from './components/UpdateNotice';
import { applyLastPalette } from './theme/appearance';
import { outputActivity } from './terminal/output-activity';
import { appKeyAction } from '@shared/shortcuts';
import { queryClient } from './query-client';

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

// The app keys (⌘Q, ⇧⌥⌘Q, ⌘, ⇧⌘U and ⌘H), in the capture phase, before a terminal takes them. The main process normally
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
window.shipwarden.app.onConfirmRequest((id, request) => {
    void confirmDialog(request).then(confirmed => window.shipwarden.app.answerConfirm(id, confirmed));
});

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <QueryClientProvider client={queryClient}>
            <App />
            <UpdateNotice />
            <DialogHost />
            <ContextMenuHost />
        </QueryClientProvider>
    </StrictMode>
);
