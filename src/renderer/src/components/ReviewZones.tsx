import { useRef, useState } from 'react';
import { Bot, Check, ChevronRight, FileDiff, LoaderCircle, Send } from 'lucide-react';
import { lineLabel } from '@shared/ask-agent';
import { noteTargetOptions, type NoteTarget, type NoteTargetOption } from '@shared/code-note';
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
import { Button, ButtonGroup, Card, CardBody, Chip, Select, type SelectOption } from './ui';

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
        <Card className={`zone-card${thread.isResolved ? ' resolved' : ''}`}>
            <CardBody>
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
                            <Button variant="link" onClick={() => setReplying(false)}>
                                Cancel
                            </Button>
                            <Button variant="link" disabled={busy || !text.trim()} onClick={() => act(() => onReply(text.trim()))}>
                                Send reply
                            </Button>
                        </>
                    ) : (
                        <Button variant="link" onClick={() => setReplying(true)}>
                            Reply
                        </Button>
                    )}
                    <Button variant="link" disabled={busy} onClick={() => act(onResolve)}>
                        {thread.isResolved ? 'Unresolve' : 'Resolve'}
                    </Button>
                    {onSendToAgent && (
                        <Button variant="link" icon={<Bot size={13} strokeWidth={1.6} />} onClick={onSendToAgent}>
                            Send to agent
                        </Button>
                    )}
                </div>
            </CardBody>
        </Card>
    );
}

/**
 * A pending comment. With `onAccept`, a comment from an agent review that waits for a decision shows an Accept button.
 * With `onSendToAgent`, the comment can go to an agent before the review goes out. The comment stays pending.
 */
