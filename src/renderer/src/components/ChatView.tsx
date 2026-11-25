import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { ArrowUp, CircleAlert, CircleCheck, LoaderCircle, MessagesSquare, Square, SquareTerminal, X } from 'lucide-react';
import { CHAT_AGENT_NAMES, type ChatItem, type ChatToolItem, chatFormatOf } from '@shared/agent-chat';
import { isImageOnlyPaste } from '@shared/shortcuts';
import { insertDictatedText } from '@shared/dictation';
import type { TerminalSession } from '@shared/terminal';
import { showsAgentDialog } from '@shared/agent-text';
import { formatDuration } from '../util';
import { screenTextOf } from '../app/use-agent-actions';
import { agentViewStore } from '../terminal/agent-view-store';
import { useTranscript } from '../terminal/transcript-store';
import {
    addChatImage,
    clearChatError,
    queueChatPrompt,
    removeChatImage,
    removeQueuedPrompt,
    sendChatPrompt,
    sendQueue,
    sendQueuedPromptNow,
    setChatDraft,
    settleSentPrompts,
    useChatInput
} from '../terminal/chat-input-store';
import { useDomFind } from './dom-find';
import { cx } from './ui/cx';
import { Button, IconButton } from './ui';
import { EmptyState } from './EmptyState';
import { Markdown } from './Markdown';
import { DictationBar, DictationButton } from '../dictation/Dictation';
import { dictationStore } from '../dictation/dictation-store';

const api = window.shipwarden;

/** After this time in the state "starting", the chat tells the user that the terminal can show a problem. */
const SLOW_START_MS = 20_000;

/** How often the chat checks the screen for a question while the agent starts. */
const START_CHECK_MS = 700;

/** The chat stays at the bottom when the user is this close to the bottom (pixels). */
const STICK_DISTANCE = 48;

interface Props {
    /** An agent tab with a transcript (see `canShowChat`). */
    session: TerminalSession;
    /** False for a pane of a split view without the focus. */
    focused?: boolean;
}

/** One tool call: the summary, and the input and the result when the user opens it. */
function ToolRow({ item }: { item: ChatToolItem }) {
    const open = item.detail !== undefined || item.result !== undefined;
    const icon =
        item.status === 'running' ? (
            <LoaderCircle size={12} strokeWidth={2} className="spin" aria-label="Running" />
        ) : (
            <span className={cx('chat-tool-dot', item.status)} role="img" aria-label={item.status === 'error' ? 'Failed' : 'Done'} />
        );
    if (!open) {
        return (
            <div className="chat-tool">
                <div className="chat-tool-summary">
                    {icon}
                    <span className="chat-tool-text">{item.summary}</span>
                </div>
            </div>
        );
    }
    return (
        <details className="chat-tool">
            <summary className="chat-tool-summary">
                {icon}
                <span className="chat-tool-text">{item.summary}</span>
            </summary>
            {item.detail && <pre className="chat-tool-detail">{item.detail}</pre>}
            {item.result && <pre className={cx('chat-tool-result', item.status === 'error' && 'error')}>{item.result}</pre>}
        </details>
    );
}

/**
 * Returns true while the agent screen shows a question at the start, for example the folder trust question of
 * Claude Code. Such a question comes before the first hook, so the chat reads the screen while the agent starts.
 */
function useStartQuestion(sessionId: string, starting: boolean): boolean {
    const [question, setQuestion] = useState(false);
    useEffect(() => {
        setQuestion(false);
        if (!starting) return;
        let current = true;
        const check = async () => {
            const screen = await screenTextOf(sessionId);
            if (current) setQuestion(screen !== undefined && showsAgentDialog(screen));
        };
        void check();
        const timer = setInterval(() => void check(), START_CHECK_MS);
        return () => {
            current = false;
            clearInterval(timer);
        };
    }, [sessionId, starting]);
    return question;
}

/** A prompt of the user: its images, then its text. */
function UserBubble({ text, images }: { text: string; images?: readonly string[] }) {
    return (
        <div className="chat-bubble">
            {images && images.length > 0 && (
                <div className="chat-bubble-images">
                    {images.map((url, index) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: Two images of a prompt can be the same, and the order does not change.
                        <img key={index} className="chat-image" src={url} alt={`Attachment ${index + 1} of the prompt`} />
                    ))}
                </div>
            )}
            {text}
        </div>
    );
}

