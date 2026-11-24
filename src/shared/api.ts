import type { AgentModel } from './agent-models';
import type { PairingOffer, RemoteDevicePermissions, RemoteStatus } from './remote';
import type { DashboardPullRequests, PipelineApprovalItem, PipelineApprovalTarget, PullRequestCommentItem } from './dashboard';
import type { RepoPullRequests } from './review-queue';
import type { Snooze, Snoozes } from './snooze';
import type { NoteInfo } from './notes';
import type { AppKeyAction, ShortcutAction } from './shortcuts';
import type { WorkflowRun } from './pipelines';
import type { ContentSearchResult, FileEntry, FilesChangedEvent } from './files';
import type { EditorList } from './editors';
import type { FileInfo } from './file-types';
import type {
    BranchStatus,
    BranchSummary,
    MergedPullRequest,
    CheckRun,
    CommitFiles,
    FileVersions,
    GitHubOwner,
    JobProgress,
    GitHubRepoInfo,
    MergeMethod,
    NewPullRequest,
    PullRequestInto,
    PendingComment,
    PullRequest,
    IssueReference,
    PullRequestCandidates,
    PullRequestChange,
    PullRequestFile,
    PullRequestFilter,
    PullRequestSummary,
    ReactionContent,
    RepoRef,
    RepoTarget,
    ReviewEvent,
    Workflow
} from './github';
import type { ReviewProviderChange, ReviewProviderInfo, ReviewProviderKind, ReviewTokenSource } from './review-providers';
import type { LspInstallState, LspMissingServer, LspServerInfo, LspServerMessage } from './lsp';
import type { ConnectionChange, ConnectionInfo, PluginInfo, Task, TaskLink, TaskScope, TaskSource } from './tasks';
import type { AgentPullRequestChange, McpApprovals, McpWatch } from './mcp';
import type { CliInstallState, CliPageRequest, CliPageResult } from './cli';
import type { AgentUpdate } from './agents';
import type { TranscriptChunk } from './agent-chat';
import type { AgentProgram } from './agent-programs';
import type { AskAgentRequest, AskAgentResult, SavedAnswer, SavedCodeAnswer } from './ask-agent';
import type { DraftRequest, DraftResult } from './drafts';
import type { ReviewCheckout, ReviewCheckoutStatus } from './review-checkout';
import type { AppSettings, CommandCheck } from './settings';
import type { HelpAction } from './onboarding';
import type { SetupCheckId, SetupCheckResult } from './setup-checks';
import type { ProjectsState, PullRepoResult, PullRepoTarget } from './projects';
import type { ProviderUsage } from './usage';
import type { UpdateState } from './updates';
import type { BranchDiff, ChangeContents, ChangeSide, CommitResult, FetchResult, GitChanges, RebaseConflictInput, RebaseResult } from './git';
import type { CompareGroup } from './agent-compare';
import type { QueueState } from './task-queue';
import type { StatsCiChange, StatsEvent, StatsStart } from './stats';
import type { Checkpoint, RewindOptions, RewindPreview, RewindResult } from './checkpoints';
import type { ScreenshotProgress, ScreenshotSide, ScreenshotState } from './screenshots';
import type { PinnedSession, PinRequest, ResumePlan } from './pinned-sessions';
import type { RecentSession } from './recent-sessions';
import type { TranscriptSearchQuery, TranscriptSearchResult } from './transcript-search';
import type { WorktreeFiles } from './worktree-overlap';
import type { WorktreeProcesses } from './processes';
import type { CreateTerminalOptions, TerminalReplay, TerminalSession, TerminalSettings } from './terminal';
import type { FileBlame, FileHistory } from './git-blame';
import type { GraphLog, GraphScope } from './git-graph';
import type { BranchDetails, DeleteBranchesResult } from './branches';
import type { BranchList, CreatedWorktree, CreateWorktreeOptions, CreateWorktreeProgress, RemoveWorktreeResult, Worktree } from './worktrees';
import type { CopyIgnoredSettings, CopyPreviewResult } from './worktree-settings';
import type { BrowserBounds, BrowserFindOptions, BrowserState } from './browser';
import type { Automation, AutomationList, AutomationRun, AutomationRunState, HttpMethod, TokenCount } from './automations';
import type { PromptTemplate, PromptTemplateList } from './prompt-templates';
import type { HttpResponse } from './automation-templates';
import type { Plan, PlanExploreRequest, PlanExploreResult } from './plans';
import type { GroupReviewAnswer, GroupReviewRequest, PrGroup } from './pr-groups';

/** Where a click on a notification goes. */
export type NotificationTarget = { view: 'worktree'; worktreePath: string; sessionId?: string } | { view: 'dashboard' } | { view: 'automations' };

/** A notification that the page asks the main process to show. */
export interface NotificationRequest {
    title: string;
    body?: string;
    /** The name of a macOS sound. Without it, the notification has no sound. */
    sound?: string | null;
    target?: NotificationTarget;
}

/** An item of a native context menu. */
/** A question of the main process for the dialog of the page. */
export interface ConfirmRequest {
    title: string;
    message?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
}

/** The state of the trusted extra certificates, for Settings › Network. */
export interface NetworkStatus {
    file?: { path: string; source: 'setting' | 'shell'; count?: number; error?: string };
    system?: { count?: number; error?: string };
    bundlePath?: string;
    /** NODE_EXTRA_CA_CERTS of the login shell. ShipWarden uses it when the file setting is empty. */
    shellFile?: string;
}

