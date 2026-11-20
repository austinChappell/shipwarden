/**
 * The prompt templates. A template is a saved prompt with variables, for example "Write tests for {{file}}".
 *
 * - Each template is one JSON file in ~/.shipwarden/prompts/<id>.json, as with the automations. The file name is the ID.
 * - The variables are the same as in the automations, plus "file". The template engine is the engine of the automations.
 * - A template can have a keyboard shortcut. The shortcut must not be a key of ShipWarden or of the terminal.
 *
 * This module uses no Electron API and no browser API.
 */
import { manualWorktreeEvent, type WorktreePlace } from './automation-events';
import { renderTemplate, templateVariables } from './automation-templates';
import { eventVariables, slugId, triggerVariables, type VariableInfo } from './automations';
import type { BranchSummary } from './github';
import { findKeybind } from './keybinds';
import { allShortcuts, appKeyAction, parseKeys, shortcutAction, type ParsedKeys } from './shortcuts';
import type { TaskLink } from './tasks';
import type { TextKeybind } from './terminal';

/** A saved prompt. */
export interface PromptTemplate {
    version: 1;
    /** The file name without ".json". Lowercase letters, digits, and hyphens. */
    id: string;
    name: string;
    /** The text of the prompt. It can contain variables, for example "{{branch}}". */
    prompt: string;
    /** The key combination that inserts the template, for example "⌃⌥T". */
    shortcut?: string;
    /** True when ShipWarden presses Enter after it inserts the prompt. By default, the user can edit the prompt first. */
    send?: boolean;
}

/** The templates in the folder, and the files that ShipWarden could not read. */
export interface PromptTemplateList {
    folder: string;
    templates: PromptTemplate[];
    problems: { file: string; error: string }[];
}

/** A template file or a form value that is not valid. The message tells the user what to change. */
export class PromptTemplateError extends Error {}

const MAX_NAME_LENGTH = 80;
const MAX_PROMPT_LENGTH = 20_000;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** True when the ID can be a file name in the prompts folder. */
export function isPromptTemplateId(id: unknown): id is string {
    return typeof id === 'string' && ID_PATTERN.test(id);
}

/** Returns an ID from the name that is not in `taken`. A second "Write tests" gets "write-tests-2". */
export function promptTemplateId(name: string, taken: Iterable<string>): string {
    const used = new Set(taken);
    const slug = slugId(name);
    const base = slug === 'automation' ? 'prompt' : slug;
    if (!used.has(base)) return base;
    for (let index = 2; ; index++) {
        const id = `${base}-${index}`;
        if (!used.has(id)) return id;
    }
}

/** Checks a template from a file or a form, and returns it in a clean form. Throws a `PromptTemplateError`. */
export function normalizePromptTemplate(value: unknown): PromptTemplate {
    const raw = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name) throw new PromptTemplateError('The template has no name.');
    if (name.length > MAX_NAME_LENGTH) throw new PromptTemplateError(`The name has more than ${MAX_NAME_LENGTH} characters.`);
    const prompt = typeof raw.prompt === 'string' ? raw.prompt : '';
    if (!prompt.trim()) throw new PromptTemplateError('The template has no prompt.');
    if (prompt.length > MAX_PROMPT_LENGTH) throw new PromptTemplateError(`The prompt has more than ${MAX_PROMPT_LENGTH} characters.`);
    const id = typeof raw.id === 'string' ? raw.id : '';
    let shortcut: string | undefined;
    if (typeof raw.shortcut === 'string' && raw.shortcut.trim()) {
        const keys = parseShortcut(raw.shortcut.trim());
        if (!keys) throw new PromptTemplateError(`The shortcut "${raw.shortcut}" is not valid. Use a key with ⌘, ⌃, or ⌥, for example ⌃⌥T.`);
        shortcut = formatKeys(keys);
    }
    return { version: 1, id, name, prompt, ...(shortcut ? { shortcut } : {}), ...(raw.send === true ? { send: true } : {}) };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Variables                                                                                                          */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The variables that ShipWarden fills from the worktree of the agent. Other variables get a field before the insert. */
