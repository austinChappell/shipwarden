import type {
    BranchStatus,
    BranchSummary,
    CheckRun,
    CommitFiles,
    FileVersions,
    IssueReference,
    JobProgress,
    MergedPullRequest,
    MergeMethod,
    NewPullRequest,
    PendingComment,
    PullRequest,
    PullRequestCandidates,
    PullRequestChange,
    PullRequestFile,
    ReactionContent,
    RepoRef,
    RepoTarget,
    ReviewEvent,
    SourceHostKind,
    Workflow
} from '@shared/github';
import type { WorkflowRun } from '@shared/pipelines';
import type { GitHubService } from './github/github-service';

/**
 * A service that keeps repositories, pull requests and pipelines, for example GitHub or Azure DevOps.
 * The IPC handlers call the host of the target, so the page uses one API for all hosts.
 * A target is a worktree path or a GitHub repository of the Review view.
 */
export interface SourceHost {
    readonly kind: SourceHostKind;
    /** Returns the branch, its pull request and the commit for checks. Returns null when the worktree has no remote of this host. */
    branchStatus(root: string): Promise<BranchStatus | null>;
    branchSummaries(root: string): Promise<Record<string, BranchSummary>>;
    /** Returns the newest merged pull request of each branch, from the recently merged pull requests. One request. */
    mergedBranches(root: string): Promise<Record<string, MergedPullRequest>>;
    /** Creates a pull request from the branch of the worktree. Returns its number. */
    createPullRequest(root: string, request: NewPullRequest): Promise<number>;
    pullRequest(target: RepoTarget, number: number): Promise<PullRequest>;
    pullRequestFiles(target: RepoTarget, number: number): Promise<PullRequestFile[]>;
    setFileViewed(pullRequestId: string, path: string, viewed: boolean): Promise<void>;
    /** Returns the changed files of one commit and its first parent, for the diff of one commit. */
    commitFiles(target: RepoTarget, sha: string): Promise<CommitFiles>;
    fileVersions(target: RepoTarget, file: PullRequestFile, baseSha: string, headSha: string): Promise<FileVersions>;
    submitReview(target: RepoTarget, number: number, headSha: string, event: ReviewEvent, body: string, comments: PendingComment[]): Promise<void>;
    replyToComment(target: RepoTarget, number: number, commentId: number, body: string): Promise<void>;
    setThreadResolved(threadId: string, resolved: boolean): Promise<void>;
    /**
     * Adds (`on`) or removes a reaction of the user to a comment or a review. `subjectId` is the `id` of the item.
     * The host accepts only the reactions in `PullRequest.reactionKinds`.
     */
    setReaction(target: RepoTarget, number: number, subjectId: string, content: ReactionContent, on: boolean): Promise<void>;
    merge(target: RepoTarget, number: number, headSha: string, method: MergeMethod): Promise<void>;
    changePullRequest(target: RepoTarget, number: number, change: PullRequestChange): Promise<void>;
    pullRequestCandidates(target: RepoTarget): Promise<PullRequestCandidates>;
    /** The issues and the pull requests that match a "#" reference in a comment. A host without this feature returns an empty list. */
    issueReferences(target: RepoTarget, query: string): Promise<IssueReference[]>;
    checks(target: RepoTarget, sha: string): Promise<CheckRun[]>;
    jobProgress(target: RepoTarget, jobId: number): Promise<JobProgress>;
    jobLog(target: RepoTarget, jobId: number): Promise<string>;
    saveJobLog(target: RepoTarget, jobId: number): Promise<string>;
    rerunJob(target: RepoTarget, jobId: number): Promise<void>;
    rerunFailedJobs(target: RepoTarget, runId: number): Promise<void>;
    workflows(target: RepoTarget, ref: string): Promise<Workflow[]>;
    dispatchWorkflow(target: RepoTarget, workflowId: number, ref: string, inputs?: Record<string, string>): Promise<void>;
    workflowRuns(target: RepoTarget, workflowId?: number): Promise<WorkflowRun[]>;
    runJobs(target: RepoTarget, runId: number): Promise<CheckRun[]>;
    cancelRun(target: RepoTarget, runId: number): Promise<void>;
    rerunRun(target: RepoTarget, runId: number): Promise<void>;
    branches(target: RepoTarget): Promise<string[]>;
}

/** Adapts `GitHubService`, which takes a repository, to `SourceHost`, which takes a target. */
export class GitHubHost implements SourceHost {
    readonly kind = 'github' as const;

