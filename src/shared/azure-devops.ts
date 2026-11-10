import type { CheckConclusion, CheckStatus, ReviewDecision, ReviewEvent } from './github';

/** The REST API version that ShipWarden sends to Azure DevOps. */
export const AZURE_API_VERSION = '7.1';

/**
 * The Microsoft Entra resource ID of Azure DevOps. The `az` CLI gives a token for this resource.
 * See https://learn.microsoft.com/azure/devops/integrate/get-started/authentication/service-principal-managed-identity
 */
export const AZURE_DEVOPS_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';

/** An Azure Repos repository: an organization, a project in it, and a repository in the project. */
export interface AzureRepoRef {
    organization: string;
    project: string;
    repository: string;
}

/**
 * Parses an Azure Repos remote URL. Returns undefined for other URLs.
 * It accepts these forms:
 * - https://dev.azure.com/{org}/{project}/_git/{repo}
 * - https://{user}@dev.azure.com/{org}/{project}/_git/{repo}
 * - git@ssh.dev.azure.com:v3/{org}/{project}/{repo}
 * - https://{org}.visualstudio.com/{project}/_git/{repo} (also with "DefaultCollection" and a user)
 * - {org}@vs-ssh.visualstudio.com:v3/{org}/{project}/{repo}
 * The parts are decoded, so "My%20Project" gives "My Project".
 */
