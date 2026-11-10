import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { locateCode } from '@shared/ask-agent';
import { codeNotePrompt, type NoteTarget } from '@shared/code-note';
import type { AgentDefinition } from '@shared/settings';
import { codeQuestions, useCodeQuestions } from '../editor/code-questions';
import { documents } from '../editor/documents';
import { clampPosition, editorPositions } from '../editor/editor-positions';
import { monaco } from '../editor/monaco';
import {
    addReviewZone,
    ComposerZone,
    QuestionZone,
    removeReviewZones,
    type AgentQuestion,
    type NoteOptions,
    type QuestionAction,
    type ZoneHandle
} from './DiffView';
import { useMissingServer } from '../lsp/missing-servers';
import { MissingServerBanner } from './MissingServerBanner';

interface Props {
    root: string;
    path: string;
    /** A line to show and select. The view uses it again when `revealNonce` changes. */
    revealLine?: number;
    /** With a column, the editor puts the cursor there. Without it, the editor selects the full line. */
    revealColumn?: number;
    revealNonce?: number;
    /** When this value changes, the editor gets the keyboard focus. */
    focusNonce?: number;
    onError(message: string): void;
    /** The agent definitions, for the "New" choices of a note. */
    agents?: AgentDefinition[];
    /** The agent of the repository. */
    defaultAgentId?: string;
    /** Sends a note about lines to an agent. Without it, the box has no "Send to agent" mode. */
    onSendNote?(prompt: string, target: NoteTarget): void;
}

/** The lines of an open "Ask agent" or "Send to agent" box. */
interface AskRange {
    startLine: number;
    line: number;
    /** True when the box opens in the "Send to agent" mode. */
    note?: boolean;
}

/**
 * Shows one file in Monaco. Cmd+S saves the file.
 * A click in the gutter, the context menu or Cmd+Shift+A opens an "Ask agent" box for the line or the selected lines.
 * The answer shows under the lines. The box can also send a note about the lines to an agent tab of the worktree, or to a new agent. A saved answer shows only while the lines have the same text as when the user asked.
 */