    constructor(
        private readonly github: GitHubService,
        private readonly repoOf: (target: RepoTarget) => Promise<RepoRef>
    ) {}

    branchStatus(root: string) {
        return this.github.branchStatus(root);
    }
    branchSummaries(root: string) {
        return this.github.branchSummaries(root);
    }
    mergedBranches(root: string) {
        return this.github.mergedBranches(root);
    }
    createPullRequest(root: string, request: NewPullRequest) {
        return this.github.createPullRequest(root, request);
    }
    async pullRequest(target: RepoTarget, number: number) {
        return this.github.pullRequest(await this.repoOf(target), number);
    }
    async pullRequestFiles(target: RepoTarget, number: number) {
        return this.github.pullRequestFiles(await this.repoOf(target), number);
    }
    setFileViewed(pullRequestId: string, path: string, viewed: boolean) {
        return this.github.setFileViewed(pullRequestId, path, viewed);
    }
    async commitFiles(target: RepoTarget, sha: string) {
        return this.github.commitFiles(await this.repoOf(target), sha);
    }
    async fileVersions(target: RepoTarget, file: PullRequestFile, baseSha: string, headSha: string) {
        return this.github.fileVersions(await this.repoOf(target), file, baseSha, headSha);
    }
    async submitReview(target: RepoTarget, number: number, headSha: string, event: ReviewEvent, body: string, comments: PendingComment[]) {
        return this.github.submitReview(await this.repoOf(target), number, headSha, event, body, comments);
    }
    async replyToComment(target: RepoTarget, number: number, commentId: number, body: string) {
        return this.github.replyToComment(await this.repoOf(target), number, commentId, body);
    }
    setThreadResolved(threadId: string, resolved: boolean) {
        return this.github.setThreadResolved(threadId, resolved);
    }
    setReaction(_target: RepoTarget, _number: number, subjectId: string, content: ReactionContent, on: boolean) {
        return this.github.setReaction(subjectId, content, on);
    }
    async merge(target: RepoTarget, number: number, headSha: string, method: MergeMethod) {
        return this.github.merge(await this.repoOf(target), number, headSha, method);
    }
    async changePullRequest(target: RepoTarget, number: number, change: PullRequestChange) {
        return this.github.changePullRequest(await this.repoOf(target), number, change);
    }
    async pullRequestCandidates(target: RepoTarget) {
        return this.github.pullRequestCandidates(await this.repoOf(target));
    }
    async issueReferences(target: RepoTarget, query: string) {
        return this.github.issueReferences(await this.repoOf(target), query);
    }
    async checks(target: RepoTarget, sha: string) {
        return this.github.checks(await this.repoOf(target), sha);
    }
    async jobProgress(target: RepoTarget, jobId: number) {
        return this.github.jobProgress(await this.repoOf(target), jobId);
    }
    async jobLog(target: RepoTarget, jobId: number) {
        return this.github.jobLog(await this.repoOf(target), jobId);
    }
    async saveJobLog(target: RepoTarget, jobId: number) {
        return this.github.saveJobLog(await this.repoOf(target), jobId);
    }
    async rerunJob(target: RepoTarget, jobId: number) {
        return this.github.rerunJob(await this.repoOf(target), jobId);
    }
    async rerunFailedJobs(target: RepoTarget, runId: number) {
        return this.github.rerunFailedJobs(await this.repoOf(target), runId);
    }
    async workflows(target: RepoTarget, ref: string) {
        return this.github.workflows(await this.repoOf(target), ref);
    }
    async dispatchWorkflow(target: RepoTarget, workflowId: number, ref: string, inputs?: Record<string, string>) {
        return this.github.dispatchWorkflow(await this.repoOf(target), workflowId, ref, inputs);
    }
    async workflowRuns(target: RepoTarget, workflowId?: number) {
        return this.github.workflowRuns(await this.repoOf(target), workflowId);
    }
    async runJobs(target: RepoTarget, runId: number) {
        return this.github.runJobs(await this.repoOf(target), runId);
    }
    async cancelRun(target: RepoTarget, runId: number) {
        return this.github.cancelRun(await this.repoOf(target), runId);
    }
    async rerunRun(target: RepoTarget, runId: number) {
        return this.github.rerunRun(await this.repoOf(target), runId);
    }
    async branches(target: RepoTarget) {
        return this.github.branches(await this.repoOf(target));
    }
}
