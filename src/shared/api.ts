import type { PairingOffer, RemoteStatus } from './remote';
import type { DashboardPullRequests, PullRequestCommentItem } from './dashboard';
import type { NoteInfo } from './notes';
import type { AppKeyAction, ShortcutAction } from './shortcuts';
import type { WorkflowRun } from './pipelines';
import type { ContentSearchResult, FileEntry, FilesChangedEvent } from './files';
import type { FileInfo } from './file-types';
import type { BranchStatus, BranchSummary, CheckRun, FileVersions, GitHubOwner, JobProgress, GitHubRepoInfo, MergeMethod, NewPullRequest, PendingComment, PullRequest, PullRequestCandidates, PullRequestChange, PullRequestFile, PullRequestFilter, PullRequestSummary, RepoRef, RepoTarget, ReviewEvent, Workflow } from './github';
import type { ReviewProviderChange, ReviewProviderInfo, ReviewProviderKind, ReviewTokenSource } from './review-providers';
import type { LspMissingServer, LspServerInfo, LspServerMessage } from './lsp';
import type { ConnectionChange, ConnectionInfo, PluginInfo, TaskLink, TaskScope, TaskSource } from './tasks';
import type { AgentUpdate } from './agents';
import type { AgentProgram } from './agent-programs';
import type { AskAgentRequest, AskAgentResult, SavedAnswer, SavedCodeAnswer } from './ask-agent';
import type { AppSettings, CommandCheck } from './settings';
import type { ProjectsState } from './projects';
import type { ProviderUsage } from './usage';
import type { UpdateState } from './updates';
import type { ChangeContents, ChangeSide, CommitResult, FetchResult, GitChanges } from './git';
import type { WorktreeProcesses } from './processes';
import type { CreateTerminalOptions, TerminalReplay, TerminalSession, TerminalSettings } from './terminal';
import type { GraphLog, GraphScope } from './git-graph';
import type { BranchList, CreatedWorktree, CreateWorktreeOptions, RemoveWorktreeResult, Worktree } from './worktrees';
import type { CopyIgnoredSettings } from './worktree-settings';
import type { BrowserBounds, BrowserState } from './browser';

