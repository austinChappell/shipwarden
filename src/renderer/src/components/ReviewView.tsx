import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { GitPullRequest, X } from 'lucide-react';
import { EmptyState } from './EmptyState';
import { parseRepoId, repoId, type BranchStatus, type CheckRun, type PullRequest, type RepoRef } from '@shared/github';
import type { ProjectsState, PullRepoTarget } from '@shared/projects';
import type { QueueItem } from '@shared/review-queue';
import type { ViewRoute } from '@shared/nav-history';
import { queryClient } from '../query-client';
import { errorText, optionalErrorText } from '../util';
import { reviewKeys, reviewStore } from '../github/review-store';
import { refreshRepo, useReviewOverview, useReviewQueue } from '../github/review-overview-store';
import { sortedGroups } from './ui/Combobox';
import { ReviewHome } from './ReviewHome';
import { ReviewRepoPage } from './ReviewRepoPage';
import { isReviewTab, ReviewPullRequest, type ReviewTab } from './ReviewPullRequest';
import { parseReviewPage, reviewPage } from '../app/review-page';

const api = window.shipwarden.github;

/** The query of one pull request. The query cache keeps it, so a pull request that opens again shows at once. */
function pullRequestQuery(repo: RepoRef, number: number) {
    return { queryKey: reviewKeys.pullRequest(repo, number), queryFn: () => api.pullRequest(repo, number) };
}

interface Props {
    /** A key for the providers of Settings › Code review. Undefined: not loaded yet. Null: no provider is on. */
    reviewKey: string | null | undefined;
    /** Opens Settings > Code review. */
    onOpenSettings(): void;
    /** The page of the view (see `reviewPage` in app/review-page) and the tab of the pull request (`tab` in the query). */
    route: ViewRoute;
    /** Shows a different page or tab. A different page adds a history entry. */
    onRoute(route: ViewRoute): void;
    /** Opens the New worktree dialog on the head branch of a pull request. */
    onNewWorktree?(repo: RepoRef, pr: Pick<PullRequest, 'headRefName'>): void;
    /** Sends a prompt to the agent of the worktree of the head branch of a pull request. */
    onSendToAgent?(repo: RepoRef, pr: Pick<PullRequest, 'headRefName'>, prompt: string): void;
    /** Sends the log of a check of a pull request to the agent of the worktree of its head branch. */
    onSendLogToAgent?(repo: RepoRef, pr: Pick<PullRequest, 'headRefName'>, check: CheckRun): void;
    /** Sends the failed checks of a pull request to the agent of the worktree of its head branch. */
    onSendChecksToAgent?(repo: RepoRef, pr: Pick<PullRequest, 'headRefName'>, checks: CheckRun[]): void;
    /** The projects. Undefined while they load. */
    projects?: ProjectsState;
    /** Adds the repository to a project, with a clone when necessary. Resolves false when the user cancels. */
    onPullRepo?(repo: RepoRef, target: PullRepoTarget): Promise<boolean>;
}

/** A review queue that the user started: a fixed list of pull requests, and the position in it. */
interface ActiveQueue {
    items: QueueItem[];
    index: number;
}

/**
 * The Review view: the pull requests of the GitHub and Azure Repos repositories, from the organizations in Settings > Code review.
 * The view has three pages. The entry page shows the repositories with pull requests that wait on the user.
 * The list page shows the pull requests of one repository. The pull request page shows one pull request.
 * The data of the first two pages comes from the review overview store, which loads at app start.
 * The review queue opens the pull requests to review one after the other, the oldest first.
 */
