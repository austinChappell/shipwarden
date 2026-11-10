import { useEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Bot, Check, ChevronRight, LoaderCircle, Send } from 'lucide-react';
import { noteTargetOptions, type NoteTarget } from '@shared/code-note';
import type { AgentDefinition } from '@shared/settings';
import type { DiffSide, PendingComment, PullRequest, PullRequestFile, RepoTarget, ReviewThread } from '@shared/github';
import { monaco } from '../editor/monaco';
import { gitHubSeenKey } from '@shared/dashboard';
import { reviewStore, useReviewState } from '../github/review-store';
import { seenStore } from '../seen-store';
import { useWorktreeSessions } from '../terminal/session-list-store';
import { errorText, timeAgo } from '../util';
import { Markdown } from './Markdown';
import { radioGroupKeys } from './keyboard';

interface Props {
    target: RepoTarget;
    pr: PullRequest;
    file: PullRequestFile;
    revealLine?: number;
    revealNonce?: number;
    onRefresh(): Promise<void>;
    /** Sends a review comment to the agent of the worktree. Without it (in the Review view), the button does not show. */
    onSendToAgent?(prompt: string): void;
}

interface Composer {
    side: DiffSide;
    line: number;
    /** The first selected line. The comment goes on `line`. */
    startLine?: number;
}

/**
 * Returns the selected lines of an editor, or the line of the cursor without a selection.
 * A selection that ends at column 1 does not contain its last line.
 */
function selectedLines(editor: monaco.editor.ICodeEditor): { startLine: number; line: number } | undefined {
    const selection = editor.getSelection();
    if (!selection) return undefined;
    if (selection.isEmpty()) return { startLine: selection.positionLineNumber, line: selection.positionLineNumber };
    const end = selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber ? selection.endLineNumber - 1 : selection.endLineNumber;
    return { startLine: selection.startLineNumber, line: end };
}

export interface ZoneHandle {
    editor: monaco.editor.ICodeEditor;
    id: string;
    root: Root;
    observer: ResizeObserver;
    widget: monaco.editor.IOverlayWidget;
    dispose(): void;
}

let nextZoneId = 0;

/**
 * Shows React content under a line of the editor. The zone height follows the content.
 * A view zone keeps the space free. The content is in an overlay widget on top of that space, as in the peek view of
 * Monaco. Content in the view zone itself cannot get clicks, because the text layer of the editor covers view zones.
 */
export function addReviewZone(editor: monaco.editor.ICodeEditor, line: number, content: React.ReactNode, options: { focus?: boolean } = {}): ZoneHandle {
    const domNode = document.createElement('div');
    domNode.className = 'review-zone';
    domNode.style.position = 'absolute';
    domNode.style.display = 'none';
    // Clicks and keys in a zone must not move the editor cursor.
    domNode.addEventListener('mousedown', event => event.stopPropagation());
    // The overlay is not in the scrollable part of the editor. Send the wheel to the editor, except in a text box that scrolls.
    domNode.addEventListener('wheel', event => {
        const box = (event.target as HTMLElement).closest('textarea');
        if (box && box.scrollHeight > box.clientHeight) return;
        event.preventDefault();
        editor.setScrollTop(editor.getScrollTop() + event.deltaY);
        editor.setScrollLeft(editor.getScrollLeft() + event.deltaX);
    }, { passive: false });
    const zoneRoot = createRoot(domNode);
    zoneRoot.render(content);

    // Monaco calls getId more than one time. The ID must not change.
    const widgetId = `shipwarden.review-zone.${nextZoneId++}`;
    const widget: monaco.editor.IOverlayWidget = { getId: () => widgetId, getDomNode: () => domNode, getPosition: () => null };
    const place = () => {
        const layout = editor.getLayoutInfo();
        domNode.style.left = `${layout.contentLeft}px`;
        domNode.style.width = `${Math.max(0, layout.contentWidth - layout.verticalScrollbarWidth)}px`;
    };
    place();
    editor.addOverlayWidget(widget);
    const layoutListener = editor.onDidLayoutChange(place);

    const placeholder = document.createElement('div');
    const zone: monaco.editor.IViewZone = {
        afterLineNumber: line,
        heightInPx: 80,
        domNode: placeholder,
        onDomNodeTop: top => {
            domNode.style.top = `${top}px`;
        }
    };
    let id = '';
    editor.changeViewZones(accessor => {
        id = accessor.addZone(zone);
    });
    // The editor hides the placeholder when its line is out of view. The content follows.
    // A hidden element cannot get the focus, so `autoFocus` has no effect. The text box gets the focus when the zone first shows.
    let focusPending = options.focus === true;
    const visibility = new MutationObserver(() => {
        const visible = placeholder.style.display !== 'none';
        domNode.style.display = visible ? '' : 'none';
        if (visible && focusPending) {
            focusPending = false;
            requestAnimationFrame(() => domNode.querySelector<HTMLElement>('textarea')?.focus());
        }
    });
    visibility.observe(placeholder, { attributes: true, attributeFilter: ['style'] });

    // The zone height follows the overlay. The overlay height includes the margins of the card. A hidden overlay has no height.
    const observer = new ResizeObserver(() => {
        const height = domNode.offsetHeight;
        if (height && Math.abs(height - (zone.heightInPx ?? 0)) > 1) {
            zone.heightInPx = height;
            editor.changeViewZones(accessor => accessor.layoutZone(id));
        }
    });
    observer.observe(domNode);
    let disposed = false;
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        observer.disconnect();
        visibility.disconnect();
        layoutListener.dispose();
        editor.removeOverlayWidget(widget);
        editor.changeViewZones(accessor => accessor.removeZone(id));
    };
    return { editor, id, root: zoneRoot, observer, widget, dispose };
}

