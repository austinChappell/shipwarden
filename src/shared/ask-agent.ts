import { agentProgramOf } from './agent-programs';
import type { DiffSide, RepoRef } from './github';

/** A question to an agent about lines of a pull request. The agent answers in print mode. It does not change files. */
export interface AskAgentRequest {
    /** An ID from the renderer. `cancelAsk` uses it. */
    id: string;
    repo: RepoRef;
    /** The head commit of the pull request. */
    headRefOid: string;
    /** The full prompt, from `askPrompt`. The main process adds a line about the folder of the agent. */
    prompt: string;
}

export interface AskAgentResult {
    /** The name of the agent that answered, for example "Claude Code". */
    agent: string;
    answer: string;
}

/** The longest diff that the prompt contains. A longer diff stops at this length. */
export const MAX_PATCH = 60_000;

/**
 * Returns the shell command that runs an agent command in print mode. The prompt goes in on stdin.
 * Returns undefined when the command is not Claude Code, Codex, Gemini CLI or opencode.
 * - Claude Code: `-p`. Print mode does not run a tool that needs a permission.
 * - Codex: `exec` with a read-only sandbox. `-` reads the prompt from stdin.
 * - Gemini CLI: `-p` adds the text to the prompt from stdin.
 * - opencode: `run` with the built-in plan agent, which cannot edit files. `run` adds stdin to the message.
 */
export function printCommand(command: string): string | undefined {
    const trimmed = command.trim();
    switch (agentProgramOf(trimmed)) {
        case 'claude':
            return `${trimmed} -p`;
        case 'codex':
            return `${trimmed} exec --sandbox read-only --skip-git-repo-check -`;
        case 'gemini':
            return `${trimmed} -p 'Answer the question above.'`;
        case 'opencode':
            return `${trimmed} run --agent plan 'Answer the question below.'`;
        default:
            return undefined;
    }
}

export interface AskPromptInput {
    pr: { number: number; title: string; url: string; baseRefName: string; headRefName: string; baseRefOid: string; headRefOid: string };
    repo: RepoRef;
    path: string;
    side: DiffSide;
    startLine: number;
    endLine: number;
    /** The text of the lines, or undefined when the file versions are not available. */
    code?: string;
    /** The "@@" hunks of the file, or undefined when GitHub did not send them. */
    patch?: string;
    question: string;
}

/** Returns "line 4" or "lines 4–9". */
export function lineLabel(startLine: number, endLine: number): string {
    return startLine === endLine ? `line ${endLine}` : `lines ${startLine}–${endLine}`;
}

/** Returns the lines `startLine` to `endLine` (1-based, inclusive) of a text. */
export function sliceLines(text: string, startLine: number, endLine: number): string {
    return text.split('\n').slice(Math.max(0, startLine - 1), endLine).join('\n');
}

/** Returns a code fence that is longer than all backtick runs in the text, so the text cannot close it. */
function fence(text: string): string {
    const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length));
    return '`'.repeat(Math.max(3, longest + 1));
}

/** Returns the prompt for a question about lines of a pull request. */
export function askPrompt(input: AskPromptInput): string {
    const { pr, repo } = input;
    const version = input.side === 'LEFT' ? `the old version (${pr.baseRefName}, ${pr.baseRefOid.slice(0, 7)})` : `the new version (${pr.headRefName}, ${pr.headRefOid.slice(0, 7)})`;
    const parts = [
        `I review pull request #${pr.number} "${pr.title}" in ${repo.owner}/${repo.name}: ${pr.url}`,
        `It merges ${pr.headRefName} (${pr.headRefOid}) into ${pr.baseRefName} (${pr.baseRefOid}).`,
        `My question is about ${input.path}, ${lineLabel(input.startLine, input.endLine)} of ${version}.`
    ];
    if (input.code !== undefined) {
        const marker = fence(input.code);
        parts.push(`The lines:\n\n${marker}\n${input.code}\n${marker}`);
    }
    if (input.patch) {
        const patch = input.patch.length > MAX_PATCH ? `${input.patch.slice(0, MAX_PATCH)}\n… (the diff continues)` : input.patch;
        const marker = fence(patch);
        parts.push(`The diff of the file in the pull request:\n\n${marker}diff\n${patch}\n${marker}`);
    }
    parts.push(
        'Answer the question. Read more of the code if it helps you. Do not change files. Write the answer in Markdown.',
        `Question: ${input.question}`
    );
    return parts.join('\n\n');
}

