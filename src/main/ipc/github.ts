import { ipcMain, shell } from 'electron';
import { IpcChannels } from '@shared/api';
import type {
    MergeMethod,
    NewPullRequest,
    PendingComment,
    PullRequestChange,
    PullRequestFile,
    PullRequestFilter,
    RepoRef,
    RepoTarget,
    ReviewEvent
} from '@shared/github';
import type { ReviewProviderChange, ReviewProviderKind } from '@shared/review-providers';
import type { Services } from '../services';
import { isWebUrl, newPullRequestOf, onlyStrings, optionalString } from './args';

/** Registers the IPC handlers of the pull requests, the pipelines and the review providers (GitHub and Azure DevOps). */
export function registerGitHubIpc({ reviewProviders, seen }: Pick<Services, 'reviewProviders' | 'seen'>): void {
    // Each call goes to the provider of its target: Azure DevOps for a worktree with an Azure Repos remote, else GitHub.
    const host = (target: RepoTarget) => reviewProviders.for(target);
    ipcMain.handle(IpcChannels.githubStatus, (_event, root: string) => reviewProviders.branchStatus(root));
    ipcMain.handle(IpcChannels.githubBranchSummaries, (_event, repoPath: string) => reviewProviders.branchSummaries(repoPath));
    ipcMain.handle(IpcChannels.githubCreatePullRequest, async (_event, root: string, request: NewPullRequest) =>
        (await host(root)).createPullRequest(root, newPullRequestOf(request))
    );
    ipcMain.handle(IpcChannels.githubFiles, async (_event, target: RepoTarget, number: number) => (await host(target)).pullRequestFiles(target, number));
    ipcMain.handle(IpcChannels.githubFileVersions, async (_event, target: RepoTarget, file: PullRequestFile, baseSha: string, headSha: string) =>
        (await host(target)).fileVersions(target, file, baseSha, headSha)
    );
    ipcMain.handle(
        IpcChannels.githubSubmitReview,
        async (_event, target: RepoTarget, number: number, headSha: string, reviewEvent: ReviewEvent, body: string, comments: PendingComment[]) =>
            (await host(target)).submitReview(target, number, headSha, reviewEvent, body, comments)
    );
    ipcMain.handle(IpcChannels.githubReply, async (_event, target: RepoTarget, number: number, commentId: number, body: string) =>
        (await host(target)).replyToComment(target, number, commentId, body)
    );
    ipcMain.handle(IpcChannels.githubSetThreadResolved, async (_event, target: RepoTarget, threadId: string, resolved: boolean) =>
        (await host(target)).setThreadResolved(threadId, resolved)
    );
    ipcMain.handle(IpcChannels.githubMerge, async (_event, target: RepoTarget, number: number, headSha: string, method: MergeMethod) =>
        (await host(target)).merge(target, number, headSha, method)
    );
    ipcMain.handle(IpcChannels.githubChecks, async (_event, target: RepoTarget, sha: string) => (await host(target)).checks(target, sha));
    ipcMain.handle(IpcChannels.githubJobProgress, async (_event, target: RepoTarget, jobId: number) => (await host(target)).jobProgress(target, Number(jobId)));
    ipcMain.handle(IpcChannels.githubJobLog, async (_event, target: RepoTarget, jobId: number) => (await host(target)).jobLog(target, jobId));
    ipcMain.handle(IpcChannels.githubSaveJobLog, async (_event, target: RepoTarget, jobId: number) => (await host(target)).saveJobLog(target, jobId));
    ipcMain.handle(IpcChannels.githubRerunJob, async (_event, target: RepoTarget, jobId: number) => (await host(target)).rerunJob(target, jobId));
    ipcMain.handle(IpcChannels.githubRerunFailedJobs, async (_event, target: RepoTarget, runId: number) => (await host(target)).rerunFailedJobs(target, runId));
    ipcMain.handle(IpcChannels.githubWorkflows, async (_event, target: RepoTarget, ref: string) => (await host(target)).workflows(target, ref));
    ipcMain.handle(IpcChannels.githubDispatchWorkflow, async (_event, target: RepoTarget, workflowId: number, ref: string, inputs?: Record<string, string>) =>
        (await host(target)).dispatchWorkflow(target, workflowId, ref, inputs && typeof inputs === 'object' ? inputs : undefined)
    );
    ipcMain.handle(IpcChannels.githubWorkflowRuns, async (_event, target: RepoTarget, workflowId?: number) =>
        (await host(target)).workflowRuns(target, typeof workflowId === 'number' ? workflowId : undefined)
    );
    ipcMain.handle(IpcChannels.githubRunJobs, async (_event, target: RepoTarget, runId: number) => (await host(target)).runJobs(target, Number(runId)));
    ipcMain.handle(IpcChannels.githubCancelRun, async (_event, target: RepoTarget, runId: number) => (await host(target)).cancelRun(target, Number(runId)));
    ipcMain.handle(IpcChannels.githubRerunRun, async (_event, target: RepoTarget, runId: number) => (await host(target)).rerunRun(target, Number(runId)));
    ipcMain.handle(IpcChannels.githubBranches, async (_event, target: RepoTarget) => (await host(target)).branches(target));
    ipcMain.handle(IpcChannels.githubPullRequest, async (_event, target: RepoTarget, number: number) => (await host(target)).pullRequest(target, number));
    ipcMain.handle(IpcChannels.githubSetFileViewed, async (_event, target: RepoTarget, pullRequestId: string, path: string, viewed: boolean) =>
        (await host(target)).setFileViewed(pullRequestId, path, viewed)
    );
    ipcMain.handle(IpcChannels.githubPullRequestCandidates, async (_event, target: RepoTarget) => (await host(target)).pullRequestCandidates(target));
    ipcMain.handle(IpcChannels.githubChangePullRequest, async (_event, target: RepoTarget, number: number, change: PullRequestChange) =>
        (await host(target)).changePullRequest(target, number, change)
    );
    ipcMain.handle(IpcChannels.reviewProvidersList, () => reviewProviders.list());
    ipcMain.handle(IpcChannels.reviewProvidersAdd, (_event, kind: ReviewProviderKind, name: string) => reviewProviders.add(kind, String(name ?? '')));
    ipcMain.handle(IpcChannels.reviewProvidersUpdate, (_event, id: string, change: ReviewProviderChange) => reviewProviders.update(String(id), change ?? {}));
    ipcMain.handle(IpcChannels.reviewProvidersRemove, (_event, id: string) => reviewProviders.remove(String(id)));
    ipcMain.handle(IpcChannels.reviewProvidersSaveToken, (_event, id: string, token: string) => reviewProviders.saveToken(String(id), token));
    ipcMain.handle(IpcChannels.reviewProvidersClearToken, (_event, id: string) => reviewProviders.clearToken(String(id)));
    ipcMain.handle(IpcChannels.reviewProvidersTokenSource, (_event, id: string) => reviewProviders.tokenSource(String(id)));
    ipcMain.handle(IpcChannels.reviewProvidersTest, (_event, id: string, organization?: string) =>
        reviewProviders.test(String(id), optionalString(organization))
    );
    ipcMain.handle(IpcChannels.reviewProvidersGitHubOwners, (_event, id: string) => reviewProviders.githubOwners(String(id)));
    ipcMain.handle(IpcChannels.githubRepositories, () => reviewProviders.repositories());
    ipcMain.handle(IpcChannels.githubRepoOf, (_event, root: string) => reviewProviders.githubRepoFor(String(root)).catch(() => null));
    ipcMain.handle(IpcChannels.githubDashboardPullRequests, () => reviewProviders.dashboardPullRequests());
    ipcMain.handle(IpcChannels.githubDashboardComments, () => reviewProviders.dashboardComments());
    ipcMain.handle(IpcChannels.seenKeys, () => seen.keys());
    ipcMain.handle(IpcChannels.seenMark, (_event, keys: unknown) => seen.mark(onlyStrings(keys)));
    ipcMain.handle(IpcChannels.githubPullRequests, async (_event, repo: RepoRef, filter: PullRequestFilter, query?: string) =>
        (await reviewProviders.github(repo)).pullRequests({ owner: String(repo?.owner), name: String(repo?.name) }, filter, query)
    );
    ipcMain.on(IpcChannels.githubOpenInBrowser, (_event, url: string) => {
        // Commit statuses and task descriptions can link to other services, so any web URL is permitted.
        if (isWebUrl(url)) {
            shell.openExternal(url);
        }
    });
}
