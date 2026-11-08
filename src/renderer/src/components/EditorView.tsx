import { useEffect, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import type { LspMissingServer } from '@shared/lsp';
import { documents } from '../editor/documents';
import { monaco } from '../editor/monaco';
import { missingServers, useMissingServer } from '../lsp/missing-servers';

interface Props {
    root: string;
    path: string;
    /** A line to show and select. The view uses it again when `revealNonce` changes. */
    revealLine?: number;
    /** With a column, the editor puts the cursor there. Without it, the editor selects the full line. */
    revealColumn?: number;
    revealNonce?: number;
    onError(message: string): void;
    /** Runs the install command of a missing language server. */
    onInstallServer(server: LspMissingServer): void;
}

/** Shows one file in Monaco. Cmd+S saves the file. */
export function EditorView({ root, path, revealLine, revealColumn, revealNonce, onError, onInstallServer }: Props) {
    const containerRef = useRef<HTMLDivElement>(null);
    const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
    const [ready, setReady] = useState(false);
    const [failure, setFailure] = useState<string>();
    const missing = useMissingServer(root, path);

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
            {missing && <MissingServerBanner {...missing} onInstall={() => onInstallServer(missing.server)} />}
            <div className="editor-monaco" ref={containerRef} />
        </div>
    );
}

interface BannerProps {
    server: LspMissingServer;
    installing: boolean;
    onInstall(): void;
}

/** Tells the user that the file needs a language server that is not installed. */
function MissingServerBanner({ server, installing, onInstall }: BannerProps) {
    let text;
    if (installing) {
        text = <>ShipWarden waits for the install of <strong>{server.name}</strong> to complete. Then it starts the server.</>;
    } else if (server.installCommand) {
        text = <>Install <strong>{server.name}</strong> to get go to definition, hover and errors in this file.</>;
    } else {
        text = <>Install <strong>{server.name}</strong> to get go to definition, hover and errors. ShipWarden did not find {server.tools.join(', ')} in the PATH.</>;
    }
    return (
        <div className="editor-server-banner" role="status">
            <Download size={14} strokeWidth={1.8} />
            <span className="editor-server-text">{text}</span>
            {!installing && server.installCommand && (
                <button className="button primary" title={server.installCommand} onClick={onInstall}>Install</button>
            )}
            <button className="button" onClick={() => missingServers.dismiss(server.serverId)}>Not now</button>
        </div>
    );
}