/** The API that the preload script gives to the renderer as `window.shipwarden`. */
export interface ShipWardenApi {
    app: {
        /** Brings the ShipWarden window to the front, for example after a click on a notification. */
        focus(): void;
        /** Facts about the app for the settings page. */
        info(): Promise<AppInfo>;
        /** Listens for the "Settings…" menu item (⌘,). The section is undefined for ⌘,. */
        onOpenSettings(listener: (section?: string) => void): () => void;
        /** The workspace shortcuts, for example ⌘T, ⌘W, ⌘D, ⌘[ and ⌘]. See `shortcutAction`. */
        onShortcut(listener: (action: ShortcutAction) => void): () => void;
        /** Questions from the main process. The page shows them in its own dialog and sends the answer with `answerConfirm`. */
        onConfirmRequest(listener: (id: number, request: ConfirmRequest) => void): () => void;
        answerConfirm(id: number, confirmed: boolean): void;
        /** The main process does not need the answer any more, for example after a timeout. The page closes the dialog. */
        onConfirmCancel(listener: (id: number) => void): () => void;
        /** Runs an app key (⌘Q, ⇧⌥⌘Q, ⌘, ⇧⌘U or ⌘H) that the page got. The main process normally reads these keys first. */
        runKey(action: AppKeyAction): void;
        /** Listens for the items of the Help menu: Show Welcome, Take the Tour and Keyboard Shortcuts. */
        onHelp(listener: (action: HelpAction) => void): () => void;
    };
    git: {
        /** The local changes of a worktree: staged, unstaged and conflicted files, and the branch state. */
        changes(worktree: string): Promise<GitChanges>;
        stage(worktree: string, paths: string[]): Promise<void>;
        unstage(worktree: string, paths: string[]): Promise<void>;
        /** The two versions of a changed file: HEAD and the index (staged), or the index and the working file (unstaged). */
        contents(worktree: string, path: string, side: ChangeSide, oldPath?: string): Promise<ChangeContents>;
        /** Commits the staged changes. The hooks of the repository run. */
        commit(worktree: string, message: string, amend: boolean): Promise<CommitResult>;
        lastMessage(worktree: string): Promise<string>;
        /** Pushes the branch. A branch without an upstream gets "origin" as its upstream. */
        push(worktree: string): Promise<void>;
        /**
         * Discards the unstaged changes of files. An untracked file goes to the Trash. A changed file gets the version of
         * the index, and a copy of the working version goes to the Trash.
         */
        discard(worktree: string, paths: string[]): Promise<void>;
        /** Pulls the upstream branch with a fast-forward only. */
        pull(worktree: string): Promise<void>;
        /** Fetches the upstream remote when the last fetch of the repository is older than 5 minutes, or now with `force`. */
        fetch(worktree: string, force?: boolean): Promise<FetchResult>;
        /** The newest commits for the graph, children before parents, at most `limit`. */
        log(worktree: string, scope: GraphScope, limit: number): Promise<GraphLog>;
        /** The changes of the branch since the merge base with the default branch of "origin", with the working files. */
        branchDiff(worktree: string): Promise<BranchDiff>;
        /** The version of a file at `base` (from `branchDiff`, else HEAD) and the working file. */
        branchContents(worktree: string, path: string, base: string | undefined, oldPath?: string): Promise<ChangeContents>;
        /**
         * The changed files of each linked worktree of a repository, for the overlap warning: the commits since the
         * merge base with the default branch, and the git status. Local git only. `repo` is the main worktree.
         */
        worktreeFiles(repo: string): Promise<WorktreeFiles[]>;
        /**
         * The last commit that changed each line of a file. With `contents`, git blames that text, so the lines match an
         * editor with changes that are not saved. Null when git does not know the file.
         */
        blame(worktree: string, path: string, contents?: string): Promise<FileBlame | null>;
        /** The commits that changed a file, newest first, at most `limit`. The history follows the renames. */
        fileHistory(worktree: string, path: string, limit: number): Promise<FileHistory>;
        /** The version of a file in the first parent of a commit and in the commit. `oldPath` is the path before a rename. */
        commitFileContents(worktree: string, commit: string, path: string, oldPath?: string): Promise<ChangeContents>;
        /** The default branch of "origin" without the remote, for example "main". Undefined when it is not known. Local git only. */
        defaultBranch(worktree: string): Promise<string | undefined>;
        /**
         * Fetches "origin" and rebases the branch onto "origin/<onto>", or onto the default branch without `onto`.
         * It refuses uncommitted changes and does not stash them. It never pushes. With `oldBases` (commits of the old
         * base of a stacked branch), it runs "git rebase --onto" and moves only the commits of the branch itself.
         */
        rebase(worktree: string, onto?: string, oldBases?: string[]): Promise<RebaseResult>;
        /** Runs "git rebase --continue" after the conflicts are resolved and staged. */
        rebaseContinue(worktree: string): Promise<RebaseResult>;
        /** Runs "git rebase --skip". The commit that stopped the rebase is lost. */
        rebaseSkip(worktree: string): Promise<RebaseResult>;
        /** Runs "git rebase --abort". */
        rebaseAbort(worktree: string): Promise<void>;
        /** The files, the stopped commit, and the commits of both sides of a rebase conflict, for an agent prompt. */
        rebaseConflict(worktree: string): Promise<RebaseConflictInput>;
        /** Pushes a rebased branch with "--force-with-lease". The UI asks the user first. */
        pushWithLease(worktree: string): Promise<void>;
    };
    updates: {
        /** The state of the updater: the running version, and a newer release when there is one. */
        state(): Promise<UpdateState>;
        /** Checks GitHub for a newer release now. */
        check(): Promise<UpdateState>;
        /** Downloads the update, checks it, and restarts the app into the new version. The terminals continue to run. */
        install(): Promise<void>;
        onState(listener: (state: UpdateState) => void): () => void;
        /** Listens for the result of a check from the "Check for Updates…" menu item (⇧⌘U). */
        onChecked(listener: (state: UpdateState) => void): () => void;
    };
    usage: {
        /** The last known plan usage of the agents. */
        get(): Promise<ProviderUsage[]>;
        /** Asks the providers again now. A provider that answered 429 waits until its wait ends. */
        refresh(): Promise<ProviderUsage[]>;
        onChanged(listener: (usage: ProviderUsage[]) => void): () => void;
    };
    ask: {
        /**
         * Asks the agent of the repository (else the default agent) a question in print mode, and returns the answer.
         * For a pull request, the agent runs in a local clone of the repository when a project has one, else in an
         * empty folder. For a worktree file, the agent runs in the worktree.
         */
        run(request: AskAgentRequest): Promise<AskAgentResult>;
        /**
         * Asks the agent of the repository of a worktree for a draft of a commit message or a pull request description.
         * The agent runs in print mode in the worktree. `cancel` with the same ID stops it.
         */
        draft(request: DraftRequest): Promise<DraftResult>;
        /** Stops a question that runs. */
        cancel(id: string): Promise<void>;
        /** Returns the saved questions and answers of a pull request, oldest first. */
        answers(repo: RepoRef, number: number): Promise<SavedAnswer[]>;
        /** Saves a question and its answer, or replaces the saved answer with the same ID. */
        saveAnswer(answer: SavedAnswer): Promise<void>;
        /** Removes a saved question and its answer. */
        removeAnswer(id: string): Promise<void>;
        /** Returns the saved questions and answers about a file in a worktree, oldest first. */
        codeAnswers(worktree: string, path: string): Promise<SavedCodeAnswer[]>;
        /** Saves a question about a worktree file and its answer, or replaces the saved answer with the same ID. */
        saveCodeAnswer(answer: SavedCodeAnswer): Promise<void>;
        /** Removes a saved question about a worktree file and its answer. */
        removeCodeAnswer(id: string): Promise<void>;
    };
    settings: {
        get(): Promise<AppSettings>;
        /** Changes some settings. Returns all settings after the change. */
        update(change: Partial<AppSettings>): Promise<AppSettings>;
        /** Finds the program of a command in the login shell PATH. */
        checkCommand(command: string): Promise<CommandCheck>;
        /**
         * Asks the agent program of a command for the models that the user can use now. Only for Claude Code and Codex.
         * Rejects with a message when the program does not send a list.
         */
        listModels(command: string): Promise<AgentModel[]>;
    };
    setup: {
        /**
         * Runs the setup checks of the welcome page. Without an ID, all checks run. With an ID, only that check runs, and
         * the list has one result. The checks do not call the GitHub API.
         */
        check(id?: SetupCheckId): Promise<SetupCheckResult[]>;
    };
    projects: {
        get(): Promise<ProjectsState>;
        /** Adds a project and makes it active. */
        create(name: string): Promise<ProjectsState>;
        rename(id: string, name: string): Promise<ProjectsState>;
        /** Removes a project. Its repositories stay on disk. */
        delete(id: string): Promise<ProjectsState>;
        setActive(id: string): Promise<ProjectsState>;
        /** Shows a folder dialog and adds the selected repository to the project. Returns the old state if the user cancels. */
        chooseRepo(id: string): Promise<ProjectsState>;
        /** Removes a repository from the project. The repository and its worktrees stay on disk. */
        removeRepo(id: string, repo: string): Promise<ProjectsState>;
        /** Moves a project to a new position in the project list. */
        move(id: string, toIndex: number): Promise<ProjectsState>;
        /** Moves a repository to a new position in the project. */
        moveRepo(id: string, repo: string, toIndex: number): Promise<ProjectsState>;
        /** Returns the main worktree of a project repository whose "origin" remote is the GitHub repository. Returns null when no project has a clone. */
        findRepo(repo: RepoRef): Promise<string | null>;
        /**
         * Adds a GitHub repository to a project and makes that project active. Without a clone in a project, it shows a
         * folder dialog and clones the repository into the selected folder. Returns null when the user cancels.
         */
        pullRepo(repo: RepoRef, target: PullRepoTarget): Promise<PullRepoResult | null>;
    };
    worktrees: {
        list(repoPath: string): Promise<Worktree[]>;
        /** Creates a worktree in the folder of the worktree settings and copies the matching git-ignored files into it. */
        create(options: CreateWorktreeOptions): Promise<CreatedWorktree>;
        /** Calls the listener for each step of a creation that has a `progressId`. Returns the function that removes it. */
        onProgress(listener: (progressId: string, progress: CreateWorktreeProgress) => void): () => void;
        /** The branches that a new worktree can start from, and the default start point (after a fetch of origin). */
        branches(repoPath: string): Promise<BranchList>;
        /**
         * Runs the teardown script of the repository (unless `skipTeardown`), then removes the worktree. With `force`,
         * git removes the worktree also with uncommitted changes or a lock. The uncommitted changes are lost.
         */
        remove(repoPath: string, worktreePath: string, options?: { skipTeardown?: boolean; force?: boolean }): Promise<RemoveWorktreeResult>;
        /** The git-ignored files and folders of the main worktree that the copy settings copy now, and the large ones in them. */
        previewCopy(repoPath: string, copy: CopyIgnoredSettings): Promise<CopyPreviewResult>;
        /**
         * Deletes a local branch. Without `force`, ShipWarden first pulls the start branch of the worktree. A failed pull
         * does not stop the delete. A branch that is not merged stays and `notMerged` is true. `mergedHead` is the head
         * commit of a merged pull request. A branch that points at this commit is deleted also after a squash merge.
         */
        deleteBranch(repoPath: string, branch: string, force?: boolean, mergedHead?: string): Promise<{ deleted: boolean; notMerged?: boolean }>;
        /**
         * The local and remote branches of a repository for the Branches page. With `fetch`, ShipWarden first fetches
         * all remotes and removes the remote branches that do not exist now.
         */
        branchDetails(repoPath: string, fetch?: boolean): Promise<BranchDetails>;
        /** Checks out a local branch or a remote branch in the main worktree. Returns the new branch list, without a fetch. */
        checkoutBranch(repoPath: string, name: string, kind: 'local' | 'remote'): Promise<BranchDetails>;
        /** Deletes local branches. Without `force`, a branch with commits that are not merged stays. */
        deleteBranches(repoPath: string, branches: string[], force?: boolean): Promise<DeleteBranchesResult>;
        /** Deletes a branch on its remote, for example "origin/feature". */
        deleteRemoteBranch(repoPath: string, name: string): Promise<void>;
        /** Fetches the upstream branch of a local branch and fast-forwards the local branch. Returns the new branch list, without a fetch of the other remotes. */
        pullBranch(repoPath: string, branch: string): Promise<BranchDetails>;
        /** The default folder of new worktrees, ~/.shipwarden/worktrees. */
        defaultFolder(): Promise<string>;
        /** Opens a folder dialog. Returns the folder, or undefined when the user cancels. */
        /** Shows a folder dialog. `title` is the title of the dialog. The default is the title for the worktree folder. */
        chooseFolder(title?: string): Promise<string | undefined>;
    };
    /** The external code editors, for "Open in editor". */
    editors: {
        /** Returns the installed editors and the editor that "Open in editor" uses now. */
        list(): Promise<EditorList>;
        /**
         * Opens the worktree in the editor of the settings. With `file` (relative to the root), the editor also opens
         * that file, at `line` when the editor accepts a line.
         */
        open(root: string, file?: string, line?: number): Promise<void>;
    };
    files: {
        /** Lists one folder of a worktree. `directory` is relative to the root. An empty string is the root. */
        listDirectory(root: string, directory: string): Promise<FileEntry[]>;
        /** Lists all files that git does not ignore, relative to the root. */
        listFiles(root: string): Promise<string[]>;
        /** Searches the file contents. The search ignores case when `caseSensitive` is false or not given. */
        searchContents(root: string, query: string, caseSensitive?: boolean): Promise<ContentSearchResult>;
        read(root: string, file: string): Promise<string>;
        /** Returns the size and the kind of a file. The page uses the kind to select a view. */
        info(root: string, file: string): Promise<FileInfo>;
        /** Shows the file in the Finder. */
        reveal(root: string, file: string): Promise<void>;
        /** Opens an image, PDF, audio or video file in the default app of macOS. Other files are refused. */
        openInDefaultApp(root: string, file: string): Promise<void>;
        write(root: string, file: string, content: string): Promise<void>;
        /** Makes an empty file. A path with "/" also makes the missing folders. */
        createFile(root: string, file: string): Promise<void>;
        /** Makes a folder. A path with "/" also makes the missing parent folders. */
        createFolder(root: string, folder: string): Promise<void>;
        /** Renames or moves a file or a folder in the worktree. */
        move(root: string, from: string, to: string): Promise<void>;
        /** Moves files and folders of the worktree to the Trash. */
        delete(root: string, paths: string[]): Promise<void>;
        /** Copies files and folders at absolute paths into a folder of the worktree. Returns the new relative paths. */
        copyIn(root: string, sources: string[], directory: string): Promise<string[]>;
        /** Returns the absolute path of a file that the user drops from the Finder. Returns an empty string for other files. */
        pathForFile(file: File): string;
        /** Reads a text file outside the worktrees, for example a type declaration that a definition points to. */
        readExternal(absolutePath: string): Promise<string>;
        /** Starts to send change events for the worktree. Each call needs one call of `unwatch`. */
        watch(root: string): void;
        unwatch(root: string): void;
        onChanged(listener: (event: FilesChangedEvent) => void): () => void;
    };
    /**
     * Pull requests, reviews and pipelines. The name is "github" for history. A worktree with an Azure Repos remote
     * goes to Azure DevOps. All other targets go to GitHub.
     */
    github: {
        /** Returns the branch, its pull request and the commit for checks. Returns null when the worktree has no remote of a review provider. */
        status(root: string): Promise<BranchStatus | null>;
        /** Creates a pull request from the branch of the worktree. Returns its number. */
        createPullRequest(root: string, request: NewPullRequest): Promise<number>;
        /**
         * Sets the repository that gets the pull requests of a fork, for all worktrees of the repository. It writes the
         * setting of `gh repo set-default` to the git config. For the parent, it adds an "upstream" remote when necessary.
         */
        setPullRequestInto(root: string, into: PullRequestInto): Promise<void>;
        files(target: RepoTarget, number: number): Promise<PullRequestFile[]>;
        /** Returns the changed files of one commit and its first parent, for the diff of one commit. */
        commitFiles(target: RepoTarget, sha: string): Promise<CommitFiles>;
        /** Returns the open pull requests of the repository by head branch, with their CI state. */
        branchSummaries(repoPath: string): Promise<Record<string, BranchSummary>>;
        /** Returns the newest merged pull request of each branch, from the 100 most recently merged pull requests. */
        mergedBranches(repoPath: string): Promise<Record<string, MergedPullRequest>>;
        fileVersions(target: RepoTarget, file: PullRequestFile, baseSha: string, headSha: string): Promise<FileVersions>;
        submitReview(target: RepoTarget, number: number, headSha: string, event: ReviewEvent, body: string, comments: PendingComment[]): Promise<void>;
        reply(target: RepoTarget, number: number, commentId: number, body: string): Promise<void>;
        setThreadResolved(target: RepoTarget, threadId: string, resolved: boolean): Promise<void>;
        /** Adds (`on`) or removes a reaction of the user to a comment or a review. `subjectId` is the `id` of the item. */
        setReaction(target: RepoTarget, number: number, subjectId: string, content: ReactionContent, on: boolean): Promise<void>;
        merge(target: RepoTarget, number: number, headSha: string, method: MergeMethod): Promise<void>;
        checks(target: RepoTarget, sha: string): Promise<CheckRun[]>;
        jobLog(target: RepoTarget, jobId: number): Promise<string>;
        /** The status of a job and its steps, also while it runs. */
        jobProgress(target: RepoTarget, jobId: number): Promise<JobProgress>;
        /** Saves a job log to a file and returns the file path. */
        saveJobLog(target: RepoTarget, jobId: number): Promise<string>;
        rerunJob(target: RepoTarget, jobId: number): Promise<void>;
        rerunFailedJobs(target: RepoTarget, runId: number): Promise<void>;
        workflows(target: RepoTarget, ref: string): Promise<Workflow[]>;
        /** Starts a workflow on a branch, with the values of its inputs. */
        dispatchWorkflow(target: RepoTarget, workflowId: number, ref: string, inputs?: Record<string, string>): Promise<void>;
        /** The newest workflow runs of a repository, of one workflow when `workflowId` is set. */
        workflowRuns(target: RepoTarget, workflowId?: number): Promise<WorkflowRun[]>;
        /** The jobs of the latest attempt of a run. */
        runJobs(target: RepoTarget, runId: number): Promise<CheckRun[]>;
        cancelRun(target: RepoTarget, runId: number): Promise<void>;
        /** Runs all jobs of a finished run again. */
        rerunRun(target: RepoTarget, runId: number): Promise<void>;
        /** The branches of a repository, the default branch first. */
        branches(target: RepoTarget): Promise<string[]>;
        /** Returns a pull request with its reviews and threads, for a repository without a worktree. */
        pullRequest(target: RepoTarget, number: number): Promise<PullRequest>;
        /** Marks a file of a pull request as viewed or not viewed. `pullRequestId` is the node ID of the pull request. */
        setFileViewed(target: RepoTarget, pullRequestId: string, path: string, viewed: boolean): Promise<void>;
        /** The users that the user can assign or ask for a review, and the labels of the repository. */
        pullRequestCandidates(target: RepoTarget): Promise<PullRequestCandidates>;
        /** The issues and the pull requests that match a "#" reference in a comment, the most recently updated first. */
        issueReferences(target: RepoTarget, query: string): Promise<IssueReference[]>;
        /** The issue or the pull request with the number, or null when the repository has no item with the number. */
        issueReference(target: RepoTarget, number: number): Promise<IssueReference | null>;
        /** Changes the details, the base branch, an assignee, a reviewer or a label of a pull request. */
        changePullRequest(target: RepoTarget, number: number, change: PullRequestChange): Promise<void>;
        /** The repositories of all GitHub providers that are on, each in the organizations of its scope. */
        repositories(): Promise<GitHubRepoInfo[]>;
        /** The GitHub repository of a local repository, from its "origin" remote. Null for a different remote. */
        repoOf(root: string): Promise<RepoRef | null>;
        /** The pull requests of a repository for a filter of the Review view. */
        pullRequests(repo: RepoRef, filter: PullRequestFilter, query?: string): Promise<PullRequestSummary[]>;
        /** The open pull requests of a repository, with the review state of the viewer, for the Review view. */
        repoPullRequests(repo: RepoRef): Promise<RepoPullRequests>;
        /** The review requests and the user's pull requests that need an action, from all GitHub providers that are on. */
        dashboardPullRequests(): Promise<DashboardPullRequests>;
        /** The new comments on pull requests for the Dashboard, from all GitHub providers that are on. */
        dashboardComments(): Promise<PullRequestCommentItem[]>;
        /** The pipeline runs that wait for the approval of the user: GitHub Actions deployments and Azure Pipelines stages. */
        dashboardApprovals(): Promise<PipelineApprovalItem[]>;
        /** Approves a pipeline run that waits for the user. */
        approvePipeline(target: PipelineApprovalTarget): Promise<void>;
        /** Opens a web page (http or https) in the default browser. */
        openInBrowser(url: string): void;
    };
    reviewProviders: {
        /** The code review providers of Settings › Code review. */
        list(): Promise<ReviewProviderInfo[]>;
        add(kind: ReviewProviderKind, name: string): Promise<ReviewProviderInfo>;
        update(id: string, change: ReviewProviderChange): Promise<void>;
        /** Removes the provider and its saved token. */
        remove(id: string): Promise<void>;
        /** Saves a personal access token for the provider, encrypted with the macOS keychain. */
        saveToken(id: string, token: string): Promise<void>;
        clearToken(id: string): Promise<void>;
        /** Where the next request of the provider gets its token. Undefined when no token is available. */
        tokenSource(id: string): Promise<ReviewTokenSource | undefined>;
        /** Sends a request with the token of the provider. Returns the name of the user of the token. Azure DevOps needs an organization. */
        test(id: string, organization?: string): Promise<string>;
        /** The user and the organizations of a GitHub provider. */
        githubOwners(id: string): Promise<GitHubOwner[]>;
        onChanged(listener: () => void): () => void;
    };
    plans: {
        /** The plans of all projects, the newest change first. */
        list(): Promise<Plan[]>;
        /** Writes a plan and returns the saved copy. */
        save(plan: Plan): Promise<Plan>;
        remove(id: string): Promise<void>;
        /** Runs the agent in print mode on all repositories of the project. The agent does not change files. */
        explore(request: PlanExploreRequest): Promise<PlanExploreResult>;
        /** Stops an exploration that runs. */
        cancelExplore(id: string): Promise<void>;
    };
    prGroups: {
        /** The PR groups of the Review view, the newest change first. */
        list(): Promise<PrGroup[]>;
        /** Writes a group and returns the saved copy. */
        save(group: PrGroup): Promise<PrGroup>;
        remove(id: string): Promise<void>;
        /**
         * Makes a local copy of each pull request, and runs the agent in print mode on all copies.
         * The agent does not change files and posts nothing.
         */
        review(request: GroupReviewRequest): Promise<GroupReviewAnswer>;
        /** Stops a group review that runs. */
        cancelReview(id: string): Promise<void>;
    };
    pins: {
        /** The pinned Claude Code sessions, the newest pin or resume first. */
        list(): Promise<PinnedSession[]>;
        /** Pins a session. An agent gives it a name after the pin. A session with a pin keeps its pin. */
        pin(request: PinRequest): Promise<PinnedSession>;
        /** Gives a pin the name of the user. */
        rename(id: string, name: string): Promise<PinnedSession>;
        remove(id: string): Promise<void>;
        /**
         * Makes the session available in a folder and returns the command that resumes it. A folder other than the
         * folder of the session gets a copy of the transcript.
         */
        prepareResume(id: string, target: { cwd: string; repoPath?: string; branch?: string }): Promise<ResumePlan>;
        /** The new list after each change, also after the agent gives a name. */
        onChanged(listener: (pins: PinnedSession[]) => void): () => void;
    };
    recentSessions: {
        /** The interactive Claude Code sessions of the last 3 days, the newest first. The list includes pinned sessions. */
        list(): Promise<RecentSession[]>;
        /**
         * Makes a recent session available in a folder and returns the command that resumes it. A folder other than the
         * folder of the session gets a copy of the transcript.
         */
        prepareResume(transcript: string, target: { cwd: string }): Promise<ResumePlan>;
    };
    transcriptSearch: {
        /**
         * Finds the Claude Code sessions whose prompts, agent text, or tool call file paths match the query. The index is
         * on this Mac. The result tells the progress while the index reads transcripts.
         */
        search(query: TranscriptSearchQuery): Promise<TranscriptSearchResult>;
    };
    compare: {
        /** The agent comparisons (one task, several agents), the newest change first. */
        list(): Promise<CompareGroup[]>;
        /** Writes a comparison and returns the saved copy. */
        save(group: CompareGroup): Promise<CompareGroup>;
        remove(id: string): Promise<void>;
    };
    stats: {
        /** The events of the agent stats log (`agent-stats.jsonl`), the oldest first. Local data: no request goes to a service. */
        events(): Promise<StatsEvent[]>;
        /** Records the start of work on a task in a new worktree. */
        started(start: StatsStart): Promise<void>;
        /** Records the CI state of the pull request of a worktree. The main process ignores a state that it has already. */
        ci(change: StatsCiChange): Promise<void>;
    };
    checkpoints: {
        /** The checkpoints of the agent turns in a worktree, the newest first. Local data: git runs on this Mac. */
        list(worktree: string): Promise<Checkpoint[]>;
        /** Shows what a rewind to a checkpoint changes. `session` is the agent session of the checkpoint. */
        preview(worktree: string, ref: string, session: string): Promise<RewindPreview>;
        /** Restores the files of the worktree to a checkpoint. */
        rewind(worktree: string, ref: string, options: RewindOptions): Promise<RewindResult>;
        /** Gets the worktree folder after each new checkpoint. */
        onChanged(listener: (worktree: string) => void): () => void;
    };
    screenshots: {
        /** The screenshots of the branch of a worktree, and the branches of both sides. Local data. */
        get(worktree: string): Promise<ScreenshotState>;
        /**
         * Captures the pages of the repository settings for one side. "branch" records the worktree. "base" records the
         * main worktree. The user runs the dev server in that worktree. ShipWarden never starts or stops it.
         */
        capture(worktree: string, side: ScreenshotSide): Promise<ScreenshotState>;
        /** One image as a data URL, or null when there is no image. */
        image(worktree: string, side: ScreenshotSide, page: string): Promise<string | null>;
        /** Removes the screenshots of the branch of a worktree. */
        clear(worktree: string): Promise<void>;
        /** Uploads the images and adds a comment with them to the pull request. Returns the address of the comment when known. */
        post(worktree: string, number: number): Promise<string | undefined>;
        /** Gets the progress of each capture. */
        onProgress(listener: (progress: ScreenshotProgress) => void): () => void;
    };
    queue: {
        /** The task queue: its items in order, and its settings. */
        get(): Promise<QueueState>;
        /** Writes the full queue and returns the saved copy. The page is the only writer. */
        save(state: QueueState): Promise<QueueState>;
    };
    automations: {
        /** The automations in ~/.shipwarden/automations, and the files that ShipWarden could not read. */
        list(): Promise<AutomationList>;
        /** Writes the automation to its file. With `previousId`, the automation had another ID before, and its old file goes away. */
        save(automation: Automation, previousId?: string): Promise<Automation>;
        /** Moves the file of the automation to the Trash. */
        remove(id: string): Promise<void>;
        /** Shows the file of the automation, or the folder without an ID, in Finder. */
        reveal(id?: string): void;
        /** The JSON text of the portable part of the automation. It has no paths and no IDs of this Mac. */
        exportText(id: string): Promise<string>;
        /** Asks for a file name and writes the export to it. Returns false when the user cancelled. */
        exportToFile(id: string): Promise<boolean>;
        /** Asks for a JSON file and returns its text. Undefined when the user cancelled. */
        importFromFile(): Promise<string | undefined>;
        /** Puts the export of the automation on the clipboard. */
        copyExport(id: string): Promise<void>;
        /** Returns the text of the clipboard. */
        readClipboard(): Promise<string>;
        /** The run history, the fired event keys and the times of the last schedule runs. */
        runs(): Promise<AutomationRunState>;
        /** Records a new run. Returns null when the automation already fired for the same event. */
        claim(run: AutomationRun): Promise<AutomationRun | null>;
        updateRun(
            id: string,
            change: Partial<Pick<AutomationRun, 'status' | 'detail' | 'worktreePath' | 'sessionId' | 'noteName' | 'tokens' | 'cacheReads' | 'turn'>>
        ): Promise<AutomationRun | undefined>;
        /**
         * Counts the tokens of the responses of a Claude Code transcript from `from` to `to` (milliseconds). Input, cache
         * writes and output count. Cache reads do not count.
         */
        countTokens(transcript: string, from: number, to?: number): Promise<TokenCount>;
        /**
         * Records event keys as fired without runs, for the first task list of an automation. `scope` is the entry for
         * `seeded`, for example "<automation ID>|<collection ID>". The default is the automation ID.
         */
        seed(automationId: string, keys: string[], scope?: string): Promise<void>;
        setScheduleRun(automationId: string, at: number): Promise<void>;
        /** Removes the closed runs from the history. */
        clearHistory(): Promise<void>;
        /**
         * Sends the HTTP request of an automation action from the main process, with the trusted certificates of
         * Settings › Network. The answer keeps at most 1 MB of the body. Throws an error when no answer comes.
         */
        http(request: { method: HttpMethod; url: string; headers: Record<string, string>; body?: string; timeoutSeconds?: number }): Promise<HttpResponse>;
        /** Called when a file in the automations folder changes, also from another app. */
        onChanged(listener: () => void): () => void;
        /**
         * True while this app holds the automation lock. Only the owner of the lock runs the automations and the task
         * queue. The background helper holds it while no window is open.
         */
        engineOwned(): Promise<boolean>;
        /** Called when this app gets or loses the automation lock. */
        onEngineChanged(listener: (owned: boolean) => void): () => void;
        /** Called when the phone approves (`approve` true) or skips a run that waits for approval. */
        onAnswerRun(listener: (runId: string, approve: boolean) => void): () => void;
    };
    prompts: {
        /** The prompt templates in ~/.shipwarden/prompts, and the files that ShipWarden could not read. */
        list(): Promise<PromptTemplateList>;
        /** Writes the template to its file. With `previousId`, the template had another ID before, and its old file goes away. */
        save(template: PromptTemplate, previousId?: string): Promise<PromptTemplate>;
        /** Moves the file of the template to the Trash. */
        remove(id: string): Promise<void>;
        /** Shows the file of the template, or the folder without an ID, in Finder. */
        reveal(id?: string): void;
        /** Called when a file in the prompts folder changes, also from another app. */
        onChanged(listener: () => void): () => void;
    };
    notes: {
        /** The folder of the notes, ~/.shipwarden/notes. */
        folder(): Promise<string>;
        /** All notes. `name` is the path of the note: "file.md", or "folder/file.md". */
        list(): Promise<NoteInfo[]>;
        /** The folders of the notes, also the empty folders. A folder is one level deep. */
        folders(): Promise<string[]>;
        createFolder(name: string): Promise<string>;
        /** Renames a folder. Its notes keep their tags. */
        renameFolder(name: string, newName: string): Promise<string>;
        /** Moves a folder and its notes to the Trash. */
        deleteFolder(name: string): Promise<void>;
        read(name: string): Promise<string>;
        write(name: string, content: string): Promise<void>;
        create(name: string, content?: string): Promise<NoteInfo>;
        /** Renames a note, or moves it to another folder ("folder/file.md") or to the top level ("file.md"). */
        rename(name: string, newName: string): Promise<NoteInfo>;
        /** Moves the note file to the Trash. */
        delete(name: string): Promise<void>;
        setTags(name: string, tags: string[]): Promise<NoteInfo>;
        /** Shows the note file, or the folder without a name, in Finder. */
        reveal(name?: string): void;
        /** Called when a file in the notes folder changes, also from another app. */
        onChanged(listener: () => void): () => void;
    };
    notifications: {
        /** Shows a macOS notification. A click on it calls the `onClick` listeners with its target. */
        show(request: NotificationRequest): void;
        /** Plays a macOS sound, for the preview in the settings. */
        playSound(name: string): void;
        onClick(listener: (target: NotificationTarget | undefined) => void): () => void;
    };
    network: {
        /** The trusted extra certificates, and NODE_EXTRA_CA_CERTS of the login shell. */
        status(): Promise<NetworkStatus>;
        /** Connects to GitHub and ClickUp and returns the result of each. */
        test(): Promise<{ name: string; ok: boolean; error?: string }[]>;
        /** Opens a file dialog for a CA certificates file. Returns the path, or undefined when the user cancels. */
        chooseCaFile(): Promise<string | undefined>;
    };
    remote: {
        /** The state of the phone connection: the server, the addresses and the paired phones. */
        status(): Promise<RemoteStatus>;
        /** Makes a new pairing code for a QR code. The old code stops. */
        startPairing(): Promise<PairingOffer>;
        cancelPairing(): Promise<void>;
        /** Removes a paired phone. Its token stops at once. */
        removeDevice(id: string): Promise<void>;
        /** Changes the permissions of a paired phone, for example "Start agents". */
        setDevicePermissions(id: string, permissions: RemoteDevicePermissions): Promise<void>;
        /** Called when a phone pairs, connects or disconnects. */
        onChanged(listener: () => void): () => void;
    };
    snoozes: {
        /** The snoozes of pull requests that did not end, by key. */
        list(): Promise<Snoozes>;
        /** Sets the snooze of a pull request. Null removes the snooze. */
        set(key: string, snooze: Snooze | null): Promise<void>;
    };
    seen: {
        /** The keys of the comments that the user saw in ShipWarden. */
        keys(): Promise<string[]>;
        /** Records that the user saw these comments. */
        mark(keys: string[]): Promise<void>;
    };
    tasks: {
        /** Lists the task plugins that ShipWarden found: the kinds of task manager that the user can add. */
        plugins(): Promise<PluginInfo[]>;
        /** All configured task managers (connections), with the state of their settings. */
        connections(): Promise<ConnectionInfo[]>;
        /** Adds a connection of a plugin. It is on and includes all scopes. */
        addConnection(pluginId: string, name: string): Promise<ConnectionInfo>;
        /** Changes the name, the scope (null for all) or the on/off state of a connection. */
        updateConnection(id: string, change: ConnectionChange): Promise<void>;
        /** Saves the settings of a connection. An empty secret keeps its old value. */
        saveConnectionSettings(id: string, values: Record<string, string | boolean>): Promise<void>;
        removeConnection(id: string): Promise<void>;
        /** The scopes that a connection can include, for example ClickUp workspaces or GitHub organizations. */
        scopes(connectionId: string): Promise<TaskScope[]>;
        /** The connections that are on. All projects use these. */
        enabledConnections(): Promise<ConnectionInfo[]>;
        /** Starts the plugin of a connection and returns its description. All projects use the same plugin process. */
        source(connectionId: string): Promise<TaskSource>;
        /** Sends a protocol request, for example "tasks/list", to the plugin of a connection. */
        request(connectionId: string, method: string, params: unknown): Promise<unknown>;
        links(): Promise<Record<string, TaskLink>>;
        setLink(worktreePath: string, link: TaskLink | null): Promise<void>;
        /** Returns the collection that the user selected last for a connection. */
        selectedCollection(connectionId: string): Promise<string | undefined>;
        setSelectedCollection(connectionId: string, collectionId: string): Promise<void>;
        /** Returns the connection that the Tasks view showed last. */
        selectedConnection(): Promise<string | undefined>;
        setSelectedConnection(connectionId: string): Promise<void>;
        onChanged(listener: (connectionId: string) => void): () => void;
        /** A change of one task from the main process, for example from the MCP tool set_task_status. The page patches its cache. */
        onTaskChanged(listener: (connectionId: string, taskId: string, patch: Partial<Task>) => void): () => void;
    };
    mcp: {
        /** The write tools that the user approved in each worktree. */
        approvals(): Promise<McpApprovals>;
        /** Removes the approvals of a worktree. Returns the approvals after the change. */
        revoke(worktree: string): Promise<McpApprovals>;
        /** Gets all approvals after each change. */
        onApprovalsChanged(listener: (approvals: McpApprovals) => void): () => void;
        /** The watches of watch_pull_request. */
        watches(): Promise<McpWatch[]>;
        /** Ends a watch. */
        unwatch(id: string): Promise<void>;
        /** Gets all watches after each change. */
        onWatchesChanged(listener: (watches: McpWatch[]) => void): () => void;
        /** A pull request tool changed a pull request. The page patches its cache. */
        onPullRequestChanged(listener: (change: AgentPullRequestChange) => void): () => void;
    };
    cli: {
        /** The state of the `shipwarden` link. */
        installState(): Promise<CliInstallState>;
        /** Adds the link in /usr/local/bin or ~/.local/bin. Returns the new state. */
        install(): Promise<CliInstallState>;
        /** Removes the link. Returns the new state. */
        remove(): Promise<CliInstallState>;
        /** A command of the CLI that the page runs. The page answers with `answer`. */
        onPageRequest(listener: (id: number, request: CliPageRequest) => void): () => void;
        answer(id: number, result: CliPageResult | undefined, error?: string): void;
    };
    review: {
        /** Returns the local copy of a pull request, and if a copy needs a clone of the repository first. */
        checkoutStatus(repo: RepoRef, number: number): Promise<ReviewCheckoutStatus>;
        /**
         * Makes or updates the local copy of a pull request at the commit `sha`. The copy is a detached git worktree
         * in ~/.shipwarden/review. It clones the repository first only when `allowClone` is true.
         */
        checkout(repo: RepoRef, number: number, sha: string, allowClone: boolean): Promise<ReviewCheckout>;
        /** Stops the language servers of a copy. The copy stays on disk. */
        release(root: string): Promise<void>;
    };
    lsp: {
        /** Starts the language server for the language in the worktree. Returns undefined when no server is available. */
        ensure(root: string, languageId: string): Promise<LspServerInfo | undefined>;
        /** Returns the server that the language needs in the worktree, when the server is not installed. */
        missing(root: string, languageId: string): Promise<LspMissingServer | undefined>;
        /**
         * Installs a missing server into the folder of the app. Call it only after the user agrees.
         * Rejects when the install fails. `onInstallState` gets the progress.
         */
        install(serverId: string): Promise<void>;
        onInstallState(listener: (state: LspInstallState) => void): () => void;
        request(key: string, method: string, params: unknown): Promise<unknown>;
        notify(key: string, method: string, params: unknown): void;
        /** Sends the result of a server request that has an `id`, for example "workspace/applyEdit". */
        respond(id: number, result: unknown): void;
        onMessage(listener: (message: LspServerMessage) => void): () => void;
    };
    processes: {
        /** Returns the processes and listening ports of each worktree. */
        list(worktreePaths: string[]): Promise<WorktreeProcesses[]>;
        /** Stops a process of a worktree and its child processes: SIGTERM, then SIGKILL after 3 seconds. */
        stop(worktreePath: string, pid: number): Promise<void>;
    };
    /** The in-app browser. Each browser tab has a view in the main process. */
    browser: {
        /** Makes the view of a browser tab of a worktree and loads the address. */
        create(id: string, url: string, worktree?: string): void;
        /** Shows the view at a place in the window (CSS pixels), or hides it with null. */
        setBounds(id: string, bounds: BrowserBounds | null): void;
        /** Loads an address. The main process refuses all schemes except http and https. */
        load(id: string, url: string): void;
        back(id: string): void;
        forward(id: string): void;
        reload(id: string): void;
        stop(id: string): void;
        /** Gives the keyboard focus to the page. */
        focus(id: string): void;
        /** Closes the view and its page. */
        destroy(id: string): void;
        state(id: string): Promise<BrowserState | undefined>;
        onState(listener: (state: BrowserState) => void): () => void;
        /** An MCP tool asked for a browser tab of a worktree. The page opens one and does not select it. */
        onAgentOpen(listener: (url: string, worktree: string) => void): () => void;
        /** A page asked for a new window. The page of the app opens a new browser tab for it. */
        onOpenTab(listener: (url: string, openerId: string) => void): () => void;
        /** A browser view got the keyboard focus. */
        onFocus(listener: (id: string) => void): () => void;
        /** The user pressed ⌘L in a browser view. */
        onFocusAddress(listener: (id: string) => void): () => void;
        /**
         * Finds the text in the page. `next` is false for a new text and true for the next match of the same text.
         * `onFound` gives the result.
         */
        find(id: string, text: string, options: BrowserFindOptions): void;
        /** Stops the find and removes the highlights of the matches. */
        stopFind(id: string): void;
        /** The user pressed ⌘F in a browser view. */
        onFindOpen(listener: (id: string) => void): () => void;
        /** The result of a find. `active` is the number of the current match, from 1. It is 0 when there is no match. */
        onFound(listener: (id: string, active: number, matches: number) => void): () => void;
    };
    terminals: {
        settings(): Promise<TerminalSettings>;
        list(): Promise<TerminalSession[]>;
        create(options: CreateTerminalOptions): Promise<TerminalSession>;
        /** Returns the recent output of the session, so that a new view can show it. */
        replay(id: string): Promise<TerminalReplay>;
        /**
         * Returns the text of the screen of a session, from its recent output. Use it for a session that the page does not
         * show, so that the page has no terminal for it. Undefined when the session does not exist.
         */
        screenText(id: string): Promise<string | undefined>;
        /**
         * Reads the complete lines of a Claude Code transcript after `offset` (bytes). Use -1 for the first read. The first
         * read gets only the end of a long file.
         */
        readTranscript(file: string, offset: number): Promise<TranscriptChunk>;
        /**
         * Starts to watch a Claude Code transcript. `onTranscriptChanged` then reports each change. Each call needs one
         * call of `unwatchTranscript`. Rejects when the file cannot be watched.
         */
        watchTranscript(file: string): Promise<void>;
        unwatchTranscript(file: string): void;
        /** Calls the listener when a watched transcript changes. */
        onTranscriptChanged(listener: (file: string) => void): () => void;
        write(id: string, data: string): void;
        /**
         * Puts an image (a data URL) on the clipboard and sends Ctrl+V to the session. Claude Code then reads the image
         * from the clipboard and adds it to its prompt. The image replaces the content of the clipboard.
         */
        pasteImage(id: string, dataUrl: string): Promise<void>;
        resize(id: string, cols: number, rows: number): void;
        kill(id: string): Promise<void>;
        /** Stops the PTY hosts of older builds and their sessions. Returns the number of sessions that stopped. */
        stopOutdatedHosts(): Promise<number>;
        /**
         * Calls the listener for each output chunk. Returns a function that removes the listener.
         * The sequence number increases by one for each chunk of a session.
         */
        onData(listener: (id: string, data: string, seq: number) => void): () => void;
        onExit(listener: (id: string, exitCode: number) => void): () => void;
        onAgentState(listener: (id: string, update: AgentUpdate) => void): () => void;
        /** Calls the listener when an agent starts or stops in a shell tab. The program is null when the agent stopped. */
        onAgentProgram(listener: (id: string, program: AgentProgram | null) => void): () => void;
    };
}