export function parseAzureRemote(url: string): AzureRepoRef | undefined {
    const text = url.trim();
    const decode = (part: string) => {
        try {
            return decodeURIComponent(part);
        } catch {
            return part;
        }
    };
    const make = (organization: string, project: string, repository: string): AzureRepoRef | undefined => {
        const repo = repository.replace(/\.git$/, '');
        if (!organization || !project || !repo) return undefined;
        return { organization: decode(organization), project: decode(project), repository: decode(repo) };
    };
    // SSH: git@ssh.dev.azure.com:v3/org/project/repo and org@vs-ssh.visualstudio.com:v3/org/project/repo.
    let match = /^(?:ssh:\/\/)?[^@\s]+@(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)(?::|:22\/|\/)v3\/([^/]+)\/([^/]+)\/([^/]+?)\/?$/.exec(text);
    if (match) return make(match[1], match[2], match[3]);
    // HTTPS: https://[user@]dev.azure.com/org/project/_git/repo
    match = /^https?:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+?)\/?(?:[?#].*)?$/.exec(text);
    if (match) return make(match[1], match[2], match[3]);
    // Legacy HTTPS: https://[user@]org.visualstudio.com/[DefaultCollection/]project/_git/repo
    match = /^https?:\/\/(?:[^@/]+@)?([^./]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/?#]+?)\/?(?:[?#].*)?$/i.exec(text);
    if (match) return make(match[1], match[2], match[3]);
    return undefined;
}

/** The base URL of the organization for REST calls. Legacy visualstudio.com organizations also answer on dev.azure.com. */
export function azureOrgUrl(repo: Pick<AzureRepoRef, 'organization'>): string {
    return `https://dev.azure.com/${encodeURIComponent(repo.organization)}`;
}

/** The base URL of the project for REST calls, for example https://dev.azure.com/acme/Web/_apis. */
export function azureProjectApi(repo: AzureRepoRef): string {
    return `${azureOrgUrl(repo)}/${encodeURIComponent(repo.project)}/_apis`;
}

/** The web page of the repository. */
export function azureRepoWebUrl(repo: AzureRepoRef): string {
    return `${azureOrgUrl(repo)}/${encodeURIComponent(repo.project)}/_git/${encodeURIComponent(repo.repository)}`;
}

/** The web page that creates a pull request from a branch. */
export function azureCreatePullRequestUrl(repo: AzureRepoRef, branch: string): string {
    return `${azureRepoWebUrl(repo)}/pullrequestcreate?sourceRef=${encodeURIComponent(branch)}`;
}

/** Adds "refs/heads/" to a branch name. A full ref stays as it is. */
export function toRefName(branch: string): string {
    return branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
}

/** Removes "refs/heads/" from a ref name. */
export function fromRefName(ref: string | null | undefined): string {
    return (ref ?? '').replace(/^refs\/heads\//, '');
}

/** The status of a build: https://learn.microsoft.com/rest/api/azure/devops/build/builds/get#buildstatus */
export type AzureBuildStatus = 'none' | 'notStarted' | 'inProgress' | 'cancelling' | 'postponed' | 'completed' | 'all';
/** The result of a build: https://learn.microsoft.com/rest/api/azure/devops/build/builds/get#buildresult */
export type AzureBuildResult = 'none' | 'succeeded' | 'partiallySucceeded' | 'failed' | 'canceled';
/** The state of a timeline record (stage, job or task). */
export type AzureTimelineState = 'pending' | 'inProgress' | 'completed';
/** The result of a timeline record (stage, job or task). */
export type AzureTimelineResult = 'succeeded' | 'succeededWithIssues' | 'failed' | 'canceled' | 'skipped' | 'abandoned';
/** The state of a commit or pull request status from an external service. */
export type AzureGitStatusState = 'notSet' | 'pending' | 'succeeded' | 'failed' | 'error' | 'notApplicable';

/** Converts the status of a build to the check status of the UI. */
export function buildStatusToCheck(status: AzureBuildStatus | string | null | undefined): CheckStatus {
    switch (status) {
        case 'completed':
            return 'completed';
        case 'inProgress':
        case 'cancelling':
            return 'in_progress';
        case 'postponed':
            return 'waiting';
        default:
            return 'queued';
    }
}

/** Converts the result of a build to the check conclusion of the UI. A build that did not complete has no conclusion. */
export function buildResultToConclusion(result: AzureBuildResult | string | null | undefined): CheckConclusion {
    switch (result) {
        case 'succeeded':
            return 'success';
        // The build passed, but some tasks had warnings or failures that "continue on error" allowed.
        case 'partiallySucceeded':
            return 'neutral';
        case 'failed':
            return 'failure';
        case 'canceled':
            return 'cancelled';
        default:
            return null;
    }
}

/** Converts the state of a timeline record to the check status of the UI. */
export function timelineStateToCheck(state: AzureTimelineState | string | null | undefined): CheckStatus {
    switch (state) {
        case 'completed':
            return 'completed';
        case 'inProgress':
            return 'in_progress';
        default:
            return 'queued';
    }
}

/** Converts the result of a timeline record to the check conclusion of the UI. */
export function timelineResultToConclusion(result: AzureTimelineResult | string | null | undefined): CheckConclusion {
    switch (result) {
        case 'succeeded':
            return 'success';
        case 'succeededWithIssues':
            return 'neutral';
        case 'failed':
            return 'failure';
        case 'canceled':
        case 'abandoned':
            return 'cancelled';
        case 'skipped':
            return 'skipped';
        default:
            return null;
    }
}

/** Converts the state of a status from an external service to the status and the conclusion of the UI. */
export function gitStatusToCheck(state: AzureGitStatusState | string | null | undefined): { status: CheckStatus; conclusion: CheckConclusion } {
    switch (state) {
        case 'succeeded':
            return { status: 'completed', conclusion: 'success' };
        case 'failed':
            return { status: 'completed', conclusion: 'failure' };
        case 'error':
            return { status: 'completed', conclusion: 'error' };
        case 'notApplicable':
            return { status: 'completed', conclusion: 'skipped' };
        default:
            return { status: 'pending', conclusion: null };
    }
}

/** The votes of a reviewer on a pull request. */
export const AZURE_VOTE = {
    approved: 10,
    approvedWithSuggestions: 5,
    none: 0,
    waitingForAuthor: -5,
    rejected: -10
} as const;

/** The review events that Azure DevOps accepts, in the order of the buttons. */
export const AZURE_REVIEW_EVENTS: ReviewEvent[] = ['COMMENT', 'WAIT_FOR_AUTHOR', 'REJECT', 'APPROVE_WITH_SUGGESTIONS', 'APPROVE'];

/** Returns the vote for a review event. A comment gives no vote. */
export function voteForEvent(event: ReviewEvent): number | undefined {
    switch (event) {
        case 'APPROVE':
            return AZURE_VOTE.approved;
        case 'APPROVE_WITH_SUGGESTIONS':
            return AZURE_VOTE.approvedWithSuggestions;
        case 'REQUEST_CHANGES':
        case 'WAIT_FOR_AUTHOR':
            return AZURE_VOTE.waitingForAuthor;
        case 'REJECT':
            return AZURE_VOTE.rejected;
        default:
            return undefined;
    }
}

/** Returns the review state of a vote, for the conversation of a pull request. A vote of 0 gives undefined. */
export function reviewStateForVote(vote: number): string | undefined {
    if (vote >= AZURE_VOTE.approved) return 'APPROVED';
    if (vote > 0) return 'APPROVED_WITH_SUGGESTIONS';
    if (vote <= AZURE_VOTE.rejected) return 'REJECTED';
    if (vote < 0) return 'WAITING_FOR_AUTHOR';
    return undefined;
}

/**
 * Returns the review decision of a pull request from the votes of its reviewers.
 * A negative vote gives "changes requested". A required reviewer without approval gives "review required".
 * At least one approval and no other block gives "approved".
 */
export function reviewDecisionFromVotes(reviewers: readonly { vote: number; isRequired?: boolean }[]): ReviewDecision {
    if (reviewers.some(reviewer => reviewer.vote < 0)) return 'CHANGES_REQUESTED';
    if (reviewers.some(reviewer => reviewer.isRequired && reviewer.vote <= 0)) return 'REVIEW_REQUIRED';
    if (reviewers.some(reviewer => reviewer.vote > 0)) return 'APPROVED';
    return reviewers.length > 0 ? 'REVIEW_REQUIRED' : null;
}

/** The status of a comment thread. Only "active" and "pending" threads are not resolved. */
export function threadIsResolved(status: string | null | undefined): boolean {
    return !['active', 'pending', 'unknown', undefined, null, ''].includes(status);
}

/**
 * Makes a thread ID that holds the repository, the pull request and the thread, so a call with only the ID
 * (for example "resolve the thread") can find the host and the repository. All Azure IDs start with "azure:".
 */
export function encodeAzureId(repo: AzureRepoRef, pullRequestId: number, threadId?: number): string {
    const parts = [repo.organization, repo.project, repo.repository, String(pullRequestId)];
    if (threadId !== undefined) parts.push(String(threadId));
    return `azure:${parts.map(encodeURIComponent).join('/')}`;
}

/** Reads an ID from `encodeAzureId`. Returns undefined for other IDs, for example GitHub node IDs. */
export function decodeAzureId(id: string): { repo: AzureRepoRef; pullRequestId: number; threadId?: number } | undefined {
    if (!id.startsWith('azure:')) return undefined;
    const parts = id.slice('azure:'.length).split('/').map(decodeURIComponent);
    if (parts.length < 4 || parts.length > 5) return undefined;
    const pullRequestId = Number(parts[3]);
    const threadId = parts[4] === undefined ? undefined : Number(parts[4]);
    if (!Number.isInteger(pullRequestId) || (threadId !== undefined && !Number.isInteger(threadId))) return undefined;
    return { repo: { organization: parts[0], project: parts[1], repository: parts[2] }, pullRequestId, threadId };
}

/** The state of the Azure DevOps token, for Settings › Code review. The page never gets the token. */
export interface AzureTokenStatus {
    /** True when a personal access token is saved. */
    saved: boolean;
    /** Where the token of the next request comes from. Undefined when no token is available. */
    source?: 'env' | 'saved' | 'az';
}

/** Returns true when an ID comes from `encodeAzureId`. */
export function isAzureId(id: string): boolean {
    return id.startsWith('azure:');
}
