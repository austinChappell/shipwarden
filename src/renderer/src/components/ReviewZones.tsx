import { useRef, useState } from 'react';
import { Bot, Check, ChevronRight, FileDiff, LoaderCircle, Send } from 'lucide-react';
import { lineLabel } from '@shared/ask-agent';
import { noteTargetOptions, type NoteTarget } from '@shared/code-note';
import type { AgentDefinition } from '@shared/settings';
import type { PendingComment, ReviewThread } from '@shared/github';
import { answerOutdated, type AgentQuestion, type QuestionAction } from '../github/agent-questions';
import { composerModes, composerPlaceholder, composerSubmitLabel, type ComposerMode } from '../github/diff-notes';
import { useWorktreeSessions } from '../terminal/session-list-store';
import { errorText, timeAgo } from '../util';
import { Markdown } from './Markdown';
import { CommentBody } from './CommentBody';
import { suggestionBlock, threadSuggestionTarget } from '@shared/suggestion';
import { applyThreadSuggestion } from '../github/suggestions';
import { radioGroupKeys } from './keyboard';
import { Reactions, type ReactionActions } from './Reactions';
import { MentionTextarea } from './MentionTextarea';

export type { AgentQuestion, ComposerMode, QuestionAction };

export function ThreadZone({
    thread,
    onReply,
    onResolve,
    onSendToAgent,
    worktree,
    reactions
}: {
    thread: ReviewThread;
    onReply(body: string): Promise<void>;
    onResolve(): Promise<void>;
    onSendToAgent?(): void;
    /** The worktree of the pull request. With it, a suggested change can go into the file. */
    worktree?: string;
    /** Without it, the comments show no reactions. */
    reactions?: ReactionActions;
}) {
    const original = threadSuggestionTarget(thread)?.original;
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
                    <div className="comment-author">
                        {comment.author?.login ?? 'unknown'} <span>{timeAgo(comment.createdAt)}</span>
                    </div>
                    <CommentBody
                        body={comment.body}
                        original={original}
                        outdated={thread.isOutdated}
                        onApply={worktree && original ? lines => applyThreadSuggestion(worktree, thread, lines) : undefined}
                    />
                    <Reactions subjectId={comment.id} reactions={comment.reactions} actions={reactions} />
                </div>
            ))}
            {replying && <MentionTextarea autoFocus value={text} placeholder="Reply" onValueChange={setText} />}
            {error && <div className="form-error">{error}</div>}
            <div className="thread-actions">
                {replying ? (
                    <>
                        <button className="link-button" onClick={() => setReplying(false)}>
                            Cancel
                        </button>
                        <button className="link-button" disabled={busy || !text.trim()} onClick={() => act(() => onReply(text.trim()))}>
                            Send reply
                        </button>
                    </>
                ) : (
                    <button className="link-button" onClick={() => setReplying(true)}>
                        Reply
                    </button>
                )}
                <button className="link-button" disabled={busy} onClick={() => act(onResolve)}>
                    {thread.isResolved ? 'Unresolve' : 'Resolve'}
                </button>
                {onSendToAgent && (
                    <button className="link-button" onClick={onSendToAgent}>
                        <Bot size={13} strokeWidth={1.6} /> Send to agent
                    </button>
                )}
            </div>
        </div>
    );
}

/** A pending comment. With `onAccept`, a comment from an agent review that waits for a decision shows an Accept button. */
export function PendingZone({
    comment,
    onRemove,
    onEdit,
    onAccept
}: {
    comment: PendingComment;
    onRemove(): void;
    onEdit?(body: string): void;
    onAccept?(): void;
}) {
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
                {comment.fromAgent && (
                    <span className="tag agent-tag">
                        <Bot size={11} strokeWidth={1.8} /> agent draft
                    </span>
                )}
                {comment.needsDecision
                    ? ' Accept or remove this comment. You cannot submit your review until you do.'
                    : ' goes out as your comment with your next review'}
            </div>
            {editing ? (
                <MentionTextarea
                    autoFocus
                    value={text}
                    onValueChange={setText}
                    onKeyDown={event => {
                        if (event.key === 'Escape') setEditing(false);
                        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) save();
                        event.stopPropagation();
                    }}
                />
            ) : (
                <CommentBody body={comment.body} original={comment.originalCode?.split('\n')} />
            )}
            <div className="thread-actions">
                {editing ? (
                    <>
                        <button className="link-button" onClick={() => setEditing(false)}>
                            Cancel
                        </button>
                        <button className="link-button" disabled={!text.trim()} onClick={save}>
                            Save
                        </button>
                    </>
                ) : (
                    onEdit && (
                        <button
                            className="link-button"
                            onClick={() => {
                                setText(comment.body);
                                setEditing(true);
                            }}
                        >
                            Edit
                        </button>
                    )
                )}
                {comment.needsDecision && onAccept && !editing && (
                    <button className="link-button accept-button" onClick={onAccept}>
                        <Check size={13} strokeWidth={2} /> Accept
                    </button>
                )}
                <button className="link-button" onClick={onRemove}>
                    Remove
                </button>
            </div>
        </div>
    );
}

