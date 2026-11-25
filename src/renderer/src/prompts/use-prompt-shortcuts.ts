import { useEffect, useRef } from 'react';
import { templateForKey } from '@shared/prompt-templates';
import { dialogOpen } from '../components/ConfirmDialog';
import { recordingKeys } from '../keyboard/keymap';
import { errorText } from '../util';
import { usePromptTemplates } from './prompt-queries';
import { runPromptTemplate } from './prompt-runner';

/**
 * Inserts a template when the user presses its shortcut. The keys work only while `enabled` is true, for example in
 * the worktree view, and not while a dialog shows. The page reads the keys in the capture phase, before a terminal
 * gets them. The main process does not take these keys, because a template cannot use a key of ShipWarden.
 */
export function usePromptShortcuts(enabled: boolean, onError: (message: string) => void): void {
    const { list } = usePromptTemplates();
    const state = useRef({ enabled, onError, templates: list.templates });
    state.current = { enabled, onError, templates: list.templates };
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            const { enabled: on, templates, onError: report } = state.current;
            if (!on || event.repeat || templates.length === 0 || dialogOpen() || recordingKeys()) return;
            const template = templateForKey(templates, event);
            if (!template) return;
            event.preventDefault();
            event.stopPropagation();
            runPromptTemplate(template).catch(error => report(errorText(error)));
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, []);
}