/** Puts the tool calls that follow each other into one group, so the text of the agent is easy to find. */
function groupItems(items: readonly ChatItem[]): (ChatItem | ChatToolItem[])[] {
    const groups: (ChatItem | ChatToolItem[])[] = [];
    for (const item of items) {
        const last = groups[groups.length - 1];
        if (item.kind === 'tool' && Array.isArray(last)) last.push(item);
        else groups.push(item.kind === 'tool' ? [item] : item);
    }
    return groups;
}

/**
 * Returns the text of the "done" line after the last answer of the agent, for example "Done in 2m 31s".
 * `endedAt` is the time of the idle state (milliseconds). The turn starts at the last prompt of the user.
 * Returns undefined when the last item is a prompt, because the agent did not answer it yet.
 */
function doneText(items: readonly ChatItem[], endedAt?: number): string | undefined {
    const last = items[items.length - 1];
    if (!last || last.kind === 'user') return undefined;
    const prompt = items.findLast(item => item.kind === 'user');
    if (!prompt?.at || !endedAt || endedAt < prompt.at) return 'Done';
    return `Done in ${formatDuration(new Date(prompt.at).toISOString(), new Date(endedAt).toISOString())}`;
}

/**
 * Shows an agent tab as a chat. The chat comes from the transcript of the agent (a Claude Code transcript or a Codex
 * session file). The agent still runs in its terminal: a prompt from the chat goes to the terminal, and the user can
 * show the terminal at any time.
 */