export function PendingZone({
    comment,
    onRemove,
    onEdit,
    onAccept,
    onSendToAgent
}: {
    comment: PendingComment;
    onRemove(): void;
    onEdit?(body: string): void;
    onAccept?(): void;
    onSendToAgent?(): void;
}) {
    const [sent, setSent] = useState(false);
    const [editing, setEditing] = useState(false);
    const [text, setText] = useState(comment.body);
    const save = () => {
        if (!text.trim()) return;
        onEdit?.(text.trim());
        setEditing(false);
    };
    return (
        <Card tone="accent" dashed={comment.fromAgent} className={`zone-card pending${comment.needsDecision ? ' needs-decision' : ''}`}>
            <CardBody>
                <div className="comment-author">
                    <Chip>pending</Chip>
                    {comment.fromAgent && (
                        <Chip tone="info" icon={<Bot size={12} strokeWidth={1.8} />}>
                            agent draft
                        </Chip>
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
                            <Button variant="link" onClick={() => setEditing(false)}>
                                Cancel
                            </Button>
                            <Button variant="link" disabled={!text.trim()} onClick={save}>
                                Save
                            </Button>
                        </>
                    ) : (
                        onEdit && (
                            <Button
                                variant="link"
                                onClick={() => {
                                    setText(comment.body);
                                    setEditing(true);
                                }}
                            >
                                Edit
                            </Button>
                        )
                    )}
                    {comment.needsDecision && onAccept && !editing && (
                        <Button variant="link" icon={<Check size={13} strokeWidth={2} />} onClick={onAccept}>
                            Accept
                        </Button>
                    )}
                    {onSendToAgent && !editing && (
                        <Button
                            variant="link"
                            icon={sent ? <Check size={13} strokeWidth={2} /> : <Bot size={13} strokeWidth={1.6} />}
                            title="Send the comment to the agent. The comment stays in your review."
                            onClick={() => {
                                onSendToAgent();
                                setSent(true);
                            }}
                        >
                            {sent ? 'Sent to agent' : 'Send to agent'}
                        </Button>
                    )}
                    <Button variant="link-danger" onClick={onRemove}>
                        Remove
                    </Button>
                </div>
            </CardBody>
        </Card>
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
/** The value of a heading in the list of agents. A heading is disabled, so the user cannot select it. */
const HEADING = '#heading:';

/**
 * Returns the options of the list of agents that get a note. A disabled heading starts each group, because the list
 * has no groups.
 */
function targetSelectOptions(targets: readonly NoteTargetOption[]): SelectOption[] {
    const group = (kind: NoteTargetOption['target']['kind'], label: string): SelectOption[] => {
        const items = targets.filter(option => option.target.kind === kind).map(option => ({ value: option.key, label: option.label }));
        return items.length ? [{ value: `${HEADING}${kind}`, label, disabled: true }, ...items] : [];
    };
    return [...group('session', 'Running in this worktree'), ...group('new', 'Start a new agent')];
}

export function ComposerZone({
    line,
    startLine = line,
    onAdd,
    onAsk,
    onSuggest,
    note,
    onSendToAgent,
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
    /**
     * Sends the text to the agent of the view, with no list of agents. It adds the "Send to agent" mode when `note`
     * is not set. The pull request diff uses it.
     */
    onSendToAgent?(text: string): void;
    onCancel(): void;
    canComment?: boolean;
    /** The mode when the box opens. */
    initialMode?: ComposerMode;
}) {
    const modes = composerModes(canComment, !!onAsk, !!note || !!onSendToAgent);
    const [text, setText] = useState('');
    const [mode, setMode] = useState<ComposerMode>(initialMode ?? modes[0] ?? 'ask');
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
    const submit = () => {
        const value = text.trim();
        if (!value) return;
        if (mode === 'ask') onAsk?.(value);
        else if (mode === 'note') {
            if (note) {
                if (target) note.onSend(value, target.target);
            } else onSendToAgent?.(value);
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
        <Card tone={mode === 'comment' ? 'accent' : 'info'} className="zone-card composer">
            <CardBody>
                {modes.length > 1 && (
                    <ButtonGroup size="sm" className="composer-mode" role="radiogroup" label="Kind of note" onKeyDown={radioGroupKeys}>
                        {modes.map(item => (
                            <Button key={item} role="radio" aria-checked={mode === item} onClick={() => setMode(item)}>
                                {MODE_LABELS[item]}
                            </Button>
                        ))}
                    </ButtonGroup>
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
                        <Button
                            className="composer-suggest"
                            icon={<FileDiff size={14} strokeWidth={1.6} />}
                            title={`Add a suggested change for ${lines}`}
                            onClick={suggest}
                        >
                            Suggest a change
                        </Button>
                    )}
                    {mode === 'note' && note && (
                        // Monaco must not handle the keys of the select. The wrapper stops them.
                        <span className="composer-target-keys" onKeyDown={event => event.stopPropagation()}>
                            <Select
                                className="composer-target"
                                aria-label="Agent that gets the note"
                                title="The agent that gets the note"
                                value={target?.key ?? ''}
                                options={targetSelectOptions(targets)}
                                onChange={setTargetKey}
                            />
                        </span>
                    )}
                    <Button onClick={onCancel}>Cancel</Button>
                    <Button variant="primary" disabled={!text.trim() || (mode === 'note' && !!note && !target)} onClick={submit}>
                        {submitLabel}
                    </Button>
                </div>
            </CardBody>
        </Card>
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
            <Card tone="info" className="zone-card agent-question collapsed">
                <button className="agent-question-toggle" title="Show the answer" onClick={() => onAction('toggle')}>
                    <ChevronRight size={13} strokeWidth={1.8} />
                    <Bot size={12} strokeWidth={1.6} />
                    <span className="agent-question-summary">{question.question}</span>
                    {question.answeredAt && <span className="agent-question-time">{timeAgo(new Date(question.answeredAt).toISOString())}</span>}
                </button>
            </Card>
        );
    }
    const outdated = answerOutdated(question, headRefOid);
    return (
        <Card tone="info" className="zone-card agent-question">
            <CardBody>
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
                    <div className="agent-question-outdated">
                        The agent answered on commit {question.commit?.slice(0, 7)}. The pull request changed after that.
                    </div>
                )}
                {question.status === 'error' && <div className="form-error">{question.error}</div>}
                <div className="thread-actions">
                    {question.status === 'running' ? (
                        <Button variant="link" onClick={() => onAction('cancel')}>
                            Cancel
                        </Button>
                    ) : done ? (
                        <>
                            {canComment && (
                                <Button variant="link" onClick={() => onAction('comment')}>
                                    Use as a pending comment
                                </Button>
                            )}
                            <Button variant="link" onClick={() => onAction('toggle')}>
                                Hide
                            </Button>
                            <Button variant="link-danger" onClick={() => onAction('delete')}>
                                Delete
                            </Button>
                        </>
                    ) : (
                        <>
                            {question.status === 'error' && (
                                <Button variant="link" onClick={() => onAction('retry')}>
                                    Try again
                                </Button>
                            )}
                            <Button variant="link" onClick={() => onAction('close')}>
                                Close
                            </Button>
                        </>
                    )}
                </div>
            </CardBody>
        </Card>
    );
}
