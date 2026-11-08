import { useEffect, useRef, useState } from 'react';
import { documents } from '../editor/documents';
import { monaco } from '../editor/monaco';

interface Props {
    root: string;
    path: string;
    /** A line to show and select. The view uses it again when `revealNonce` changes. */
    revealLine?: number;
    /** With a column, the editor puts the cursor there. Without it, the editor selects the full line. */
    revealColumn?: number;
    revealNonce?: number;
    onError(message: string): void;
}

/** Shows one file in Monaco. Cmd+S saves the file. */
export function EditorView({ root, path, revealLine, revealColumn, revealNonce, onError }: Props) {
    const containerRef = useRef<HTMLDivElement>(null);
    const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
    const [ready, setReady] = useState(false);
    const [failure, setFailure] = useState<string>();

    useEffect(() => {
        const container = containerRef.current;
        if (!container) {
            return;
        }
        let disposed = false;
        const editor = monaco.editor.create(container, {
            theme: 'shipwarden',
            automaticLayout: true,
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
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
            documents.save(root, path).catch(error => onError(error instanceof Error ? error.message : String(error)));
        });

        documents.open(root, path).then(
            model => {
                if (disposed) {
                    return;
                }
                editor.setModel(model);
                setReady(true);
                editor.focus();
            },
            error => {
                if (!disposed) {
                    setFailure((error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
                }
            }
        );

        return () => {
            disposed = true;
            // The model stays in the document store, so the undo history stays.
            editor.setModel(null);
            editor.dispose();
            editorRef.current = undefined;
        };
    }, [root, path]);

    useEffect(() => {
        const editor = editorRef.current;
        if (ready && editor && revealLine) {
            editor.revealLineInCenter(revealLine);
            if (revealColumn) {
                editor.setPosition({ lineNumber: revealLine, column: revealColumn });
            } else {
                editor.setSelection(new monaco.Selection(revealLine, 1, revealLine, editor.getModel()?.getLineMaxColumn(revealLine) ?? 1));
            }
            editor.focus();
        }
    }, [ready, revealLine, revealColumn, revealNonce]);

    return (
        <div className="editor">
            {failure && <div className="editor-failure">{failure}</div>}
            <div className="editor-monaco" ref={containerRef} />
        </div>
    );
}
