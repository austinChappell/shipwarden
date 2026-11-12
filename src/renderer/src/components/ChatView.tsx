import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { ArrowUp, CircleAlert, LoaderCircle, MessagesSquare, Square, SquareTerminal, X } from 'lucide-react';
import type { ChatItem, ChatToolItem } from '@shared/agent-chat';
import { isImageOnlyPaste } from '@shared/shortcuts';
import type { TerminalSession } from '@shared/terminal';
import { bracketedPaste, countImageMarks, showsAgentDialog } from '../app/agent-text';
import { errorText } from '../util';
import { screenTextOf } from '../app/use-agent-actions';
import { agentViewStore } from '../terminal/agent-view-store';
import { useTranscript } from '../terminal/transcript-store';
import { cx } from './ui/cx';
import { Button, IconButton } from './ui';
import { EmptyState } from './EmptyState';
import { Markdown } from './Markdown';

const api = window.shipwarden;

/** The time between the paste of a prompt and the Enter key. The agent must get the paste first. */
const SUBMIT_DELAY_MS = 200;

/** The maximum time that Claude Code can take to read an image from the clipboard and show its mark. */
const IMAGE_READ_TIMEOUT_MS = 5000;

/** How often the chat checks the screen for the mark of a new image. */
const IMAGE_CHECK_MS = 150;

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Gives an image to Claude Code: the image goes on the clipboard, and Ctrl+V makes Claude Code read it. Returns when
 * Claude Code shows the mark of the image ("[Image #1]") in its prompt. Throws an error when the mark does not come.
 */
async function giveImage(sessionId: string, dataUrl: string): Promise<void> {
    const marks = async () => countImageMarks((await screenTextOf(sessionId)) ?? '');
    const before = await marks();
    await api.terminals.pasteImage(sessionId, dataUrl);
    const deadline = Date.now() + IMAGE_READ_TIMEOUT_MS;
    while (Date.now() < deadline) {
        await delay(IMAGE_CHECK_MS);
        if ((await marks()) > before) return;
    }
    throw new Error('Claude Code did not take the image.');
}

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
 * Shows an agent tab as a chat. The chat comes from the Claude Code transcript. The agent still runs in its terminal:
 * a prompt from the chat goes to the terminal, and the user can show the terminal at any time.
 */
