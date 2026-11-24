/**
 * Dictation in the agent prompt and in the chat. The main process runs the dictation helper
 * (native/dictation/main.swift). The helper uses the speech recognition of macOS on this Mac only, so no audio leaves
 * the Mac. The helper writes one JSON object on each line of stdout (see `parseHelperLine`).
 */

/** The error codes of the helper, and the errors of the main process. */
export type DictationErrorCode =
    | 'unsupportedLanguage'
    | 'onDeviceUnavailable'
    | 'speechDenied'
    | 'microphoneDenied'
    | 'noMicrophone'
    | 'audioFailed'
    | 'recognitionFailed'
    | 'badArguments'
    | 'helperMissing'
    | 'helperFailed'
    | 'unsupportedPlatform';

const ERROR_CODES: ReadonlySet<string> = new Set<DictationErrorCode>([
    'unsupportedLanguage',
    'onDeviceUnavailable',
    'speechDenied',
    'microphoneDenied',
    'noMicrophone',
    'audioFailed',
    'recognitionFailed',
    'badArguments',
    'helperMissing',
    'helperFailed',
    'unsupportedPlatform'
]);

/** One line of the helper. */
export type HelperEvent =
    | { type: 'listening' }
    | { type: 'partial'; text: string }
    | { type: 'final'; text: string }
    | { type: 'error'; code: DictationErrorCode; message: string };

/**
 * Reads one line of the helper. Returns undefined for an empty line or a line that is not a helper event. An error
 * with an unknown code becomes "helperFailed".
 */
export function parseHelperLine(line: string): HelperEvent | undefined {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return undefined;
    let value: unknown;
    try {
        value = JSON.parse(trimmed);
    } catch {
        return undefined;
    }
    if (!value || typeof value !== 'object') return undefined;
    const object = value as Record<string, unknown>;
    const text = typeof object.text === 'string' ? object.text : undefined;
    switch (object.type) {
        case 'listening':
            return { type: 'listening' };
        case 'partial':
        case 'final':
            return text === undefined ? undefined : { type: object.type, text };
        case 'error': {
            const code = typeof object.code === 'string' && ERROR_CODES.has(object.code) ? (object.code as DictationErrorCode) : 'helperFailed';
            const message = typeof object.message === 'string' ? object.message : '';
            return { type: 'error', code, message };
        }
        default:
            return undefined;
    }
}

/**
 * Splits the output of a process into lines. A chunk can end in the middle of a line. `push` keeps that part until
 * the next chunk.
 */
export class LineSplitter {
    private rest = '';

    /** Adds a chunk and returns the complete lines, without the line ends. */
    push(chunk: string): string[] {
        const lines = (this.rest + chunk).split('\n');
        this.rest = lines.pop() ?? '';
        return lines.map(line => (line.endsWith('\r') ? line.slice(0, -1) : line));
    }

    /** Returns the last line without a line end, if there is one. */
    flush(): string[] {
        const rest = this.rest;
        this.rest = '';
        return rest ? [rest] : [];
    }
}

/**
 * The state of a dictation.
 * - "starting": the helper is starting, or macOS is asking for a permission.
 * - "listening": the microphone is recording.
 * - "stopping": the recording stopped, and the helper is making the final text.
 * - "done": the final text is in `text`.
 * - "error": the dictation stopped with an error.
 * - "cancelled": the dictation stopped without a text.
 */
export type DictationState = 'starting' | 'listening' | 'stopping' | 'done' | 'error' | 'cancelled';

/** The states after which a dictation does not change. */
export function isDictationEnded(state: DictationState): boolean {
    return state === 'done' || state === 'error' || state === 'cancelled';
}

/** A change of a dictation, from the main process to the page. */
export interface DictationUpdate {
    id: string;
    state: DictationState;
    /** The text until now. The next update replaces it. */
    partial: string;
    /** The final text, in the state "done". It can be empty. */
    text?: string;
    /** The error, in the state "error". */
    error?: { code: DictationErrorCode; message: string };
}

/** Returns the error text for the user. `detail` is the message of the helper. */
export function dictationErrorText(code: DictationErrorCode, detail = ''): string {
    switch (code) {
        case 'unsupportedLanguage':
            return 'macOS has no speech recognition for your language. Change the language in System Settings › General › Language & Region.';
        case 'onDeviceUnavailable':
            return 'macOS cannot change speech into text on this Mac for your language. ShipWarden does not send audio to a server. Turn on Dictation in System Settings › Keyboard to get the language, or use a different language.';
        case 'speechDenied':
            return 'ShipWarden has no permission for speech recognition. Turn on ShipWarden in System Settings › Privacy & Security › Speech Recognition.';
        case 'microphoneDenied':
            return 'ShipWarden has no permission for the microphone. Turn on ShipWarden in System Settings › Privacy & Security › Microphone.';
        case 'noMicrophone':
            return 'macOS has no microphone. Connect a microphone and try again.';
        case 'audioFailed':
            return withDetail('The recording did not start.', detail);
        case 'recognitionFailed':
            return withDetail('The speech recognition stopped with an error.', detail);
        case 'helperMissing':
            return withDetail('The dictation helper is missing.', detail);
        case 'unsupportedPlatform':
            return 'Dictation needs macOS.';
        case 'badArguments':
        case 'helperFailed':
            return withDetail('The dictation helper stopped with an error.', detail);
    }
}

function withDetail(text: string, detail: string): string {
    const clean = detail.trim();
    if (!clean) return text;
    return `${text} ${/[.!?]$/.test(clean) ? clean : `${clean}.`}`;
}

/**
 * Inserts dictated text into a text field at the selection. It adds a space before the text when the character before
 * it is not a space, and a space after it when the character after it is not a space. Returns the new value and the
 * cursor position after the text.
 */
export function insertDictatedText(value: string, start: number, end: number, text: string): { value: string; cursor: number } {
    const clean = text.trim();
    const from = Math.max(0, Math.min(start, value.length));
    const to = Math.max(from, Math.min(end, value.length));
    if (!clean) return { value, cursor: to };
    const before = value.slice(0, from);
    const after = value.slice(to);
    const lead = before && !/\s$/.test(before) ? ' ' : '';
    const trail = after && !/^\s/.test(after) ? ' ' : '';
    const inserted = `${lead}${clean}${trail}`;
    return { value: before + inserted + after, cursor: before.length + lead.length + clean.length };
}
