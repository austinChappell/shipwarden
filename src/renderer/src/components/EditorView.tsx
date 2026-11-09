import { useEffect, useMemo, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { locateCode } from '@shared/ask-agent';
import type { LspMissingServer } from '@shared/lsp';
import { codeQuestions, useCodeQuestions } from '../editor/code-questions';
import { documents } from '../editor/documents';
import { monaco } from '../editor/monaco';
import { addReviewZone, ComposerZone, QuestionZone, removeReviewZones, type AgentQuestion, type QuestionAction, type ZoneHandle } from './DiffView';
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

/** The lines of an open "Ask agent" box. */
interface AskRange {
    startLine: number;
    line: number;
}

/**
 * Shows one file in Monaco. Cmd+S saves the file.
 * A click in the gutter, the context menu or Cmd+Shift+A opens an "Ask agent" box for the line or the selected lines.
 * The answer shows under the lines. A saved answer shows only while the lines have the same text as when the user asked.
 */
export function EditorView({ root, path, revealLine, revealColumn, revealNonce, onError, onInstallServer }: Props) {
    const containerRef = useRef<HTMLDivElement>(null);
    const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
    const [ready, setReady] = useState(false);
    const [failure, setFailure] = useState<string>();
    const missing = useMissingServer(root, path);
    const [asking, setAsking] = useState<AskRange>();
    const questions = useCodeQuestions(root, path);
    /** Changes after each edit of the text, so that the cards follow their lines. */
    const [textVersion, setTextVersion] = useState(0);
    const onErrorRef = useRef(onError);
    onErrorRef.current = onError;
    const reportError = (message: string) => onErrorRef.current(message);

    useEffect(() => codeQuestions.load(root, path, reportError), [root, path]);

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
            guides: { indentation: true, bracketPairs: false },
            glyphMargin: true
        });
        editorRef.current = editor;

        /** Returns the selected lines when the selection contains `line` (or with no line), else only `line`. */
        const rangeAt = (line?: number): AskRange | undefined => {
            const selection = editor.getSelection();
            if (selection && !selection.isEmpty()) {
                // A selection that ends at column 1 does not contain its last line.
                const end = selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber ? selection.endLineNumber - 1 : selection.endLineNumber;
                if (line === undefined || (line >= selection.startLineNumber && line <= end)) return { startLine: selection.startLineNumber, line: end };
            }
            const at = line ?? selection?.positionLineNumber;
            return at ? { startLine: at, line: at } : undefined;
        };
        editor.addAction({
            id: 'shipwarden.askAgent',
            label: 'Ask Agent About These Lines',
            keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyA],
            contextMenuGroupId: 'navigation',
            contextMenuOrder: 0,
            run: () => setAsking(rangeAt())
        });
        // A click in the glyph margin opens the box. The editor sends the event before it moves the cursor.
        const hover = editor.createDecorationsCollection();
        editor.onMouseDown(event => {
            const line = event.target.position?.lineNumber;
            if (event.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && line) {
                setAsking(rangeAt(line));
            }
        });
        editor.onMouseMove(event => {
            const line = event.target.position?.lineNumber;
            hover.set(event.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && line
                ? [{ range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: 'ask-glyph', glyphMarginHoverMessage: { value: 'Ask the agent about this line or the selected lines' } } }]
                : []);
        });
        editor.onMouseLeave(() => hover.clear());
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
                // Wait for a pause in the typing, so the cards do not move with each key.
                let timer: ReturnType<typeof setTimeout> | undefined;
                const listener = editor.onDidChangeModelContent(() => {
                    clearTimeout(timer);
                    timer = setTimeout(() => setTextVersion(value => value + 1), 300);
                });
                editor.onDidDispose(() => {
                    clearTimeout(timer);
                    listener.dispose();
                });
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

    /**
     * The questions to show, each at its last line. A saved answer shows only where the file has the text of its lines.
     * A question that runs or failed, or that the user asked while the app runs, shows at its line.
     */
    const placedKey = useRef('');
    const placedRef = useRef<{ question: AgentQuestion; line: number; changed: boolean }[]>([]);
    const placed = useMemo(() => {
        const model = ready ? editorRef.current?.getModel() : undefined;
        if (!model) return [];
        const lines = model.getLinesContent();
        const next = questions.flatMap(question => {
            const code = codeQuestions.code(question.id);
            const old = { question, line: Math.min(question.line, lines.length), changed: false };
            if (question.status !== 'done' || code === undefined) return [old];
            const at = locateCode(lines, { startLine: question.startLine, line: question.line, code });
            if (at) return [{ question, line: at.line, changed: false }];
            // An answer from this run of the app stays, with a note. The user can be in the middle of an edit.
            return codeQuestions.isNew(question.id) ? [{ ...old, changed: true }] : [];
        });
        // Keep the same array when nothing moved, so the zones stay and the editor does not flicker.
        const nextKey = next.map(item => `${item.question.id}:${item.line}:${item.changed}`).join(',');
        if (nextKey === placedKey.current && next.every((item, index) => item.question === placedRef.current[index]?.question)) return placedRef.current;
        placedKey.current = nextKey;
        placedRef.current = next;
        return next;
    }, [ready, questions, textVersion]);

    // Show the questions to the agent and the answers as view zones under their lines.
    useEffect(() => {
        const editor = editorRef.current;
        if (!ready || !editor || !placed.length) {
            return;
        }
        const handles: ZoneHandle[] = placed.map(({ question, line, changed }) => {
            const onAction = (action: QuestionAction) => {
                if (action === 'retry') codeQuestions.retry(root, question, reportError);
                else if (action === 'toggle') codeQuestions.change(root, path, question.id, { collapsed: !question.collapsed });
                else codeQuestions.remove(root, question, reportError);
            };
            return addReviewZone(editor, line, <QuestionZone question={question} headRefOid="" canComment={false} linesChanged={changed} onAction={onAction} />);
        });
        return () => removeReviewZones(handles);
    }, [ready, placed, root, path]);

    // The "Ask agent" box has its own zone, so a new answer does not remove the text that the user types.
    useEffect(() => {
        const editor = editorRef.current;
        const model = editor?.getModel();
        if (!ready || !editor || !model || !asking) {
            return;
        }
        const { startLine, line } = asking;
        const handle = addReviewZone(editor, line, (
            <ComposerZone
                line={line}
                startLine={startLine}
                canComment={false}
                onAdd={() => undefined}
                onAsk={text => {
                    const end = Math.min(line, model.getLineCount());
                    const range = new monaco.Range(startLine, 1, end, model.getLineMaxColumn(end));
                    // "\n" between the lines, so `locateCode` can compare the text with the lines of the model.
                    const code = model.getValueInRange(range, monaco.editor.EndOfLinePreference.LF);
                    codeQuestions.ask(root, path, startLine, end, code, text, reportError);
                    setAsking(undefined);
                }}
                onCancel={() => {
                    setAsking(undefined);
                    editor.focus();
                }}
            />
        ), { focus: true });
        return () => removeReviewZones([handle]);
    }, [ready, asking, root, path]);

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
