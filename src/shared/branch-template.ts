import type { Task } from './tasks';

/**
 * The variables of a branch template, for example "{username}/{taskKey}-{taskShortDescription}".
 * The order is the order in the settings help.
 */
export const BRANCH_VARIABLES = [
    { name: 'taskKey', example: 'ENG-1234', help: 'The key of the task, for example ENG-1234. A task without a key uses its ID.' },
    { name: 'taskId', example: '86b2x9q4f', help: 'The ID of the task in the task manager.' },
    { name: 'taskTitle', example: 'fix-the-login-redirect', help: 'The title of the task, in lowercase with hyphens.' },
    {
        name: 'taskShortDescription',
        example: 'fix-login-redirect',
        help: 'A short description of the task, in lowercase with hyphens. An agent writes it when you start the task.'
    },
    { name: 'username', example: 'jsmith', help: 'Your login name on this computer.' }
] as const;

export type BranchVariable = (typeof BRANCH_VARIABLES)[number]['name'];

export type BranchValues = Record<BranchVariable, string>;

const VARIABLE_PATTERN = /\{([A-Za-z]+)\}/g;
const KNOWN = new Set<string>(BRANCH_VARIABLES.map(variable => variable.name));

/** Returns the variable names in the template that ShipWarden does not know. */
export function unknownVariables(template: string): string[] {
    return [...new Set([...template.matchAll(VARIABLE_PATTERN)].map(match => match[1]).filter(name => !KNOWN.has(name)))];
}

/** Returns true when the template contains the variable. */
export function usesVariable(template: string, name: BranchVariable): boolean {
    return template.includes(`{${name}}`);
}

/** The longest title part of a branch name. */
const MAX_TITLE = 50;
/** The longest short description. */
const MAX_SHORT = 40;

/** Converts a text to lowercase words with hyphens, for example "Fix the login" to "fix-the-login". */
export function kebabCase(text: string): string {
    return text
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/**
 * Converts a short description to lowercase words with hyphens, for example "Fix the login" to "fix-the-login".
 * It also splits camelCase words, so "fixLoginRedirect" gives "fix-login-redirect".
 */
export function shortKebabCase(text: string): string {
    return kebabCase(text.replace(/([a-z0-9])([A-Z])/g, '$1-$2'))
        .slice(0, MAX_SHORT)
        .replace(/-+$/, '');
}

/** The short description when the agent gives no answer: the first words of the title, in lowercase with hyphens. */
export function fallbackShortDescription(title: string): string {
    return shortKebabCase(
        title
            .split(/\s+/)
            .filter(word => !/^(a|an|the|to|of|for|and|in|on)$/i.test(word))
            .slice(0, 4)
            .join(' ')
    );
}

/** The longest task description in the prompt. */
const MAX_PROMPT_DESCRIPTION = 2000;

/** Returns the prompt that asks an agent for the short description of a task. */
export function shortDescriptionPrompt(task: Pick<Task, 'title' | 'description'>): string {
    const description = task.description?.trim().slice(0, MAX_PROMPT_DESCRIPTION);
    return [
        'Write a short description of this task for a git branch name.',
        'Use 2 to 4 words in lowercase with hyphens, for example fix-login-redirect or add-dark-mode.',
        'Do not read files. Do not run commands. Reply with only the description, on one line.',
        '',
        `Title: ${task.title}`,
        ...(description ? ['', 'Description:', description] : [])
    ].join('\n');
}

/** Reads the short description from the answer of the agent. Returns undefined when the answer has no usable text. */
export function parseShortDescription(answer: string): string | undefined {
    const line = answer
        .split('\n')
        .map(item => item.replace(/[`"'*]/g, '').trim())
        .filter(Boolean)
        .pop();
    const value = line ? shortKebabCase(line) : '';
    return value || undefined;
}

/** The values of the variables for a task. `shortDescription` is the answer of the agent, or undefined to use the title. */
export function branchValues(task: Pick<Task, 'id' | 'key' | 'title'>, username: string, shortDescription?: string): BranchValues {
    const key = task.key?.replace(/^#/, '') || task.id;
    return {
        taskKey: key,
        taskId: task.id,
        taskTitle: kebabCase(task.title).slice(0, MAX_TITLE).replace(/-+$/, ''),
        taskShortDescription: shortDescription || fallbackShortDescription(task.title),
        username
    };
}

/**
 * Makes a valid git branch name from a text. It replaces spaces and the characters that git does not allow
 * (~ ^ : ? * [ \ and control characters) with "-", and removes the parts that git does not allow:
 * "..", "@{", an empty folder part, a part that starts with "." and an end of "/", "." or ".lock".
 */
export function cleanBranchName(text: string): string {
    return text
        .replace(/[\s~^:?*[\\\u0000-\u001f\u007f]+/g, '-')
        .replace(/@\{/g, '-')
        .replace(/\.{2,}/g, '.')
        .replace(/\/{2,}/g, '/')
        .split('/')
        .map(part =>
            part
                .replace(/^[.-]+/, '')
                .replace(/(\.lock)+$/i, '')
                .replace(/[.-]+$/, '')
                .replace(/-{2,}/g, '-')
        )
        .filter(Boolean)
        .join('/');
}

/** Puts the values into the template and returns a valid branch name. An unknown variable becomes empty text. */
export function renderBranchTemplate(template: string, values: BranchValues): string {
    const filled = template.replace(VARIABLE_PATTERN, (_match, name: string) => (KNOWN.has(name) ? values[name as BranchVariable] : ''));
    return cleanBranchName(filled);
}

/** The values for the example in the settings. */
export function exampleValues(username: string): BranchValues {
    const values = Object.fromEntries(BRANCH_VARIABLES.map(variable => [variable.name, variable.example])) as BranchValues;
    return { ...values, username: username || values.username };
}