/** The text of each mode button of the composer. */
const MODE_LABELS: Record<ComposerMode, React.ReactNode> = {
    comment: 'Comment',
    ask: (
        <>
            <Bot size={12} strokeWidth={1.6} /> Ask agent
        </>
    ),
    note: (
        <>
            <Send size={12} strokeWidth={1.6} /> Send to agent
        </>
    )
};

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
export function ComposerZone({
    line,
    startLine = line,
    onAdd,
    onAsk,
    onSuggest,
    note,
    onCancel,
    canComment = true,
    initialMode
}: {
    line: number;
    startLine?: number;
    /** Adds the comment. `originalCode` is the text of the lines when the user started a suggested change. */
    onAdd(body: string, originalCode?: string): void;
    /** Returns the text of the lines for a suggested change. Without it, the "Suggest a change" button does not show. */
    onSuggest?(): Promise<string | undefined>;
    onAsk?(question: string): void;
    note?: NoteOptions;
    onCancel(): void;
    canComment?: boolean;
    /** The mode when the box opens. */
    initialMode?: ComposerMode;
}) {
    const [text, setText] = useState('');
    const [mode, setMode] = useState<ComposerMode>(initialMode ?? (canComment ? 'comment' : 'ask'));
    const textRef = useRef<HTMLTextAreaElement>(null);
    /** The text of the lines when the user started a suggested change. */
    const [originalCode, setOriginalCode] = useState<string>();
    const [suggestError, setSuggestError] = useState<string>();
    const [targetKey, setTargetKey] = useState<string>();
    const sessions = useWorktreeSessions(note?.worktree ?? '');
    const targets = note ? noteTargetOptions(sessions, note.agents, note.defaultAgentId) : [];
    // The selected agent can stop while the box is open. Then the first choice applies.
    const target = targets.find(option => option.key === targetKey) ?? targets[0];
    const lines = lineLabel(startLine, line);
    const modes = composerModes(canComment, !!onAsk, !!note);
    const submit = () => {
        const value = text.trim();
        if (!value) return;
        if (mode === 'ask') onAsk?.(value);
        else if (mode === 'note') {
            if (target) note?.onSend(value, target.target);
        } else onAdd(value, originalCode);
    };
    /** Puts a suggestion block with the text of the lines at the cursor. */
    const suggest = async () => {
        if (!onSuggest) return;
        setSuggestError(undefined);
        let code: string | undefined;
        try {
            code = await onSuggest();
        } catch (err) {
            setSuggestError(errorText(err));
            return;
        }
        if (code === undefined) {
            setSuggestError('ShipWarden cannot read the lines of the file.');
            return;
        }
        const box = textRef.current;
        const at = box ? box.selectionStart : text.length;
        const end = box ? box.selectionEnd : text.length;
        const before = text.slice(0, at);
        const after = text.slice(end);
        const prefix = before && !before.endsWith('\n') ? '\n' : '';
        const suggestion = suggestionBlock(code);
        const block = `${prefix}${suggestion}${after && !after.startsWith('\n') ? '\n' : ''}`;
        setText(before + block + after);
        setOriginalCode(code);
        // Select the lines in the block, so the user can type the change at once.
        const first = before.length + prefix.length + suggestion.indexOf('\n') + 1;
        requestAnimationFrame(() => {
            box?.focus();
            box?.setSelectionRange(first, first + code.length);
        });
    };
    const placeholder = composerPlaceholder(mode, lines);
    const submitLabel = composerSubmitLabel(mode);
    return (
        <div className={`zone-card composer${mode === 'comment' ? '' : ' ask'}`}>
            {modes.length > 1 && (
                <div className="segmented compact composer-mode" role="radiogroup" aria-label="Kind of note" onKeyDown={radioGroupKeys}>
                    {modes.map(item => (
                        <button key={item} role="radio" aria-checked={mode === item} className={mode === item ? 'selected' : ''} onClick={() => setMode(item)}>
                            {MODE_LABELS[item]}
                        </button>
                    ))}
                </div>
            )}
            <MentionTextarea
                ref={textRef}
                autoFocus
                value={text}
                placeholder={placeholder}
                aria-label={placeholder}
                onValueChange={setText}
                onKeyDown={event => {
                    if (event.key === 'Escape') onCancel();
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit();
                    // Monaco must not handle keys that the user types in the comment box.
                    event.stopPropagation();
                }}
            />
            {suggestError && <div className="form-error">{suggestError}</div>}
            <div className="row-buttons">
                {mode === 'comment' && onSuggest && (
                    <button className="button composer-suggest" title={`Add a suggested change for ${lines}`} onClick={suggest}>
                        <FileDiff size={13} strokeWidth={1.6} /> Suggest a change
                    </button>
                )}
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
                                {targets
                                    .filter(option => option.target.kind === 'session')
                                    .map(option => (
                                        <option key={option.key} value={option.key}>
                                            {option.label}
                                        </option>
                                    ))}
                            </optgroup>
                        )}
                        <optgroup label="Start a new agent">
                            {targets
                                .filter(option => option.target.kind === 'new')
                                .map(option => (
                                    <option key={option.key} value={option.key}>
                                        {option.label}
                                    </option>
                                ))}
                        </optgroup>
                    </select>
                )}
                <button className="button" onClick={onCancel}>
                    Cancel
                </button>
                <button className="button primary" disabled={!text.trim() || (mode === 'note' && !target)} onClick={submit}>
                    {submitLabel}
                </button>
            </div>
        </div>
    );
}

