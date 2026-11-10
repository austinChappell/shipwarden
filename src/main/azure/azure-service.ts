import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    azureCreatePullRequestUrl,
    azureOrgUrl,
    azureProjectApi,
    decodeAzureId,
    fromRefName,
    parseAzureRemote,
    toRefName,
    voteForEvent,
    type AzureRepoRef
} from '@shared/azure-devops';
import {
    cleanActionsLog,
    type BranchStatus,
    type BranchSummary,
    type CheckRun,
    type FileVersions,
    type GitHubUser,
    type JobProgress,
    type MergeMethod,
    type NewPullRequest,
    type PendingComment,
    type PullRequest,
    type PullRequestCandidates,
    type PullRequestChange,
    type PullRequestFile,
    type RepoTarget,
    type ReviewEvent,
    type Workflow
} from '@shared/github';
import type { WorkflowRun } from '@shared/pipelines';
import type { SourceHost } from '../source-host';
import { AzureDevOpsClient, AzureError } from './azure-client';
import {
    branchSummaries,
    buildsForCommit,
    buildToCheck,
    buildToRun,
    gitStatusToCheckRun,
    mapChanges,
    mapPullRequest,
    mergeStrategyOf,
    orderedRecords,
    timelineToProgress,
    userOf,
    loginOf,
    type AzBuild,
    type AzBuildDefinition,
    type AzChangeEntry,
    type AzCommit,
    type AzGitStatus,
    type AzIdentity,
    type AzIteration,
    type AzList,
    type AzPullRequest,
    type AzRepository,
    type AzThread,
    type AzTimelineRecord
} from './azure-mapping';

/** The diff view does not load file versions that are larger than this limit. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** The empty identity. Azure DevOps turns off auto-complete when `autoCompleteSetBy` has this ID. */
const NO_IDENTITY = '00000000-0000-0000-0000-000000000000';

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

/** A repository with its ID and default branch from Azure DevOps. */
interface ResolvedRepo {
    ref: AzureRepoRef;
    id: string;
    defaultBranch: string;
    /** The base URL of the git API of the repository. */
    api: string;
}

/**
 * Reads and changes pull requests and pipelines of Azure Repos (Azure DevOps Services).
 * It takes only worktree paths as targets. The Review view and the Pipelines view list GitHub repositories only.
 */
export class AzureDevOpsService implements SourceHost {
    readonly kind = 'azure' as const;

    private readonly remotes = new Map<string, AzureRepoRef | null>();
    private readonly repositories = new Map<string, Promise<ResolvedRepo>>();
    private readonly viewers = new Map<string, Promise<string>>();
    /** The users of the default team of each project, for the reviewer picker. */
    private readonly members = new Map<string, AzIdentity[]>();
    /**
     * The files that the user marked as viewed, by pull request. Azure DevOps has no public API for this state,
     * so it stays in memory until the app quits.
     */
    private readonly viewed = new Map<string, Set<string>>();

    constructor(private readonly client: AzureDevOpsClient, private readonly readRemote: (root: string) => Promise<string> = root => git(root, ['remote', 'get-url', 'origin'])) {}

    /** Returns the Azure repository of a worktree from its "origin" remote. Returns null for other remotes. */
    async repoFor(root: string): Promise<AzureRepoRef | null> {
        if (!this.remotes.has(root)) {
            const url = await this.readRemote(root).catch(() => '');
            this.remotes.set(root, parseAzureRemote(url) ?? null);
        }
        return this.remotes.get(root)!;
    }

    /** True when the target is a worktree with an Azure Repos remote. */
    async owns(target: RepoTarget): Promise<boolean> {
        return typeof target === 'string' && (await this.repoFor(target)) !== null;
    }

    private async resolve(target: RepoTarget): Promise<ResolvedRepo> {
        if (typeof target !== 'string') {
            throw new AzureError('Azure DevOps needs a worktree. The Review view supports only GitHub.', 0);
        }
        const ref = await this.repoFor(target);
        if (!ref) {
            throw new AzureError('The "origin" remote of this worktree is not an Azure Repos repository.', 0);
        }
        const key = `${ref.organization}/${ref.project}/${ref.repository}`;
        let repo = this.repositories.get(key);
        if (!repo) {
            repo = (async () => {
                const data = await this.client.request<AzRepository>('GET', `${azureProjectApi(ref)}/git/repositories/${encodeURIComponent(ref.repository)}`);
                return {
                    ref,
                    id: data.id,
                    defaultBranch: fromRefName(data.defaultBranch) || 'main',
                    api: `${azureProjectApi(ref)}/git/repositories/${data.id}`
                };
            })();
            this.repositories.set(key, repo);
            repo.catch(() => this.repositories.delete(key));
        }
        return repo;
    }

