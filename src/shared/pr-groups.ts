import { extractJson, fileDiffs, MAX_REVIEW_PATCH, readReview, type ParsedReview, type ReviewPromptInput } from './agent-review';
import { parseAzureRemote } from './azure-devops';
import { DEFAULT_REVIEW_STRICTNESS, strictnessInstructions, type ReviewStrictness } from './review-strictness';
import { pluralize } from './format';
import { repoId, type RepoRef } from './github';

/**
 * PR groups: a saved list of pull requests that an agent reviews together. The pull requests can be in different
 * repositories, and on GitHub or Azure Repos. The agent reads all of them in one run, so it can find problems
 * between them, for example an API change that the client does not use correctly.
 *
 * The functions of this module use no Electron API and no browser API. The main process and the page both use them.
 */

/** A pull request of a group. */
export interface GroupPullRequest {
    repo: RepoRef;
    number: number;
    /** The title when the user added the pull request. The page shows it before the pull request loads. */
    title?: string;
}

/** The counts of the last group review for one pull request. */
export interface GroupReviewCounts {
    /** The comments on lines of the diff. They became pending comments. */
    comments: number;
    /** The comments that are not on a changed line. They went into the review text. */
    notes: number;
}

/** The result of the last group review. The pending comments stay only in the review store of the page. */
export interface GroupReviewResult {
    at: number;
    /** The name of the agent, for example "Claude Code". */
    agent: string;
    /** The summary of the agent for all pull requests, in Markdown. */
    summary: string;
    /** The head commit of each pull request at the review, by `prKey`. */
    heads: Record<string, string>;
    /** The counts for each pull request, by `prKey`. */
    counts: Record<string, GroupReviewCounts>;
}

export interface PrGroup {
    id: string;
    name: string;
    /** Context for the agent from the user, for example the merge order. Markdown. */
    note: string;
    pullRequests: GroupPullRequest[];
    /** The plan that made the group, if a plan made it. */
    planId?: string;
    createdAt: number;
    updatedAt: number;
    lastReview?: GroupReviewResult;
}

/** A pull request for a group review run in the main process. */
export interface GroupReviewTarget {
    repo: RepoRef;
    number: number;
    /** The head commit. The main process makes a local copy of the pull request at this commit. */
    headRefOid: string;
}

/** A request to the main process to review the pull requests of a group. The agent does not change files. */
export interface GroupReviewRequest {
    /** An ID for `cancelReview`. */
    id: string;
    pullRequests: GroupReviewTarget[];
    /** The full prompt, from `groupReviewPrompt`. The main process adds a note about the folders. */
    prompt: string;
}

export interface GroupReviewAnswer {
    agent: string;
    answer: string;
}

export const MAX_GROUP_NAME = 120;
export const MAX_GROUP_PULL_REQUESTS = 20;
const MAX_NOTE_LENGTH = 20_000;
const MAX_SUMMARY_LENGTH = 100_000;

/** Makes a short random ID. */
export function newGroupId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Returns the key of a pull request, for example "octo/app#12" or "azure:org/project/app#12". */
export function prKey(pr: { repo: RepoRef; number: number }): string {
    return `${repoId(pr.repo)}#${pr.number}`;
}

/** Returns the size of a group for the UI, for example "3 PRs in 2 repositories" or "No PRs". */
export function groupSize(group: Pick<PrGroup, 'pullRequests'>): string {
    if (group.pullRequests.length === 0) return 'No PRs';
    const repos = new Set(group.pullRequests.map(pr => repoId(pr.repo).toLowerCase())).size;
    return `${pluralize(group.pullRequests.length, 'PR')} in ${pluralize(repos, 'repository', 'repositories')}`;
}

/** Makes a new group. */
export function newGroup(now: number, name = 'New group', pullRequests: GroupPullRequest[] = []): PrGroup {
    return { id: newGroupId(), name, note: '', pullRequests: uniquePullRequests(pullRequests), createdAt: now, updatedAt: now };
}