export function ReviewView({
    reviewKey,
    onOpenSettings,
    route,
    onRoute,
    onNewWorktree,
    onSendToAgent,
    onSendLogToAgent,
    onSendChecksToAgent,
    projects,
    onPullRepo
}: Props) {
    const overview = useReviewOverview();
    const queueItems = useReviewQueue();
    const { repo, number: selected } = parseReviewPage(route.page);
    const routeTab = isReviewTab(route.query?.tab) ? route.query.tab : undefined;
    /** The error of the last agent review start, for the pull request that the user selected then. */
    const [agentError, setAgentError] = useState<{ repo: string; number: number; text: string }>();
    const [queue, setQueue] = useState<ActiveQueue>();
    /** The repository and the pull request that the user came back from. The pages focus their rows. */
    const [lastRepo, setLastRepo] = useState<string>();
    const [lastNumber, setLastNumber] = useState<number>();
    // A step back to a page above gives the focus to the row of the page that the user came back from. This is also
    // true for the back step of the history (⌘[).
    const previous = useRef({ repo, selected });
    useEffect(() => {
        const before = previous.current;
        previous.current = { repo, selected };
        if (before.repo && !repo) setLastRepo(before.repo);
        if (before.selected && !selected && before.repo === repo) setLastNumber(before.selected);
    }, [repo, selected]);

    const repoRef = useMemo(() => (repo ? parseRepoId(repo) : undefined), [repo]);

    /** Shows a page of the view. A different page adds a history entry. */
    const go = (target?: string, number?: number) => onRoute({ page: reviewPage(target, number) });
    /** Opens a pull request, also in another repository. */
    const openPr = (target: string, number: number) => go(target, number);
    const selectTab = (tab: ReviewTab) => onRoute({ page: route.page, query: { ...route.query, tab } });

    // A pull request shows its cached data immediately. Its comments and reviews change often. Thus it loads again in the
    // background each time that it opens.
    const prQuery = useQuery({
        ...pullRequestQuery(repoRef ?? { owner: '', name: '' }, selected ?? 0),
        enabled: !!repoRef && !!selected,
        staleTime: 0
    });
    const pr = repoRef && selected ? prQuery.data : undefined;
    const prLoading = prQuery.isFetching;
    const shownAgentError = agentError && agentError.repo === repo && agentError.number === selected ? agentError.text : undefined;
    const prError = shownAgentError ?? optionalErrorText(prQuery.error);

    const refresh = async () => {
        await Promise.all([prQuery.refetch(), repo ? refreshRepo(repo) : undefined]);
    };

    /** The panels take a branch status. In the Review view, it comes from the pull request. */
    const status: BranchStatus | undefined =
        repoRef && pr ? { repo: repoRef, branch: pr.headRefName, sha: pr.headRefOid, pullRequest: pr, host: repoRef.host } : undefined;

    /** The repositories by owner, for the groups of the picker. */
    const groups = useMemo(
        () =>
            sortedGroups(
                overview.catalog ?? [],
                item => item.owner,
                item => ({ value: repoId(item), label: item.name })
            ),
        [overview.catalog]
    );

    const startQueue = () => {
        if (queueItems.length === 0) return;
        setQueue({ items: queueItems, index: 0 });
        openPr(queueItems[0].repo, queueItems[0].number);
    };
    const stepQueue = () => {
        if (!queue) return;
        const index = queue.index + 1;
        if (index >= queue.items.length) {
            endQueue();
            return;
        }
        setQueue({ ...queue, index });
        openPr(queue.items[index].repo, queue.items[index].number);
    };
    const endQueue = () => {
        setQueue(undefined);
        go();
    };

    const backToList = () => {
        setQueue(undefined);
        go(repo);
    };
    const backToHome = () => go();
    /** The queue shows only on the page of its current pull request. Another page, for example after ⌘[, hides it. */
    const queueItem = queue?.items[queue.index];
    const shownQueue = queueItem && queueItem.repo === repo && queueItem.number === selected ? queue : undefined;

    /** Opens the pull request and starts an agent review of it. The agent posts nothing. */
    const handToAgent = async (number: number) => {
        if (!repoRef || !repo) return;
        go(repo, number);
        try {
            const full = await queryClient.ensureQueryData(pullRequestQuery(repoRef, number));
            void reviewStore.runAgentReview(repoRef, full);
        } catch (err) {
            setAgentError({ repo, number, text: errorText(err) });
        }
    };

    if (reviewKey === undefined) {
        return <div className="review-view" />;
    }
    if (reviewKey === null) {
        return (
            <div className="review-view">
                <EmptyState
                    icon={GitPullRequest}
                    title="No code review account"
                    actions={
                        <button className="button primary" onClick={onOpenSettings}>
                            Open Settings › Code review
                        </button>
                    }
                    hint={
                        <>
                            For GitHub, ShipWarden can use the login of the GitHub CLI. Run <kbd>gh auth login</kbd> in a terminal.
                        </>
                    }
                >
                    Add a GitHub or Azure DevOps account to see the pull requests that wait for your review.
                </EmptyState>
            </div>
        );
    }

    if (!repo || !repoRef) {
        return (
            <div className="review-view">
                <ReviewHome queue={queueItems} focusRepo={lastRepo} onSelect={value => go(value)} onStartQueue={startQueue} onOpenSettings={onOpenSettings} />
            </div>
        );
    }

    return (
        <div className="review-view">
            {/* The list stays in the page when it is hidden, so that it keeps its scroll position. */}
            <ReviewRepoPage
                key={repo}
                repo={repo}
                repoRef={repoRef}
                groups={groups}
                focusNumber={lastNumber}
                hidden={selected !== undefined}
                onSelectRepo={value => go(value)}
                onBack={backToHome}
                onOpen={number => go(repo, number)}
                onCheckout={onNewWorktree && (target => onNewWorktree(repoRef, target))}
                onHandToAgent={number => void handToAgent(number)}
            />

            {selected && (
                <div className="review-body review-pr-wrap">
                    {shownQueue && (
                        <div className="review-queue-bar" role="status">
                            <span>
                                Review queue · {shownQueue.index + 1} of {shownQueue.items.length}
                            </span>
                            <span className="header-spacer" />
                            <button className="button" onClick={stepQueue}>
                                {shownQueue.index + 1 < shownQueue.items.length ? 'Next pull request' : 'Finish queue'}
                            </button>
                            <button className="icon-button" title="End the review queue" onClick={endQueue}>
                                <X size={14} strokeWidth={1.7} />
                            </button>
                        </div>
                    )}
                    <ReviewPullRequest
                        key={repo}
                        tab={routeTab}
                        onSelectTab={selectTab}
                        repo={repoRef}
                        status={status}
                        pr={pr ?? undefined}
                        loading={prLoading}
                        syncedAt={prQuery.dataUpdatedAt}
                        error={prError}
                        onRefresh={refresh}
                        onBack={backToList}
                        onNewWorktree={onNewWorktree && (target => onNewWorktree(repoRef, target))}
                        onSendToAgent={onSendToAgent && ((target, prompt) => onSendToAgent(repoRef, target, prompt))}
                        onSendLogToAgent={onSendLogToAgent && ((target, check) => onSendLogToAgent(repoRef, target, check))}
                        onSendChecksToAgent={onSendChecksToAgent && ((target, checks) => onSendChecksToAgent(repoRef, target, checks))}
                        projects={projects}
                        onPullRepo={onPullRepo && (target => onPullRepo(repoRef, target))}
                    />
                </div>
            )}
        </div>
    );
}