    /** Returns the ID of the user of the token in the organization. */
    private viewerId(ref: AzureRepoRef): Promise<string> {
        let viewer = this.viewers.get(ref.organization);
        if (!viewer) {
            viewer = this.client.request<{ authenticatedUser: { id: string } }>('GET', `${azureOrgUrl(ref)}/_apis/connectionData`)
                .then(data => data.authenticatedUser.id);
            this.viewers.set(ref.organization, viewer);
            viewer.catch(() => this.viewers.delete(ref.organization));
        }
        return viewer;
    }

    private prApi(repo: ResolvedRepo, number: number): string {
        return `${repo.api}/pullrequests/${number}`;
    }

    async branchStatus(root: string): Promise<BranchStatus | null> {
        const ref = await this.repoFor(root);
        if (!ref) return null;
        const repo = await this.resolve(root);
        const branch = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
        const localSha = await git(root, ['rev-parse', 'HEAD']);
        let pullRequest: PullRequest | null = null;
        if (branch !== 'HEAD') {
            const list = await this.client.request<AzList<AzPullRequest>>('GET',
                `${repo.api}/pullrequests?searchCriteria.sourceRefName=${encodeURIComponent(toRefName(branch))}&searchCriteria.status=all&$top=20`);
            const newest = [...list.value].sort((a, b) => b.creationDate.localeCompare(a.creationDate));
            const pick = newest.find(pr => pr.status === 'active') ?? newest[0];
            if (pick) pullRequest = await this.pullRequest(root, pick.pullRequestId);
        }
        return {
            repo: { owner: `${ref.organization}/${ref.project}`, name: ref.repository },
            branch,
            sha: pullRequest?.state === 'OPEN' && pullRequest.headRefOid ? pullRequest.headRefOid : localSha,
            pullRequest,
            host: 'azure',
            createUrl: azureCreatePullRequestUrl(ref, branch)
        };
    }

    async branchSummaries(root: string): Promise<Record<string, BranchSummary>> {
        if (!(await this.repoFor(root))) return {};
        const repo = await this.resolve(root);
        const [prs, builds, viewerId] = await Promise.all([
            this.client.request<AzList<AzPullRequest>>('GET', `${repo.api}/pullrequests?searchCriteria.status=active&$top=100`),
            this.recentBuilds(repo, 200).catch(() => [] as AzBuild[]),
            this.viewerId(repo.ref).catch(() => undefined)
        ]);
        return branchSummaries(repo.ref, prs.value, builds, viewerId);
    }

    async createPullRequest(root: string, request: NewPullRequest): Promise<number> {
        const repo = await this.resolve(root);
        const branch = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
        if (branch === 'HEAD') {
            throw new AzureError('The worktree has no branch (detached HEAD).', 0);
        }
        const created = await this.client.request<AzPullRequest>('POST', `${repo.api}/pullrequests`, {
            sourceRefName: toRefName(branch),
            targetRefName: toRefName(request.base || repo.defaultBranch),
            title: request.title,
            description: request.body,
            isDraft: request.draft
        });
        return created.pullRequestId;
    }

    async pullRequest(target: RepoTarget, number: number): Promise<PullRequest> {
        const repo = await this.resolve(target);
        const base = this.prApi(repo, number);
        const [pr, threads, commits, iterations, viewerId] = await Promise.all([
            this.client.request<AzPullRequest>('GET', base),
            this.client.request<AzList<AzThread>>('GET', `${base}/threads`),
            this.client.request<AzList<AzCommit>>('GET', `${base}/commits?$top=100`),
            this.client.request<AzList<AzIteration>>('GET', `${base}/iterations`),
            this.viewerId(repo.ref).catch(() => undefined)
        ]);
        const iteration = iterations.value[iterations.value.length - 1];
        const changes = iteration ? await this.changes(repo, number, iteration.id).catch(() => undefined) : undefined;
        return mapPullRequest({
            repo: repo.ref,
            pr,
            threads: threads.value,
            commits: commits.value,
            iteration,
            changedFiles: changes?.length,
            viewerId
        });
    }

