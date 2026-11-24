import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { ArrowUp, CircleAlert, CircleCheck, FileText, LoaderCircle, MessagesSquare, Paperclip, Square, SquareTerminal, X } from 'lucide-react';
import { CHAT_AGENT_NAMES, type ChatItem, type ChatToolItem, chatFormatOf } from '@shared/agent-chat';
import { isImageOnlyPaste } from '@shared/shortcuts';
import { insertDictatedText } from '@shared/dictation';
import { attachmentKindOf, type ConvertedDocument, documentPrompt, MAX_DOCUMENTS, truncationNote, unsupportedFileText } from '@shared/documents';
import type { TerminalSession } from '@shared/terminal';
import { bracketedPaste, countImageMarks, showsAgentDialog } from '@shared/agent-text';
import { errorText, formatDuration } from '../util';
import { screenTextOf } from '../app/use-agent-actions';
import { agentViewStore } from '../terminal/agent-view-store';
import { useTranscript } from '../terminal/transcript-store';
import { useDomFind } from './dom-find';
import { cx } from './ui/cx';
import { Button, IconButton } from './ui';
import { EmptyState } from './EmptyState';
import { Markdown } from './Markdown';
import { DictationBar, DictationButton } from '../dictation/Dictation';
import { dictationStore } from '../dictation/dictation-store';

const api = window.shipwarden;

/** The time between the paste of a prompt and the Enter key. The agent must get the paste first. */
const SUBMIT_DELAY_MS = 200;

/** The maximum time that the agent can take to read an image from the clipboard and show its mark. */
const IMAGE_READ_TIMEOUT_MS = 5000;

/** How often the chat checks the screen for the mark of a new image. */
const IMAGE_CHECK_MS = 150;

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Gives an image to the agent: the image goes on the clipboard, and Ctrl+V makes the agent read it. Returns when the
 * agent shows the mark of the image ("[Image #1]") in its prompt. Claude Code and Codex show the same mark. Throws an
 * error when the mark does not come. `agent` is the agent name for the error.
 */
async function giveImage(sessionId: string, dataUrl: string, agent: string): Promise<void> {
    const marks = async () => countImageMarks((await screenTextOf(sessionId)) ?? '');
    const before = await marks();
    await api.terminals.pasteImage(sessionId, dataUrl);
    const deadline = Date.now() + IMAGE_READ_TIMEOUT_MS;
    while (Date.now() < deadline) {
        await delay(IMAGE_CHECK_MS);
        if ((await marks()) > before) return;
    }
    throw new Error(`${agent} did not take the image.`);
}

/** A document in the composer: converting, or ready for the next prompt. */
interface AttachedDocument {
    id: string;
    name: string;
    /** Undefined while the main process converts the file. */
    document?: ConvertedDocument;
}

/** A file that the user dropped, pasted, or chose. `file` is set for a dropped or pasted file. */
interface IncomingFile {
    name: string;
    /** The absolute path. It is empty for a pasted file without a path, for example an image from a web page. */
    path: string;
    file?: File;
}

/** Reads a browser file as a data URL. */
function readDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => (typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('ShipWarden cannot read the image.')));
        reader.onerror = () => reject(new Error('ShipWarden cannot read the image.'));
        reader.readAsDataURL(file);
    });
}