/** Removes zones from their editors. React unmounts the content after the current render. */
export function removeReviewZones(handles: ZoneHandle[]): void {
    handles.forEach(handle => handle.dispose());
    queueMicrotask(() => handles.forEach(handle => handle.root.unmount()));
}

export function ThreadZone({ thread, onReply, onResolve, onSendToAgent }: {
    thread: ReviewThread;
    onReply(body: string): Promise<void>;
    onResolve(): Promise<void>;
    onSendToAgent?(): void;
}) {
    const [replying, setReplying] = useState(false);
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();
    const act = async (action: () => Promise<void>) => {
        setBusy(true);
        setError(undefined);
        try {
            await action();
        } catch (err) {
            setError(errorText(err));
        } finally {
            setBusy(false);
        }
    };
    return (
        <div className={`zone-card${thread.isResolved ? ' resolved' : ''}`}>
            {thread.comments.map(comment => (
                <div key={comment.id} className="thread-comment">
                    <div className="comment-author">{comment.author?.login ?? 'unknown'} <span>{timeAgo(comment.createdAt)}</span></div>
                    <Markdown className="comment-body" text={comment.body} />
                </div>
            ))}
            {replying && <textarea autoFocus value={text} placeholder="Reply" onChange={event => setText(event.target.value)} />}
            {error && <div className="form-error">{error}</div>}
            <div className="thread-actions">
                {replying ? (
                    <>
                        <button className="link-button" onClick={() => setReplying(false)}>Cancel</button>
                        <button className="link-button" disabled={busy || !text.trim()} onClick={() => act(() => onReply(text.trim()))}>Send reply</button>
                    </>
                ) : (
                    <button className="link-button" onClick={() => setReplying(true)}>Reply</button>
                )}
                <button className="link-button" disabled={busy} onClick={() => act(onResolve)}>{thread.isResolved ? 'Unresolve' : 'Resolve'}</button>
                {onSendToAgent && <button className="link-button" onClick={onSendToAgent}><Bot size={13} strokeWidth={1.6} /> Send to agent</button>}
            </div>
        </div>
    );
}

/** A pending comment. With `onAccept`, a comment from an agent review that waits for a decision shows an Accept button. */
export function PendingZone({ comment, onRemove, onEdit, onAccept }: { comment: PendingComment; onRemove(): void; onEdit?(body: string): void; onAccept?(): void }) {
    const [editing, setEditing] = useState(false);
    const [text, setText] = useState(comment.body);
    const save = () => {
        if (!text.trim()) return;
        onEdit?.(text.trim());
        setEditing(false);
    };
    return (
        <div className={`zone-card pending${comment.fromAgent ? ' from-agent' : ''}${comment.needsDecision ? ' needs-decision' : ''}`}>
            <div className="comment-author">
                <span className="tag">pending</span>
                {comment.fromAgent && <span className="tag agent-tag"><Bot size={11} strokeWidth={1.8} /> agent draft</span>}
                {comment.needsDecision
                    ? ' Accept or remove this comment. You cannot submit your review until you do.'
                    : ' goes out as your comment with your next review'}
            </div>
            {editing ? (
                <textarea
                    autoFocus
                    value={text}
                    onChange={event => setText(event.target.value)}
                    onKeyDown={event => {
                        if (event.key === 'Escape') setEditing(false);
                        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) save();
                        event.stopPropagation();
                    }}
                />
            ) : (
                <Markdown className="comment-body" text={comment.body} />
            )}
            <div className="thread-actions">
                {editing ? (
                    <>
                        <button className="link-button" onClick={() => setEditing(false)}>Cancel</button>
                        <button className="link-button" disabled={!text.trim()} onClick={save}>Save</button>
                    </>
                ) : (
                    onEdit && <button className="link-button" onClick={() => { setText(comment.body); setEditing(true); }}>Edit</button>
                )}
                {comment.needsDecision && onAccept && !editing && (
                    <button className="link-button accept-button" onClick={onAccept}><Check size={13} strokeWidth={2} /> Accept</button>
                )}
                <button className="link-button" onClick={onRemove}>Remove</button>
            </div>
        </div>
    );
}