/** The names of the IPC channels. */
export const IpcChannels = {
    projectsGet: 'projects:get',
    projectsCreate: 'projects:create',
    projectsRename: 'projects:rename',
    projectsDelete: 'projects:delete',
    projectsSetActive: 'projects:setActive',
    projectsChooseRepo: 'projects:chooseRepo',
    projectsRemoveRepo: 'projects:removeRepo',
    projectsMove: 'projects:move',
    projectsMoveRepo: 'projects:moveRepo',
    projectsFindRepo: 'projects:findRepo',
    projectsPullRepo: 'projects:pullRepo',
    worktreesList: 'worktrees:list',
    worktreesCreate: 'worktrees:create',
    worktreesProgress: 'worktrees:progress',
    worktreesBranches: 'worktrees:branches',
    worktreesRemove: 'worktrees:remove',
    worktreesPreviewCopy: 'worktrees:previewCopy',
    worktreesDefaultFolder: 'worktrees:defaultFolder',
    worktreesDeleteBranch: 'worktrees:deleteBranch',
    worktreesChooseFolder: 'worktrees:chooseFolder',
    worktreesBranchDetails: 'worktrees:branchDetails',
    worktreesCheckoutBranch: 'worktrees:checkoutBranch',
    worktreesDeleteBranches: 'worktrees:deleteBranches',
    worktreesDeleteRemoteBranch: 'worktrees:deleteRemoteBranch',
    worktreesPullBranch: 'worktrees:pullBranch',
    filesListDirectory: 'files:listDirectory',
    filesListFiles: 'files:listFiles',
    filesSearch: 'files:search',
    filesRead: 'files:read',
    filesInfo: 'files:info',
    filesReveal: 'files:reveal',
    filesOpenInDefaultApp: 'files:openInDefaultApp',
    editorsList: 'editors:list',
    editorsOpen: 'editors:open',
    filesWrite: 'files:write',
    filesCreateFile: 'files:createFile',
    filesCreateFolder: 'files:createFolder',
    filesMove: 'files:move',
    filesDelete: 'files:delete',
    filesCopyIn: 'files:copyIn',
    filesReadExternal: 'files:readExternal',
    filesWatch: 'files:watch',
    filesUnwatch: 'files:unwatch',
    filesChanged: 'files:changed',
    githubStatus: 'github:status',
    githubFiles: 'github:files',
    githubCommitFiles: 'github:commitFiles',
    githubBranchSummaries: 'github:branchSummaries',
    githubMergedBranches: 'github:mergedBranches',
    githubFileVersions: 'github:fileVersions',
    githubSubmitReview: 'github:submitReview',
    githubReply: 'github:reply',
    githubSetThreadResolved: 'github:setThreadResolved',
    githubSetReaction: 'github:setReaction',
    githubMerge: 'github:merge',
    githubChecks: 'github:checks',
    githubJobProgress: 'github:jobProgress',
    githubJobLog: 'github:jobLog',
    githubSaveJobLog: 'github:saveJobLog',
    githubRerunJob: 'github:rerunJob',
    githubRerunFailedJobs: 'github:rerunFailedJobs',
    githubWorkflows: 'github:workflows',
    githubDispatchWorkflow: 'github:dispatchWorkflow',
    githubWorkflowRuns: 'github:workflowRuns',
    githubRunJobs: 'github:runJobs',
    githubCancelRun: 'github:cancelRun',
    githubRerunRun: 'github:rerunRun',
    githubBranches: 'github:branches',
    githubOpenInBrowser: 'github:openInBrowser',
    githubPullRequest: 'github:pullRequest',
    githubSetFileViewed: 'github:setFileViewed',
    githubPullRequestCandidates: 'github:pullRequestCandidates',
    githubIssueReferences: 'github:issueReferences',
    githubIssueReference: 'github:issueReference',
    githubChangePullRequest: 'github:changePullRequest',
    githubRepositories: 'github:repositories',
    githubRepoOf: 'github:repoOf',
    githubPullRequests: 'github:pullRequests',
    githubDashboardPullRequests: 'github:dashboardPullRequests',
    githubRepoPullRequests: 'github:repoPullRequests',
    githubDashboardComments: 'github:dashboardComments',
    githubDashboardApprovals: 'github:dashboardApprovals',
    githubApprovePipeline: 'github:approvePipeline',
    githubCreatePullRequest: 'github:createPullRequest',
    githubSetPullRequestInto: 'github:setPullRequestInto',
    reviewProvidersList: 'reviewProviders:list',
    reviewProvidersAdd: 'reviewProviders:add',
    reviewProvidersUpdate: 'reviewProviders:update',
    reviewProvidersRemove: 'reviewProviders:remove',
    reviewProvidersSaveToken: 'reviewProviders:saveToken',
    reviewProvidersClearToken: 'reviewProviders:clearToken',
    reviewProvidersTokenSource: 'reviewProviders:tokenSource',
    reviewProvidersTest: 'reviewProviders:test',
    reviewProvidersGitHubOwners: 'reviewProviders:githubOwners',
    reviewProvidersChanged: 'reviewProviders:changed',
    plansList: 'plans:list',
    plansSave: 'plans:save',
    plansRemove: 'plans:remove',
    plansExplore: 'plans:explore',
    plansCancelExplore: 'plans:cancelExplore',
    prGroupsList: 'prGroups:list',
    prGroupsSave: 'prGroups:save',
    prGroupsRemove: 'prGroups:remove',
    prGroupsReview: 'prGroups:review',
    prGroupsCancelReview: 'prGroups:cancelReview',
    pinsList: 'pins:list',
    pinsPin: 'pins:pin',
    pinsRename: 'pins:rename',
    pinsRemove: 'pins:remove',
    pinsPrepareResume: 'pins:prepareResume',
    pinsChanged: 'pins:changed',
    recentSessionsList: 'recentSessions:list',
    recentSessionsPrepareResume: 'recentSessions:prepareResume',
    transcriptSearch: 'transcriptSearch:search',
    compareList: 'compare:list',
    compareSave: 'compare:save',
    compareRemove: 'compare:remove',
    statsEvents: 'stats:events',
    statsStarted: 'stats:started',
    statsCi: 'stats:ci',
    checkpointsList: 'checkpoints:list',
    checkpointsPreview: 'checkpoints:preview',
    checkpointsRewind: 'checkpoints:rewind',
    checkpointsChanged: 'checkpoints:changed',
    screenshotsGet: 'screenshots:get',
    screenshotsCapture: 'screenshots:capture',
    screenshotsImage: 'screenshots:image',
    screenshotsClear: 'screenshots:clear',
    screenshotsPost: 'screenshots:post',
    screenshotsProgress: 'screenshots:progress',
    mcpApprovals: 'mcp:approvals',
    mcpRevoke: 'mcp:revoke',
    mcpApprovalsChanged: 'mcp:approvalsChanged',
    mcpWatches: 'mcp:watches',
    mcpUnwatch: 'mcp:unwatch',
    mcpWatchesChanged: 'mcp:watchesChanged',
    mcpPullRequestChanged: 'mcp:pullRequestChanged',
    cliPageRequest: 'cli:pageRequest',
    cliPageAnswer: 'cli:pageAnswer',
    cliInstallState: 'cli:installState',
    cliInstall: 'cli:install',
    cliRemove: 'cli:remove',
    queueGet: 'queue:get',
    queueSave: 'queue:save',
    automationsList: 'automations:list',
    automationsSave: 'automations:save',
    automationsRemove: 'automations:remove',
    automationsReveal: 'automations:reveal',
    automationsExportText: 'automations:exportText',
    automationsExportToFile: 'automations:exportToFile',
    automationsImportFromFile: 'automations:importFromFile',
    automationsCopyExport: 'automations:copyExport',
    automationsReadClipboard: 'automations:readClipboard',
    automationsRuns: 'automations:runs',
    automationsCountTokens: 'automations:countTokens',
    automationsClaim: 'automations:claim',
    automationsUpdateRun: 'automations:updateRun',
    automationsSeed: 'automations:seed',
    automationsSetScheduleRun: 'automations:setScheduleRun',
    automationsClearHistory: 'automations:clearHistory',
    automationsHttp: 'automations:http',
    automationsChanged: 'automations:changed',
    automationsEngineOwned: 'automations:engineOwned',
    automationsEngineChanged: 'automations:engineChanged',
    automationsAnswerRun: 'automations:answerRun',
    promptsList: 'prompts:list',
    promptsSave: 'prompts:save',
    promptsRemove: 'prompts:remove',
    promptsReveal: 'prompts:reveal',
    promptsChanged: 'prompts:changed',
    notesFolder: 'notes:folder',
    notesList: 'notes:list',
    notesFolders: 'notes:folders',
    notesCreateFolder: 'notes:createFolder',
    notesRenameFolder: 'notes:renameFolder',
    notesDeleteFolder: 'notes:deleteFolder',
    notesRead: 'notes:read',
    notesWrite: 'notes:write',
    notesCreate: 'notes:create',
    notesRename: 'notes:rename',
    notesDelete: 'notes:delete',
    notesSetTags: 'notes:setTags',
    notesReveal: 'notes:reveal',
    notesChanged: 'notes:changed',
    notificationsShow: 'notifications:show',
    notificationsPlaySound: 'notifications:playSound',
    notificationsClicked: 'notifications:clicked',
    networkStatus: 'network:status',
    networkTest: 'network:test',
    networkChooseCaFile: 'network:chooseCaFile',
    remoteStatus: 'remote:status',
    remoteStartPairing: 'remote:startPairing',
    remoteCancelPairing: 'remote:cancelPairing',
    remoteRemoveDevice: 'remote:removeDevice',
    remoteSetDevicePermissions: 'remote:setDevicePermissions',
    remoteChanged: 'remote:changed',
    snoozesList: 'snoozes:list',
    snoozesSet: 'snoozes:set',
    seenKeys: 'seen:keys',
    seenMark: 'seen:mark',
    tasksPlugins: 'tasks:plugins',
    tasksConnections: 'tasks:connections',
    tasksAddConnection: 'tasks:addConnection',
    tasksUpdateConnection: 'tasks:updateConnection',
    tasksSaveConnectionSettings: 'tasks:saveConnectionSettings',
    tasksRemoveConnection: 'tasks:removeConnection',
    tasksScopes: 'tasks:scopes',
    tasksEnabledConnections: 'tasks:enabledConnections',
    tasksSource: 'tasks:source',
    tasksRequest: 'tasks:request',
    tasksLinks: 'tasks:links',
    tasksSetLink: 'tasks:setLink',
    tasksChanged: 'tasks:changed',
    tasksSelectedCollection: 'tasks:selectedCollection',
    tasksSetSelectedCollection: 'tasks:setSelectedCollection',
    tasksSelectedConnection: 'tasks:selectedConnection',
    tasksSetSelectedConnection: 'tasks:setSelectedConnection',
    tasksTaskChanged: 'tasks:taskChanged',
    reviewCheckoutStatus: 'review:checkoutStatus',
    reviewCheckout: 'review:checkout',
    reviewRelease: 'review:release',
    lspEnsure: 'lsp:ensure',
    lspMissing: 'lsp:missing',
    lspRequest: 'lsp:request',
    lspNotify: 'lsp:notify',
    lspRespond: 'lsp:respond',
    lspMessage: 'lsp:message',
    lspInstall: 'lsp:install',
    lspInstallState: 'lsp:installState',
    terminalsSettings: 'terminals:settings',
    terminalsList: 'terminals:list',
    terminalsCreate: 'terminals:create',
    terminalsReplay: 'terminals:replay',
    terminalsScreenText: 'terminals:screenText',
    terminalsReadTranscript: 'terminals:readTranscript',
    terminalsWatchTranscript: 'terminals:watchTranscript',
    terminalsUnwatchTranscript: 'terminals:unwatchTranscript',
    terminalsTranscriptChanged: 'terminals:transcriptChanged',
    terminalsWrite: 'terminals:write',
    terminalsPasteImage: 'terminals:pasteImage',
    terminalsResize: 'terminals:resize',
    terminalsKill: 'terminals:kill',
    terminalsStopOutdated: 'terminals:stopOutdated',
    processesList: 'processes:list',
    processesStop: 'processes:stop',
    terminalsData: 'terminals:data',
    terminalsExit: 'terminals:exit',
    terminalsAgentState: 'terminals:agentState',
    terminalsAgentProgram: 'terminals:agentProgram',
    appFocus: 'app:focus',
    appInfo: 'app:info',
    appOpenSettings: 'app:openSettings',
    appShortcut: 'app:shortcut',
    appConfirmRequest: 'app:confirmRequest',
    appConfirmAnswer: 'app:confirmAnswer',
    appConfirmCancel: 'app:confirmCancel',
    appRunKey: 'app:runKey',
    appHelp: 'app:help',
    browserCreate: 'browser:create',
    browserSetBounds: 'browser:setBounds',
    browserLoad: 'browser:load',
    browserBack: 'browser:back',
    browserForward: 'browser:forward',
    browserReload: 'browser:reload',
    browserStop: 'browser:stop',
    browserFocus: 'browser:focus',
    browserDestroy: 'browser:destroy',
    browserState: 'browser:state',
    browserStateChanged: 'browser:stateChanged',
    browserOpenTab: 'browser:openTab',
    browserAgentOpen: 'browser:agentOpen',
    browserFocused: 'browser:focused',
    browserFocusAddress: 'browser:focusAddress',
    browserFind: 'browser:find',
    browserStopFind: 'browser:stopFind',
    browserFindOpen: 'browser:findOpen',
    browserFound: 'browser:found',
    usageGet: 'usage:get',
    askRun: 'ask:run',
    askDraft: 'ask:draft',
    askCancel: 'ask:cancel',
    askAnswers: 'ask:answers',
    askSaveAnswer: 'ask:saveAnswer',
    askRemoveAnswer: 'ask:removeAnswer',
    askCodeAnswers: 'ask:codeAnswers',
    askSaveCodeAnswer: 'ask:saveCodeAnswer',
    askRemoveCodeAnswer: 'ask:removeCodeAnswer',
    usageRefresh: 'usage:refresh',
    usageChanged: 'usage:changed',
    updatesState: 'updates:state',
    gitChanges: 'git:changes',
    gitStage: 'git:stage',
    gitUnstage: 'git:unstage',
    gitContents: 'git:contents',
    gitCommit: 'git:commit',
    gitLastMessage: 'git:lastMessage',
    gitPush: 'git:push',
    gitDiscard: 'git:discard',
    gitPull: 'git:pull',
    gitFetch: 'git:fetch',
    gitLog: 'git:log',
    gitBranchDiff: 'git:branchDiff',
    gitBranchContents: 'git:branchContents',
    gitWorktreeFiles: 'git:worktreeFiles',
    gitBlame: 'git:blame',
    gitFileHistory: 'git:fileHistory',
    gitCommitFileContents: 'git:commitFileContents',
    gitDefaultBranch: 'git:defaultBranch',
    gitRebase: 'git:rebase',
    gitRebaseContinue: 'git:rebaseContinue',
    gitRebaseSkip: 'git:rebaseSkip',
    gitRebaseAbort: 'git:rebaseAbort',
    gitRebaseConflict: 'git:rebaseConflict',
    gitPushWithLease: 'git:pushWithLease',
    updatesCheck: 'updates:check',
    updatesInstall: 'updates:install',
    updatesChanged: 'updates:changed',
    updatesChecked: 'updates:checked',
    settingsGet: 'settings:get',
    settingsUpdate: 'settings:update',
    settingsCheckCommand: 'settings:checkCommand',
    settingsListModels: 'settings:listModels',
    setupCheck: 'setup:check'
} as const;

export interface AppInfo {
    version: string;
    /** The folder with the settings, the task plugin settings and the logs. */
    dataFolder: string;
    /** The home folder of the user. The Terminal page starts its shells in it. */
    homeFolder: string;
    /** The log of the PTY host process. */
    ptyHostLog: string;
    /** The login name of the user on this computer. */
    username: string;
}
