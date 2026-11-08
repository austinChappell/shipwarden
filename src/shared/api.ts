import type { DashboardPullRequests, PullRequestCommentItem } from './dashboard';
import type { NoteInfo } from './notes';
import type { AppKeyAction, ShortcutAction } from './shortcuts';
import type { WorkflowRun } from './pipelines';
import type { ContentSearchResult, FileEntry, FilesChangedEvent } from './files';
import type { BranchStatus, BranchSummary, CheckRun, FileVersions, GitHubOwner, JobProgress, GitHubRepoInfo, MergeMethod, PendingComment, PullRequest, PullRequestFile, PullRequestFilter, PullRequestSummary, RepoRef, RepoTarget, ReviewEvent, Workflow } from './github';
import type { LspServerInfo, LspServerMessage } from './lsp';
import type { ConnectionChange, ConnectionInfo, PluginInfo, TaskLink, TaskScope, TaskSource } from './tasks';
import type { AgentUpdate } from './agents';
import type { AppSettings, CommandCheck } from './settings';
import type { ProjectsState } from './projects';
import type { ProviderUsage } from './usage';
import type { UpdateState } from './updates';
import type { ChangeContents, ChangeSide, CommitResult, GitChanges } from './git';
import type { WorktreeProcesses } from './processes';
import type { CreateTerminalOptions, TerminalReplay, TerminalSession, TerminalSettings } from './terminal';
import type { CreatedWorktree, CreateWorktreeOptions, RemoveWorktreeResult, Worktree } from './worktrees';
import type { CopyIgnoredSettings } from './worktree-settings';

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

export type ContextMenuItem = { id: string; label: string; enabled?: boolean } | { type: 'separator' };

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
        /** Shows a native context menu at the pointer. Returns the ID of the chosen item, or undefined. */
        contextMenu(items: ContextMenuItem[]): Promise<string | undefined>;
        /** The workspace shortcuts: ⌘T, ⌘W, ⌘D, ⇧⌘D, ⌘[ and ⌘]. See `shortcutAction`. */
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
    };
    worktrees: {
        list(repoPath: string): Promise<Worktree[]>;
        /** Creates a worktree in the folder of the worktree settings and copies the matching git-ignored files into it. */
        create(options: CreateWorktreeOptions): Promise<CreatedWorktree>;
        /** Runs the teardown script of the repository (unless `skipTeardown`), then removes the worktree. */
        remove(repoPath: string, worktreePath: string, options?: { skipTeardown?: boolean }): Promise<RemoveWorktreeResult>;
        /** The git-ignored files and folders of the main worktree that the copy settings copy now. */
        previewCopy(repoPath: string, copy: CopyIgnoredSettings): Promise<string[]>;
        /** Deletes a local branch. Without `force`, a branch that is not merged stays and `notMerged` is true. */
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
        write(root: string, file: string, content: string): Promise<void>;
        /** Reads a text file outside the worktrees, for example a type declaration that a definition points to. */
        readExternal(absolutePath: string): Promise<string>;
        /** Starts to send change events for the worktree. Each call needs one call of `unwatch`. */
        watch(root: string): void;
        unwatch(root: string): void;
        onChanged(listener: (event: FilesChangedEvent) => void): () => void;
    };
    github: {
        /** Returns the branch, its pull request and the commit for checks. Returns null when the worktree has no GitHub remote. */
        status(root: string): Promise<BranchStatus | null>;
        files(target: RepoTarget, number: number): Promise<PullRequestFile[]>;
        /** Returns the open pull requests of the repository by head branch, with their CI state. */
        branchSummaries(repoPath: string): Promise<Record<string, BranchSummary>>;
        fileVersions(target: RepoTarget, file: PullRequestFile, baseSha: string, headSha: string): Promise<FileVersions>;
        submitReview(target: RepoTarget, number: number, headSha: string, event: ReviewEvent, body: string, comments: PendingComment[]): Promise<void>;
        reply(target: RepoTarget, number: number, commentId: number, body: string): Promise<void>;
        setThreadResolved(threadId: string, resolved: boolean): Promise<void>;
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
        setFileViewed(pullRequestId: string, path: string, viewed: boolean): Promise<void>;
        /** The user and the organizations of the GitHub token. */
        owners(): Promise<GitHubOwner[]>;
        /** The repositories of the owners that the user can access. All owners when `owners` is undefined. */
        repositories(owners?: string[]): Promise<GitHubRepoInfo[]>;
        /** The pull requests of a repository for a filter of the Review view. */
        pullRequests(repo: RepoRef, filter: PullRequestFilter, query?: string): Promise<PullRequestSummary[]>;
        /** The review requests and the user's pull requests that need an action, for the owners of Settings > Code review. */
        dashboardPullRequests(owners: string[] | 'all' | undefined): Promise<DashboardPullRequests>;
        /** The new comments on pull requests for the Dashboard. */
        dashboardComments(owners: string[] | 'all' | undefined): Promise<PullRequestCommentItem[]>;
        /** Opens a web page (http or https) in the default browser. */
        openInBrowser(url: string): void;
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
    terminals: {
        settings(): Promise<TerminalSettings>;
        list(): Promise<TerminalSession[]>;
        create(options: CreateTerminalOptions): Promise<TerminalSession>;
        /** Returns the recent output of the session, so that a new view can show it. */
        replay(id: string): Promise<TerminalReplay>;
        write(id: string, data: string): void;
        resize(id: string, cols: number, rows: number): void;
        kill(id: string): Promise<void>;
        /**
         * Calls the listener for each output chunk. Returns a function that removes the listener.
         * The sequence number increases by one for each chunk of a session.
         */
        onData(listener: (id: string, data: string, seq: number) => void): () => void;
        onExit(listener: (id: string, exitCode: number) => void): () => void;
        onAgentState(listener: (id: string, update: AgentUpdate) => void): () => void;
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
    worktreesList: 'worktrees:list',
    worktreesCreate: 'worktrees:create',
    worktreesRemove: 'worktrees:remove',
    worktreesPreviewCopy: 'worktrees:previewCopy',
    worktreesDefaultFolder: 'worktrees:defaultFolder',
    worktreesDeleteBranch: 'worktrees:deleteBranch',
    appContextMenu: 'app:contextMenu',
    worktreesChooseFolder: 'worktrees:chooseFolder',
    filesListDirectory: 'files:listDirectory',
    filesListFiles: 'files:listFiles',
    filesSearch: 'files:search',
    filesRead: 'files:read',
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
    githubOwners: 'github:owners',
    githubRepositories: 'github:repositories',
    githubPullRequests: 'github:pullRequests',
    githubDashboardPullRequests: 'github:dashboardPullRequests',
    githubDashboardComments: 'github:dashboardComments',
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
    processesList: 'processes:list',
    processesStop: 'processes:stop',
    terminalsData: 'terminals:data',
    terminalsExit: 'terminals:exit',
    terminalsAgentState: 'terminals:agentState',
    appFocus: 'app:focus',
    appInfo: 'app:info',
    appOpenSettings: 'app:openSettings',
    appShortcut: 'app:shortcut',
    appConfirmRequest: 'app:confirmRequest',
    appConfirmAnswer: 'app:confirmAnswer',
    appRunKey: 'app:runKey',
    usageGet: 'usage:get',
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
