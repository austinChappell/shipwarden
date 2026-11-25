import { useCallback, useSyncExternalStore } from 'react';
import { countImageMarks, bracketedPaste } from '@shared/agent-text';
import { unsettledPrompts } from '@shared/chat-sent';
import { type ConvertedDocument, documentPrompt } from '@shared/documents';
import { screenTextOf } from '../app/use-agent-actions';
import { errorText } from '../util';
import { agentStateStore } from './agent-state-store';
import { transcriptStore } from './transcript-store';

const api = window.shipwarden;

/** The time between the paste of a prompt and the Enter key. The agent must get the paste first. */
const SUBMIT_DELAY_MS = 200;

/** The maximum time that the agent can take to read an image from the clipboard and show its mark. */
const IMAGE_READ_TIMEOUT_MS = 5000;

/** How often the chat checks the screen for the mark of a new image. */
const IMAGE_CHECK_MS = 150;

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A document in the prompt box: converting, or ready for the next prompt. */
export interface AttachedDocument {
    id: string;
    name: string;
    /** Undefined while the main process converts the file. */
    document?: ConvertedDocument;
}

/** A prompt of the chat: the text of the user, pasted images as data URLs, and converted documents. */
export interface ChatPrompt {
    id: string;
    text: string;
    images: string[];
    documents: ConvertedDocument[];
}

/** A prompt that went to the agent. The chat shows it as pending until the transcript has it. */
export interface SentPrompt {
    id: string;
    /** The full text for the agent, with the list of the documents (see `documentPrompt`). */
    text: string;
    /** All images for the agent, with the page images of a PDF without text. */
    images: string[];
    /** The number of user prompts in the transcript before this prompt. */
    users: number;
}

/** The prompt box of one agent tab. */
export interface ChatInput {
    /** The text in the prompt box. */
    draft: string;
    /** The images that the user pasted for the next prompt, as data URLs. */
    images: string[];
    /** The documents for the next prompt. The agent gets the path of the text file of each document. */
    documents: AttachedDocument[];
    /** The prompts that wait for the end of the turn of the agent, oldest first. */
    queue: ChatPrompt[];
    /** The prompts that went to the agent, but are not in the transcript yet. */
    sent: SentPrompt[];
    /** True while the chat gives a prompt and its images to the agent. */
    sending: boolean;
    error?: string;
}

const EMPTY: ChatInput = { draft: '', images: [], documents: [], queue: [], sent: [], sending: false };

/**
 * The prompt boxes of the agent tabs, by session ID. The data stays when the chat closes, for example when the user
 * opens another page or another project. The data does not go to disk.
 */
const inputs = new Map<string, ChatInput>();
const listeners = new Set<() => void>();
/** The agent name of each session, for the error messages of a send. */
const agentNames = new Map<string, string>();
/** The sends of each session, in order. Two sends must not use the clipboard at the same time. */
const chains = new Map<string, Promise<void>>();
let nextId = 0;

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function get(id: string): ChatInput {
    return inputs.get(id) ?? EMPTY;
}

function change(id: string, update: (input: ChatInput) => ChatInput): void {
    inputs.set(id, update(get(id)));
    for (const listener of listeners) listener();
}

/** Returns the prompt box of a session. The component renders again when it changes. */
export function useChatInput(id: string): ChatInput {
    const snapshot = useCallback(() => get(id), [id]);
    return useSyncExternalStore(subscribe, snapshot);
}

export function setChatDraft(id: string, draft: string): void {
    change(id, input => ({ ...input, draft }));
}

export function addChatImage(id: string, image: string): void {
    change(id, input => ({ ...input, images: [...input.images, image] }));
}

export function removeChatImage(id: string, index: number): void {
    change(id, input => ({ ...input, images: input.images.filter((_, item) => item !== index) }));
}

/** Adds a document chip that is converting. Returns the ID of the chip. */
export function addChatDocument(id: string, name: string): string {
    nextId += 1;
    const documentId = `d${nextId}`;
    change(id, input => ({ ...input, documents: [...input.documents, { id: documentId, name }] }));
    return documentId;
}

/** Sets the converted document of a chip. The chip is ready for the next prompt after this. */
export function setChatDocument(id: string, documentId: string, document: ConvertedDocument): void {
    change(id, input => ({ ...input, documents: input.documents.map(item => (item.id === documentId ? { ...item, document } : item)) }));
}

export function removeChatDocument(id: string, documentId: string): void {
    change(id, input => ({ ...input, documents: input.documents.filter(item => item.id !== documentId) }));
}

export function clearChatError(id: string): void {
    change(id, input => ({ ...input, error: undefined }));
}

/** Removes the sent prompts that the transcript has now. `userTexts` are the texts of the user prompts in the transcript. */
export function settleSentPrompts(id: string, userTexts: readonly string[]): void {
    const input = get(id);
    if (input.sent.length === 0) return;
    const left = unsettledPrompts(input.sent, userTexts);
    if (left.length < input.sent.length) change(id, current => ({ ...current, sent: unsettledPrompts(current.sent, userTexts) }));
}