    /** Returns the changes of an iteration against the base of the pull request. */
    private async changes(repo: ResolvedRepo, number: number, iterationId: number): Promise<PullRequestFile[]> {
        const entries: AzChangeEntry[] = [];
        let skip = 0;
        // Azure DevOps returns at most 2000 changes in one page.
        for (let page = 0; page < 5; page++) {
            const data = await this.client.request<{ changeEntries: AzChangeEntry[]; nextSkip?: number; nextTop?: number }>('GET',
                `${this.prApi(repo, number)}/iterations/${iterationId}/changes?$compareTo=0&$top=2000&$skip=${skip}`);
            entries.push(...data.changeEntries);
            if (!data.nextSkip || !data.nextTop) break;
            skip = data.nextSkip;
        }
        return mapChanges(entries);
    }

    async pullRequestFiles(target: RepoTarget, number: number): Promise<PullRequestFile[]> {
        const repo = await this.resolve(target);
        const iterations = await this.client.request<AzList<AzIteration>>('GET', `${this.prApi(repo, number)}/iterations`);
        const last = iterations.value[iterations.value.length - 1];
        if (!last) return [];
        const viewed = this.viewed.get(this.viewedKey(repo.ref, number)) ?? new Set<string>();
        return (await this.changes(repo, number, last.id)).map(file => ({ ...file, viewed: viewed.has(file.path) }));
    }

    private viewedKey(ref: AzureRepoRef, number: number): string {
        return `${ref.organization}/${ref.project}/${ref.repository}#${number}`;
    }

    async setFileViewed(pullRequestId: string, filePath: string, viewed: boolean): Promise<void> {
        const decoded = decodeAzureId(pullRequestId);
        if (!decoded) throw new AzureError('The pull request ID is not an Azure DevOps ID.', 0);
        const key = this.viewedKey(decoded.repo, decoded.pullRequestId);
        const set = this.viewed.get(key) ?? new Set<string>();
        if (viewed) set.add(filePath); else set.delete(filePath);
        this.viewed.set(key, set);
    }

    async fileVersions(target: RepoTarget, file: PullRequestFile, baseSha: string, headSha: string): Promise<FileVersions> {
        const repo = await this.resolve(target);
        const read = async (filePath: string, sha: string): Promise<string | undefined> => {
            try {
                const text = await this.client.text(
                    `${repo.api}/items?path=${encodeURIComponent(`/${filePath}`)}&versionDescriptor.version=${encodeURIComponent(sha)}&versionDescriptor.versionType=commit&$format=octetStream&download=false`,
                    'application/octet-stream'
                );
                if (text.length > MAX_FILE_BYTES || text.slice(0, 8000).includes('\0')) return undefined;
                return text;
            } catch (error) {
                if (error instanceof AzureError && error.status === 404) return '';
                throw error;
            }
        };
        const [base, head] = await Promise.all([
            file.status === 'added' || !baseSha ? Promise.resolve('') : read(file.previousPath ?? file.path, baseSha),
            file.status === 'removed' ? Promise.resolve('') : read(file.path, headSha)
        ]);
        if (base === undefined || head === undefined) return { base: '', head: '', unavailable: true };
        return { base, head };
    }

    /**
     * Sends a review: each pending comment becomes a thread on its line, the body becomes a thread without a file,
     * and the event sets the vote of the user. A comment gives no vote.
     */
    async submitReview(target: RepoTarget, number: number, _headSha: string, event: ReviewEvent, body: string, comments: PendingComment[]): Promise<void> {
        const repo = await this.resolve(target);
        const base = this.prApi(repo, number);
        for (const comment of comments) {
            const start = { line: Math.min(comment.startLine ?? comment.line, comment.line), offset: 1 };
            const end = { line: comment.line, offset: 1 };
            const context = comment.side === 'LEFT'
                ? { filePath: `/${comment.path}`, leftFileStart: start, leftFileEnd: end }
                : { filePath: `/${comment.path}`, rightFileStart: start, rightFileEnd: end };
            await this.client.request('POST', `${base}/threads`, {
                comments: [{ parentCommentId: 0, content: comment.body, commentType: 'text' }],
                status: 'active',
                threadContext: context
            });
        }
        if (body.trim()) {
            await this.client.request('POST', `${base}/threads`, {
                comments: [{ parentCommentId: 0, content: body, commentType: 'text' }],
                status: 'active'
            });
        }
        const vote = voteForEvent(event);
        if (vote !== undefined) {
            const viewerId = await this.viewerId(repo.ref);
            await this.client.request('PUT', `${base}/reviewers/${viewerId}`, { vote });
        }
    }

