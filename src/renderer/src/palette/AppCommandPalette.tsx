import { useEffect, useState } from 'react';
import type { NoteInfo } from '@shared/notes';
import { useAutomationList } from '../automations/automation-queries';
import { useReviewQueuePullRequests } from '../github/review-overview-store';
import { CommandPalette } from './CommandPalette';
import { paletteItems, type PaletteContext } from './palette-commands';

const api = window.shipwarden;

/** The state of the app for the palette. The palette loads the notes, the automations, and the review queue itself. */
export type AppPaletteContext = Omit<PaletteContext, 'notes' | 'automations' | 'reviewQueue'>;

interface Props {
    context: AppPaletteContext;
    onClose(): void;
    onError(message: string): void;
}

/** The command palette of the app. It shows only while it is open, so its data loads only then. */
export function AppCommandPalette({ context, onClose, onError }: Props) {
    const [notes, setNotes] = useState<NoteInfo[]>();
    useEffect(() => {
        let live = true;
        api.notes.list().then(
            list => live && setNotes(list),
            () => undefined
        );
        return () => {
            live = false;
        };
    }, []);
    const { list } = useAutomationList();
    const reviewQueue = useReviewQueuePullRequests();
    const items = paletteItems({ ...context, notes, automations: list.automations, reviewQueue });
    return <CommandPalette items={items} onClose={onClose} onError={onError} />;
}
