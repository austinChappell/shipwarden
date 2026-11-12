import { useEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DiffSide, PullRequest, PullRequestFile, RepoTarget } from '@shared/github';
import { monaco } from '../editor/monaco';
import { gitHubSeenKey } from '@shared/dashboard';
import { reviewStore, useReviewState } from '../github/review-store';
import { replyToThread, setThreadResolved } from '../github/pull-request-mutations';
import { lineNotePrompt, threadPrompt } from '../github/agent-prompts';
import { selectionLines, threadsWithLine } from '../github/diff-notes';
import { seenStore } from '../seen-store';
import { errorText } from '../util';
import { ComposerZone, PendingZone, ThreadZone } from './ReviewZones';
import { reactionActions } from './Reactions';
import { MentionContext, mentionSourceOf } from './mention-context';
import { Checkbox } from './ui';

export {
    ComposerZone,
    PendingZone,
    QuestionZone,
    ThreadZone,
    type AgentQuestion,
    type ComposerMode,
    type NoteOptions,
    type QuestionAction
} from './ReviewZones';

interface Props {
    target: RepoTarget;
    pr: PullRequest;
    file: PullRequestFile;
    revealLine?: number;
    revealNonce?: number;
    /** Not used. A reply or a resolve puts its result into the cache, so the view does not load the pull request again. */
    onRefresh?(): Promise<void>;
    /** Sends a review comment to the agent of the worktree. Without it (in the Review view), the button does not show. */
    onSendToAgent?(prompt: string): void;
}

