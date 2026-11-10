import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, LoaderCircle, X } from 'lucide-react';
import { documents } from '../editor/documents';
import { monaco } from '../editor/monaco';
import { lspBridge } from '../lsp/bridge';
import { useMissingServer } from '../lsp/missing-servers';
import type { CheckoutState } from '../github/review-checkout-store';
import { CopyButton } from './CopyButton';

/** A position in a file of the pull request. */
export interface CodeLocation {
    path: string;
    line?: number;
    column?: number;
    /** "definition": after the file opens, go to the definition of the name at the position. */
    action?: 'definition';
    /** A new value shows the location again. */
    nonce: number;
}

interface Props {
    /** The folder of the copy of the pull request. Undefined while the copy is not ready. */
    root: string | undefined;
    checkout: CheckoutState;
    location: CodeLocation;
    canGoBack: boolean;
    onBack(): void;
    onClose(): void;
    /** Tries the copy again after an error, or after the user did not agree to a clone. */
    onRetry(): void;
    /** Gets the position of the cursor, so that "Back" can go to it. */
    onCursor(path: string, line: number, column: number): void;
}

/**
 * The code of the pull request at its head commit, in a read-only Monaco editor. The language server of the copy
 * supplies go to definition, references and hover. "Go to definition" into another file opens it here.
 */
export function ReviewCodeView({ root, checkout, location, canGoBack, onBack, onClose, onRetry, onCursor }: Props) {
    return (
        <div className="review-code">
            <header className="review-code-header">
                <button className="icon-button" title="Back" disabled={!canGoBack} onClick={onBack}>
                    <ArrowLeft size={14} strokeWidth={1.6} />
                </button>
                <span className="review-code-path" title={location.path}>
                    {location.path}
                </span>
                <CopyButton text={location.path} title="Copy the file path" size={13} />
                <button className="icon-button" title="Close the code" onClick={onClose}>
                    <X size={14} strokeWidth={1.6} />
                </button>
            </header>
            {root ? <CodeEditor root={root} location={location} onCursor={onCursor} /> : <CheckoutMessage checkout={checkout} onRetry={onRetry} />}
        </div>
    );
}

/** Tells the user why the code does not show yet. */
export function CheckoutMessage({ checkout, onRetry }: { checkout: CheckoutState; onRetry(): void }) {
    if (checkout.status === 'working') {
        return (
            <div className="panel-message">
                <LoaderCircle size={14} className="spin" />
                {checkout.cloning ? ' ShipWarden clones the repository. This can take some minutes.' : ' ShipWarden gets the files of the pull request…'}
            </div>
        );
    }
    if (checkout.status === 'error') {
        return (
            <div className="panel-message review-code-message">
                <span className="form-error">{checkout.error}</span>
                <button className="button" onClick={onRetry}>
                    Try again
                </button>
            </div>
        );
    }
    return (
        <div className="panel-message review-code-message">
            <span>Go to definition and the file explorer need a local copy of the pull request.</span>
            <button className="button primary" onClick={onRetry}>
                Get the files
            </button>
        </div>
    );
}

function CodeEditor({ root, location, onCursor }: { root: string; location: CodeLocation; onCursor: Props['onCursor'] }) {
    const containerRef = useRef<HTMLDivElement>(null);
    const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
    const [failure, setFailure] = useState<string>();
    const missing = useMissingServer(root, location.path);
    const onCursorRef = useRef(onCursor);
    onCursorRef.current = onCursor;

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        const editor = monaco.editor.create(container, {
            theme: 'shipwarden',
            automaticLayout: true,
            readOnly: true,
            readOnlyMessage: { value: 'This is the code of the pull request. You cannot change it here.' },
            fontFamily: '"JetBrains Mono", Menlo, monospace',
            fontSize: 13,
            lineHeight: 20,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            renderLineHighlight: 'line',
            padding: { top: 8 },
            smoothScrolling: true,
            stickyScroll: { enabled: true },
            bracketPairColorization: { enabled: true },
            guides: { indentation: true, bracketPairs: false }
        });
        editorRef.current = editor;
        const listener = editor.onDidChangeCursorPosition(event => {
            const model = editor.getModel();
            if (!model) return;
            onCursorRef.current(model.uri.path.slice(root.length + 1), event.position.lineNumber, event.position.column);
        });
        return () => {
            listener.dispose();
            // The model stays in the document store. The Review view closes the models of the copy.
            editor.setModel(null);
            editor.dispose();
            editorRef.current = undefined;
        };
    }, [root]);

    useEffect(() => {
        const editor = editorRef.current;
        if (!editor) return;
        let current = true;
        setFailure(undefined);
        documents.open(root, location.path).then(
            async model => {
                if (!current || (editor.getModel() === model && !location.line)) {
                    if (current) editor.focus();
                    return;
                }
                if (editor.getModel() !== model) editor.setModel(model);
                if (location.line) {
                    const line = Math.min(location.line, model.getLineCount());
                    const column = location.column ?? 1;
                    editor.setPosition({ lineNumber: line, column });
                    editor.revealLineInCenter(line);
                    if (!location.column) editor.setSelection(new monaco.Selection(line, 1, line, model.getLineMaxColumn(line)));
                }
                editor.focus();
                if (location.action === 'definition') {
                    // The server must have the file first. Before that, the request gets no result.
                    await lspBridge.whenTracked(model);
                    if (current && editor.getModel() === model) {
                        void editor.getAction('editor.action.revealDefinition')?.run();
                    }
                }
            },
            error => {
                if (current)
                    setFailure((error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
            }
        );
        return () => {
            current = false;
        };
    }, [root, location.path, location.line, location.column, location.action, location.nonce]);

    return (
        <div className="review-code-body">
            {failure && <div className="editor-failure">{failure}</div>}
            {missing && (
                <div className="editor-server-banner" role="status">
                    <span className="editor-server-text">
                        Install <strong>{missing.server.name}</strong> to get go to definition and hover in this file.
                    </span>
                </div>
            )}
            <div className="editor-monaco" ref={containerRef} />
        </div>
    );
}
