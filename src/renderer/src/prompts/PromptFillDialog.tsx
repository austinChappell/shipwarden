import { useRef, useState, useSyncExternalStore } from 'react';
import { MessageSquareText, X } from 'lucide-react';
import { fillPrompt, variableLabel } from '@shared/prompt-templates';
import { useModal } from '../components/use-modal';
import { Button, Field, IconButton, Input } from '../components/ui';

/** The answer of the dialog: the values of the variables, and true when the prompt must go at once. */
export interface FillAnswer {
    values: Record<string, string>;
    send: boolean;
}

interface Request {
    id: number;
    name: string;
    prompt: string;
    /** The values that ShipWarden knows. The preview shows them. */
    known: Record<string, string | undefined>;
    /** The variables without a value. Each one gets a field. */
    missing: string[];
    /** True when the template sends the prompt at once by default. */
    send: boolean;
    resolve(answer: FillAnswer | undefined): void;
}

let current: Request | undefined;
let counter = 0;
const listeners = new Set<() => void>();

function emit() {
    for (const listener of listeners) listener();
}

/**
 * Asks the user for the values of the variables that have no value. Resolves the values and the choice "Insert" or
 * "Send", or undefined when the user cancels. A second request cancels the first one.
 */
export function fillPromptDialog(request: Omit<Request, 'id' | 'resolve'>): Promise<FillAnswer | undefined> {
    current?.resolve(undefined);
    return new Promise(resolve => {
        counter += 1;
        current = { ...request, id: counter, resolve };
        emit();
    });
}

function finish(request: Request, answer: FillAnswer | undefined) {
    if (current?.id === request.id) current = undefined;
    emit();
    request.resolve(answer);
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** Shows the dialog of `fillPromptDialog`. The app renders it one time. */
export function PromptFillHost() {
    const request = useSyncExternalStore(subscribe, () => current);
    return request ? <PromptFillDialog key={request.id} request={request} /> : null;
}

function PromptFillDialog({ request }: { request: Request }) {
    const dialog = useRef<HTMLDivElement>(null);
    useModal(dialog);
    const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(request.missing.map(name => [name, ''])));
    const complete = request.missing.every(name => values[name]?.trim());
    const preview = fillPrompt(request.prompt, { ...request.known, ...values });
    const submit = (send: boolean) => {
        if (complete) finish(request, { values, send });
    };
    const cancel = () => finish(request, undefined);

    return (
        <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && cancel()}>
            <div
                ref={dialog}
                className="modal prompt-fill-dialog"
                role="dialog"
                aria-modal="true"
                aria-label={request.name}
                onKeyDown={event => {
                    // The keys must not reach the shortcuts of the app or a terminal.
                    event.stopPropagation();
                    if (event.key === 'Escape') {
                        event.preventDefault();
                        cancel();
                    }
                }}
            >
                <header className="modal-header">
                    <MessageSquareText size={15} strokeWidth={1.8} />
                    <h2>{request.name}</h2>
                    <span className="header-spacer" />
                    <IconButton icon={<X size={14} strokeWidth={1.8} />} label="Close" title="Close (Esc)" onClick={cancel} />
                </header>
                <form
                    className="modal-body prompt-fill-body"
                    onSubmit={event => {
                        event.preventDefault();
                        submit(request.send);
                    }}
                >
                    <p className="muted">The prompt has variables without a value. Type a value for each one.</p>
                    {request.missing.map((name, index) => (
                        <Field key={name} label={variableLabel(name)} htmlFor={`prompt-var-${index}`} hint={`{{${name}}}`}>
                            <Input
                                id={`prompt-var-${index}`}
                                autoFocus={index === 0}
                                value={values[name] ?? ''}
                                onChange={event => setValues(map => ({ ...map, [name]: event.target.value }))}
                            />
                        </Field>
                    ))}
                    <pre className="prompt-fill-preview">{preview}</pre>
                    {/* Enter in a field sends the form with the default choice of the template. */}
                    <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
                </form>
                <footer className="modal-footer">
                    <Button onClick={cancel}>Cancel</Button>
                    <Button variant={request.send ? 'secondary' : 'primary'} disabled={!complete} onClick={() => submit(false)}>
                        Insert
                    </Button>
                    <Button variant={request.send ? 'primary' : 'secondary'} disabled={!complete} onClick={() => submit(true)}>
                        Send
                    </Button>
                </footer>
            </div>
        </div>
    );
}