export type ComposerMode = 'comment' | 'ask' | 'note';

/** The data of the "Send to agent" mode of the composer. */
export interface NoteOptions {
    /** The worktree of the file. The menu shows the agents that run in it. */
    worktree: string;
    agents: AgentDefinition[];
    /** The agent of the repository. Its "New" choice comes first. */
    defaultAgentId?: string;
    onSend(note: string, target: NoteTarget): void;
}

/**
 * The box for a new review comment under a line. With `onAsk`, the box can also ask the agent a question about the lines.
 * With `note`, the box can also send a note about the lines to an agent that runs, or to a new agent.
 * `canComment` false hides the comment mode, for example for a closed pull request or a file of a worktree.
 */
export function ComposerZone({ line, startLine = line, onAdd, onAsk, note, onCancel, canComment = true, initialMode }: {
    line: number;
    startLine?: number;
    onAdd(body: string): void;
    onAsk?(question: string): void;
    note?: NoteOptions;
    onCancel(): void;
    canComment?: boolean;
    /** The mode when the box opens. */
    initialMode?: ComposerMode;
}) {
    const [text, setText] = useState('');
    const [mode, setMode] = useState<ComposerMode>(initialMode ?? (canComment ? 'comment' : 'ask'));
    const [targetKey, setTargetKey] = useState<string>();
    const sessions = useWorktreeSessions(note?.worktree ?? '');
    const targets = note ? noteTargetOptions(sessions, note.agents, note.defaultAgentId) : [];
    // The selected agent can stop while the box is open. Then the first choice applies.
    const target = targets.find(option => option.key === targetKey) ?? targets[0];
    const lines = startLine === line ? `line ${line}` : `lines ${startLine}–${line}`;
    const modes: { mode: ComposerMode; label: React.ReactNode }[] = [
        ...(canComment ? [{ mode: 'comment' as const, label: 'Comment' }] : []),
        ...(onAsk ? [{ mode: 'ask' as const, label: <><Bot size={12} strokeWidth={1.6} /> Ask agent</> }] : []),
        ...(note ? [{ mode: 'note' as const, label: <><Send size={12} strokeWidth={1.6} /> Send to agent</> }] : [])
    ];
    const submit = () => {
        const value = text.trim();
        if (!value) return;
        if (mode === 'ask') onAsk?.(value);
        else if (mode === 'note') {
            if (target) note?.onSend(value, target.target);
        } else onAdd(value);
    };
    const placeholder = mode === 'ask' ? `Ask the agent about ${lines}` : mode === 'note' ? `Tell the agent what to do with ${lines}` : `Comment on ${lines}`;
    const submitLabel = mode === 'ask' ? 'Ask agent' : mode === 'note' ? 'Send to agent' : 'Add review comment';
    return (
        <div className={`zone-card composer${mode === 'comment' ? '' : ' ask'}`}>
            {modes.length > 1 && (
                <div className="segmented compact composer-mode" role="radiogroup" aria-label="Kind of note" onKeyDown={radioGroupKeys}>
                    {modes.map(item => (
                        <button key={item.mode} role="radio" aria-checked={mode === item.mode} className={mode === item.mode ? 'selected' : ''} onClick={() => setMode(item.mode)}>{item.label}</button>
                    ))}
                </div>
            )}
            <textarea
                autoFocus
                value={text}
                placeholder={placeholder}
                aria-label={placeholder}
                onChange={event => setText(event.target.value)}
                onKeyDown={event => {
                    if (event.key === 'Escape') onCancel();
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit();
                    // Monaco must not handle keys that the user types in the comment box.
                    event.stopPropagation();
                }}
            />
            <div className="row-buttons">
                {mode === 'note' && (
                    <select
                        className="tasks-select composer-target"
                        aria-label="Agent that gets the note"
                        title="The agent that gets the note"
                        value={target?.key ?? ''}
                        onChange={event => setTargetKey(event.target.value)}
                        onKeyDown={event => event.stopPropagation()}
                    >
                        {targets.some(option => option.target.kind === 'session') && (
                            <optgroup label="Running in this worktree">
                                {targets.filter(option => option.target.kind === 'session').map(option => <option key={option.key} value={option.key}>{option.label}</option>)}
                            </optgroup>
                        )}
                        <optgroup label="Start a new agent">
                            {targets.filter(option => option.target.kind === 'new').map(option => <option key={option.key} value={option.key}>{option.label}</option>)}
                        </optgroup>
                    </select>
                )}
                <button className="button" onClick={onCancel}>Cancel</button>
                <button className="button primary" disabled={!text.trim() || (mode === 'note' && !target)} onClick={submit}>{submitLabel}</button>
            </div>
        </div>
    );
}

