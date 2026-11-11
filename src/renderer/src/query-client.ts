import { QueryClient } from '@tanstack/react-query';

/** The time that loaded data stays fresh. A view that opens in this time shows the data and does not load it again. */
export const STALE_MS = 5 * 60_000;

/**
 * The cache of the loaded data of the views, for the session.
 * A view that opens again shows its cached data immediately. Stale data loads again in the background.
 * Data that a view shows now loads again after STALE_MS. The timer stops when no view shows the data,
 * or when the window is hidden.
 */
export const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: STALE_MS,
            refetchInterval: STALE_MS,
            refetchIntervalInBackground: false,
            // Keep the data for the session. A view that opens after a long time still shows its last data first.
            gcTime: Number.POSITIVE_INFINITY,
            // The views show the error of a failed request, and the user can try again.
            retry: false
        },
        mutations: {
            retry: false
        }
    }
});

/**
 * The first parts of the query keys. Each query key starts with one of these roots, and then adds its own parts.
 * A change can mark all data of a root as stale with one call: `queryClient.invalidateQueries({ queryKey: keyRoots.x })`.
 */
export const keyRoots = {
    /** The Dashboard: pull requests, comments and task activity. */
    dashboard: ['dashboard'],
    /** The GitHub and Azure repositories of the review providers. */
    repositories: ['github', 'repositories'],
    /** The open pull requests of each repository, for the Review view. */
    repoPullRequests: ['github', 'repoPullRequests'],
    /** The GitHub repository of a local repository. */
    repoOf: ['github', 'repoOf'],
    /** One pull request with its details, threads and timeline. */
    pullRequest: ['github', 'pullRequest'],
    /** The files and the file versions of a pull request. */
    pullRequestFiles: ['github', 'pullRequestFiles'],
    /** The pull requests that a worktree branch can link to. */
    pullRequestCandidates: ['github', 'pullRequestCandidates'],
    /** The issues and the pull requests for a "#" reference in a comment, by repository and query. */
    issueReferences: ['github', 'issueReferences'],
    /** The pull request and CI state of each branch of a repository. */
    branchSummaries: ['github', 'branchSummaries'],
    /** The pull request and CI state of one worktree branch. */
    branchStatus: ['github', 'branchStatus'],
    /** The branches of a repository. */
    branches: ['github', 'branches'],
    /** The CI checks of a commit. */
    checks: ['github', 'checks'],
    /** The workflows, workflow runs, run jobs and job logs. */
    workflows: ['github', 'workflows'],
    workflowRuns: ['github', 'workflowRuns'],
    runJobs: ['github', 'runJobs'],
    jobLog: ['github', 'jobLog'],
    /** The review providers (GitHub and Azure DevOps accounts). */
    reviewProviders: ['reviewProviders'],
    /** The task managers, the task plugins and the task data. */
    tasks: ['tasks'],
    /** The usage limits of the agent providers. */
    usage: ['usage'],
    /** The setup checks of the welcome page. They load only on request, and a fix updates one entry. */
    setup: ['setup'],
    /** The state of the app updates. */
    updates: ['updates'],
    /** The state of the network certificates. */
    network: ['network'],
    /** The listening ports of each worktree, for the sidebar. */
    worktreePorts: ['worktreePorts'],
    /** The automation files and the run history. Local data: no request goes to a service. */
    automations: ['automations']
} as const;

/** The roots that a change to a pull request, a branch or a CI run can make stale. */
const PULL_REQUEST_ROOTS = [
    keyRoots.pullRequest,
    keyRoots.pullRequestFiles,
    keyRoots.branchSummaries,
    keyRoots.branchStatus,
    keyRoots.repoPullRequests,
    keyRoots.checks,
    keyRoots.workflowRuns,
    keyRoots.runJobs,
    keyRoots.dashboard
];

/**
 * Marks the data of all pull requests, branches and CI runs as stale. The data that shows now loads again.
 * This function sends many requests. Use it only as a last resort.
 * After a change, first write the new data into the cache with `setQueryData` or `setQueriesData`.
 * When the new data is not known, mark only the narrowest key as stale.
 */
export function invalidatePullRequestData(): Promise<void> {
    return Promise.all(PULL_REQUEST_ROOTS.map(queryKey => queryClient.invalidateQueries({ queryKey }))).then(() => undefined);
}
