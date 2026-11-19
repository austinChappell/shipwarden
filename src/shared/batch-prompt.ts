/**
 * One prompt for the agents of more than one pull request. A plan or a PR group sends the same prompt to the agent in
 * the worktree of each selected pull request. Each agent gets the list of all the pull requests, so it knows which
 * part of the change is its part.
 *
 * The functions of this module use no Electron API and no browser API.
 */

/** A pull request that gets the prompt, or that is only in the list for context. */
export interface BatchPullRequest {
    /** The repository, for example "octo/api". */
    repo: string;
    /** The number of the pull request. Undefined for a plan step without a pull request. */
    number?: number;
    /** The web address of the pull request. */
    url?: string;
    title: string;
    /** The branch of the pull request. */
    branch?: string;
}

export interface BatchPromptInput {
    /** The kind of the list, for the first sentence. */
    kind: 'plan' | 'group';
    /** The title of the plan or the name of the group. */
    title: string;
    /** All pull requests of the plan or the group, in their order. */
    pullRequests: readonly BatchPullRequest[];
    /** The index in `pullRequests` of the pull request of this agent. */
    index: number;
    /** The count of the agents that get the prompt. */
    recipients: number;
    /** The text from the user. */
    prompt: string;
    /** True: the agent commits and pushes its changes. */
    push: boolean;
}

/** The maximum length of the text from the user. */
export const MAX_BATCH_PROMPT = 20_000;

/** Returns the name of a pull request in a list, for example "octo/api#12" or "octo/api (branch plan/1)". */
export function batchItemName(pr: BatchPullRequest): string {
    if (pr.number !== undefined) return `${pr.repo}#${pr.number}`;
    return pr.branch ? `${pr.repo} (branch ${pr.branch})` : pr.repo;
}

/** Returns the full prompt for the agent of one pull request. */
export function batchPrompt(input: BatchPromptInput): string {
    const own = input.pullRequests[input.index];
    if (!own) throw new Error('The pull request is not in the list.');
    const where = input.kind === 'plan' ? `the plan "${input.title}"` : `the PR group "${input.title}"`;
    const self = own.number !== undefined ? `pull request ${batchItemName(own)}${own.url ? ` (${own.url})` : ''}` : `the branch of ${batchItemName(own)}`;
    const parts: string[] = [`You work on ${self}. It is part of ${where}.`];
    if (input.pullRequests.length > 1) {
        const lines = input.pullRequests.map((pr, index) => {
            const mark = index === input.index ? ' (this worktree)' : '';
            return `${index + 1}. ${batchItemName(pr)}: ${pr.title}${mark}`;
        });
        parts.push(`The pull requests of ${where}, in order:\n${lines.join('\n')}`);
    }
    if (input.recipients > 1) {
        parts.push(
            `The agents of ${input.recipients} of these pull requests get this same request. Change only the files of this worktree. The other agents make the other changes.`
        );
    }
    parts.push(`The request:\n\n${input.prompt.trim()}`);
    parts.push(
        input.push
            ? 'When you change files, run the tests and commit. Then push the branch, so that the pull request gets the change.'
            : 'When you change files, run the tests and commit. Do not push.'
    );
    return parts.join('\n\n');
}