/**
 * Shows a question to the agent under its lines, with the answer or the error. The answer can become a pending comment.
 * An answer stays on disk until the user deletes it. "Hide" collapses the card to the question only.
 */
export function QuestionZone({
    question,
    headRefOid,
    onAction,
    canComment,
    linesChanged = false
}: {
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
    const outdated = answerOutdated(question, headRefOid);
    return (
        <div className="zone-card agent-question">
            <div className="comment-author">
                <Bot size={12} strokeWidth={1.6} /> You asked {question.agent ?? 'the agent'}
                {done && question.answeredAt && <span className="agent-question-time">{timeAgo(new Date(question.answeredAt).toISOString())}</span>}
            </div>
            <div className="comment-body agent-question-text">{question.question}</div>
            {question.status === 'running' && (
                <div className="agent-question-wait">
                    <LoaderCircle size={13} className="spin" /> The agent reads the code…
                </div>
            )}
            {done && <Markdown className="comment-body agent-answer" text={question.answer ?? ''} />}
            {done && linesChanged && <div className="agent-question-outdated">The lines changed after you asked. The answer is about the old lines.</div>}
            {outdated && (
                <div className="agent-question-outdated">The agent answered on commit {question.commit?.slice(0, 7)}. The pull request changed after that.</div>
            )}
            {question.status === 'error' && <div className="form-error">{question.error}</div>}
            <div className="thread-actions">
                {question.status === 'running' ? (
                    <button className="link-button" onClick={() => onAction('cancel')}>
                        Cancel
                    </button>
                ) : done ? (
                    <>
                        {canComment && (
                            <button className="link-button" onClick={() => onAction('comment')}>
                                Use as a pending comment
                            </button>
                        )}
                        <button className="link-button" onClick={() => onAction('toggle')}>
                            Hide
                        </button>
                        <button className="link-button" onClick={() => onAction('delete')}>
                            Delete
                        </button>
                    </>
                ) : (
                    <>
                        {question.status === 'error' && (
                            <button className="link-button" onClick={() => onAction('retry')}>
                                Try again
                            </button>
                        )}
                        <button className="link-button" onClick={() => onAction('close')}>
                            Close
                        </button>
                    </>
                )}
            </div>
        </div>
    );
}