/** A question to the agent about lines of a file, and its answer when it comes. */
export interface AgentQuestion {
    id: string;
    path: string;
    side: DiffSide;
    startLine: number;
    line: number;
    question: string;
    status: 'running' | 'done' | 'error';
    agent?: string;
    answer?: string;
    error?: string;
    /** The head commit of the pull request when the agent answered. */
    commit?: string;
    /** The time of the answer, in milliseconds since 1970. */
    answeredAt?: number;
    /** True when the card shows only the question. A saved answer starts collapsed. */
    collapsed?: boolean;
}

/** The actions on a question card. */
export type QuestionAction = 'close' | 'cancel' | 'retry' | 'comment' | 'toggle' | 'delete';

/**
 * Shows a question to the agent under its lines, with the answer or the error. The answer can become a pending comment.
 * An answer stays on disk until the user deletes it. "Hide" collapses the card to the question only.
 */
export function QuestionZone({ question, headRefOid, onAction, canComment, linesChanged = false }: {
    question: AgentQuestion;
    /** The current head commit of the pull request. */
    headRefOid: string;
    /** True when the lines of a worktree file changed after the question. */
    linesChanged?: boolean;
    onAction(action: QuestionAction): void;
    canComment: boolean;
}) {
    const done = question.status === 'done' && !!question.answer;
    if (done && question.collapsed) {
        return (
            <div className="zone-card agent-question collapsed">
                <button className="agent-question-toggle" title="Show the answer" onClick={() => onAction('toggle')}>
                    <ChevronRight size={13} strokeWidth={1.8} />
                    <Bot size={12} strokeWidth={1.6} />
                    <span className="agent-question-summary">{question.question}</span>
                    {question.answeredAt && <span className="agent-question-time">{timeAgo(new Date(question.answeredAt).toISOString())}</span>}
                </button>
            </div>
        );
    }
    const outdated = done && !!question.commit && question.commit !== headRefOid;
    return (
        <div className="zone-card agent-question">
            <div className="comment-author">
                <Bot size={12} strokeWidth={1.6} /> You asked {question.agent ?? 'the agent'}
                {done && question.answeredAt && <span className="agent-question-time">{timeAgo(new Date(question.answeredAt).toISOString())}</span>}
            </div>
            <div className="comment-body agent-question-text">{question.question}</div>
            {question.status === 'running' && <div className="agent-question-wait"><LoaderCircle size={13} className="spin" /> The agent reads the code…</div>}
            {done && <Markdown className="comment-body agent-answer" text={question.answer ?? ''} />}
            {done && linesChanged && <div className="agent-question-outdated">The lines changed after you asked. The answer is about the old lines.</div>}
            {outdated && <div className="agent-question-outdated">The agent answered on commit {question.commit?.slice(0, 7)}. The pull request changed after that.</div>}
            {question.status === 'error' && <div className="form-error">{question.error}</div>}
            <div className="thread-actions">
                {question.status === 'running' ? (
                    <button className="link-button" onClick={() => onAction('cancel')}>Cancel</button>
                ) : done ? (
                    <>
                        {canComment && <button className="link-button" onClick={() => onAction('comment')}>Use as a pending comment</button>}
                        <button className="link-button" onClick={() => onAction('toggle')}>Hide</button>
                        <button className="link-button" onClick={() => onAction('delete')}>Delete</button>
                    </>
                ) : (
                    <>
                        {question.status === 'error' && <button className="link-button" onClick={() => onAction('retry')}>Try again</button>}
                        <button className="link-button" onClick={() => onAction('close')}>Close</button>
                    </>
                )}
            </div>
        </div>
    );
}

