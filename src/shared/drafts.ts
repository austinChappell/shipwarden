import { fence, MAX_PATCH } from './ask-agent';

/**
 * The settings of the agent drafts of commit messages and pull request descriptions, for all repositories.
 * The ✨ buttons of the Changes tab and the pull request form use them.
 */
export interface DraftSettings {
    /** Extra instructions for each commit message, for example "Write the subject in the imperative mood". */
    commitInstructions?: string;
    /** Extra instructions for each pull request description. */
    pullRequestInstructions?: string;
    /** True to ask for the Conventional Commits format ("feat: …", "fix(scope): …"). On by default. */
    conventionalCommits: boolean;
}

/** The draft settings of one repository. A missing value uses the global setting. */
export interface RepoDraftSettings {
    /** Instructions that the agent gets after the global instructions. */
    commitInstructions?: string;
    pullRequestInstructions?: string;
    conventionalCommits?: boolean;
}

export const DEFAULT_DRAFT_SETTINGS: DraftSettings = { conventionalCommits: true };

/** The longest instruction text that the settings keep. */
const MAX_INSTRUCTIONS = 10_000;

function cleanInstructions(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim().slice(0, MAX_INSTRUCTIONS) : undefined;
}

/** Converts stored draft settings to valid settings. A missing switch is on. */
export function normalizeDraftSettings(value: unknown): DraftSettings {
    const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    const commitInstructions = cleanInstructions(raw.commitInstructions);
    const pullRequestInstructions = cleanInstructions(raw.pullRequestInstructions);
    return {
        ...(commitInstructions ? { commitInstructions } : {}),
        ...(pullRequestInstructions ? { pullRequestInstructions } : {}),
        conventionalCommits: raw.conventionalCommits !== false
    };
}

/** Returns the valid draft settings of a repository, or undefined when nothing differs from the global settings. */
export function normalizeRepoDraftSettings(value: unknown): RepoDraftSettings | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const raw = value as Record<string, unknown>;
    const result: RepoDraftSettings = {};
    const commitInstructions = cleanInstructions(raw.commitInstructions);
    const pullRequestInstructions = cleanInstructions(raw.pullRequestInstructions);
    if (commitInstructions) result.commitInstructions = commitInstructions;
    if (pullRequestInstructions) result.pullRequestInstructions = pullRequestInstructions;
    if (typeof raw.conventionalCommits === 'boolean') result.conventionalCommits = raw.conventionalCommits;
    return Object.keys(result).length > 0 ? result : undefined;
}

/** The draft settings that apply to one repository. */
export interface ResolvedDraftSettings {
    /** The global instructions first, then the instructions of the repository. */
    commitInstructions: string[];
    pullRequestInstructions: string[];
    conventionalCommits: boolean;
}

/** Returns the draft settings of a repository: the global instructions and its own, and its own switch, else the global switch. */
export function resolveDraftSettings(global: DraftSettings, repo: RepoDraftSettings | undefined): ResolvedDraftSettings {
    const list = (...items: (string | undefined)[]) => items.filter((item): item is string => !!item);
    return {
        commitInstructions: list(global.commitInstructions, repo?.commitInstructions),
        pullRequestInstructions: list(global.pullRequestInstructions, repo?.pullRequestInstructions),
        conventionalCommits: repo?.conventionalCommits ?? global.conventionalCommits
    };
}

/** "commit" drafts the message of the next commit. "pullRequest" drafts the description of a pull request for the branch. */
export type DraftKind = 'commit' | 'pullRequest';

/** A request for a draft. The agent runs in print mode in the worktree. It does not change files. */
export interface DraftRequest {
    /** An ID from the renderer. `ask.cancel` uses it. */
    id: string;
    /** The path of the worktree. */
    worktree: string;
    kind: DraftKind;
    /** For a commit message: true when the commit replaces the last commit. The draft then includes the changes of the last commit. */
    amend?: boolean;
}

export interface DraftResult {
    /** The name of the agent that wrote the draft. */
    agent: string;
    text: string;
}

/** The git data of a commit message draft. */
export interface CommitDraftInput {
    branch?: string;
    /** The output of `git diff --cached --stat`. */
    stat: string;
    /** The staged diff. For an amend, the diff from the parent of HEAD to the index. */
    diff: string;
    /** The subjects of the last commits, newest first. They show the style of the repository. */
    recentSubjects: string[];
    /** The message of the commit that an amend replaces. */
    amendedMessage?: string;
    settings: ResolvedDraftSettings;
}

/** The git data of a pull request description draft. */
export interface PullRequestDraftInput {
    branch: string;
    /** The branch that the pull request merges into, for example "origin/main". */
    base: string;
    /** The commits of the branch: the subject and the body of each, oldest first. */
    commits: string[];
    stat: string;
    diff: string;
    /** The pull request template of the repository, if it has one. */
    template?: { path: string; text: string };
    settings: ResolvedDraftSettings;
}