/** Returns the group with the pull request at the end. A pull request that is in the group already stays in its place. */
export function withPullRequest(group: PrGroup, pr: GroupPullRequest): PrGroup {
    if (group.pullRequests.some(item => prKey(item) === prKey(pr))) return group;
    if (group.pullRequests.length >= MAX_GROUP_PULL_REQUESTS) {
        throw new Error(`A group can have at most ${MAX_GROUP_PULL_REQUESTS} pull requests.`);
    }
    return { ...group, pullRequests: [...group.pullRequests, pr] };
}

/**
 * Returns the group with the pull request moved by `delta` places: -1 is one place up, 1 is one place down.
 * A move past the start or the end of the list, or a key that is not in the group, changes nothing.
 */
export function movePullRequest(group: PrGroup, key: string, delta: number): PrGroup {
    const from = group.pullRequests.findIndex(pr => prKey(pr) === key);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= group.pullRequests.length || to === from) return group;
    const pullRequests = [...group.pullRequests];
    const [moved] = pullRequests.splice(from, 1);
    pullRequests.splice(to, 0, moved);
    return { ...group, pullRequests };
}

function uniquePullRequests(list: GroupPullRequest[]): GroupPullRequest[] {
    const seen = new Set<string>();
    const result: GroupPullRequest[] = [];
    for (const pr of list) {
        const key = prKey(pr);
        if (seen.has(key) || result.length >= MAX_GROUP_PULL_REQUESTS) continue;
        seen.add(key);
        result.push(pr);
    }
    return result;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Links                                                                                                               */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * Reads a pull request from a text. Returns undefined for other texts. It accepts these forms:
 * - https://github.com/{owner}/{name}/pull/{number}
 * - https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{number}
 * - https://{org}.visualstudio.com/{project}/_git/{repo}/pullrequest/{number}
 * - {owner}/{name}#{number}
 */
export function parsePullRequestLink(text: string): { repo: RepoRef; number: number } | undefined {
    const value = text.trim();
    let match = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(value);
    if (match) return pullRequestOf({ owner: match[1], name: match[2] }, match[3]);
    match = /^(https?:\/\/[^\s]+\/_git\/[^/\s?#]+)\/pullrequest\/(\d+)(?:[/?#].*)?$/i.exec(value);
    if (match) {
        const azure = parseAzureRemote(match[1]);
        if (azure) return pullRequestOf({ owner: `${azure.organization}/${azure.project}`, name: azure.repository, host: 'azure' }, match[2]);
        return undefined;
    }
    match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/.exec(value);
    if (match) return pullRequestOf({ owner: match[1], name: match[2] }, match[3]);
    return undefined;
}

function pullRequestOf(repo: RepoRef, number: string): { repo: RepoRef; number: number } | undefined {
    const value = Number(number);
    return Number.isInteger(value) && value > 0 ? { repo, number: value } : undefined;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Normalize                                                                                                           */
/* ------------------------------------------------------------------------------------------------------------------ */

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown, max: number): string | undefined {
    return typeof value === 'string' ? value.slice(0, max) : undefined;
}

function time(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function repoOf(value: unknown): RepoRef | undefined {
    const raw = record(value);
    const owner = text(raw.owner, 400)?.trim();
    const name = text(raw.name, 400)?.trim();
    if (!owner || !name) return undefined;
    return raw.host === 'azure' ? { owner, name, host: 'azure' } : { owner, name };
}

function groupPullRequestOf(value: unknown): GroupPullRequest | undefined {
    const raw = record(value);
    const repo = repoOf(raw.repo);
    const number = raw.number;
    if (!repo || typeof number !== 'number' || !Number.isInteger(number) || number <= 0) return undefined;
    const title = text(raw.title, 500)?.trim();
    return title ? { repo, number, title } : { repo, number };
}

function stringMap(value: unknown, max: number): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, item] of Object.entries(record(value))) {
        if (typeof item === 'string' && item) result[key.slice(0, 1000)] = item.slice(0, max);
    }
    return result;
}

function countsOf(value: unknown): Record<string, GroupReviewCounts> {
    const result: Record<string, GroupReviewCounts> = {};
    for (const [key, item] of Object.entries(record(value))) {
        const raw = record(item);
        const count = (field: unknown) => (typeof field === 'number' && Number.isInteger(field) && field >= 0 ? field : 0);
        result[key.slice(0, 1000)] = { comments: count(raw.comments), notes: count(raw.notes) };
    }
    return result;
}

function reviewResultOf(value: unknown): GroupReviewResult | undefined {
    const raw = record(value);
    const at = time(raw.at);
    if (!at) return undefined;
    return {
        at,
        agent: text(raw.agent, 200) ?? '',
        summary: text(raw.summary, MAX_SUMMARY_LENGTH) ?? '',
        heads: stringMap(raw.heads, 100),
        counts: countsOf(raw.counts)
    };
}

/** Returns a valid group, or undefined when the value has no ID. */
export function normalizeGroup(value: unknown): PrGroup | undefined {
    const raw = record(value);
    const id = text(raw.id, 100)?.trim();
    if (!id) return undefined;
    const now = Date.now();
    const pullRequests = uniquePullRequests(
        (Array.isArray(raw.pullRequests) ? raw.pullRequests : []).map(groupPullRequestOf).filter((pr): pr is GroupPullRequest => !!pr)
    );
    const group: PrGroup = {
        id,
        name: text(raw.name, MAX_GROUP_NAME)?.trim() || 'New group',
        note: text(raw.note, MAX_NOTE_LENGTH) ?? '',
        pullRequests,
        createdAt: time(raw.createdAt) ?? now,
        updatedAt: time(raw.updatedAt) ?? now
    };
    const planId = text(raw.planId, 100)?.trim();
    if (planId) group.planId = planId;
    const lastReview = reviewResultOf(raw.lastReview);
    if (lastReview) group.lastReview = lastReview;
    return group;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Review                                                                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

/** True when the pull request has a new head commit since the last group review, or was not in that review. */
export function changedSinceReview(group: Pick<PrGroup, 'lastReview'>, key: string, headRefOid: string | undefined): boolean {
    const head = group.lastReview?.heads[key];
    return !!group.lastReview && (!head || (!!headRefOid && head !== headRefOid));
}

export interface GroupPromptInput {
    name: string;
    note: string;
    /** The pull requests in the order of the group. */
    pullRequests: ReviewPromptInput[];
    /** How many comments the agent writes. Without it, "balanced". */
    strictness?: ReviewStrictness;
}

/**
 * Returns the prompt that asks an agent to review the pull requests of a group together, and to answer in JSON.
 * All diffs share one limit. Each pull request gets an equal part of the rest of the limit, so a large pull request
 * does not push out the others.
 */
export function groupReviewPrompt(input: GroupPromptInput): string {
    const parts = [
        `Review these ${input.pullRequests.length} pull requests together. They belong together: "${input.name}". A change in one pull request can need a change in another one.`
    ];
    if (input.note.trim()) {
        parts.push(`A note from the reviewer about the group:\n\n${input.note.trim()}`);
    }
    let left = MAX_REVIEW_PATCH;
    input.pullRequests.forEach((item, index) => {
        const { pr, repo } = item;
        const share = Math.floor(left / (input.pullRequests.length - index));
        const { diffs, skipped, used } = fileDiffs(item.files, share);
        left -= used;
        const section = [
            `## Pull request ${index + 1}: ${prKey({ repo, number: pr.number })}`,
            `"${pr.title}": ${pr.url}`,
            `It merges ${pr.headRefName} (${pr.headRefOid}) into ${pr.baseRefName} (${pr.baseRefOid}).`
        ];
        if (pr.body?.trim()) section.push(`The description:\n\n${pr.body.trim()}`);
        section.push(`The diff of each file. Each file starts with a "---" line:\n\n${diffs.join('\n\n') || '(no diff)'}`);
        if (skipped.length) section.push(`These files are not in the diff above:\n${skipped.map(file => `- ${file}`).join('\n')}`);
        parts.push(section.join('\n\n'));
    });
    parts.push(
        [
            ...strictnessInstructions(
                input.strictness ?? DEFAULT_REVIEW_STRICTNESS,
                'Look most at the problems between the pull requests: changed contracts, names, types and data shapes that do not match, a missing change on one side, and a merge or deploy order that breaks something.'
            ),
            'Read more of the code if it helps you. Do not change files. Do not post comments.',
            'Put a comment on the pull request where the change must happen. If both sides must change, write a comment on each side.',
            'Your answer must be one JSON object and nothing else, with this shape:',
            '{"summary": "<the review of the group as a whole, in Markdown>", "pullRequests": [{"pr": "<the key after \'Pull request N:\'>", "summary": "<the review of this pull request, in Markdown>", "comments": [{"path": "<file path>", "line": <line number>, "side": "RIGHT", "body": "<the comment, in Markdown>"}]}]}',
            '"side" is "RIGHT" for a line of the new version (an added line or a context line) and "LEFT" for a removed line.',
            '"line" is the line number in that version of the file. It must be a line in a "@@" hunk of the diff of that pull request.'
        ].join('\n')
    );
    return parts.join('\n\n');
}

/** Returns the note about the folders that the main process puts before the prompt of a group review. */
export function groupFolderNote(folders: { key: string; path: string }[]): string {
    return [
        'Each pull request has a local copy at its head commit. The copies are git worktrees. You can read all of them:',
        ...folders.map(folder => `- ${folder.key}: ${folder.path}`),
        'The current folder is the copy of the first pull request.'
    ].join('\n');
}

export interface ParsedGroupReview {
    summary: string;
    /** The review of each pull request, by `prKey`. A pull request without a review from the agent is not in the map. */
    reviews: Map<string, ParsedReview>;
}

/**
 * Reads the answer of a group review. A review for a key that is not in the group goes into the summary.
 * When the answer is not JSON, all of it is the summary.
 */
export function parseGroupReview(answer: string, pullRequests: { key: string; files: { path: string; patch?: string }[] }[]): ParsedGroupReview {
    const data = extractJson(answer);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return { summary: answer.trim(), reviews: new Map() };
    }
    const raw = data as { summary?: unknown; pullRequests?: unknown };
    const summaryParts = [typeof raw.summary === 'string' ? raw.summary.trim() : ''];
    const byKey = new Map(pullRequests.map(item => [item.key.toLowerCase(), item]));
    const reviews = new Map<string, ParsedReview>();
    for (const item of Array.isArray(raw.pullRequests) ? raw.pullRequests : []) {
        if (!item || typeof item !== 'object') continue;
        const pr = (item as { pr?: unknown }).pr;
        const wanted = typeof pr === 'string' ? pr.trim().toLowerCase() : '';
        const target = byKey.get(wanted);
        // Without a target, no file has lines. Then all comments of the item go to `unplaced`.
        const review = readReview(item, target?.files ?? []);
        if (!target) {
            const lost = [review.summary, ...review.unplaced].filter(Boolean).join('\n');
            if (lost) summaryParts.push(`Notes for ${wanted || 'an unknown pull request'}:\n\n${lost}`);
            continue;
        }
        const before = reviews.get(target.key);
        reviews.set(
            target.key,
            before
                ? {
                      summary: [before.summary, review.summary].filter(Boolean).join('\n\n'),
                      comments: [...before.comments, ...review.comments],
                      unplaced: [...before.unplaced, ...review.unplaced]
                  }
                : review
        );
    }
    return { summary: summaryParts.filter(Boolean).join('\n\n'), reviews };
}