/** Where a click on a notification goes. */
export type NotificationTarget =
    | { view: 'worktree'; worktreePath: string; sessionId?: string }
    | { view: 'dashboard' };

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
        /** Listens for the "Settings…" menu item (⌘,). */
        onOpenSettings(listener: () => void): () => void;
        /** The workspace shortcuts, for example ⌘T, ⌘W, ⌘D, ⌘[ and ⌘]. See `shortcutAction`. */
        onShortcut(listener: (action: ShortcutAction) => void): () => void;
        /** Questions from the main process. The page shows them in its own dialog and sends the answer with `answerConfirm`. */
        onConfirmRequest(listener: (id: number, request: ConfirmRequest) => void): () => void;
        answerConfirm(id: number, confirmed: boolean): void;
        /** Runs an app key (⌘Q, ⇧⌥⌘Q, ⌘, or ⌘H) that the page got. The main process normally reads these keys first. */
        runKey(action: AppKeyAction): void;
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
    };
    updates: {
        /** The state of the updater: the running version, and a newer release when there is one. */
        state(): Promise<UpdateState>;
        /** Checks GitHub for a newer release now. */
        check(): Promise<UpdateState>;
        /** Downloads the update, checks it, and restarts the app into the new version. The terminals continue to run. */
        install(): Promise<void>;
        onState(listener: (state: UpdateState) => void): () => void;
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
    };
    worktrees: {
        list(repoPath: string): Promise<Worktree[]>;
        /** Creates a worktree in the folder of the worktree settings and copies the matching git-ignored files into it. */
        create(options: CreateWorktreeOptions): Promise<CreatedWorktree>;
        /** The branches that a new worktree can start from, and the default start point (after a fetch of origin). */
        branches(repoPath: string): Promise<BranchList>;
        /** Runs the teardown script of the repository (unless `skipTeardown`), then removes the worktree. */
        remove(repoPath: string, worktreePath: string, options?: { skipTeardown?: boolean }): Promise<RemoveWorktreeResult>;
        /** The git-ignored files and folders of the main worktree that the copy settings copy now. */
        previewCopy(repoPath: string, copy: CopyIgnoredSettings): Promise<string[]>;
        /**
         * Deletes a local branch. Without `force`, ShipWarden first pulls the start branch of the worktree. A failed pull
         * does not stop the delete. A branch that is not merged stays and `notMerged` is true.
         */
        deleteBranch(repoPath: string, branch: string, force?: boolean): Promise<{ deleted: boolean; notMerged?: boolean }>;
        /** The default folder of new worktrees, ~/.shipwarden/worktrees. */
        defaultFolder(): Promise<string>;
        /** Opens a folder dialog. Returns the folder, or undefined when the user cancels. */
        chooseFolder(): Promise<string | undefined>;
    };
    files: {
        /** Lists one folder of a worktree. `directory` is relative to the root. An empty string is the root. */
        listDirectory(root: string, directory: string): Promise<FileEntry[]>;
        /** Lists all files that git does not ignore, relative to the root. */
        listFiles(root: string): Promise<string[]>;
        searchContents(root: string, query: string): Promise<ContentSearchResult>;
        read(root: string, file: string): Promise<string>;
        /** Returns the size and the kind of a file. The page uses the kind to select a view. */
        info(root: string, file: string): Promise<FileInfo>;
        /** Shows the file in the Finder. */
        reveal(root: string, file: string): Promise<void>;
        /** Opens an image, PDF, audio or video file in the default app of macOS. Other files are refused. */
        openInDefaultApp(root: string, file: string): Promise<void>;
        write(root: string, file: string, content: string): Promise<void>;
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
        /** Returns the branch, its pull request and the commit for checks. Returns null when the worktree has no GitHub or Azure Repos remote. */
        status(root: string): Promise<BranchStatus | null>;
        /** Creates a pull request from the branch of the worktree. Returns its number. */
        createPullRequest(root: string, request: NewPullRequest): Promise<number>;
        files(target: RepoTarget, number: number): Promise<PullRequestFile[]>;
        /** Returns the open pull requests of the repository by head branch, with their CI state. */
        branchSummaries(repoPath: string): Promise<Record<string, BranchSummary>>;
        fileVersions(target: RepoTarget, file: PullRequestFile, baseSha: string, headSha: string): Promise<FileVersions>;
        submitReview(target: RepoTarget, number: number, headSha: string, event: ReviewEvent, body: string, comments: PendingComment[]): Promise<void>;
        reply(target: RepoTarget, number: number, commentId: number, body: string): Promise<void>;
        setThreadResolved(target: RepoTarget, threadId: string, resolved: boolean): Promise<void>;
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
        /** Changes the details, an assignee, a reviewer or a label of a pull request. */
        changePullRequest(target: RepoTarget, number: number, change: PullRequestChange): Promise<void>;
        /** The repositories of all GitHub providers that are on, each in the organizations of its scope. */
        repositories(): Promise<GitHubRepoInfo[]>;
        /** The pull requests of a repository for a filter of the Review view. */
        pullRequests(repo: RepoRef, filter: PullRequestFilter, query?: string): Promise<PullRequestSummary[]>;
        /** The review requests and the user's pull requests that need an action, from all GitHub providers that are on. */
        dashboardPullRequests(): Promise<DashboardPullRequests>;
        /** The new comments on pull requests for the Dashboard, from all GitHub providers that are on. */
        dashboardComments(): Promise<PullRequestCommentItem[]>;
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
        /** Called when a phone pairs, connects or disconnects. */
        onChanged(listener: () => void): () => void;
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
        /** The connections that are on. Each project uses these. */
        enabledConnections(): Promise<ConnectionInfo[]>;
        /** Starts the plugin of a connection for a project and returns its description. */
        source(connectionId: string, projectId: string): Promise<TaskSource>;
        /** Sends a protocol request, for example "tasks/list", to the plugin of a connection in a project. */
        request(connectionId: string, projectId: string, method: string, params: unknown): Promise<unknown>;
        links(): Promise<Record<string, TaskLink>>;
        setLink(worktreePath: string, link: TaskLink | null): Promise<void>;
        /** Returns the collection that the user selected last for a connection. */
        selectedCollection(connectionId: string): Promise<string | undefined>;
        setSelectedCollection(connectionId: string, collectionId: string): Promise<void>;
        /** Returns the connection that the Tasks view showed last in a project. */
        selectedConnection(projectId: string): Promise<string | undefined>;
        setSelectedConnection(projectId: string, connectionId: string): Promise<void>;
        onChanged(listener: (connectionId: string, projectId: string) => void): () => void;
    };
    lsp: {
        /** Starts the language server for the language in the worktree. Returns undefined when no server is available. */
        ensure(root: string, languageId: string): Promise<LspServerInfo | undefined>;
        /** Returns the server that the language needs in the worktree, when the server is not installed. */
        missing(root: string, languageId: string): Promise<LspMissingServer | undefined>;
        request(key: string, method: string, params: unknown): Promise<unknown>;
        notify(key: string, method: string, params: unknown): void;
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
        /** Makes the view of a browser tab and loads the address. */
        create(id: string, url: string): void;
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
        /** A page asked for a new window. The page of the app opens a new browser tab for it. */
        onOpenTab(listener: (url: string, openerId: string) => void): () => void;
        /** A browser view got the keyboard focus. */
        onFocus(listener: (id: string) => void): () => void;
        /** The user pressed ⌘L in a browser view. */
        onFocusAddress(listener: (id: string) => void): () => void;
    };
    terminals: {
        settings(): Promise<TerminalSettings>;
        list(): Promise<TerminalSession[]>;
        create(options: CreateTerminalOptions): Promise<TerminalSession>;
        /** Returns the recent output of the session, so that a new view can show it. */
        replay(id: string): Promise<TerminalReplay>;
        write(id: string, data: string): void;
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
    worktreesList: 'worktrees:list',
    worktreesCreate: 'worktrees:create',
    worktreesBranches: 'worktrees:branches',
    worktreesRemove: 'worktrees:remove',
    worktreesPreviewCopy: 'worktrees:previewCopy',
    worktreesDefaultFolder: 'worktrees:defaultFolder',
    worktreesDeleteBranch: 'worktrees:deleteBranch',
    worktreesChooseFolder: 'worktrees:chooseFolder',
    filesListDirectory: 'files:listDirectory',
    filesListFiles: 'files:listFiles',
    filesSearch: 'files:search',
    filesRead: 'files:read',
    filesInfo: 'files:info',
    filesReveal: 'files:reveal',
    filesOpenInDefaultApp: 'files:openInDefaultApp',
    filesWrite: 'files:write',
    filesReadExternal: 'files:readExternal',
    filesWatch: 'files:watch',
    filesUnwatch: 'files:unwatch',
    filesChanged: 'files:changed',
    githubStatus: 'github:status',
    githubFiles: 'github:files',
    githubBranchSummaries: 'github:branchSummaries',
    githubFileVersions: 'github:fileVersions',
    githubSubmitReview: 'github:submitReview',
    githubReply: 'github:reply',
    githubSetThreadResolved: 'github:setThreadResolved',
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
    githubChangePullRequest: 'github:changePullRequest',
    githubRepositories: 'github:repositories',
    githubPullRequests: 'github:pullRequests',
    githubDashboardPullRequests: 'github:dashboardPullRequests',
    githubDashboardComments: 'github:dashboardComments',
    githubCreatePullRequest: 'github:createPullRequest',
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
    remoteChanged: 'remote:changed',
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
    lspEnsure: 'lsp:ensure',
    lspMissing: 'lsp:missing',
    lspRequest: 'lsp:request',
    lspNotify: 'lsp:notify',
    lspMessage: 'lsp:message',
    terminalsSettings: 'terminals:settings',
    terminalsList: 'terminals:list',
    terminalsCreate: 'terminals:create',
    terminalsReplay: 'terminals:replay',
    terminalsWrite: 'terminals:write',
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
    appRunKey: 'app:runKey',
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
    browserFocused: 'browser:focused',
    browserFocusAddress: 'browser:focusAddress',
    usageGet: 'usage:get',
    askRun: 'ask:run',
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
    updatesCheck: 'updates:check',
    updatesInstall: 'updates:install',
    updatesChanged: 'updates:changed',
    settingsGet: 'settings:get',
    settingsUpdate: 'settings:update',
    settingsCheckCommand: 'settings:checkCommand'
} as const;

export interface AppInfo {
    version: string;
    /** The folder with the settings, the task plugin settings and the logs. */
    dataFolder: string;
    /** The log of the PTY host process. */
    ptyHostLog: string;
}