/** The text that the main process adds to the prompt about the folder of the agent. */
export function folderNote(localClone: boolean, headRefOid: string): string {
    return localClone
        ? `The current folder is a local clone of the repository. It is possibly not on the pull request commit. To read a file of the pull request, use \`git show ${headRefOid}:<path>\`. If the commit is not in the clone, use the GitHub CLI (\`gh\`).`
        : 'The current folder is empty. To read more of the repository, use the GitHub CLI (`gh`).';
}

/**
 * Removes terminal control sequences from a text. A shell setup can write them, for example an OSC sequence that
 * sets the window title before each command.
 */
export function stripTerminalCodes(text: string): string {
    return text
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
        .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
        .replace(/\x1b[@-_]/g, '');
}

/** Returns the part of the output after the marker. Without the marker, returns all of the output. */
export function afterMarker(output: string, marker: string): string {
    const index = output.indexOf(marker);
    return index < 0 ? output : output.slice(index + marker.length);
}

/** A question to the agent and its answer, kept on disk so that the user can read it again later. */
export interface SavedAnswer {
    /** The ID of the question. */
    id: string;
    repo: RepoRef;
    /** The number of the pull request. */
    number: number;
    path: string;
    side: DiffSide;
    startLine: number;
    line: number;
    question: string;
    /** The name of the agent that answered. */
    agent: string;
    answer: string;
    /** The head commit of the pull request when the agent answered. The lines refer to this commit. */
    commit: string;
    /** The time of the answer, in milliseconds since 1970. */
    answeredAt: number;
}

/** The longest text of a question or an answer that the store keeps. */
const MAX_SAVED_TEXT = 200_000;

const isText = (value: unknown, max = 1000): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const isLine = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0;

/** Returns the value as a SavedAnswer, or undefined when a field is missing or not correct. */
export function parseSavedAnswer(value: unknown): SavedAnswer | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const item = value as Record<string, unknown>;
    const repo = item.repo as Record<string, unknown> | undefined;
    if (!repo || !isText(repo.owner, 200) || !isText(repo.name, 200)) return undefined;
    if (!isText(item.id, 200) || !isLine(item.number) || !isText(item.path, 4000)) return undefined;
    if (item.side !== 'LEFT' && item.side !== 'RIGHT') return undefined;
    if (!isLine(item.startLine) || !isLine(item.line) || item.startLine > item.line) return undefined;
    if (!isText(item.question, MAX_SAVED_TEXT) || !isText(item.answer, MAX_SAVED_TEXT) || !isText(item.agent, 200)) return undefined;
    if (typeof item.commit !== 'string' || item.commit.length > 100) return undefined;
    if (typeof item.answeredAt !== 'number' || !Number.isFinite(item.answeredAt)) return undefined;
    return {
        id: item.id,
        repo: { owner: repo.owner, name: repo.name },
        number: item.number,
        path: item.path,
        side: item.side,
        startLine: item.startLine,
        line: item.line,
        question: item.question,
        agent: item.agent,
        answer: item.answer,
        commit: item.commit,
        answeredAt: item.answeredAt
    };
}

/** Returns true when the saved answer is about the pull request `number` of `repo`. The owner and name ignore case, as on GitHub. */
export function isAnswerFor(answer: SavedAnswer, repo: RepoRef, number: number): boolean {
    return answer.number === number
        && answer.repo.owner.toLowerCase() === repo.owner.toLowerCase()
        && answer.repo.name.toLowerCase() === repo.name.toLowerCase();
}
