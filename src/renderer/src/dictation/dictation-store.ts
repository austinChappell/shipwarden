import { useSyncExternalStore } from 'react';
import { bracketedPaste } from '@shared/agent-text';
import { type DictationErrorCode, type DictationState, type DictationUpdate, dictationErrorText, isDictationEnded } from '@shared/dictation';

/** The parts of the main process API that the store uses. A test gives a fake API. */
export interface DictationApi {
    start(id: string): void;
    stop(id: string): void;
    cancel(id: string): void;
    onUpdate(listener: (update: DictationUpdate) => void): () => void;
    /** Writes text to a terminal session. */
    write(sessionId: string, data: string): void;
}

/** The dictation of one agent tab, as the page shows it. */
export interface DictationView {
    id: string;
    /** The terminal session of the agent tab. */
    sessionId: string;
    /** "error" stays until the user closes the message or starts a new dictation. */
    state: DictationState;
    partial: string;
    /** The error text for the user, in the state "error". */
    error?: string;
    errorCode?: DictationErrorCode;
}

/**
 * Inserts the final text into a text field of an agent tab. Returns false when the field cannot take the text now.
 * The text then goes to the terminal.
 */
export type DictationInput = (text: string) => boolean;

/**
 * The dictation of the page. One dictation runs at a time, for one agent tab. The final text goes to the chat field of
 * the tab when the chat shows, else to the agent prompt in the terminal. The terminal gets the text as a bracketed
 * paste without Enter, so the user can check the text before sending it.
 */
export class DictationStore {
    private view: DictationView | undefined;
    private readonly listeners = new Set<() => void>();
    private readonly inputs = new Map<string, DictationInput>();
    private readonly api: DictationApi;
    private readonly makeId: () => string;
    private unsubscribe: (() => void) | undefined;

    constructor(api: DictationApi, makeId: () => string = () => crypto.randomUUID()) {
        this.api = api;
        this.makeId = makeId;
    }

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    getSnapshot = (): DictationView | undefined => this.view;

    /** True while a dictation records or makes its final text. */
    running(): boolean {
        return !!this.view && !isDictationEnded(this.view.state);
    }

    /** Starts a dictation for the agent tab of the session. A dictation that runs stops without a text. */
    start(sessionId: string): void {
        this.listen();
        if (this.view && this.running()) this.api.cancel(this.view.id);
        const id = this.makeId();
        this.set({ id, sessionId, state: 'starting', partial: '' });
        this.api.start(id);
    }

    /** Stops the recording. The final text comes later. */
    stop(): void {
        if (this.view && this.running()) this.api.stop(this.view.id);
    }

    /** Stops the dictation without a text, and closes an error message. */
    cancel(): void {
        const view = this.view;
        if (!view) return;
        if (this.running()) this.api.cancel(view.id);
        this.set(undefined);
    }

    /** Stops the dictation of the session when it runs. Else starts a dictation for the session. */
    toggle(sessionId: string): void {
        if (this.running() && this.view?.sessionId === sessionId) this.stop();
        else this.start(sessionId);
    }

    /** Registers the text field of an agent tab, for example the chat field. Returns the function that removes it. */
    registerInput(sessionId: string, input: DictationInput): () => void {
        this.inputs.set(sessionId, input);
        return () => {
            if (this.inputs.get(sessionId) === input) this.inputs.delete(sessionId);
        };
    }

    private listen(): void {
        this.unsubscribe ??= this.api.onUpdate(update => this.onUpdate(update));
    }

    private onUpdate(update: DictationUpdate): void {
        const view = this.view;
        // An update of an older dictation, for example the "cancelled" state after a new start.
        if (!view || view.id !== update.id) return;
        switch (update.state) {
            case 'done':
                this.set(undefined);
                this.deliver(view.sessionId, update.text ?? update.partial);
                return;
            case 'cancelled':
                this.set(undefined);
                return;
            case 'error': {
                const code = update.error?.code ?? 'helperFailed';
                this.set({ ...view, state: 'error', partial: update.partial, errorCode: code, error: dictationErrorText(code, update.error?.message) });
                return;
            }
            default:
                this.set({ ...view, state: update.state, partial: update.partial });
        }
    }

    private deliver(sessionId: string, text: string): void {
        const clean = text.trim();
        if (!clean) return;
        const input = this.inputs.get(sessionId);
        if (input?.(clean)) return;
        this.api.write(sessionId, bracketedPaste(clean));
    }

    private set(view: DictationView | undefined): void {
        this.view = view;
        for (const listener of this.listeners) listener();
    }
}

/** The API of the main process. It is a function, so a test can import this module without the preload. */
const api = () => window.shipwarden;

/** The dictation of the page. */
export const dictationStore = new DictationStore({
    start: id => api().dictation.start(id),
    stop: id => api().dictation.stop(id),
    cancel: id => api().dictation.cancel(id),
    onUpdate: listener => api().dictation.onUpdate(listener),
    write: (sessionId, data) => api().terminals.write(sessionId, data)
});

/** The dictation of an agent tab, or undefined when the tab has no dictation. */
export function useDictation(sessionId: string): DictationView | undefined {
    const view = useSyncExternalStore(dictationStore.subscribe, dictationStore.getSnapshot);
    return view?.sessionId === sessionId ? view : undefined;
}
