import { execFile } from 'child_process';
import type {
    BranchStatus,
    BranchSummary,
    CheckRun,
    FileVersions,
    GitHubOwner,
    GitHubRepoInfo,
    MergeMethod,
    NewPullRequest,
    PendingComment,
    IssueReference,
    PullRequestCandidates,
    PullRequestChange,
    MergedPullRequest,
    PullRequest,
    PullRequestFile,
    PullRequestFilter,
    PullRequestInto,
    PullRequestSummary,
    ReactionContent,
    RepoRef,
    ReviewEvent,
    Workflow,
    JobProgress,
    CommitFiles
} from '@shared/github';
import type { DashboardPullRequests, PipelineApprovalItem, PullRequestCommentItem } from '@shared/dashboard';
import type { WorkflowRun } from '@shared/pipelines';
import type { WorkflowJobSpec } from '@shared/workflow-graph';
import type { RepoPullRequests } from '@shared/review-queue';
import type { GitHubClient } from './github-client';
import * as actions from './actions';
import { headOf, resolvePullTarget, setPullRequestInto, type PullTarget } from './fork-target';
import { DashboardLoader } from './dashboard-loader';
import * as pulls from './pull-requests';
import { fetchRepoPullRequests } from './repo-pull-requests';
import * as reviews from './review-actions';
import { commentOnGitHub, uploadToGitHub, type UploadFile } from '../screenshots/screenshot-upload';

export { githubViewerRole } from './pull-request-mapping';

function git(cwd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile('git', args, { cwd }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(`The command "git ${args.join(' ')}" failed: ${(stderr || error.message).trim()}`));
            } else {
                resolve(stdout.trim());
            }
        });
    });
}

/** Returns the owner of the fork when the pull requests go from a fork to its parent, else undefined. */
function forkOwner(target: PullTarget): string | undefined {
    return target.fork?.into === 'parent' ? target.headOwner : undefined;
}

/**
 * Reads and changes pull requests, reviews and GitHub Actions for the worktrees and the Review view.
 * The class sends each call to a module of this folder.
 */
export class GitHubService {
    private readonly dashboard: DashboardLoader;

    private readonly targets = new Map<string, Promise<PullTarget | null>>();

    /** The parent of each repository: a repository for a fork, else null. The key is "owner/name". */
    private readonly parents = new Map<string, RepoRef | null>();

    constructor(private readonly client: GitHubClient) {
        this.dashboard = new DashboardLoader(client);
    }

    /**
     * Returns the repository that gets the pull requests of the worktree. Returns null when "origin" is not a GitHub repository.
     * It is the "origin" repository, or the parent when "origin" is a fork (see `resolvePullTarget`).
     */
    async repoFor(root: string): Promise<RepoRef | null> {
        return (await this.pullTarget(root))?.repo ?? null;
    }

    /** Returns the pull request target of the worktree. A failed lookup is not kept, so the next call tries again. */
    private pullTarget(root: string): Promise<PullTarget | null> {
        let target = this.targets.get(root);
        if (!target) {
            target = resolvePullTarget(git, root, repo => this.parentOf(repo));
            this.targets.set(root, target);
            target.catch(() => this.targets.delete(root));
        }
        return target;
    }

    /** Returns the parent of a fork, or null for a repository that is not a fork. One request for each repository. */
    private async parentOf(repo: RepoRef): Promise<RepoRef | null> {
        const key = `${repo.owner}/${repo.name}`.toLowerCase();
        if (!this.parents.has(key)) {
            const info = await this.client.rest<{ fork?: boolean; parent?: { name: string; owner: { login: string } } }>(
                'GET',
                `/repos/${repo.owner}/${repo.name}`
            );
            this.parents.set(key, info.fork && info.parent ? { owner: info.parent.owner.login, name: info.parent.name } : null);
        }
        return this.parents.get(key)!;
    }