    /** Adds a reply to a thread. `threadId` is the `databaseId` of the comments of the thread. */
    async replyToComment(target: RepoTarget, number: number, threadId: number, body: string): Promise<void> {
        const repo = await this.resolve(target);
        await this.client.request('POST', `${this.prApi(repo, number)}/threads/${threadId}/comments`, {
            content: body,
            parentCommentId: 1,
            commentType: 'text'
        });
    }

    async setThreadResolved(threadId: string, resolved: boolean): Promise<void> {
        const decoded = decodeAzureId(threadId);
        if (!decoded?.threadId) throw new AzureError('The thread ID is not an Azure DevOps thread ID.', 0);
        const { repo: ref, pullRequestId } = decoded;
        const data = await this.client.request<AzRepository>('GET', `${azureProjectApi(ref)}/git/repositories/${encodeURIComponent(ref.repository)}`);
        await this.client.request('PATCH', `${azureProjectApi(ref)}/git/repositories/${data.id}/pullrequests/${pullRequestId}/threads/${decoded.threadId}`, {
            status: resolved ? 'fixed' : 'active'
        });
    }

    /** Completes the pull request. Azure DevOps refuses it when the source branch has a newer commit than `headSha`. */
    async merge(target: RepoTarget, number: number, headSha: string, method: MergeMethod): Promise<void> {
        const repo = await this.resolve(target);
        await this.client.request('PATCH', this.prApi(repo, number), {
            status: 'completed',
            lastMergeSourceCommit: { commitId: headSha },
            completionOptions: { mergeStrategy: mergeStrategyOf(method) }
        });
    }

    async changePullRequest(target: RepoTarget, number: number, change: PullRequestChange): Promise<void> {
        const repo = await this.resolve(target);
        const base = this.prApi(repo, number);
        switch (change.kind) {
            case 'details': {
                const update: Record<string, unknown> = {};
                if (change.title !== undefined) update.title = change.title;
                if (change.body !== undefined) update.description = change.body;
                if (change.state) update.status = change.state === 'closed' ? 'abandoned' : 'active';
                await this.client.request('PATCH', base, update);
                return;
            }
            case 'draft':
                await this.client.request('PATCH', base, { isDraft: change.draft });
                return;
            case 'autoMerge':
                if (change.method) {
                    await this.client.request('PATCH', base, {
                        autoCompleteSetBy: { id: await this.viewerId(repo.ref) },
                        completionOptions: { mergeStrategy: mergeStrategyOf(change.method) }
                    });
                } else {
                    await this.client.request('PATCH', base, { autoCompleteSetBy: { id: NO_IDENTITY } });
                }
                return;
            case 'assignee':
                throw new AzureError('Azure DevOps pull requests have no assignees.', 0);
            case 'reviewer': {
                const id = await this.identityId(repo, number, change.reviewer.login);
                if (change.add) {
                    await this.client.request('PUT', `${base}/reviewers/${id}`, { vote: 0 });
                } else {
                    await this.client.request('DELETE', `${base}/reviewers/${id}`);
                }
                return;
            }
            case 'label':
                if (change.add) {
                    await this.client.request('POST', `${base}/labels`, { name: change.name });
                } else {
                    await this.client.request('DELETE', `${base}/labels/${encodeURIComponent(change.name)}`);
                }
                return;
        }
    }

    /** Finds the identity ID of a login: in the reviewers of the pull request, in the team members, else with the identity search. */
    private async identityId(repo: ResolvedRepo, number: number, login: string): Promise<string> {
        const pr = await this.client.request<AzPullRequest>('GET', this.prApi(repo, number));
        const known = [...(pr.reviewers ?? []), ...(this.members.get(this.membersKey(repo.ref)) ?? [])];
        const found = known.find(identity => loginOf(identity) === login);
        if (found) return found.id;
        const search = await this.client.request<AzList<{ id: string }>>('GET',
            `https://vssps.dev.azure.com/${encodeURIComponent(repo.ref.organization)}/_apis/identities?searchFilter=General&filterValue=${encodeURIComponent(login)}&queryMembership=None`);
        if (!search.value[0]) throw new AzureError(`Azure DevOps has no user "${login}".`, 404);
        return search.value[0].id;
    }