/** Returns the files of a drop or a paste, with their paths. */
function incomingFiles(files: FileList): IncomingFile[] {
    return [...files].map(file => ({ name: file.name, path: api.files.pathForFile(file), file }));
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
    /** The agent cannot take a prompt now. */
    const blocked = waiting || starting;
    const [pending, setPending] = useState<{ text: string; images: string[]; users: number }>();
    /**
     * The images that the user pasted for the next prompt, as data URLs. The agent gets them when the user sends the
     * prompt, so the user can remove an image before that. The previews use data URLs, because the content security
     * policy of the page blocks blob URLs.
     */
    const [images, setImages] = useState<string[]>([]);
    /** The documents for the next prompt. The agent gets the path of the text file of each document. */
    const [documents, setDocuments] = useState<AttachedDocument[]>([]);
    /** The error of the last attachment, for example a file type that the chat cannot attach. */
    const [attachError, setAttachError] = useState<string>();
    /** True while the user drags files over the chat. */
    const [dragging, setDragging] = useState(false);
    /** True while the chat gives the prompt and its images to the agent. */
    const [sending, setSending] = useState(false);
    const [sendError, setSendError] = useState<string>();
    const transcript = useTranscript(file, working || starting || waiting || !!pending, `${state}:${session.agentStateAt ?? 0}`);
    const [draft, setDraft] = useState('');
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

    // The final text of a dictation goes to the cursor of the text field. A disabled field also takes it, so the text
    // does not go to the terminal while the agent waits for an answer there.
    useEffect(
        () =>
            dictationStore.registerInput(session.id, text => {
                const input = inputRef.current;
                if (!input) return false;
                const next = insertDictatedText(input.value, input.selectionStart, input.selectionEnd, text);
                setDraft(next.value);
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

    const converting = documents.some(item => !item.document);
    const readyDocuments = documents.flatMap(item => (item.document ? [item.document] : []));
    const canSend = (draft.trim() !== '' || images.length > 0 || readyDocuments.length > 0) && !blocked && !sending && !converting;

    /**
     * Gives the images to the agent one after the other, then the text, then Enter. The page images of a PDF without
     * text go with the images. The text starts with the list of the documents (see `documentPrompt`).
     */
    const send = async () => {
        if (!canSend) return;
        const text = draft.trim();
        const id = session.id;
        const sentImages = images;
        const sentDocuments = documents;
        const sent = [...sentImages, ...readyDocuments.flatMap(item => (item.kind === 'images' ? item.images : []))];
        const prompt = documentPrompt(readyDocuments, text);
        setSending(true);
        setSendError(undefined);
        setAttachError(undefined);
        setPending({ text: prompt, images: sent, users: userCount });
        setImages([]);
        setDocuments([]);
        setDraft('');
        stick.current = true;
        try {
            for (const image of sent) await giveImage(id, image, agentName);
            if (prompt) {
                api.terminals.write(id, bracketedPaste(prompt));
                await delay(SUBMIT_DELAY_MS);
            }
            api.terminals.write(id, '\r');
        } catch (err) {
            // The prompt of the agent can have some of the images now. The terminal shows them.
            setPending(undefined);
            setImages(sentImages);
            setDocuments(sentDocuments);
            setDraft(current => current || text);
            setSendError(
                `${errorText(err)} The prompt did not go to the agent. The prompt in the terminal can have some of the images. Remove them there, or try again.`
            );
        } finally {
            setSending(false);
        }
    };

    /** Converts one document and shows it as a chip. A failure removes the chip and shows the error. */
    const attachDocument = async (name: string, path: string) => {
        if (!path) {
            setAttachError(`ShipWarden cannot find the file "${name}" on the Mac. Save the file, then attach it again.`);
            return;
        }
        const id = crypto.randomUUID();
        setDocuments(current => [...current, { id, name }]);
        try {
            const result = await api.documents.convert(path);
            if (result.ok) setDocuments(current => current.map(item => (item.id === id ? { ...item, document: result.document } : item)));
            else {
                setDocuments(current => current.filter(item => item.id !== id));
                setAttachError(result.error);
            }
        } catch (err) {
            setDocuments(current => current.filter(item => item.id !== id));
            setAttachError(errorText(err));
        }
    };

    /** Adds dropped, pasted, or chosen files to the next prompt: images as images, and documents as text files. */
    const attachFiles = async (files: readonly IncomingFile[]) => {
        setAttachError(undefined);
        let room = MAX_DOCUMENTS - documents.length;
        for (const incoming of files) {
            const kind = attachmentKindOf(incoming.name, incoming.file?.type);
            if (kind === 'unsupported') {
                setAttachError(unsupportedFileText(incoming.name));
            } else if (kind === 'document') {
                if (room <= 0) {
                    setAttachError(`A prompt can have ${MAX_DOCUMENTS} documents. Send the prompt, then attach more documents.`);
                    continue;
                }
                room -= 1;
                void attachDocument(incoming.name, incoming.path);
            } else {
                try {
                    const url = incoming.file ? await readDataUrl(incoming.file) : await api.documents.readImage(incoming.path);
                    setImages(current => [...current, url]);
                } catch (err) {
                    setAttachError(errorText(err));
                }
            }
        }
    };

    const chooseFiles = async () => {
        const paths = await api.documents.choose();
        await attachFiles(paths.map(path => ({ name: path.slice(path.lastIndexOf('/') + 1), path })));
    };

    /**
     * A paste of only files adds them to the next prompt: an image as an image, and a document as a text file. A paste
     * with text pastes the text in the field.
     */
    const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
        const data = event.clipboardData;
        if (!isImageOnlyPaste([...data.types], data.getData('text/plain'))) return;
        event.preventDefault();
        const files = incomingFiles(data.files);
        // A copied file from Finder has a path. A pasted image from a web page or a screenshot has none.
        const withPath = files.filter(item => item.path);
        if (withPath.length > 0) {
            void attachFiles(withPath);
            return;
        }
        const image = files.find(item => item.file?.type.startsWith('image/'));
        if (image) void attachFiles([image]);
    };

    const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes('Files');

    const onDragOver = (event: DragEvent<HTMLDivElement>) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'copy';
        setDragging(true);
    };

    const onDrop = (event: DragEvent<HTMLDivElement>) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.stopPropagation();
        setDragging(false);
        void attachFiles(incomingFiles(event.dataTransfer.files));
    };

    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void send();
        }
    };

    // Claude Code and Codex stop the turn at the Escape key.
    const stop = () => api.terminals.write(session.id, '\x1b');

    const groups = groupItems(transcript.items);
    const empty = !transcript.loading && transcript.items.length === 0 && !pending;
    // Codex stays "done" after a turn. Claude Code changes from "done" to "idle" after a time.
    const done = (state === 'idle' || state === 'done') && !pending ? doneText(transcript.items, session.agentStateAt) : undefined;

    return (
        <div
            className={cx('chat-view', dragging && 'dragging-files')}
            data-dictation-session={session.id}
            onDragOver={onDragOver}
            onDragLeave={event => {
                // The pointer left the chat, not only a child element of the chat.
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
            }}
            onDrop={onDrop}
        >
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
                    <IconButton icon={<X size={14} strokeWidth={1.8} />} label="Close the message" onClick={() => setSendError(undefined)} />
                </div>
            )}
            {attachError && (
                <div className="chat-waiting error" role="alert">
                    <CircleAlert size={14} strokeWidth={1.8} className="chat-waiting-icon" />
                    <span className="chat-waiting-text">{attachError}</span>
                    <IconButton icon={<X size={14} strokeWidth={1.8} />} label="Close the message" onClick={() => setAttachError(undefined)} />
                </div>
            )}
            <DictationBar sessionId={session.id} />
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
                {documents.length > 0 && (
                    <div className="chat-documents">
                        {documents.map(item => {
                            const note = item.document && truncationNote(item.document);
                            return (
                                <span key={item.id} className="chat-document" title={note ? `${item.name}: ${note}` : item.name}>
                                    {item.document ? (
                                        <FileText size={12} strokeWidth={1.8} aria-hidden="true" />
                                    ) : (
                                        <LoaderCircle size={12} strokeWidth={2} className="spin" aria-label="Converting" />
                                    )}
                                    <span className="chat-document-name">{item.name}</span>
                                    {note && <span className="chat-document-cut">Cut</span>}
                                    <button
                                        type="button"
                                        className="chat-document-remove"
                                        title="Remove"
                                        aria-label={`Remove ${item.name}`}
                                        disabled={sending}
                                        onClick={() => setDocuments(current => current.filter(other => other.id !== item.id))}
                                    >
                                        <X size={11} strokeWidth={2.4} />
                                    </button>
                                </span>
                            );
                        })}
                    </div>
                )}
                {readyDocuments.some(item => item.truncated) && (
                    <p className="chat-document-notes">
                        {readyDocuments
                            .filter(item => item.truncated)
                            .map(item => `${item.name}: ${truncationNote(item)}`)
                            .join(' ')}
                    </p>
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
                              ? `${agentName} is starting…`
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
                        icon={<Paperclip size={14} strokeWidth={1.6} />}
                        label="Attach files: PDF, Word, spreadsheets, and images"
                        disabled={sending}
                        onClick={() => void chooseFiles()}
                    />
                    <DictationButton sessionId={session.id} />
                    <IconButton
                        type="submit"
                        variant="outline"
                        icon={<ArrowUp size={14} strokeWidth={2} />}
                        label={converting ? 'Converting the documents' : 'Send'}
                        disabled={!canSend}
                    />
                </div>
            </form>
        </div>
    );
}
