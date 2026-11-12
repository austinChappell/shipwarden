import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { CircleAlert, Info, Pencil, TriangleAlert } from 'lucide-react';
import { Button, Input } from './ui';
import { modalOpen, trapTab } from './use-modal';

export interface ConfirmOptions {
    /** The question, in one short sentence. */
    title: string;
    /** More text below the title. Blank lines make paragraphs. */
    message?: string;
    /** Preformatted text, for example the output of a script. It shows in a scrolling box. */
    detail?: string;
    /** The text of the button that agrees. The default is "OK". */
    confirmLabel?: string;
    /** The text of the button that cancels. The default is "Cancel". */
    cancelLabel?: string;
    /** True for an action that removes or stops something. The confirm button is red. */
    danger?: boolean;
}

interface Request extends ConfirmOptions {
    id: number;
    /** True for a message with only one button. */
    notice?: boolean;
    /** A text field. Its value is the answer of `promptDialog`. */
    input?: { value: string; placeholder?: string };
    resolve(value: boolean): void;
}

let queue: Request[] = [];
let counter = 0;
const listeners = new Set<() => void>();

function emit() {
    listeners.forEach(listener => listener());
}

function push(request: Omit<Request, 'id' | 'resolve'>): Promise<boolean> {
    return new Promise(resolve => {
        counter += 1;
        queue = [...queue, { ...request, id: counter, resolve }];
        emit();
    });
}

/** Asks the user a question in a dialog of the app. Resolves true when the user agrees. */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
    return push(options);
}

/** Shows a message in a dialog of the app. Resolves when the user closes it. */
export async function alertDialog(title: string, message?: string): Promise<void> {
    await push({ title, message, confirmLabel: 'OK', notice: true });
}

/**
 * Asks the user for a text in a dialog of the app, for example a new name. Resolves the trimmed text, or undefined
 * when the user cancels. An empty text is a valid answer (for example "no name").
 */
export async function promptDialog(options: ConfirmOptions & { value?: string; placeholder?: string }): Promise<string | undefined> {
    const input = { value: options.value ?? '', placeholder: options.placeholder };
    const ok = await push({ ...options, input });
    return ok ? input.value.trim() : undefined;
}

/** True while a dialog of this file or a modal dialog of `useModal` shows. The shortcuts of the app do nothing then. */
export function dialogOpen(): boolean {
    return queue.length > 0 || modalOpen();
}

function answer(request: Request, value: boolean) {
    queue = queue.filter(item => item.id !== request.id);
    emit();
    request.resolve(value);
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** Shows the dialogs of `confirmDialog` and `alertDialog`, one at a time. The app renders it one time. */
export function DialogHost() {
    const current = useSyncExternalStore(subscribe, () => queue[0]);
    const confirmButton = useRef<HTMLButtonElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const previousFocus = useRef<Element | null>(null);
    const [text, setText] = useState('');

    // biome-ignore lint/correctness/useExhaustiveDependencies: The effect must run one time for each dialog. The id identifies the dialog.
    useEffect(() => {
        if (!current) return;
        previousFocus.current = document.activeElement;
        if (current.input) {
            setText(current.input.value);
            // The field gets the focus, with its text selected, so the user can type a new text at once.
            requestAnimationFrame(() => inputRef.current?.select());
        } else {
            confirmButton.current?.focus();
        }
        return () => {
            // The focus goes back, for example to the terminal.
            if (previousFocus.current instanceof HTMLElement) previousFocus.current.focus();
        };
    }, [current?.id]);

    if (!current) return null;
    const Icon = current.input ? Pencil : current.notice ? Info : current.danger ? TriangleAlert : CircleAlert;
    const confirm = () => {
        if (current.input) current.input.value = text;
        answer(current, true);
    };
    const paragraphs =
        current.message
            ?.split(/\n\s*\n/)
            .map(text => text.trim())
            .filter(Boolean) ?? [];

    return (
        <div className="modal-backdrop confirm-backdrop" onMouseDown={event => event.target === event.currentTarget && answer(current, false)}>
            <div
                className="modal confirm-dialog"
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="confirm-title"
                onKeyDown={event => {
                    // The keys must not reach the shortcuts of the app or a terminal.
                    event.stopPropagation();
                    trapTab(event, event.currentTarget);
                    if (event.key === 'Escape') {
                        event.preventDefault();
                        answer(current, false);
                    }
                }}
            >
                <div className="confirm-content">
                    <Icon size={20} strokeWidth={1.8} className={`confirm-icon${current.danger ? ' danger' : ''}`} />
                    <div className="confirm-text">
                        <h2 id="confirm-title">{current.title}</h2>
                        {paragraphs.map((text, index) => (
                            <p key={index}>{text}</p>
                        ))}
                        {current.detail && <pre className="confirm-detail">{current.detail}</pre>}
                        {current.input && (
                            <Input
                                ref={inputRef}
                                className="confirm-input"
                                value={text}
                                placeholder={current.input.placeholder}
                                onChange={event => setText(event.target.value)}
                                onKeyDown={event => {
                                    if (event.key === 'Enter') {
                                        event.preventDefault();
                                        confirm();
                                    }
                                }}
                            />
                        )}
                    </div>
                </div>
                <footer className="modal-footer">
                    {!current.notice && <Button onClick={() => answer(current, false)}>{current.cancelLabel ?? 'Cancel'}</Button>}
                    <Button ref={confirmButton} variant={current.danger ? 'danger-solid' : 'primary'} onClick={confirm}>
                        {current.confirmLabel ?? 'OK'}
                    </Button>
                </footer>
            </div>
        </div>
    );
}