export function promptVariables(): VariableInfo[] {
    return [
        { name: 'file', description: 'The open file, relative to the worktree' },
        ...triggerVariables({ type: 'manual', entity: 'worktree' }).filter(variable => !variable.name.startsWith('task.') || isLinkedTaskValue(variable.name))
    ];
}

/** The task variables that the link of a worktree gives without a request. */
function isLinkedTaskValue(name: string): boolean {
    return name === 'task.key' || name === 'task.title' || name === 'task.url';
}

/** The worktree of the agent, and the data of the worktree that ShipWarden has without a request. */
export interface PromptContext {
    place: WorktreePlace;
    /** The open file, relative to the worktree. */
    file?: string;
    /** The pull request and CI state of the branch, from the branch summaries. */
    summary?: BranchSummary;
    taskLink?: TaskLink;
    /** The time of the insert, in milliseconds. */
    at: number;
}

/** Returns the values of the variables for the worktree of the agent. They are the same values as in a manual automation. */
export function promptValues(context: PromptContext): Record<string, string | undefined> {
    const event = manualWorktreeEvent('prompt', 'manual', context.place, context.summary, context.at, context.taskLink);
    return eventVariables(event, { file: context.file });
}

/**
 * Returns the variables of the prompt that have no value, one time each, in the order of the prompt. A value with only
 * spaces counts as no value. ShipWarden asks the user for these values, so it never sends an empty value.
 */
export function missingVariables(prompt: string, values: Record<string, string | undefined>): string[] {
    return templateVariables(prompt).filter(name => !values[name]?.trim());
}

/** Replaces each variable of the prompt with its value. */
export function fillPrompt(prompt: string, values: Record<string, string | undefined>): string {
    return renderTemplate(prompt, values);
}

