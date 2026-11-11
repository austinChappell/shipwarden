import type { ShortcutAction } from '@shared/shortcuts';
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IpcChannels, type ConfirmRequest, type NotificationTarget, type ShipWardenApi } from '@shared/api';
import type { FilesChangedEvent } from '@shared/files';
import type { LspInstallState, LspServerMessage } from '@shared/lsp';
import type { AgentUpdate } from '@shared/agents';
import type { AgentProgram } from '@shared/agent-programs';
import type { UpdateState } from '@shared/updates';
import type { ProviderUsage } from '@shared/usage';
import type { BrowserState } from '@shared/browser';
import type { HelpAction } from '@shared/onboarding';

function subscribe<Args extends unknown[]>(channel: string, listener: (...args: Args) => void): () => void {
    const handler = (_event: IpcRendererEvent, ...args: unknown[]) => listener(...(args as Args));
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
}

const api: ShipWardenApi = {
    app: {
        focus: () => ipcRenderer.send(IpcChannels.appFocus),
        info: () => ipcRenderer.invoke(IpcChannels.appInfo),
        onOpenSettings: listener => subscribe<[string | undefined]>(IpcChannels.appOpenSettings, listener),
        onShortcut: listener => subscribe<[ShortcutAction]>(IpcChannels.appShortcut, listener),
        onConfirmRequest: listener => subscribe<[number, ConfirmRequest]>(IpcChannels.appConfirmRequest, listener),
        answerConfirm: (id, confirmed) => ipcRenderer.send(IpcChannels.appConfirmAnswer, id, confirmed),
        runKey: action => ipcRenderer.send(IpcChannels.appRunKey, action),
        onHelp: listener => subscribe<[HelpAction]>(IpcChannels.appHelp, listener)
    },
    git: {
        changes: worktree => ipcRenderer.invoke(IpcChannels.gitChanges, worktree),
        stage: (worktree, paths) => ipcRenderer.invoke(IpcChannels.gitStage, worktree, paths),
        unstage: (worktree, paths) => ipcRenderer.invoke(IpcChannels.gitUnstage, worktree, paths),
        contents: (worktree, path, side, oldPath) => ipcRenderer.invoke(IpcChannels.gitContents, worktree, path, side, oldPath),
        commit: (worktree, message, amend) => ipcRenderer.invoke(IpcChannels.gitCommit, worktree, message, amend),
        lastMessage: worktree => ipcRenderer.invoke(IpcChannels.gitLastMessage, worktree),
        push: worktree => ipcRenderer.invoke(IpcChannels.gitPush, worktree),
        discard: (worktree, paths) => ipcRenderer.invoke(IpcChannels.gitDiscard, worktree, paths),
        pull: worktree => ipcRenderer.invoke(IpcChannels.gitPull, worktree),
        fetch: (worktree, force) => ipcRenderer.invoke(IpcChannels.gitFetch, worktree, force),
        log: (worktree, scope, limit) => ipcRenderer.invoke(IpcChannels.gitLog, worktree, scope, limit)
    },
    updates: {
        state: () => ipcRenderer.invoke(IpcChannels.updatesState),
        check: () => ipcRenderer.invoke(IpcChannels.updatesCheck),
        install: () => ipcRenderer.invoke(IpcChannels.updatesInstall),
        onState: listener => subscribe<[UpdateState]>(IpcChannels.updatesChanged, listener),
        onChecked: listener => subscribe<[UpdateState]>(IpcChannels.updatesChecked, listener)
    },
    usage: {
        get: () => ipcRenderer.invoke(IpcChannels.usageGet),
        refresh: () => ipcRenderer.invoke(IpcChannels.usageRefresh),
        onChanged: listener => subscribe<[ProviderUsage[]]>(IpcChannels.usageChanged, listener)
    },
    ask: {
        run: request => ipcRenderer.invoke(IpcChannels.askRun, request),
        cancel: id => ipcRenderer.invoke(IpcChannels.askCancel, id),
        answers: (repo, number) => ipcRenderer.invoke(IpcChannels.askAnswers, repo, number),
        saveAnswer: answer => ipcRenderer.invoke(IpcChannels.askSaveAnswer, answer),
        removeAnswer: id => ipcRenderer.invoke(IpcChannels.askRemoveAnswer, id),
        codeAnswers: (worktree, path) => ipcRenderer.invoke(IpcChannels.askCodeAnswers, worktree, path),
        saveCodeAnswer: answer => ipcRenderer.invoke(IpcChannels.askSaveCodeAnswer, answer),
        removeCodeAnswer: id => ipcRenderer.invoke(IpcChannels.askRemoveCodeAnswer, id)
    },
    settings: {
        get: () => ipcRenderer.invoke(IpcChannels.settingsGet),
        update: change => ipcRenderer.invoke(IpcChannels.settingsUpdate, change),
        checkCommand: command => ipcRenderer.invoke(IpcChannels.settingsCheckCommand, command)
    },
    setup: {
        check: id => ipcRenderer.invoke(IpcChannels.setupCheck, id)
    },
    projects: {
        get: () => ipcRenderer.invoke(IpcChannels.projectsGet),
        create: name => ipcRenderer.invoke(IpcChannels.projectsCreate, name),
        rename: (id, name) => ipcRenderer.invoke(IpcChannels.projectsRename, id, name),
        delete: id => ipcRenderer.invoke(IpcChannels.projectsDelete, id),
        setActive: id => ipcRenderer.invoke(IpcChannels.projectsSetActive, id),
        chooseRepo: id => ipcRenderer.invoke(IpcChannels.projectsChooseRepo, id),
        removeRepo: (id, repo) => ipcRenderer.invoke(IpcChannels.projectsRemoveRepo, id, repo),
        move: (id, toIndex) => ipcRenderer.invoke(IpcChannels.projectsMove, id, toIndex),
        moveRepo: (id, repo, toIndex) => ipcRenderer.invoke(IpcChannels.projectsMoveRepo, id, repo, toIndex),
        findRepo: repo => ipcRenderer.invoke(IpcChannels.projectsFindRepo, repo),
        pullRepo: (repo, target) => ipcRenderer.invoke(IpcChannels.projectsPullRepo, repo, target)
    },
    worktrees: {
        list: repoPath => ipcRenderer.invoke(IpcChannels.worktreesList, repoPath),
        create: options => ipcRenderer.invoke(IpcChannels.worktreesCreate, options),
        branches: repoPath => ipcRenderer.invoke(IpcChannels.worktreesBranches, repoPath),
        remove: (repoPath, worktreePath, options) => ipcRenderer.invoke(IpcChannels.worktreesRemove, repoPath, worktreePath, options),
        previewCopy: (repoPath, copy) => ipcRenderer.invoke(IpcChannels.worktreesPreviewCopy, repoPath, copy),
        defaultFolder: () => ipcRenderer.invoke(IpcChannels.worktreesDefaultFolder),
        deleteBranch: (repoPath, branch, force) => ipcRenderer.invoke(IpcChannels.worktreesDeleteBranch, repoPath, branch, force),
        chooseFolder: () => ipcRenderer.invoke(IpcChannels.worktreesChooseFolder)
    },
    files: {
        listDirectory: (root, directory) => ipcRenderer.invoke(IpcChannels.filesListDirectory, root, directory),
        listFiles: root => ipcRenderer.invoke(IpcChannels.filesListFiles, root),
        searchContents: (root, query, caseSensitive) => ipcRenderer.invoke(IpcChannels.filesSearch, root, query, caseSensitive),
        read: (root, file) => ipcRenderer.invoke(IpcChannels.filesRead, root, file),
        info: (root, file) => ipcRenderer.invoke(IpcChannels.filesInfo, root, file),
        reveal: (root, file) => ipcRenderer.invoke(IpcChannels.filesReveal, root, file),
        openInDefaultApp: (root, file) => ipcRenderer.invoke(IpcChannels.filesOpenInDefaultApp, root, file),
        write: (root, file, content) => ipcRenderer.invoke(IpcChannels.filesWrite, root, file, content),
        readExternal: absolutePath => ipcRenderer.invoke(IpcChannels.filesReadExternal, absolutePath),
        watch: root => ipcRenderer.send(IpcChannels.filesWatch, root),
        unwatch: root => ipcRenderer.send(IpcChannels.filesUnwatch, root),
        onChanged: listener => subscribe<[FilesChangedEvent]>(IpcChannels.filesChanged, listener)
    },
    github: {
        status: root => ipcRenderer.invoke(IpcChannels.githubStatus, root),
        files: (root, number) => ipcRenderer.invoke(IpcChannels.githubFiles, root, number),
        commitFiles: (root, sha) => ipcRenderer.invoke(IpcChannels.githubCommitFiles, root, sha),
        branchSummaries: repoPath => ipcRenderer.invoke(IpcChannels.githubBranchSummaries, repoPath),
        fileVersions: (root, file, baseSha, headSha) => ipcRenderer.invoke(IpcChannels.githubFileVersions, root, file, baseSha, headSha),
        submitReview: (root, number, headSha, event, body, comments) =>
            ipcRenderer.invoke(IpcChannels.githubSubmitReview, root, number, headSha, event, body, comments),
        reply: (root, number, commentId, body) => ipcRenderer.invoke(IpcChannels.githubReply, root, number, commentId, body),
        setThreadResolved: (target, threadId, resolved) => ipcRenderer.invoke(IpcChannels.githubSetThreadResolved, target, threadId, resolved),
        setReaction: (target, number, subjectId, content, on) => ipcRenderer.invoke(IpcChannels.githubSetReaction, target, number, subjectId, content, on),
        merge: (root, number, headSha, method) => ipcRenderer.invoke(IpcChannels.githubMerge, root, number, headSha, method),
        checks: (root, sha) => ipcRenderer.invoke(IpcChannels.githubChecks, root, sha),
        jobLog: (root, jobId) => ipcRenderer.invoke(IpcChannels.githubJobLog, root, jobId),
        jobProgress: (root, jobId) => ipcRenderer.invoke(IpcChannels.githubJobProgress, root, jobId),
        saveJobLog: (root, jobId) => ipcRenderer.invoke(IpcChannels.githubSaveJobLog, root, jobId),
        rerunJob: (root, jobId) => ipcRenderer.invoke(IpcChannels.githubRerunJob, root, jobId),
        rerunFailedJobs: (root, runId) => ipcRenderer.invoke(IpcChannels.githubRerunFailedJobs, root, runId),
        workflows: (root, ref) => ipcRenderer.invoke(IpcChannels.githubWorkflows, root, ref),
        dispatchWorkflow: (root, workflowId, ref, inputs) => ipcRenderer.invoke(IpcChannels.githubDispatchWorkflow, root, workflowId, ref, inputs),
        workflowRuns: (target, workflowId) => ipcRenderer.invoke(IpcChannels.githubWorkflowRuns, target, workflowId),
        runJobs: (target, runId) => ipcRenderer.invoke(IpcChannels.githubRunJobs, target, runId),
        cancelRun: (target, runId) => ipcRenderer.invoke(IpcChannels.githubCancelRun, target, runId),
        rerunRun: (target, runId) => ipcRenderer.invoke(IpcChannels.githubRerunRun, target, runId),
        branches: target => ipcRenderer.invoke(IpcChannels.githubBranches, target),
        pullRequest: (target, number) => ipcRenderer.invoke(IpcChannels.githubPullRequest, target, number),
        setFileViewed: (target, pullRequestId, path, viewed) => ipcRenderer.invoke(IpcChannels.githubSetFileViewed, target, pullRequestId, path, viewed),
        pullRequestCandidates: target => ipcRenderer.invoke(IpcChannels.githubPullRequestCandidates, target),
        issueReferences: (target, query) => ipcRenderer.invoke(IpcChannels.githubIssueReferences, target, query),
        changePullRequest: (target, number, change) => ipcRenderer.invoke(IpcChannels.githubChangePullRequest, target, number, change),
        repositories: () => ipcRenderer.invoke(IpcChannels.githubRepositories),
        repoOf: root => ipcRenderer.invoke(IpcChannels.githubRepoOf, root),
        pullRequests: (repo, filter, query) => ipcRenderer.invoke(IpcChannels.githubPullRequests, repo, filter, query),
        repoPullRequests: repo => ipcRenderer.invoke(IpcChannels.githubRepoPullRequests, repo),
        dashboardPullRequests: () => ipcRenderer.invoke(IpcChannels.githubDashboardPullRequests),
        dashboardComments: () => ipcRenderer.invoke(IpcChannels.githubDashboardComments),
        openInBrowser: url => ipcRenderer.send(IpcChannels.githubOpenInBrowser, url),
        createPullRequest: (root, request) => ipcRenderer.invoke(IpcChannels.githubCreatePullRequest, root, request)
    },
    reviewProviders: {
        list: () => ipcRenderer.invoke(IpcChannels.reviewProvidersList),
        add: (kind, name) => ipcRenderer.invoke(IpcChannels.reviewProvidersAdd, kind, name),
        update: (id, change) => ipcRenderer.invoke(IpcChannels.reviewProvidersUpdate, id, change),
        remove: id => ipcRenderer.invoke(IpcChannels.reviewProvidersRemove, id),
        saveToken: (id, token) => ipcRenderer.invoke(IpcChannels.reviewProvidersSaveToken, id, token),
        clearToken: id => ipcRenderer.invoke(IpcChannels.reviewProvidersClearToken, id),
        tokenSource: id => ipcRenderer.invoke(IpcChannels.reviewProvidersTokenSource, id),
        test: (id, organization) => ipcRenderer.invoke(IpcChannels.reviewProvidersTest, id, organization),
        githubOwners: id => ipcRenderer.invoke(IpcChannels.reviewProvidersGitHubOwners, id),
        onChanged: listener => subscribe<[]>(IpcChannels.reviewProvidersChanged, listener)
    },
    plans: {
        list: () => ipcRenderer.invoke(IpcChannels.plansList),
        save: plan => ipcRenderer.invoke(IpcChannels.plansSave, plan),
        remove: id => ipcRenderer.invoke(IpcChannels.plansRemove, id),
        explore: request => ipcRenderer.invoke(IpcChannels.plansExplore, request),
        cancelExplore: id => ipcRenderer.invoke(IpcChannels.plansCancelExplore, id)
    },
    automations: {
        list: () => ipcRenderer.invoke(IpcChannels.automationsList),
        save: (automation, previousId) => ipcRenderer.invoke(IpcChannels.automationsSave, automation, previousId),
        remove: id => ipcRenderer.invoke(IpcChannels.automationsRemove, id),
        reveal: id => ipcRenderer.send(IpcChannels.automationsReveal, id),
        exportText: id => ipcRenderer.invoke(IpcChannels.automationsExportText, id),
        exportToFile: id => ipcRenderer.invoke(IpcChannels.automationsExportToFile, id),
        importFromFile: () => ipcRenderer.invoke(IpcChannels.automationsImportFromFile),
        copyExport: id => ipcRenderer.invoke(IpcChannels.automationsCopyExport, id),
        readClipboard: () => ipcRenderer.invoke(IpcChannels.automationsReadClipboard),
        runs: () => ipcRenderer.invoke(IpcChannels.automationsRuns),
        countTokens: (transcript, from, to) => ipcRenderer.invoke(IpcChannels.automationsCountTokens, transcript, from, to),
        claim: run => ipcRenderer.invoke(IpcChannels.automationsClaim, run),
        updateRun: (id, change) => ipcRenderer.invoke(IpcChannels.automationsUpdateRun, id, change),
        seed: (automationId, keys, scope) => ipcRenderer.invoke(IpcChannels.automationsSeed, automationId, keys, scope),
        setScheduleRun: (automationId, at) => ipcRenderer.invoke(IpcChannels.automationsSetScheduleRun, automationId, at),
        clearHistory: () => ipcRenderer.invoke(IpcChannels.automationsClearHistory),
        onChanged: listener => subscribe<[]>(IpcChannels.automationsChanged, listener)
    },
    notes: {
        folder: () => ipcRenderer.invoke(IpcChannels.notesFolder),
        list: () => ipcRenderer.invoke(IpcChannels.notesList),
        folders: () => ipcRenderer.invoke(IpcChannels.notesFolders),
        createFolder: name => ipcRenderer.invoke(IpcChannels.notesCreateFolder, name),
        renameFolder: (name, newName) => ipcRenderer.invoke(IpcChannels.notesRenameFolder, name, newName),
        deleteFolder: name => ipcRenderer.invoke(IpcChannels.notesDeleteFolder, name),
        read: name => ipcRenderer.invoke(IpcChannels.notesRead, name),
        write: (name, content) => ipcRenderer.invoke(IpcChannels.notesWrite, name, content),
        create: (name, content) => ipcRenderer.invoke(IpcChannels.notesCreate, name, content),
        rename: (name, newName) => ipcRenderer.invoke(IpcChannels.notesRename, name, newName),
        delete: name => ipcRenderer.invoke(IpcChannels.notesDelete, name),
        setTags: (name, tags) => ipcRenderer.invoke(IpcChannels.notesSetTags, name, tags),
        reveal: name => ipcRenderer.send(IpcChannels.notesReveal, name),
        onChanged: listener => subscribe<[]>(IpcChannels.notesChanged, listener)
    },
    notifications: {
        show: request => ipcRenderer.send(IpcChannels.notificationsShow, request),
        playSound: name => ipcRenderer.send(IpcChannels.notificationsPlaySound, name),
        onClick: listener => subscribe<[NotificationTarget | undefined]>(IpcChannels.notificationsClicked, listener)
    },
    network: {
        status: () => ipcRenderer.invoke(IpcChannels.networkStatus),
        test: () => ipcRenderer.invoke(IpcChannels.networkTest),
        chooseCaFile: () => ipcRenderer.invoke(IpcChannels.networkChooseCaFile)
    },
    remote: {
        status: () => ipcRenderer.invoke(IpcChannels.remoteStatus),
        startPairing: () => ipcRenderer.invoke(IpcChannels.remoteStartPairing),
        cancelPairing: () => ipcRenderer.invoke(IpcChannels.remoteCancelPairing),
        removeDevice: id => ipcRenderer.invoke(IpcChannels.remoteRemoveDevice, id),
        onChanged: listener => subscribe<[]>(IpcChannels.remoteChanged, listener)
    },
    seen: {
        keys: () => ipcRenderer.invoke(IpcChannels.seenKeys),
        mark: keys => ipcRenderer.invoke(IpcChannels.seenMark, keys)
    },
    tasks: {
        plugins: () => ipcRenderer.invoke(IpcChannels.tasksPlugins),
        connections: () => ipcRenderer.invoke(IpcChannels.tasksConnections),
        addConnection: (pluginId, name) => ipcRenderer.invoke(IpcChannels.tasksAddConnection, pluginId, name),
        updateConnection: (id, change) => ipcRenderer.invoke(IpcChannels.tasksUpdateConnection, id, change),
        saveConnectionSettings: (id, values) => ipcRenderer.invoke(IpcChannels.tasksSaveConnectionSettings, id, values),
        removeConnection: id => ipcRenderer.invoke(IpcChannels.tasksRemoveConnection, id),
        scopes: connectionId => ipcRenderer.invoke(IpcChannels.tasksScopes, connectionId),
        enabledConnections: () => ipcRenderer.invoke(IpcChannels.tasksEnabledConnections),
        source: connectionId => ipcRenderer.invoke(IpcChannels.tasksSource, connectionId),
        request: (connectionId, method, params) => ipcRenderer.invoke(IpcChannels.tasksRequest, connectionId, method, params),
        links: () => ipcRenderer.invoke(IpcChannels.tasksLinks),
        setLink: (worktreePath, link) => ipcRenderer.invoke(IpcChannels.tasksSetLink, worktreePath, link),
        selectedCollection: connectionId => ipcRenderer.invoke(IpcChannels.tasksSelectedCollection, connectionId),
        setSelectedCollection: (connectionId, collectionId) => ipcRenderer.invoke(IpcChannels.tasksSetSelectedCollection, connectionId, collectionId),
        selectedConnection: () => ipcRenderer.invoke(IpcChannels.tasksSelectedConnection),
        setSelectedConnection: connectionId => ipcRenderer.invoke(IpcChannels.tasksSetSelectedConnection, connectionId),
        onChanged: listener => subscribe<[string]>(IpcChannels.tasksChanged, listener)
    },
    review: {
        checkoutStatus: (repo, number) => ipcRenderer.invoke(IpcChannels.reviewCheckoutStatus, repo, number),
        checkout: (repo, number, sha, allowClone) => ipcRenderer.invoke(IpcChannels.reviewCheckout, repo, number, sha, allowClone),
        release: root => ipcRenderer.invoke(IpcChannels.reviewRelease, root)
    },
    lsp: {
        ensure: (root, languageId) => ipcRenderer.invoke(IpcChannels.lspEnsure, root, languageId),
        missing: (root, languageId) => ipcRenderer.invoke(IpcChannels.lspMissing, root, languageId),
        install: serverId => ipcRenderer.invoke(IpcChannels.lspInstall, serverId),
        onInstallState: listener => subscribe<[LspInstallState]>(IpcChannels.lspInstallState, listener),
        request: (key, method, params) => ipcRenderer.invoke(IpcChannels.lspRequest, key, method, params),
        notify: (key, method, params) => ipcRenderer.send(IpcChannels.lspNotify, key, method, params),
        respond: (id, result) => ipcRenderer.send(IpcChannels.lspRespond, id, result),
        onMessage: listener => subscribe<[LspServerMessage]>(IpcChannels.lspMessage, listener)
    },
    processes: {
        list: worktreePaths => ipcRenderer.invoke(IpcChannels.processesList, worktreePaths),
        stop: (worktreePath, pid) => ipcRenderer.invoke(IpcChannels.processesStop, worktreePath, pid)
    },
    browser: {
        create: (id, url) => ipcRenderer.send(IpcChannels.browserCreate, id, url),
        setBounds: (id, bounds) => ipcRenderer.send(IpcChannels.browserSetBounds, id, bounds),
        load: (id, url) => ipcRenderer.send(IpcChannels.browserLoad, id, url),
        back: id => ipcRenderer.send(IpcChannels.browserBack, id),
        forward: id => ipcRenderer.send(IpcChannels.browserForward, id),
        reload: id => ipcRenderer.send(IpcChannels.browserReload, id),
        stop: id => ipcRenderer.send(IpcChannels.browserStop, id),
        focus: id => ipcRenderer.send(IpcChannels.browserFocus, id),
        destroy: id => ipcRenderer.send(IpcChannels.browserDestroy, id),
        state: id => ipcRenderer.invoke(IpcChannels.browserState, id),
        onState: listener => subscribe<[BrowserState]>(IpcChannels.browserStateChanged, listener),
        onOpenTab: listener => subscribe<[string, string]>(IpcChannels.browserOpenTab, listener),
        onFocus: listener => subscribe<[string]>(IpcChannels.browserFocused, listener),
        onFocusAddress: listener => subscribe<[string]>(IpcChannels.browserFocusAddress, listener)
    },
    terminals: {
        settings: () => ipcRenderer.invoke(IpcChannels.terminalsSettings),
        list: () => ipcRenderer.invoke(IpcChannels.terminalsList),
        create: options => ipcRenderer.invoke(IpcChannels.terminalsCreate, options),
        replay: id => ipcRenderer.invoke(IpcChannels.terminalsReplay, id),
        screenText: id => ipcRenderer.invoke(IpcChannels.terminalsScreenText, id),
        write: (id, data) => ipcRenderer.send(IpcChannels.terminalsWrite, id, data),
        resize: (id, cols, rows) => ipcRenderer.send(IpcChannels.terminalsResize, id, cols, rows),
        kill: id => ipcRenderer.invoke(IpcChannels.terminalsKill, id),
        stopOutdatedHosts: () => ipcRenderer.invoke(IpcChannels.terminalsStopOutdated),
        onData: listener => subscribe<[string, string, number]>(IpcChannels.terminalsData, listener),
        onExit: listener => subscribe<[string, number]>(IpcChannels.terminalsExit, listener),
        onAgentState: listener => subscribe<[string, AgentUpdate]>(IpcChannels.terminalsAgentState, listener),
        onAgentProgram: listener => subscribe<[string, AgentProgram | null]>(IpcChannels.terminalsAgentProgram, listener)
    }
};

contextBridge.exposeInMainWorld('shipwarden', api);