interface Composer {
    side: DiffSide;
    line: number;
    /** The first selected line. The comment goes on `line`. */
    startLine?: number;
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
    domNode.addEventListener(
        'wheel',
        event => {
            const box = (event.target as HTMLElement).closest('textarea');
            if (box && box.scrollHeight > box.clientHeight) return;
            event.preventDefault();
            editor.setScrollTop(editor.getScrollTop() + event.deltaY);
            editor.setScrollLeft(editor.getScrollLeft() + event.deltaX);
        },
        { passive: false }
    );
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

/** Shows the change to one file in a pull request, with the review threads under their lines. */
export function DiffView({ target, pr, file, revealLine, revealNonce, onSendToAgent }: Props) {
    const containerRef = useRef<HTMLDivElement>(null);
    const diffRef = useRef<monaco.editor.IStandaloneDiffEditor | undefined>(undefined);
    const zonesRef = useRef<ZoneHandle[]>([]);
    const [ready, setReady] = useState(false);
    const [message, setMessage] = useState<string>('Loading the diff…');
    const [composer, setComposer] = useState<Composer>();
    const review = useReviewState(target, pr.number);
    /** The file in the loaded file list, for its "Viewed" state. */
    const viewedFile = review.files?.find(item => item.path === file.path);
    // The zones keep this function. The ref gives the zones the newest function without a new set of zones.
    const onSendToAgentRef = useRef(onSendToAgent);
    onSendToAgentRef.current = onSendToAgent;

    // The comments in this diff count as seen on the Dashboard.
    useEffect(() => {
        seenStore.mark(pr.threads.filter(thread => thread.path === file.path).flatMap(thread => thread.comments.map(comment => gitHubSeenKey(comment.id))));
    }, [pr, file.path]);

    // Create the diff editor and load the two versions of the file.
    // biome-ignore lint/correctness/useExhaustiveDependencies: The file object changes on each refresh. The editor loads again only for a new path or new commits.
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
                if (
                    (type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS || type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) &&
                    event.target.position
                ) {
                    setComposer({ side, line: event.target.position.lineNumber });
                }
            });
            editor.onMouseMove(event => {
                const type = event.target.type;
                const line = event.target.position?.lineNumber;
                const onGutter = type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS || type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN;
                hoverDecorations.get(editor)!.set(
                    onGutter && line
                        ? [
                              {
                                  range: new monaco.Range(line, 1, line, 1),
                                  options: { glyphMarginClassName: 'comment-glyph', glyphMarginHoverMessage: { value: 'Add a review comment' } }
                              }
                          ]
                        : []
                );
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
                    const at = selectionLines(editor.getSelection());
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

        // Each zone has its own React root, so the zone content needs its own mention provider.
        const mentions = mentionSourceOf(target, pr);
        const addZone = (side: DiffSide, line: number, content: React.ReactNode, focus = false) =>
            handles.push(addReviewZone(editorFor(side), line, <MentionContext value={mentions}>{content}</MentionContext>, { focus }));

        for (const thread of threadsWithLine(pr.threads, file.path)) {
            addZone(
                thread.side,
                thread.line,
                <ThreadZone
                    thread={thread}
                    worktree={typeof target === 'string' ? target : undefined}
                    onReply={body => replyToThread(target, pr, thread, body)}
                    onResolve={() => setThreadResolved(target, pr, thread, !thread.isResolved)}
                    reactions={reactionActions(target, pr)}
                    onSendToAgent={onSendToAgentRef.current && (() => onSendToAgentRef.current?.(threadPrompt(pr, thread)))}
                />
            );
        }
        for (const comment of review.pending) {
            if (comment.path === file.path) {
                addZone(
                    comment.side,
                    comment.line,
                    <PendingZone
                        comment={comment}
                        onRemove={() => reviewStore.removePending(target, pr.number, comment)}
                        onEdit={body => reviewStore.updatePending(target, pr.number, comment, body)}
                        onSendToAgent={onSendToAgentRef.current && (() => onSendToAgentRef.current?.(lineNotePrompt(pr, comment)))}
                    />
                );
            }
        }
        if (composer) {
            addZone(
                composer.side,
                composer.line,
                <ComposerZone
                    line={composer.line}
                    startLine={composer.startLine}
                    onSendToAgent={
                        onSendToAgentRef.current &&
                        (body => {
                            const startLine = composer.startLine !== undefined && composer.startLine < composer.line ? composer.startLine : undefined;
                            onSendToAgentRef.current?.(lineNotePrompt(pr, { path: file.path, line: composer.line, startLine, side: composer.side, body }));
                            setComposer(undefined);
                        })
                    }
                    onCancel={() => setComposer(undefined)}
                    onSuggest={
                        composer.side === 'RIGHT'
                            ? async () => {
                                  const model = diff.getModifiedEditor().getModel();
                                  return model
                                      ? model
                                            .getLinesContent()
                                            .slice((composer.startLine ?? composer.line) - 1, composer.line)
                                            .join('\n')
                                      : undefined;
                              }
                            : undefined
                    }
                    onAdd={(body, originalCode) => {
                        const startLine = composer.startLine !== undefined && composer.startLine < composer.line ? composer.startLine : undefined;
                        reviewStore.addPending(target, pr.number, { path: file.path, line: composer.line, startLine, side: composer.side, body, originalCode });
                        setComposer(undefined);
                    }}
                />,
                true
            );
        }
        zonesRef.current = handles;

        return () => {
            zonesRef.current = [];
            removeReviewZones(handles);
        };
    }, [ready, pr, review.pending, composer, file.path, target]);

    // biome-ignore lint/correctness/useExhaustiveDependencies: A new revealNonce shows the same line again after the user scrolls away.
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
                    <Checkbox
                        className="viewed-toggle"
                        label="Viewed"
                        title="Mark the file as viewed, as on GitHub"
                        checked={!!viewedFile.viewed}
                        onChange={checked => reviewStore.setViewed(target, pr.number, pr.id, file.path, checked).catch(err => setMessage(errorText(err)))}
                    />
                )}
            </div>
            {message && <div className="editor-failure">{message}</div>}
            <div className="editor-monaco" ref={containerRef} />
        </div>
    );
}