export function ChatView({ session, focused = true }: Props) {
    const file = session.agentTranscript ?? '';
    const state = session.agentState;
    const starting = state === 'starting';
    const working = state === 'working';
    const startQuestion = useStartQuestion(session.id, starting);
    const [slowStart, setSlowStart] = useState(false);
    /** The agent waits for an answer that the chat cannot give: a permission, or a question at the start. */
    const waiting = state === 'waiting' || startQuestion;
    /** The agent cannot take a prompt now. */
    const blocked = waiting || starting;
    const [pending, setPending] = useState<{ text: string; images: string[]; users: number }>();
    /**
     * The images that the user pasted for the next prompt, as data URLs. Claude Code gets them when the user sends the
     * prompt, so the user can remove an image before that. The previews use data URLs, because the content security
     * policy of the page blocks blob URLs.
     */
    const [images, setImages] = useState<string[]>([]);
    /** True while the chat gives the prompt and its images to the agent. */
    const [sending, setSending] = useState(false);
    const [sendError, setSendError] = useState<string>();
    const transcript = useTranscript(file, working || starting || waiting || !!pending, `${state}:${session.agentStateAt ?? 0}`);
    const [draft, setDraft] = useState('');
    const listRef = useRef<HTMLDivElement>(null);
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

    const userCount = transcript.items.filter(item => item.kind === 'user').length;
    // The prompt shows as pending until the transcript has it.
    useEffect(() => {
        if (pending && userCount > pending.users) setPending(undefined);
    }, [pending, userCount]);

    // The chat stays at the bottom while the user does not scroll up.
    // biome-ignore lint/correctness/useExhaustiveDependencies: A new item, a pending prompt, or a state change can make the list longer.
    useLayoutEffect(() => {
        const list = listRef.current;
        if (list && stick.current) list.scrollTop = list.scrollHeight;
    }, [transcript.items, pending, state, session.agentMessage]);

    useEffect(() => {
        if (focused && !waiting) inputRef.current?.focus();
    }, [focused, waiting]);

    // The text field grows with its text, up to the maximum height in the CSS.
    // biome-ignore lint/correctness/useExhaustiveDependencies: The height depends on the text.
    useLayoutEffect(() => {
        const input = inputRef.current;
        if (!input) return;
        input.style.height = 'auto';
        input.style.height = `${input.scrollHeight}px`;
    }, [draft]);

    /** Gives the images to the agent one after the other, then the text, then Enter. */
    const send = async () => {
        const text = draft.trim();
        if ((!text && images.length === 0) || blocked || sending) return;
        const id = session.id;
        const sent = images;
        setSending(true);
        setSendError(undefined);
        setPending({ text, images: sent, users: userCount });
        setImages([]);
        setDraft('');
        stick.current = true;
        try {
            for (const image of sent) await giveImage(id, image);
            if (text) {
                api.terminals.write(id, bracketedPaste(text));
                await delay(SUBMIT_DELAY_MS);
            }
            api.terminals.write(id, '\r');
        } catch (err) {
            // The prompt of Claude Code can have some of the images now. The terminal shows them.
            setPending(undefined);
            setImages(sent);
            setDraft(current => current || text);
            setSendError(
                `${errorText(err)} The prompt did not go to the agent. The prompt in the terminal can have some of the images. Remove them there, or try again.`
            );
        } finally {
            setSending(false);
        }
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
            if (typeof reader.result === 'string') setImages(current => [...current, reader.result as string]);
        };
        reader.readAsDataURL(file);
    };

    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void send();
        }
    };

    // Claude Code stops its turn at the Escape key.
    const stop = () => api.terminals.write(session.id, '\x1b');

    const groups = groupItems(transcript.items);
    const empty = !transcript.loading && transcript.items.length === 0 && !pending;

    return (
        <div className="chat-view">
            <div
                className="chat-list"
                ref={listRef}
                onScroll={event => {
                    const list = event.currentTarget;
                    stick.current = list.scrollHeight - list.scrollTop - list.clientHeight < STICK_DISTANCE;
                }}
            >
                {empty && starting ? (
                    <EmptyState icon={LoaderCircle} title="Starting Claude Code">
                        You can write a prompt now. You can send it when the agent is ready.
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
                        {pending && (
                            <div className="chat-user pending">
                                <UserBubble text={pending.text} images={pending.images} />
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
                        {startQuestion ? 'Claude Code asks a question before it starts.' : (session.agentMessage ?? 'The agent needs your input.')}
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
                    <span className="chat-waiting-text">Claude Code did not start yet. The terminal can show the cause.</span>
                    <Button size="sm" icon={<SquareTerminal size={13} strokeWidth={1.8} />} onClick={() => agentViewStore.set(session.id, 'terminal')}>
                        Show terminal
                    </Button>
                </div>
            )}
            {sendError && (
                <div className="chat-waiting error" role="alert">
                    <CircleAlert size={14} strokeWidth={1.8} className="chat-waiting-icon" />
                    <span className="chat-waiting-text">{sendError}</span>
                    <IconButton icon={<X size={14} strokeWidth={1.8} />} label="Close the message" onClick={() => setSendError(undefined)} />
                </div>
            )}
            <form
                className="chat-composer"
                onSubmit={event => {
                    event.preventDefault();
                    void send();
                }}
            >
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
                                    onClick={() => setImages(current => current.filter((_, item) => item !== index))}
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
                            : starting
                              ? 'Claude Code is starting…'
                              : 'Write a prompt. Press Shift+Enter for a new line.'
                    }
                    aria-label="Prompt"
                    onChange={event => setDraft(event.target.value)}
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
                    <IconButton
                        type="submit"
                        variant="outline"
                        icon={<ArrowUp size={14} strokeWidth={2} />}
                        label="Send"
                        disabled={(!draft.trim() && images.length === 0) || blocked || sending}
                    />
                </div>
            </form>
        </div>
    );
}