/** Removes a prompt from the queue. */
export function removeQueuedPrompt(id: string, promptId: string): void {
    change(id, input => ({ ...input, queue: input.queue.filter(prompt => prompt.id !== promptId) }));
}

/**
 * Takes the text, the images, and the documents of the prompt box. Returns undefined when the box is empty or when a
 * document is converting.
 */
function takeDraft(id: string): ChatPrompt | undefined {
    const input = get(id);
    const text = input.draft.trim();
    if (input.documents.some(item => !item.document)) return undefined;
    const documents = input.documents.flatMap(item => (item.document ? [item.document] : []));
    if (!text && input.images.length === 0 && documents.length === 0) return undefined;
    change(id, current => ({ ...current, draft: '', images: [], documents: [] }));
    nextId += 1;
    return { id: `p${nextId}`, text, images: input.images, documents };
}

/** Puts the prompt of the box in the queue. The queue sends it when the agent ends its turn. */
export function queueChatPrompt(id: string, agentName: string): void {
    agentNames.set(id, agentName);
    const prompt = takeDraft(id);
    if (prompt) change(id, input => ({ ...input, queue: [...input.queue, prompt] }));
}

/** Gives the prompt of the box to the agent now. */
export function sendChatPrompt(id: string, agentName: string, transcriptFile: string): Promise<void> {
    agentNames.set(id, agentName);
    const prompt = takeDraft(id);
    return prompt ? send(id, [prompt], transcriptFile) : Promise.resolve();
}

/** Gives one queued prompt to the agent now, also while the agent works. */
export function sendQueuedPromptNow(id: string, promptId: string, transcriptFile: string): Promise<void> {
    const prompt = get(id).queue.find(item => item.id === promptId);
    if (!prompt) return Promise.resolve();
    removeQueuedPrompt(id, promptId);
    return send(id, [prompt], transcriptFile);
}

/** Gives all queued prompts to the agent as one prompt, as the terminal of Claude Code does. */
export function sendQueue(id: string, transcriptFile: string): Promise<void> {
    const input = get(id);
    if (input.queue.length === 0 || input.sending) return Promise.resolve();
    const prompts = input.queue;
    change(id, current => ({ ...current, queue: [] }));
    return send(id, prompts, transcriptFile);
}

/**
 * Gives prompts to the agent as one prompt: the images one after the other, then the text, then Enter. The page images
 * of a PDF without text go with the images. The text of each prompt starts with the list of its documents (see
 * `documentPrompt`). When the send fails, the text, the images, and the documents go back to the prompt box, and the
 * chat shows the error.
 */
function send(id: string, prompts: ChatPrompt[], transcriptFile: string): Promise<void> {
    const text = prompts
        .map(prompt => documentPrompt(prompt.documents, prompt.text))
        .filter(Boolean)
        .join('\n\n');
    const userText = prompts
        .map(prompt => prompt.text)
        .filter(Boolean)
        .join('\n\n');
    const userImages = prompts.flatMap(prompt => prompt.images);
    const documents = prompts.flatMap(prompt => prompt.documents);
    const images = [...userImages, ...documents.flatMap(document => (document.kind === 'images' ? document.images : []))];
    const previous = chains.get(id) ?? Promise.resolve();
    const next = previous.then(async () => {
        const users = transcriptStore.get(transcriptFile).items.filter(item => item.kind === 'user').length;
        const sent: SentPrompt = { id: prompts[0].id, text, images, users };
        change(id, input => ({ ...input, sending: true, error: undefined, sent: [...input.sent, sent] }));
        try {
            for (const image of images) await giveImage(id, image, agentNames.get(id) ?? 'The agent');
            if (text) {
                api.terminals.write(id, bracketedPaste(text));
                await delay(SUBMIT_DELAY_MS);
            }
            api.terminals.write(id, '\r');
            change(id, input => ({ ...input, sending: false }));
        } catch (err) {
            // The prompt of the agent can have some of the images now. The terminal shows them.
            change(id, input => ({
                ...input,
                sending: false,
                sent: input.sent.filter(prompt => prompt !== sent),
                draft: [userText, input.draft].filter(Boolean).join('\n\n'),
                images: [...userImages, ...input.images],
                documents: [...documents.map(document => ({ id: `d${++nextId}`, name: document.name, document })), ...input.documents],
                error: `${errorText(err)} The prompt did not go to the agent. The prompt in the terminal can have some of the images. Remove them there, or try again.`
            }));
        }
    });
    chains.set(id, next);
    void next.finally(() => {
        if (chains.get(id) === next) chains.delete(id);
    });
    return next;
}

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

/** True when the agent can take a prompt: it is not starting, working, or waiting for an answer. */
export function takesPrompt(state: string | undefined): boolean {
    return state === 'idle' || state === 'done';
}

// The queue sends its prompts when the agent ends its turn, also when the chat of the agent is not on the screen.
agentStateStore.subscribe(() => {
    const states = agentStateStore.getSnapshot();
    for (const [id, input] of inputs) {
        const update = states.get(id);
        if (input.queue.length > 0 && !input.sending && takesPrompt(update?.state)) void sendQueue(id, update?.transcript ?? '');
    }
});