export function EditorView({ root, path, revealLine, revealColumn, revealNonce, focusNonce, onError, agents, defaultAgentId, onSendNote }: Props) {
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
    // The function reads the newest onError through the ref. Its identity does not change.
    const reportError = useCallback((message: string) => onErrorRef.current(message), []);
    // The box reads the newest values, so that a new render of the app does not open the box again.
    const noteRef = useRef({ agents, defaultAgentId, onSendNote });
    noteRef.current = { agents, defaultAgentId, onSendNote };
    // The effect that opens the file reads this value, so that a reveal line does not open the file again.
    const revealLineRef = useRef(revealLine);
    revealLineRef.current = revealLine;

    useEffect(() => codeQuestions.load(root, path, reportError), [root, path, reportError]);

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
                const end =
                    selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber ? selection.endLineNumber - 1 : selection.endLineNumber;
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
        editor.addAction({
            id: 'shipwarden.sendNoteToAgent',
            label: 'Send Note About These Lines to Agent',
            contextMenuGroupId: 'navigation',
            contextMenuOrder: 0.5,
            // Without a way to send a note, the "Ask agent" box opens.
            run: () => {
                const range = rangeAt();
                setAsking(range && { ...range, note: true });
            }
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
            hover.set(
                event.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && line
                    ? [
                          {
                              range: new monaco.Range(line, 1, line, 1),
                              options: {
                                  glyphMarginClassName: 'ask-glyph',
                                  glyphMarginHoverMessage: { value: 'Ask the agent about this line or the selected lines, or send a note to an agent' }
                              }
                          }
                      ]
                    : []
            );
        });
        editor.onMouseLeave(() => hover.clear());
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
            documents.save(root, path).catch(error => reportError(error instanceof Error ? error.message : String(error)));
        });

        documents.open(root, path).then(
            model => {
                if (disposed) {
                    return;
                }
                editor.setModel(model);
                // Show the last cursor and scroll position of the file. A reveal line has priority.
                const saved = editorPositions.get(root, path);
                if (saved && !revealLineRef.current) {
                    const position = clampPosition(saved, model.getLineCount());
                    editor.setPosition({ lineNumber: position.line, column: position.column });
                    editor.setScrollTop(position.scrollTop);
                    editor.setScrollLeft(position.scrollLeft);
                }
                setReady(true);
                // Wait for a pause in the typing, so the cards do not move with each key.
                let timer: ReturnType<typeof setTimeout> | undefined;
                const listener = editor.onDidChangeModelContent(() => {
                    clearTimeout(timer);
                    timer = setTimeout(() => setTextVersion(value => value + 1), 300);
                });
                // Record the position after the restore, so that the first events do not replace the saved position.
                const savePosition = () => {
                    const cursor = editor.getPosition();
                    if (!cursor || editor.getModel() !== model) return;
                    editorPositions.set(root, path, {
                        line: cursor.lineNumber,
                        column: cursor.column,
                        scrollTop: editor.getScrollTop(),
                        scrollLeft: editor.getScrollLeft()
                    });
                };
                const cursorListener = editor.onDidChangeCursorPosition(savePosition);
                const scrollListener = editor.onDidScrollChange(savePosition);
                editor.onDidDispose(() => {
                    clearTimeout(timer);
                    listener.dispose();
                    cursorListener.dispose();
                    scrollListener.dispose();
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
    }, [root, path, reportError]);

    /**
     * The questions to show, each at its last line. A saved answer shows only where the file has the text of its lines.
     * A question that runs or failed, or that the user asked while the app runs, shows at its line.
     */
    const placedKey = useRef('');
    const placedRef = useRef<{ question: AgentQuestion; line: number; changed: boolean }[]>([]);
    // biome-ignore lint/correctness/useExhaustiveDependencies: The model text changes without a new model object. textVersion tells the memo to place the questions again.
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
            return addReviewZone(
                editor,
                line,
                <QuestionZone question={question} headRefOid="" canComment={false} linesChanged={changed} onAction={onAction} />
            );
        });
        return () => removeReviewZones(handles);
    }, [ready, placed, root, path, reportError]);

    // The "Ask agent" box has its own zone, so a new answer does not remove the text that the user types.
    useEffect(() => {
        const editor = editorRef.current;
        const model = editor?.getModel();
        if (!ready || !editor || !model || !asking) {
            return;
        }
        const { startLine, line, note } = asking;
        /** Returns the last line that the file still has, and the text of the lines. */
        const linesNow = () => {
            const end = Math.min(line, model.getLineCount());
            const range = new monaco.Range(startLine, 1, end, model.getLineMaxColumn(end));
            // "\n" between the lines, so `locateCode` can compare the text with the lines of the model.
            return { end, code: model.getValueInRange(range, monaco.editor.EndOfLinePreference.LF) };
        };
        const { agents: agentList, defaultAgentId: defaultId, onSendNote: send } = noteRef.current;
        const noteOptions: NoteOptions | undefined =
            send && agentList?.length
                ? {
                      worktree: root,
                      agents: agentList,
                      defaultAgentId: defaultId,
                      onSend: (text, target) => {
                          const { end, code } = linesNow();
                          noteRef.current.onSendNote?.(codeNotePrompt({ path, startLine, endLine: end, code, note: text }), target);
                          setAsking(undefined);
                      }
                  }
                : undefined;
        const handle = addReviewZone(
            editor,
            line,
            <ComposerZone
                line={line}
                startLine={startLine}
                canComment={false}
                initialMode={note && noteOptions ? 'note' : 'ask'}
                onAdd={() => undefined}
                onAsk={text => {
                    const { end, code } = linesNow();
                    codeQuestions.ask(root, path, startLine, end, code, text, reportError);
                    setAsking(undefined);
                }}
                note={noteOptions}
                onCancel={() => {
                    setAsking(undefined);
                    editor.focus();
                }}
            />,
            { focus: true }
        );
        return () => removeReviewZones([handle]);
    }, [ready, asking, root, path, reportError]);

    // biome-ignore lint/correctness/useExhaustiveDependencies: A new revealNonce shows the same line again. The user can scroll away and ask for the line again.
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

    // The editor already has the focus after it loads. This effect is for a file that is already open.
    useEffect(() => {
        if (ready && focusNonce) {
            editorRef.current?.focus();
        }
    }, [ready, focusNonce]);

    return (
        <div className="editor">
            {failure && <div className="editor-failure">{failure}</div>}
            {missing && <MissingServerBanner {...missing} features="go to definition, hover and errors" />}
            <div className="editor-monaco" ref={containerRef} />
        </div>
    );
}