/** The label of the field of a variable: its description when ShipWarden knows it, else its name. */
export function variableLabel(name: string): string {
    return promptVariables().find(variable => variable.name === name)?.description ?? name;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Shortcuts                                                                                                          */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * The keys of macOS and of the text fields that a template must not take, for example ⌘C and ⌘V. The app does not list
 * them on the Keyboard Shortcuts page.
 */
const SYSTEM_KEYS: { keys: string; label: string }[] = [
    { keys: '⌘A', label: 'Select all' },
    { keys: '⌘C', label: 'Copy' },
    { keys: '⌘V', label: 'Paste' },
    { keys: '⌘X', label: 'Cut' },
    { keys: '⌘Z', label: 'Undo' },
    { keys: '⇧⌘Z', label: 'Redo' },
    { keys: '⌘F', label: 'Find' },
    { keys: '⌘G', label: 'Find the next match' },
    { keys: '⇧⌘G', label: 'Find the previous match' },
    { keys: '⌘S', label: 'Save the file' },
    { keys: '⌘M', label: 'Minimize the window' },
    { keys: '⌘L', label: 'Select the address bar of a browser tab' },
    { keys: '⌘R', label: 'Load the browser page again' }
];

/**
 * Reads a shortcut, for example "⌃⌥T". Returns undefined when the text is not a key combination, or when it has no ⌘,
 * ⌃, or ⌥. A key without these modifiers types a character, so it cannot be a shortcut.
 */
export function parseShortcut(text: string): ParsedKeys | undefined {
    const keys = parseKeys(text);
    if (!keys || !(keys.meta || keys.control || keys.alt)) return undefined;
    return keys;
}

/** The name of each key code in a shortcut. */
const CODE_NAMES: Record<string, string> = {
    BracketLeft: '[',
    BracketRight: ']',
    Comma: ',',
    ArrowLeft: '←',
    ArrowRight: '→',
    ArrowUp: '↑',
    ArrowDown: '↓',
    Tab: 'Tab'
};

/** Writes a key combination as text, with the modifiers in the order of macOS: ⌃⌥⇧⌘. */
export function formatKeys(keys: ParsedKeys): string {
    const name = /^Key[A-Z]$/.test(keys.code) ? keys.code.slice(3) : /^Digit\d$/.test(keys.code) ? keys.code.slice(5) : (CODE_NAMES[keys.code] ?? keys.key);
    return `${keys.control ? '⌃' : ''}${keys.alt ? '⌥' : ''}${keys.shift ? '⇧' : ''}${keys.meta ? '⌘' : ''}${name}`;
}

/** The parts of a key event that a shortcut compares. */
export interface KeyEventLike {
    key: string;
    code: string;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
}

/**
 * Returns the shortcut text of a key event, for example "⌃⌥T". Returns undefined for a key that a shortcut cannot use,
 * for example a modifier key alone, a key without ⌘, ⌃, or ⌥, or a key that `parseKeys` does not know.
 */
export function shortcutOfEvent(event: KeyEventLike): string | undefined {
    const name = /^Key[A-Z]$/.test(event.code) ? event.code.slice(3) : /^Digit\d$/.test(event.code) ? event.code.slice(5) : CODE_NAMES[event.code];
    if (!name) return undefined;
    const keys = parseShortcut(`${event.ctrlKey ? '⌃' : ''}${event.altKey ? '⌥' : ''}${event.shiftKey ? '⇧' : ''}${event.metaKey ? '⌘' : ''}${name}`);
    return keys ? formatKeys(keys) : undefined;
}

function sameKeys(a: ParsedKeys, b: ParsedKeys): boolean {
    return a.code === b.code && a.meta === b.meta && a.control === b.control && a.alt === b.alt && a.shift === b.shift;
}

/** Returns the template whose shortcut is the key event, or undefined. */
export function templateForKey(templates: readonly PromptTemplate[], event: KeyEventLike): PromptTemplate | undefined {
    const text = shortcutOfEvent(event);
    return text ? templates.find(template => template.shortcut === text) : undefined;
}

/**
 * Returns a message when the shortcut is already a key of ShipWarden, of macOS, of a terminal keybind, or of another
 * template. Returns undefined when the shortcut is free. `selfId` is the ID of the template that has the shortcut.
 */
export function shortcutConflict(
    shortcut: string,
    templates: readonly PromptTemplate[],
    selfId: string | undefined,
    terminalKeybinds: readonly TextKeybind[] = []
): string | undefined {
    const keys = parseShortcut(shortcut);
    if (!keys) return `"${shortcut}" is not a valid shortcut. Use a key with ⌘, ⌃, or ⌥.`;
    const input = { type: 'keyDown', meta: keys.meta, shift: keys.shift, control: keys.control, alt: keys.alt, key: keys.key, code: keys.code };
    const listed = allShortcuts().find(info => info.keys.some(text => sameParsed(text, keys)));
    if (listed) return `${shortcut} is already the key of "${listed.label}".`;
    if (shortcutAction(input) || appKeyAction(input)) return `${shortcut} is already a key of ShipWarden.`;
    const system = SYSTEM_KEYS.find(item => sameParsed(item.keys, keys));
    if (system) return `${shortcut} is already the key of "${system.label}".`;
    const press = { key: keys.key, shiftKey: keys.shift, ctrlKey: keys.control, altKey: keys.alt, metaKey: keys.meta };
    if (findKeybind(terminalKeybinds, press)) return `${shortcut} is already a keybind of the terminal config.`;
    const other = templates.find(template => template.id !== selfId && template.shortcut && sameParsed(template.shortcut, keys));
    if (other) return `${shortcut} is already the key of the template "${other.name}".`;
    return undefined;
}

function sameParsed(text: string, keys: ParsedKeys): boolean {
    const other = parseKeys(text);
    return !!other && sameKeys(other, keys);
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Starters                                                                                                           */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The starter templates. The settings page can add them to an empty folder. */
export const STARTER_PROMPTS: readonly PromptTemplate[] = [
    { version: 1, id: 'write-tests', name: 'Write tests for the open file', prompt: 'Write tests for {{file}}. Use the test style of the files near it.' },
    { version: 1, id: 'fix-lint', name: 'Fix the lint errors', prompt: 'Run the linter on the branch {{branch}} and fix all the errors.' },
    {
        version: 1,
        id: 'explain-file',
        name: 'Explain the open file',
        prompt: 'Explain what {{file}} does. Do not change the code.'
    },
    {
        version: 1,
        id: 'review-pr',
        name: 'Review the pull request',
        prompt: 'Review the changes of {{pr.url}} for bugs. Focus on {{focus}}. Do not change the code.'
    }
];