    private membersKey(ref: AzureRepoRef): string {
        return `${ref.organization}/${ref.project}`;
    }

    /** The members of the default team of the project, for the reviewer picker. Azure DevOps has no label list for a repository. */
    async pullRequestCandidates(target: RepoTarget): Promise<PullRequestCandidates> {
        const repo = await this.resolve(target);
        const project = await this.client.request<{ defaultTeam?: { id: string } }>('GET', `${azureOrgUrl(repo.ref)}/_apis/projects/${encodeURIComponent(repo.ref.project)}`);
        if (!project.defaultTeam) return { users: [], labels: [] };
        const members = await this.client.request<AzList<{ identity: AzIdentity }>>('GET',
            `${azureOrgUrl(repo.ref)}/_apis/projects/${encodeURIComponent(repo.ref.project)}/teams/${project.defaultTeam.id}/members?$top=200`);
        const identities = members.value.map(member => member.identity).filter(identity => !identity.isContainer);
        this.members.set(this.membersKey(repo.ref), identities);
        return { users: identities.map(userOf).filter((user): user is GitHubUser => !!user), labels: [] };
    }

    /** The newest builds of the repository, newest first. */
    private async recentBuilds(repo: ResolvedRepo, top: number, definitionId?: number): Promise<AzBuild[]> {
        const definition = definitionId ? `&definitions=${definitionId}` : '';
        const data = await this.client.request<AzList<AzBuild>>('GET',
            `${azureProjectApi(repo.ref)}/build/builds?repositoryId=${repo.id}&repositoryType=TfsGit&queryOrder=queueTimeDescending&$top=${top}${definition}`);
        return data.value;
    }

    /** The newest build of each pipeline for the commit, and the statuses of other services on the commit. */
    async checks(target: RepoTarget, sha: string): Promise<CheckRun[]> {
        const repo = await this.resolve(target);
        const [builds, statuses] = await Promise.all([
            this.recentBuilds(repo, 100),
            this.client.request<AzList<AzGitStatus>>('GET', `${repo.api}/commits/${sha}/statuses?latestOnly=true`).then(data => data.value, () => [] as AzGitStatus[])
        ]);
        return [
            ...buildsForCommit(builds, sha).map(build => buildToCheck(repo.ref, build)),
            ...statuses.map(gitStatusToCheckRun)
        ].sort((a, b) => a.name.localeCompare(b.name));
    }

    private build(repo: ResolvedRepo, buildId: number): Promise<AzBuild> {
        return this.client.request<AzBuild>('GET', `${azureProjectApi(repo.ref)}/build/builds/${buildId}`);
    }

    private async timeline(repo: ResolvedRepo, buildId: number): Promise<AzTimelineRecord[]> {
        const data = await this.client.request<{ records?: AzTimelineRecord[] } | undefined>('GET', `${azureProjectApi(repo.ref)}/build/builds/${buildId}/timeline`);
        return data?.records ?? [];
    }

    /** The status of a build and its tasks. `jobId` is the build ID, because a build is one check in the UI. */
    async jobProgress(target: RepoTarget, jobId: number): Promise<JobProgress> {
        const repo = await this.resolve(target);
        const [build, records] = await Promise.all([this.build(repo, jobId), this.timeline(repo, jobId)]);
        return timelineToProgress(build, records);
    }

    /**
     * The log of a build: the log of each task, in the order of the timeline, with a header line for each task.
     * The Job records have only a short log, so the task logs give the full output.
     */
    async jobLog(target: RepoTarget, jobId: number): Promise<string> {
        const repo = await this.resolve(target);
        const logs = `${azureProjectApi(repo.ref)}/build/builds/${jobId}/logs`;
        const records = await this.timeline(repo, jobId);
        const jobNames = new Map(orderedRecords(records, 'Job').map(job => [job.id, job.name]));
        const tasks = orderedRecords(records, 'Task').filter(task => task.log);
        if (tasks.length > 0) {
            const parts = await Promise.all(tasks.map(async task => {
                const job = task.parentId ? jobNames.get(task.parentId) : undefined;
                const title = job && jobNames.size > 1 ? `${job} › ${task.name}` : task.name;
                return `##[section]${title}\n${await this.client.text(`${logs}/${task.log!.id}`)}`;
            }));
            return cleanActionsLog(parts.join('\n'));
        }
        // A classic pipeline can have no job records with a log. Then all logs of the build go in the result.
        const list = await this.client.request<AzList<{ id: number }>>('GET', logs);
        const parts = await Promise.all(list.value.map(log => this.client.text(`${logs}/${log.id}`)));
        return cleanActionsLog(parts.join('\n'));
    }