/** Shows the change to one file in a pull request, with the review threads under their lines. */
export function DiffView({ target, pr, file, revealLine, revealNonce, onRefresh, onSendToAgent }: Props) {
    const containerRef = useRef<HTMLDivElement>(null);
    const diffRef = useRef<monaco.editor.IStandaloneDiffEditor | undefined>(undefined);
    const zonesRef = useRef<ZoneHandle[]>([]);
    const [ready, setReady] = useState(false);
    const [message, setMessage] = useState<string>('Loading the diff…');
    const [composer, setComposer] = useState<Composer>();
    const review = useReviewState(target, pr.number);
    /** The file in the loaded file list, for its "Viewed" state. */
    const viewedFile = review.files?.find(item => item.path === file.path);

    // The comments in this diff count as seen on the Dashboard.
    useEffect(() => {
        seenStore.mark(pr.threads.filter(thread => thread.path === file.path).flatMap(thread => thread.comments.map(comment => gitHubSeenKey(comment.id))));
    }, [pr, file.path]);

    // Create the diff editor and load the two versions of the file.
    useEffect(() => {
        const container = containerRef.current;
        if (!container) {
            return;
        }
        let disposed = false;
        const models: monaco.editor.ITextModel[] = [];
        const diff = monaco.editor.createDiffEditor(container, {
            theme: 'shipwarden',
            automaticLayout: true,
            readOnly: true,
            originalEditable: false,
            renderSideBySide: true,
            useInlineViewWhenSpaceIsLimited: true,
            renderSideBySideInlineBreakpoint: 760,
            fontFamily: '"JetBrains Mono", Menlo, monospace',
            fontSize: 13,
            lineHeight: 20,
            minimap: { enabled: false },
            glyphMargin: true,
            renderOverviewRuler: false,
            scrollBeyondLastLine: false,
            hideUnchangedRegions: { enabled: true, contextLineCount: 4, minimumLineCount: 6, revealLineCount: 20 }
        });
        diffRef.current = diff;

        // A click on a line number starts a new comment on that line.
        const hoverDecorations = new Map<monaco.editor.ICodeEditor, monaco.editor.IEditorDecorationsCollection>();
        const listen = (editor: monaco.editor.IStandaloneCodeEditor, side: DiffSide) => {
            hoverDecorations.set(editor, editor.createDecorationsCollection());
            editor.onMouseDown(event => {
                const type = event.target.type;
                if ((type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS || type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) && event.target.position) {
                    setComposer({ side, line: event.target.position.lineNumber });
                }
            });
            editor.onMouseMove(event => {
                const type = event.target.type;
                const line = event.target.position?.lineNumber;
                const onGutter = type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS || type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN;
                hoverDecorations.get(editor)!.set(onGutter && line
                    ? [{ range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: 'comment-glyph', glyphMarginHoverMessage: { value: 'Add a review comment' } } }]
                    : []);
            });
            editor.onMouseLeave(() => hoverDecorations.get(editor)!.clear());
            // ⇧⌘M starts a comment from the keyboard. The comment goes on the line of the cursor, or on the last selected line.
            editor.addAction({
                id: 'shipwarden.comment',
                label: 'Comment on Line or Selection',
                keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyM],
                contextMenuGroupId: 'navigation',
                contextMenuOrder: 0,
                run: () => {
                    const at = selectedLines(editor);
                    if (at) setComposer({ side, ...at });
                }
            });
        };
        listen(diff.getModifiedEditor(), 'RIGHT');
        listen(diff.getOriginalEditor(), 'LEFT');

        reviewStore.fileVersions(target, file, pr.baseRefOid, pr.headRefOid).then(
            versions => {
                if (disposed) {
                    return;
                }
                if (versions.unavailable) {
                    setMessage('This file is binary or too large to show.');
                    return;
                }
                const uri = (side: string, path: string) => monaco.Uri.from({ scheme: 'shipwarden-pr', path: `/${pr.number}/${side}/${path}` });
                const original = monaco.editor.createModel(versions.base, undefined, uri('base', file.previousPath ?? file.path));
                const modified = monaco.editor.createModel(versions.head, undefined, uri(`head-${pr.headRefOid.slice(0, 7)}`, file.path));
                models.push(original, modified);
                diff.setModel({ original, modified });
                setReady(true);
                setMessage('');
            },
            err => !disposed && setMessage(errorText(err))
        );

        return () => {
            disposed = true;
            zonesRef.current.forEach(zone => zone.dispose());
            const roots = zonesRef.current.map(zone => zone.root);
            zonesRef.current = [];
            diff.setModel(null);
            diff.dispose();
            models.forEach(model => model.dispose());
            diffRef.current = undefined;
            // React must not unmount a root while it renders.
            queueMicrotask(() => roots.forEach(zoneRoot => zoneRoot.unmount()));
        };
    }, [target, pr.number, pr.baseRefOid, pr.headRefOid, file.path]);

    // Show the review threads, the pending comments and the comment box as view zones under their lines.
    useEffect(() => {
        const diff = diffRef.current;
        if (!ready || !diff) {
            return;
        }
        const editorFor = (side: DiffSide) => (side === 'LEFT' ? diff.getOriginalEditor() : diff.getModifiedEditor());
        const handles: ZoneHandle[] = [];

        const addZone = (side: DiffSide, line: number, content: React.ReactNode, focus = false) =>
            handles.push(addReviewZone(editorFor(side), line, content, { focus }));

        for (const thread of pr.threads) {
            if (thread.path !== file.path || thread.line === null) {
                continue;
            }
            addZone(thread.side, thread.line, (
                <ThreadZone
                    thread={thread}
                    onReply={async body => {
                        await window.shipwarden.github.reply(target, pr.number, thread.comments[thread.comments.length - 1].databaseId, body);
                        await onRefresh();
                    }}
                    onResolve={async () => {
                        await window.shipwarden.github.setThreadResolved(target, thread.id, !thread.isResolved);
                        await onRefresh();
                    }}
                    onSendToAgent={onSendToAgent && (() => onSendToAgent(
                        `A reviewer left this comment on ${thread.path} line ${thread.line} in pull request #${pr.number} (${pr.url}):\n\n` +
                        thread.comments.map(comment => `${comment.author?.login ?? 'someone'}: ${comment.body}`).join('\n\n') +
                        '\n\nMake the change that the reviewer asks for.'
                    ))}
                />
            ));
        }
        for (const comment of review.pending) {
            if (comment.path === file.path) {
                addZone(comment.side, comment.line, <PendingZone comment={comment} onRemove={() => reviewStore.removePending(target, pr.number, comment)} onEdit={body => reviewStore.updatePending(target, pr.number, comment, body)} />);
            }
        }
        if (composer) {
            addZone(composer.side, composer.line, (
                <ComposerZone
                    line={composer.line}
                    startLine={composer.startLine}
                    onCancel={() => setComposer(undefined)}
                    onAdd={body => {
                        reviewStore.addPending(target, pr.number, { path: file.path, line: composer.line, side: composer.side, body });
                        setComposer(undefined);
                    }}
                />
            ), true);
        }
        zonesRef.current = handles;

        return () => {
            zonesRef.current = [];
            removeReviewZones(handles);
        };
    }, [ready, pr, review.pending, composer, file.path, target]);

    useEffect(() => {
        const diff = diffRef.current;
        if (ready && diff && revealLine) {
            diff.getModifiedEditor().revealLineInCenter(revealLine);
        }
    }, [ready, revealLine, revealNonce]);

    return (
        <div className="editor">
            <div className="diff-header">
                <span className={`file-status status-${file.status}`}>{file.status[0].toUpperCase()}</span>
                <span className="diff-path">{file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}</span>
                <span className="additions">+{file.additions}</span>
                <span className="deletions">−{file.deletions}</span>
                <span className="diff-hint">Click a line number to comment</span>
                {viewedFile && (
                    <label className="viewed-toggle" title="Mark the file as viewed, as on GitHub">
                        <input
                            type="checkbox"
                            checked={!!viewedFile.viewed}
                            onChange={event => reviewStore.setViewed(target, pr.number, pr.id, file.path, event.target.checked).catch(err => setMessage(errorText(err)))}
                        />
                        Viewed
                    </label>
                )}
            </div>
            {message && <div className="editor-failure">{message}</div>}
            <div className="editor-monaco" ref={containerRef} />
        </div>
    );
}
