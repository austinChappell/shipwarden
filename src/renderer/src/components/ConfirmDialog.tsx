import { useEffect, useRef, useSyncExternalStore } from 'react';
import { CircleAlert, Info, TriangleAlert } from 'lucide-react';

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

/** True while a dialog shows. The shortcuts of the app do nothing then. */
export function dialogOpen(): boolean {
    return queue.length > 0;
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
    const previousFocus = useRef<Element | null>(null);

    useEffect(() => {
        if (!current) return;
        previousFocus.current = document.activeElement;
        confirmButton.current?.focus();
        return () => {
            // The focus goes back, for example to the terminal.
            if (previousFocus.current instanceof HTMLElement) previousFocus.current.focus();
        };
    }, [current?.id]);

    if (!current) return null;
    const Icon = current.notice ? Info : current.danger ? TriangleAlert : CircleAlert;
    const paragraphs = current.message?.split(/\n\s*\n/).map(text => text.trim()).filter(Boolean) ?? [];

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
                        {paragraphs.map((text, index) => <p key={index}>{text}</p>)}
                        {current.detail && <pre className="confirm-detail">{current.detail}</pre>}
                    </div>
                </div>
                <footer className="modal-footer confirm-footer">
                    {!current.notice && (
                        <button className="button" onClick={() => answer(current, false)}>{current.cancelLabel ?? 'Cancel'}</button>
                    )}
                    <button
                        ref={confirmButton}
                        className={`button ${current.danger ? 'danger' : 'primary'}`}
                        onClick={() => answer(current, true)}
                    >
                        {current.confirmLabel ?? 'OK'}
                    </button>
                </footer>
            </div>
        </div>
    );
}