    async saveJobLog(target: RepoTarget, jobId: number): Promise<string> {
        const repo = await this.resolve(target);
        const folder = path.join(os.homedir(), '.shipwarden', 'ci-logs');
        await fs.mkdir(folder, { recursive: true });
        const safe = (text: string) => text.replace(/[^A-Za-z0-9._-]+/g, '_');
        const file = path.join(folder, `${safe(repo.ref.organization)}-${safe(repo.ref.repository)}-build-${jobId}.log`);
        await fs.writeFile(file, await this.jobLog(target, jobId));
        return file;
    }

    /** Runs the failed jobs of a build again (retry). */
    async rerunJob(target: RepoTarget, jobId: number): Promise<void> {
        await this.rerunFailedJobs(target, jobId);
    }

    async rerunFailedJobs(target: RepoTarget, runId: number): Promise<void> {
        const repo = await this.resolve(target);
        await this.client.request('PATCH', `${azureProjectApi(repo.ref)}/build/builds/${runId}?retry=true`, {});
    }

    /** The pipelines (build definitions) of the repository. Each one can start by hand, except a disabled one. */
    async workflows(target: RepoTarget, _ref: string): Promise<Workflow[]> {
        const repo = await this.resolve(target);
        const data = await this.client.request<AzList<AzBuildDefinition>>('GET',
            `${azureProjectApi(repo.ref)}/build/definitions?repositoryId=${repo.id}&repositoryType=TfsGit`);
        return data.value.map(definition => ({
            id: definition.id,
            name: definition.name,
            path: definition.path ?? '\\',
            dispatchable: definition.queueStatus !== 'disabled',
            inputs: []
        }));
    }

    /** Queues a build of a pipeline on a branch. The inputs go to the template parameters of a YAML pipeline. */
    async dispatchWorkflow(target: RepoTarget, workflowId: number, ref: string, inputs?: Record<string, string>): Promise<void> {
        const repo = await this.resolve(target);
        await this.client.request('POST', `${azureProjectApi(repo.ref)}/build/builds`, {
            definition: { id: workflowId },
            sourceBranch: toRefName(ref),
            ...(inputs && Object.keys(inputs).length > 0 ? { templateParameters: inputs } : {})
        });
    }

    async workflowRuns(target: RepoTarget, workflowId?: number): Promise<WorkflowRun[]> {
        const repo = await this.resolve(target);
        return (await this.recentBuilds(repo, 40, workflowId)).map(build => buildToRun(repo.ref, build));
    }

    /** A build is one check in the UI, so the "jobs" of a run are the build itself. */
    async runJobs(target: RepoTarget, runId: number): Promise<CheckRun[]> {
        const repo = await this.resolve(target);
        return [buildToCheck(repo.ref, await this.build(repo, runId))];
    }

    async cancelRun(target: RepoTarget, runId: number): Promise<void> {
        const repo = await this.resolve(target);
        await this.client.request('PATCH', `${azureProjectApi(repo.ref)}/build/builds/${runId}`, { status: 'cancelling' });
    }

    /** Queues a new build of the same pipeline, branch and commit. */
    async rerunRun(target: RepoTarget, runId: number): Promise<void> {
        const repo = await this.resolve(target);
        const build = await this.build(repo, runId);
        await this.client.request('POST', `${azureProjectApi(repo.ref)}/build/builds`, {
            definition: { id: build.definition.id },
            sourceBranch: build.sourceBranch,
            sourceVersion: build.sourceVersion
        });
    }

    async branches(target: RepoTarget): Promise<string[]> {
        const repo = await this.resolve(target);
        const data = await this.client.request<AzList<{ name: string }>>('GET', `${repo.api}/refs?filter=heads/&$top=300`);
        const names = data.value.map(item => fromRefName(item.name)).filter(name => name !== repo.defaultBranch);
        return [repo.defaultBranch, ...names];
    }
}