export function ChatView({ session, focused = true }: Props) {
    const file = session.agentTranscript ?? '';
    // A tab without a transcript is a Claude Code tab that is starting (see `canShowChat`).
    const agentName = CHAT_AGENT_NAMES[chatFormatOf(file) ?? 'claude'];
    const state = session.agentState;
    const starting = state === 'starting';
    const working = state === 'working';
    const startQuestion = useStartQuestion(session.id, starting);
    const [slowStart, setSlowStart] = useState(false);
    /** The agent waits for an answer that the chat cannot give: a permission, or a question at the start. */
    const waiting = state === 'waiting' || startQuestion;
    /** The agent can take a prompt now. While it starts or works, a new prompt goes in the queue. */
    const ready = !waiting && !starting && !working;
    /**
     * The prompt box: the text, the pasted images, the queue, and the sent prompts. The store keeps them when the
     * chat closes. The previews use data URLs, because the content security policy of the page blocks blob URLs.
     */
    const input = useChatInput(session.id);
    const { draft, images, queue, sent, sending } = input;
    const pending = sent.length > 0;
    const transcript = useTranscript(file, working || starting || waiting || pending, `${state}:${session.agentStateAt ?? 0}`);
    const listRef = useRef<HTMLDivElement>(null);
    const findBar = useDomFind(listRef, 'Find in the chat');
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const stick = useRef(true);

    // The terminal was shown only for an answer. The chat now shows, so the tab uses the default view again.
    useEffect(() => {
        if (agentViewStore.getSnapshot().get(session.id) === 'answer') agentViewStore.set(session.id, undefined);
    }, [session.id]);

    // A start that takes long can be an error, for example a command that is not found. The terminal shows it.
    useEffect(() => {
        setSlowStart(false);
        if (!starting) return;
        const timer = setTimeout(() => setSlowStart(true), SLOW_START_MS);
        return () => clearTimeout(timer);
    }, [starting]);

    // A sent prompt shows as pending until the transcript has a user prompt with its text.
    const userTexts = useMemo(() => transcript.items.flatMap(item => (item.kind === 'user' ? [item.text] : [])), [transcript.items]);
    useEffect(() => {
        settleSentPrompts(session.id, userTexts);
    }, [session.id, userTexts]);

    // The queue sends its prompts when the agent ends its turn. The store does this too, but it can miss a state that
    // the session had before the chat opened.
    useEffect(() => {
        if (ready && queue.length > 0 && !sending) void sendQueue(session.id, file);
    }, [ready, queue.length, sending, session.id, file]);

    // The chat stays at the bottom while the user does not scroll up.
    // biome-ignore lint/correctness/useExhaustiveDependencies: A new item, a pending prompt, or a state change can make the list longer.
    useLayoutEffect(() => {
        const list = listRef.current;
        if (list && stick.current) list.scrollTop = list.scrollHeight;
    }, [transcript.items, sent, state, session.agentMessage]);

    useEffect(() => {
        if (focused && !waiting) inputRef.current?.focus();
    }, [focused, waiting]);

    // The final text of a dictation goes to the cursor of the text field. A disabled field also takes it, so the text
    // does not go to the terminal while the agent waits for an answer there.
    useEffect(
        () =>
            dictationStore.registerInput(session.id, text => {
                const input = inputRef.current;
                if (!input) return false;
                const next = insertDictatedText(input.value, input.selectionStart, input.selectionEnd, text);
                setChatDraft(session.id, next.value);
                requestAnimationFrame(() => {
                    if (input.disabled) return;
                    input.focus();
                    input.setSelectionRange(next.cursor, next.cursor);
                });
                return true;
            }),
        [session.id]
    );

    // The text field grows with its text, up to the maximum height in the CSS.
    // biome-ignore lint/correctness/useExhaustiveDependencies: The height depends on the text.
    useLayoutEffect(() => {
        const input = inputRef.current;
        if (!input) return;
        input.style.height = 'auto';
        input.style.height = `${input.scrollHeight}px`;
    }, [draft]);

    /**
     * Sends the prompt of the box. While the agent starts or works, the prompt goes in the queue, and the queue sends
     * it when the agent ends its turn.
     */
    const send = () => {
        if ((!draft.trim() && images.length === 0) || waiting) return;
        stick.current = true;
        if (ready && queue.length === 0 && !sending) void sendChatPrompt(session.id, agentName, file);
        else queueChatPrompt(session.id, agentName);
    };

    /** A paste of only an image adds the image to the next prompt. A paste with text pastes the text in the field. */
    const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
        const data = event.clipboardData;
        if (!isImageOnlyPaste([...data.types], data.getData('text/plain'))) return;
        event.preventDefault();
        const file = [...data.files].find(item => item.type.startsWith('image/'));
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            if (typeof reader.result === 'string') addChatImage(session.id, reader.result);
        };
        reader.readAsDataURL(file);
    };

    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            send();
        }
    };

    // Claude Code and Codex stop the turn at the Escape key.
    const stop = () => api.terminals.write(session.id, '\x1b');

    const groups = groupItems(transcript.items);
    const empty = !transcript.loading && transcript.items.length === 0 && !pending;
    const sendError = input.error;
    // Codex stays "done" after a turn. Claude Code changes from "done" to "idle" after a time.
    const done = (state === 'idle' || state === 'done') && !pending ? doneText(transcript.items, session.agentStateAt) : undefined;

    return (
        <div className="chat-view" data-dictation-session={session.id}>
            {findBar}
            <div
                className="chat-list"
                ref={listRef}
                onScroll={event => {
                    const list = event.currentTarget;
                    stick.current = list.scrollHeight - list.scrollTop - list.clientHeight < STICK_DISTANCE;
                }}
            >
                {empty && starting ? (
                    <EmptyState icon={LoaderCircle} title={`Starting ${agentName}`}>
                        You can write a prompt now. It goes to the agent when the agent is ready.
                    </EmptyState>
                ) : empty ? (
                    <EmptyState icon={MessagesSquare} title="No messages yet">
                        Write a prompt below. The agent answers here.
                    </EmptyState>
                ) : (
                    <div className="chat-column">
                        {transcript.truncated && <p className="chat-note">The chat shows the newest part of a long session. The terminal has all of it.</p>}
                        {transcript.error && <p className="chat-note error">{transcript.error}</p>}
                        {groups.map(group =>
                            Array.isArray(group) ? (
                                <div className="chat-tools" key={group[0].id}>
                                    {group.map(item => (
                                        <ToolRow key={item.id} item={item} />
                                    ))}
                                </div>
                            ) : group.kind === 'user' ? (
                                <div className="chat-user" key={group.id}>
                                    <UserBubble text={group.text} images={group.images} />
                                </div>
                            ) : (
                                <Markdown key={group.id} className="chat-agent" text={group.kind === 'agent' ? group.text : ''} />
                            )
                        )}
                        {sent.map(prompt => (
                            <div className="chat-user pending" key={prompt.id}>
                                <UserBubble text={prompt.text} images={prompt.images} />
                            </div>
                        ))}
                        {done && (
                            <div className="chat-status done" role="status">
                                <CircleCheck size={13} strokeWidth={2} className="chat-done-icon" aria-hidden="true" />
                                <span>{done}</span>
                            </div>
                        )}
                        {working && (
                            <div className="chat-status" role="status">
                                <LoaderCircle size={13} strokeWidth={2} className="spin" aria-hidden="true" />
                                <span>{session.agentMessage ?? 'Working'}…</span>
                            </div>
                        )}
                    </div>
                )}
            </div>
            {waiting && (
                <div className="chat-waiting" role="alert">
                    <CircleAlert size={14} strokeWidth={1.8} className="chat-waiting-icon" />
                    <span className="chat-waiting-text">
                        {startQuestion ? `${agentName} is asking a question before it starts.` : (session.agentMessage ?? 'The agent needs your input.')}
                    </span>
                    <Button
                        size="sm"
                        variant="primary"
                        icon={<SquareTerminal size={13} strokeWidth={1.8} />}
                        onClick={() => agentViewStore.set(session.id, 'answer')}
                    >
                        Answer
                    </Button>
                </div>
            )}
            {starting && slowStart && !waiting && (
                <div className="chat-waiting" role="status">
                    <CircleAlert size={14} strokeWidth={1.8} className="chat-waiting-icon" />
                    <span className="chat-waiting-text">{agentName} did not start yet. The terminal can show the cause.</span>
                    <Button size="sm" icon={<SquareTerminal size={13} strokeWidth={1.8} />} onClick={() => agentViewStore.set(session.id, 'terminal')}>
                        Show terminal
                    </Button>
                </div>
            )}
            {sendError && (
                <div className="chat-waiting error" role="alert">
                    <CircleAlert size={14} strokeWidth={1.8} className="chat-waiting-icon" />
                    <span className="chat-waiting-text">{sendError}</span>
                    <IconButton icon={<X size={14} strokeWidth={1.8} />} label="Close the message" onClick={() => clearChatError(session.id)} />
                </div>
            )}
            <DictationBar sessionId={session.id} />
            <form
                className="chat-composer"
                onSubmit={event => {
                    event.preventDefault();
                    send();
                }}
            >
                {queue.length > 0 && (
                    // biome-ignore lint/a11y/noRedundantRoles: Safari removes the list role when the list has no bullets.
                    <ul className="chat-queue" role="list" aria-label="Queued prompts">
                        {queue.map(prompt => (
                            <li key={prompt.id} className="chat-queued">
                                <span className="chat-queued-text">
                                    {prompt.text || pluralImages(prompt.images.length)}
                                    {prompt.text && prompt.images.length > 0 && ` · ${pluralImages(prompt.images.length)}`}
                                </span>
                                <Button size="sm" disabled={waiting} onClick={() => void sendQueuedPromptNow(session.id, prompt.id, file)}>
                                    Send now
                                </Button>
                                <IconButton
                                    size="sm"
                                    icon={<X size={13} strokeWidth={1.8} />}
                                    label="Remove the queued prompt"
                                    onClick={() => removeQueuedPrompt(session.id, prompt.id)}
                                />
                            </li>
                        ))}
                    </ul>
                )}
                {images.length > 0 && (
                    <div className="chat-attachments">
                        {images.map((url, index) => (
                            // biome-ignore lint/suspicious/noArrayIndexKey: The user can paste the same image two times. The index is the identity of a preview.
                            <div key={index} className="chat-attachment">
                                <img src={url} alt={`Pasted attachment ${index + 1}`} />
                                <button
                                    type="button"
                                    className="chat-attachment-remove"
                                    title="Remove"
                                    aria-label={`Remove pasted attachment ${index + 1}`}
                                    disabled={sending}
                                    onClick={() => removeChatImage(session.id, index)}
                                >
                                    <X size={11} strokeWidth={2.4} />
                                </button>
                            </div>
                        ))}
                    </div>
                )}
                <textarea
                    ref={inputRef}
                    className="chat-input"
                    rows={1}
                    value={draft}
                    disabled={waiting}
                    placeholder={
                        waiting
                            ? 'Answer the agent in the terminal first.'
                            : starting || working
                              ? 'Write a prompt. It waits in the queue until the agent is ready.'
                              : 'Write a prompt. Press Shift+Enter for a new line.'
                    }
                    aria-label="Prompt"
                    onChange={event => setChatDraft(session.id, event.target.value)}
                    onKeyDown={onKeyDown}
                    onPaste={onPaste}
                />
                <div className="chat-composer-actions">
                    <IconButton
                        icon={<SquareTerminal size={14} strokeWidth={1.6} />}
                        label="Show the terminal"
                        onClick={() => agentViewStore.set(session.id, 'terminal')}
                    />
                    {working && <IconButton icon={<Square size={12} strokeWidth={2} />} label="Stop the agent (Escape in the terminal)" onClick={stop} />}
                    <DictationButton sessionId={session.id} />
                    <IconButton
                        type="submit"
                        variant="outline"
                        icon={<ArrowUp size={14} strokeWidth={2} />}
                        label={ready && queue.length === 0 ? 'Send' : 'Add to the queue'}
                        disabled={(!draft.trim() && images.length === 0) || waiting}
                    />
                </div>
            </form>
        </div>
    );
}

function pluralImages(count: number): string {
    return count === 1 ? '1 image' : `${count} images`;
}
