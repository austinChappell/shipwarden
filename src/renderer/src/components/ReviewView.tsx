import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GitPullRequest, X } from 'lucide-react';
import type { BranchStatus, CheckRun, PullRequest, RepoRef } from '@shared/github';
import type { ProjectsState, PullRepoTarget } from '@shared/projects';
import type { QueueItem } from '@shared/review-queue';
import { errorText } from '../util';
import { cacheKey, cached, remember } from '../data-cache';
import { reviewStore } from '../github/review-store';
import { reviewOverviewStore, useReviewOverview, useReviewQueue } from '../github/review-overview-store';
import { sortedGroups } from './Combobox';
import { ReviewHome } from './ReviewHome';
import { ReviewRepoPage } from './ReviewRepoPage';
import { ReviewPullRequest } from './ReviewPullRequest';

const api = window.shipwarden.github;

const prKey = (repo: string, number: number) => cacheKey('review.pr', repo, number);

interface Props {
    /** A key for the GitHub providers of Settings › Code review. Undefined: not loaded yet. Null: no GitHub provider is on. */
    githubKey: string | null | undefined;
    /** Opens Settings > Code review. */
    onOpenSettings(): void;
    /** A pull request to open, for example from the Dashboard. A new `nonce` opens it again. */
    open?: ReviewOpenRequest;
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

export interface ReviewOpenRequest {
    /** "owner/name". */
    repo: string;
    number: number;
    tab: 'overview' | 'checks' | 'files';
    nonce: number;
}

/** A review queue that the user started: a fixed list of pull requests, and the position in it. */
interface ActiveQueue {
    items: QueueItem[];
    index: number;
}

function toRef(repo: string): RepoRef {
    const [owner, name] = repo.split('/');
    return { owner, name };
}

/**
 * The Review view: the pull requests of the GitHub repositories, from the organizations in Settings > Code review.
 * The view has three pages. The entry page shows the repositories with pull requests that wait on the user.
 * The list page shows the pull requests of one repository. The pull request page shows one pull request.
 * The data of the first two pages comes from the review overview store, which loads at app start.
 * The review queue opens the pull requests to review one after the other, the oldest first.
 */
export function ReviewView({ githubKey, onOpenSettings, open, onNewWorktree, onSendToAgent, onSendLogToAgent, onSendChecksToAgent, projects, onPullRepo }: Props) {
    const overview = useReviewOverview();
    const queueItems = useReviewQueue();
    const [repo, setRepo] = useState<string>();
    const [selected, setSelected] = useState<number>();
    const [pr, setPr] = useState<PullRequest | null>();
    const [prLoading, setPrLoading] = useState(false);
    const [prError, setPrError] = useState<string>();
    const [queue, setQueue] = useState<ActiveQueue>();
    /** The repository and the pull request that the user came back from. The pages focus their rows. */
    const [lastRepo, setLastRepo] = useState<string>();
    const [lastNumber, setLastNumber] = useState<number>();

    const repoRef = useMemo(() => (repo ? toRef(repo) : undefined), [repo]);

    /** Opens a pull request, also in another repository. */
    const pendingOpen = useRef<{ repo: string; number: number } | undefined>(undefined);
    const openPr = useCallback(
        (target: string, number: number) => {
            // The selection effect below runs only when the repository changes.
            pendingOpen.current = target !== repo ? { repo: target, number } : undefined;
            setRepo(target);
            setSelected(number);
        },
        [repo]
    );

    // A new repository starts with no selection, or with the pull request of an open request.
    useEffect(() => {
        const pending = pendingOpen.current;
        setSelected(pending && pending.repo === repo ? pending.number : undefined);
        pendingOpen.current = undefined;
    }, [repo]);

    // An open request selects its repository and pull request.
    // biome-ignore lint/correctness/useExhaustiveDependencies: The effect runs one time for each open request. A new nonce is a new request.
    useEffect(() => {
        if (!open) return;
        setQueue(undefined);
        openPr(open.repo, open.number);
    }, [open?.nonce]);

    /** Each pull request request gets a number, so that a slow response for another pull request cannot show. */
    const prRequest = useRef(0);
    const loadPr = useCallback(async () => {
        if (!repoRef || !selected) return;
        const id = ++prRequest.current;
        setPrLoading(true);
        try {
            const result = await api.pullRequest(repoRef, selected);
            if (id !== prRequest.current) return;
            setPr(remember(prKey(`${repoRef.owner}/${repoRef.name}`, selected), result));
            setPrError(undefined);
        } catch (err) {
            if (id === prRequest.current) setPrError(errorText(err));
        } finally {
            if (id === prRequest.current) setPrLoading(false);
        }
    }, [repoRef, selected]);

    // A pull request shows its cached data immediately, and loads new data in the background.
    useEffect(() => {
        setPr(repoRef && selected ? cached<PullRequest>(prKey(`${repoRef.owner}/${repoRef.name}`, selected)) : undefined);
        setPrError(undefined);
        void loadPr();
    }, [loadPr, repoRef, selected]);

    const refresh = async () => {
        await Promise.all([loadPr(), repo ? reviewOverviewStore.refresh(repo) : undefined]);
    };

    /** The panels take a branch status. In the Review view, it comes from the pull request. */
    const status: BranchStatus | undefined = repoRef && pr ? { repo: repoRef, branch: pr.headRefName, sha: pr.headRefOid, pullRequest: pr } : undefined;

    /** The repositories by owner, for the groups of the picker. */
    const groups = useMemo(
        () =>
            sortedGroups(
                overview.catalog ?? [],
                item => item.owner,
                item => ({ value: `${item.owner}/${item.name}`, label: item.name })
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
        setLastRepo(repo);
        setRepo(undefined);
    };

    const backToList = () => {
        setQueue(undefined);
        setLastNumber(selected);
        setSelected(undefined);
    };
    const backToHome = () => {
        setLastRepo(repo);
        setRepo(undefined);
    };

    /** Opens the pull request and starts an agent review of it. The agent posts nothing. */
    const handToAgent = async (number: number) => {
        if (!repoRef || !repo) return;
        setSelected(number);
        try {
            const full = cached<PullRequest>(prKey(repo, number)) ?? (await api.pullRequest(repoRef, number));
            void reviewStore.runAgentReview(repoRef, full);
        } catch (err) {
            setPrError(errorText(err));
        }
    };

    if (githubKey === undefined) {
        return <div className="review-view" />;
    }
    if (githubKey === null) {
        return (
            <div className="review-view">
                <div className="review-empty">
                    <GitPullRequest size={30} strokeWidth={1.3} />
                    <h2>Review pull requests</h2>
                    <p>Add a GitHub provider to see its pull requests here.</p>
                    <button className="button primary" onClick={onOpenSettings}>
                        Open Settings › Code review
                    </button>
                </div>
            </div>
        );
    }

    if (!repo || !repoRef) {
        return (
            <div className="review-view">
                <ReviewHome
                    queue={queueItems}
                    focusRepo={lastRepo}
                    onSelect={value => setRepo(value)}
                    onStartQueue={startQueue}
                    onOpenSettings={onOpenSettings}
                />
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
                onSelectRepo={value => setRepo(value)}
                onBack={backToHome}
                onOpen={number => setSelected(number)}
                onCheckout={onNewWorktree && (target => onNewWorktree(repoRef, target))}
                onHandToAgent={number => void handToAgent(number)}
            />

            {selected && (
                <div className="review-body review-pr-wrap">
                    {queue && (
                        <div className="review-queue-bar" role="status">
                            <span>
                                Review queue · {queue.index + 1} of {queue.items.length}
                            </span>
                            <span className="header-spacer" />
                            <button className="button" onClick={stepQueue}>
                                {queue.index + 1 < queue.items.length ? 'Next pull request' : 'Finish queue'}
                            </button>
                            <button className="icon-button" title="End the review queue" onClick={endQueue}>
                                <X size={14} strokeWidth={1.7} />
                            </button>
                        </div>
                    )}
                    <ReviewPullRequest
                        key={repo}
                        tabRequest={open && open.repo === repo && open.number === selected ? open : undefined}
                        repo={repoRef}
                        status={status}
                        pr={pr ?? undefined}
                        loading={prLoading}
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