/** Cuts a diff at `MAX_PATCH` characters and puts it in a fence. */
function diffBlock(diff: string): string {
    const text = diff.length > MAX_PATCH ? `${diff.slice(0, MAX_PATCH)}\n… (the diff continues)` : diff;
    const marker = fence(text);
    return `${marker}diff\n${text}\n${marker}`;
}

function textBlock(text: string, language = ''): string {
    const marker = fence(text);
    return `${marker}${language}\n${text}\n${marker}`;
}

function instructionsPart(instructions: string[]): string[] {
    return instructions.length ? [`Follow these instructions from the user. They have priority over the rules above.\n\n${instructions.join('\n\n')}`] : [];
}

/** The rule at the end of each draft prompt. ShipWarden puts the full answer into the text box. */
const OUTPUT_RULE = 'Write only the text. Do not add an introduction, notes, or a code fence around the text. Do not change files.';

/** Returns the prompt for a commit message draft. */
export function commitDraftPrompt(input: CommitDraftInput): string {
    const rules = input.settings.conventionalCommits
        ? [
              'Use the Conventional Commits format: "<type>(<optional scope>): <description>", for example "feat(auth): add a sign-out button".',
              'Types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert. Mark a breaking change with "!" after the type or scope.'
          ]
        : ['Do not use the Conventional Commits format unless the recent commits use it.'];
    const parts = [
        `Write a git commit message for the ${input.amendedMessage !== undefined ? 'amended commit' : 'staged changes'}${input.branch ? ` on the branch "${input.branch}"` : ''}. The current folder is the git worktree.`,
        [
            'The rules:',
            '- The first line is a summary of at most 72 characters.',
            '- When the change needs an explanation, add a blank line and a short body. Tell why the change is necessary, not only what changed. Wrap the body at 72 characters.',
            ...rules.map(rule => `- ${rule}`),
            '- Use the style of the recent commits of the repository.'
        ].join('\n')
    ];
    if (input.recentSubjects.length) parts.push(`The recent commits:\n\n${textBlock(input.recentSubjects.join('\n'))}`);
    if (input.amendedMessage) parts.push(`The message of the commit that the amend replaces:\n\n${textBlock(input.amendedMessage)}`);
    parts.push(`The changed files:\n\n${textBlock(input.stat.trimEnd())}`, `The diff:\n\n${diffBlock(input.diff)}`);
    parts.push(...instructionsPart(input.settings.commitInstructions));
    parts.push(`Read the files in the worktree if the diff does not show enough. ${OUTPUT_RULE}`);
    return parts.join('\n\n');
}

/** Returns the prompt for a pull request description draft. */
export function pullRequestDraftPrompt(input: PullRequestDraftInput): string {
    const parts = [
        `Write the description of a pull request that merges the branch "${input.branch}" into ${input.base}. The current folder is the git worktree of the branch.`,
        input.template
            ? `The repository has a pull request template (${input.template.path}). Use its structure: keep its headings, fill in each section, and keep its checklists. Remove the HTML comments that only give help to the author.\n\n${textBlock(input.template.text, 'markdown')}`
            : 'Write a short summary of the change, then a list of the main changes. Tell how to test the change when it is not clear.',
        'Write the description in Markdown. Tell why the change is necessary and what it changes. Do not repeat each line of the diff.'
    ];
    if (input.commits.length) parts.push(`The commits of the branch, oldest first:\n\n${textBlock(input.commits.join('\n\n---\n\n'))}`);
    parts.push(`The changed files:\n\n${textBlock(input.stat.trimEnd())}`, `The diff:\n\n${diffBlock(input.diff)}`);
    parts.push(...instructionsPart(input.settings.pullRequestInstructions));
    parts.push(`Read the files in the worktree if the diff does not show enough. Do not include a title. ${OUTPUT_RULE}`);
    return parts.join('\n\n');
}

/** Removes a code fence around all of the answer. Some agents put one there in spite of the prompt. */
export function cleanDraft(answer: string): string {
    const text = answer.trim();
    const match = /^(`{3,}|~{3,})[\w-]*\n([\s\S]*)\n\1\s*$/.exec(text);
    // A fence line inside means that the text starts and ends with two different code blocks. The text then stays.
    if (!match || match[2].split('\n').some(line => line.trimStart().startsWith(match[1]))) return text;
    return match[2].trim();
}

/**
 * The places where GitHub and Azure DevOps look for a pull request template, from the root of the repository.
 * The match ignores case. A folder (with "/" at the end) holds more templates. The first Markdown file applies.
 */
export const PULL_REQUEST_TEMPLATE_PATHS = [
    '.github/pull_request_template.md',
    'pull_request_template.md',
    'docs/pull_request_template.md',
    '.azuredevops/pull_request_template.md',
    '.vsts/pull_request_template.md',
    '.github/pull_request_template/',
    'pull_request_template/',
    'docs/pull_request_template/',
    '.azuredevops/pull_request_template/',
    '.vsts/pull_request_template/'
];