    /**
     * Selects the repository that gets the pull requests of a fork: the parent or the fork. The choice applies to all
     * worktrees of the repository, so all cached targets clear.
     */
    async setPullRequestInto(root: string, into: PullRequestInto): Promise<void> {
        const fork = (await this.pullTarget(root))?.fork;
        if (!fork) {
            throw new Error('The "origin" remote of this worktree is not a fork.');
        }
        try {
            await setPullRequestInto(git, root, fork, into);
        } finally {
            this.targets.clear();
        }
    }

    /** Returns the branch, the PR of the branch and the commit to show checks for. Returns null without a GitHub remote. */
    async branchStatus(root: string): Promise<BranchStatus | null> {
        const target = await this.pullTarget(root);
        if (!target) {
            return null;
        }
        const { repo } = target;
        const branch = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
        const localSha = await git(root, ['rev-parse', 'HEAD']);
        const found =
            branch === 'HEAD'
                ? []
                : await this.client.rest<{ number: number }[]>(
                      'GET',
                      `/repos/${repo.owner}/${repo.name}/pulls?state=all&sort=updated&direction=desc&head=${encodeURIComponent(`${target.headOwner}:${branch}`)}`
                  );
        const pullRequest = found.length > 0 ? await this.pullRequest(repo, found[0].number) : null;
        // The branches are always on "origin", also for a fork. The local check sends no request to GitHub.
        const pushed =
            branch !== 'HEAD' &&
            (await git(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]).then(
                () => true,
                () => false
            ));
        return {
            repo,
            branch,
            sha: pullRequest?.state === 'OPEN' ? pullRequest.headRefOid : localSha,
            pullRequest,
            pushed,
            ...(target.fork ? { fork: target.fork } : {})
        };
    }

    /**
     * Creates a pull request from the branch of the worktree. The base is the default branch when the request has none.
     * For a fork, the pull request goes to the selected repository, with the branch of the fork as its head. Returns its number.
     */
    async createPullRequest(root: string, request: NewPullRequest): Promise<number> {
        const target = await this.pullTarget(root);
        if (!target) {
            throw new Error('The "origin" remote of this worktree is not a GitHub repository.');
        }
        const branch = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
        if (branch === 'HEAD') {
            throw new Error('The worktree has no branch (detached HEAD).');
        }
        return pulls.createPullRequest(this.client, target.repo, headOf(target, branch), request);
    }

    /**
     * Returns the open pull requests of the repository by head branch, with the combined CI state.
     * One GraphQL request covers all worktrees, so the worktree list can poll it.
     */
    async branchSummaries(root: string): Promise<Record<string, BranchSummary>> {
        const target = await this.pullTarget(root);
        if (!target) {
            return {};
        }
        return pulls.fetchBranchSummaries(this.client, target.repo, forkOwner(target));
    }

    /** Returns the newest merged pull request of each branch. One GraphQL request covers all worktrees. */
    async mergedBranches(root: string): Promise<Record<string, MergedPullRequest>> {
        const target = await this.pullTarget(root);
        return target ? pulls.fetchMergedBranches(this.client, target.repo, forkOwner(target)) : {};
    }

    async pullRequest(repo: RepoRef, number: number): Promise<PullRequest> {
        return pulls.fetchPullRequest(this.client, repo, number);
    }

    /** Returns the users that the user can assign or ask for a review, and the labels of the repository. */
    async pullRequestCandidates(repo: RepoRef): Promise<PullRequestCandidates> {
        return pulls.fetchPullRequestCandidates(this.client, repo);
    }

    /** Returns the issues and the pull requests of the repository that match a "#" reference. */
    async issueReferences(repo: RepoRef, query: string): Promise<IssueReference[]> {
        return pulls.fetchIssueReferences(this.client, repo, query);
    }

    /** Returns the issue or the pull request with the number, or null when the repository has no item with the number. */
    async issueReference(repo: RepoRef, number: number): Promise<IssueReference | null> {
        return pulls.fetchIssueReference(this.client, repo, number);
    }

    /** Makes one change to a pull request: the details, an assignee, a reviewer or a label. */
    async changePullRequest(repo: RepoRef, number: number, change: PullRequestChange): Promise<void> {
        return reviews.changePullRequest(this.client, repo, number, change);
    }

    async pullRequestFiles(repo: RepoRef, number: number): Promise<PullRequestFile[]> {
        return pulls.fetchPullRequestFiles(this.client, repo, number);
    }

    /** Returns the changed files of one commit and its first parent. */
    async commitFiles(repo: RepoRef, sha: string): Promise<CommitFiles> {
        return pulls.fetchCommitFiles(this.client, repo, sha);
    }

    /** Marks a file of a pull request as viewed or not viewed, as the "Viewed" box on GitHub does. `pullRequestId` is the node ID. */
    async setFileViewed(pullRequestId: string, path: string, viewed: boolean): Promise<void> {
        return reviews.setFileViewed(this.client, pullRequestId, path, viewed);
    }

    /** Returns the review requests and the user's open pull requests that need an action, for the Dashboard. */
    async dashboardPullRequests(owners: string[] | 'all' | undefined): Promise<DashboardPullRequests> {
        return this.dashboard.dashboardPullRequests(owners);
    }

    /**
     * Returns the new comments for the Dashboard, on pull requests of the user or where the user commented or reviewed.
     * GitHub search is slow for these searches, so they come after the pull requests.
     */
    async dashboardComments(owners: string[] | 'all' | undefined): Promise<PullRequestCommentItem[]> {
        return this.dashboard.dashboardComments(owners);
    }

    /** Returns the runs of a repository that wait for the approval of the user, for the Dashboard. */
    async pendingApprovals(repo: RepoRef): Promise<PipelineApprovalItem[]> {
        return actions.fetchPendingApprovals(this.client, repo);
    }

    /** Approves the deployments of a waiting run to the environments. */
    async approveDeployments(repo: RepoRef, runId: number, environmentIds: number[]): Promise<void> {
        return actions.approveDeployments(this.client, repo, runId, environmentIds);
    }

    /** Returns the user and the organizations of the token, for the organization choice of the Review view. */
    async owners(): Promise<GitHubOwner[]> {
        return pulls.fetchOwners(this.client);
    }

    /**
     * Returns the repositories that the user can access, of the given owners (all owners when undefined),
     * the repository with the newest push first.
     */
    async repositories(owners?: string[]): Promise<GitHubRepoInfo[]> {
        return pulls.fetchRepositories(this.client, owners);
    }

    /**
     * Returns the pull requests of a repository for a filter of the Review view, the newest update first.
     * The closed list is shorter and has no CI state, because GitHub is slow to get the CI state of old pull requests.
     */
    async pullRequests(repo: RepoRef, filter: PullRequestFilter, query?: string): Promise<PullRequestSummary[]> {
        return pulls.fetchPullRequests(this.client, repo, filter, query);
    }

    /**
     * Returns the open pull requests of a repository (up to 100, the newest update first) for the Review view.
     * For each pull request, it tells if GitHub asks the viewer for a review, the last review of the viewer and the checks.
     * For a pull request to review again, it also counts the new commits and the resolved threads of the viewer.
     */
    async repoPullRequests(repo: RepoRef): Promise<RepoPullRequests> {
        return fetchRepoPullRequests(this.client, repo);
    }

    /** Returns the base and head versions of a file in a pull request. A missing version is an empty string. */
    async fileVersions(repo: RepoRef, file: PullRequestFile, baseSha: string, headSha: string): Promise<FileVersions> {
        return pulls.fetchFileVersions(this.client, repo, file, baseSha, headSha);
    }

    async submitReview(repo: RepoRef, number: number, headSha: string, event: ReviewEvent, body: string, comments: PendingComment[]): Promise<void> {
        return reviews.submitReview(this.client, repo, number, headSha, event, body, comments);
    }

    async replyToComment(repo: RepoRef, number: number, commentId: number, body: string): Promise<void> {
        return reviews.replyToComment(this.client, repo, number, commentId, body);
    }

    async setThreadResolved(threadId: string, resolved: boolean): Promise<void> {
        return reviews.setThreadResolved(this.client, threadId, resolved);
    }

    /** Adds (`on`) or removes a reaction of the user. `subjectId` is the node ID of a comment or a review. */
    async setReaction(subjectId: string, content: ReactionContent, on: boolean): Promise<void> {
        return reviews.setReaction(this.client, subjectId, content, on);
    }

    async merge(repo: RepoRef, number: number, headSha: string, method: MergeMethod): Promise<void> {
        return reviews.merge(this.client, repo, number, headSha, method);
    }

    /** Returns the check runs and the commit statuses of a commit. */
    async checks(repo: RepoRef, sha: string): Promise<CheckRun[]> {
        return actions.fetchChecks(this.client, repo, sha);
    }

    /** The status of a job and its steps. It works while the job runs, also when the log is not ready. */
    async jobProgress(repo: RepoRef, jobId: number): Promise<JobProgress> {
        return actions.fetchJobProgress(this.client, repo, jobId);
    }

    async jobLog(repo: RepoRef, jobId: number): Promise<string> {
        return actions.fetchJobLog(this.client, repo, jobId);
    }

    /** Saves the log of a job to a file, so that an agent can read the full log. Returns the file path. */
    async saveJobLog(repo: RepoRef, jobId: number): Promise<string> {
        return actions.saveJobLog(this.client, repo, jobId);
    }

    async rerunJob(repo: RepoRef, jobId: number): Promise<void> {
        return actions.rerunJob(this.client, repo, jobId);
    }

    async rerunFailedJobs(repo: RepoRef, runId: number): Promise<void> {
        return actions.rerunFailedJobs(this.client, repo, runId);
    }

    /** Lists the active workflows. A workflow is dispatchable when its file has a workflow_dispatch trigger. */
    async workflows(repo: RepoRef, ref: string): Promise<Workflow[]> {
        return actions.fetchWorkflows(this.client, repo, ref);
    }

    /** Starts a workflow with a `workflow_dispatch` trigger on a branch or tag, with the values of its inputs. */
    async dispatchWorkflow(repo: RepoRef, workflowId: number, ref: string, inputs?: Record<string, string>): Promise<void> {
        return actions.dispatchWorkflow(this.client, repo, workflowId, ref, inputs);
    }

    /** Returns the newest workflow runs of a repository, of one workflow when `workflowId` is set. */
    async workflowRuns(repo: RepoRef, workflowId?: number): Promise<WorkflowRun[]> {
        return actions.fetchWorkflowRuns(this.client, repo, workflowId);
    }

    /** Returns the jobs of the latest attempt of a run, as check runs, so the log view can show their logs. */
    async runJobs(repo: RepoRef, runId: number): Promise<CheckRun[]> {
        return actions.fetchRunJobs(this.client, repo, runId);
    }

    /** Returns one workflow run, for the workflow file and the commit of a check. */
    async workflowRun(repo: RepoRef, runId: number): Promise<WorkflowRun> {
        return actions.fetchWorkflowRun(this.client, repo, runId);
    }

    /** Returns the jobs of a workflow file at a commit, with their needs. Returns null when the file is not found. */
    async workflowJobs(repo: RepoRef, path: string, sha: string): Promise<WorkflowJobSpec[] | null> {
        return actions.fetchWorkflowJobs(this.client, repo, path, sha);
    }

    async cancelRun(repo: RepoRef, runId: number): Promise<void> {
        return actions.cancelRun(this.client, repo, runId);
    }

    /** Runs all jobs of a finished run again. */
    async rerunRun(repo: RepoRef, runId: number): Promise<void> {
        return actions.rerunRun(this.client, repo, runId);
    }

    /** Returns the branches of a repository (at most 300), the default branch first. */
    async branches(repo: RepoRef): Promise<string[]> {
        return pulls.fetchBranches(this.client, repo);
    }

    /** Commits the images to the screenshot branch and adds a comment with them to the pull request. */
    async postScreenshots(repo: RepoRef, number: number, files: UploadFile[], body: (urls: string[]) => string): Promise<string | undefined> {
        const urls = await uploadToGitHub(this.client, repo, number, files);
        return commentOnGitHub(this.client, repo, number, body(urls));
    }
}
