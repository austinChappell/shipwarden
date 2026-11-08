import { useMemo, useState, type ReactNode } from 'react';
import { Check, CheckCheck, ChevronRight, CircleCheck, CircleX, ExternalLink, EyeOff, FileWarning, Filter, GitMerge, GitPullRequest, LayoutDashboard, MessageSquare, RefreshCw, Settings2, SquareCheckBig, TriangleAlert } from 'lucide-react';
import {
    DASHBOARD_WINDOW_DAYS,
    gitHubSeenKey,
    isHiddenComment,
    MY_PULL_REQUEST_GROUP_ORDER,
    MY_PULL_REQUEST_REASON_LABELS,
    myPullRequestGroup,
    parsePullRequestTitle,
    shortAge,
    taskSeenKey,
    type MyPullRequestReason,
    type CommentFilter,
    type MyPullRequestItem,
    type PullRequestCommentItem,
    type TaskCommentItem
} from '@shared/dashboard';
import type { RepoRef } from '@shared/github';
import { dashboardStore, useDashboard } from '../dashboard-store';
import { seenStore, useSeenVersion } from '../seen-store';
import { timeAgo } from '../util';
import { Markdown } from './Markdown';
import { Masonry } from './Masonry';
import { confirmDialog } from './ConfirmDialog';

export type ReviewTabRequest = 'overview' | 'checks' | 'files';

interface Props {
    /** Opens a pull request in the Review view. */
    onOpenPullRequest(repo: RepoRef, number: number, tab: ReviewTabRequest): void;
    /** The hidden authors and the hiding rules of Settings > Dashboard. */
    filter: CommentFilter;
    onHideAuthor(author: string): void;
    /** Opens Settings > Dashboard with a new rule from this comment. */
    onCreateRule(author: string, text: string): void;
    onOpenSettings(): void;
}

const openUrl = (url: string | undefined) => url && window.shipwarden.github.openInBrowser(url);

function Section({ icon, title, count, actions, children }: { icon: ReactNode; title: string; count: number; actions?: ReactNode; children: ReactNode }) {
    return (
        <section className="dash-section">
            <header className="dash-section-header">
                {icon}
                <h2>{title}</h2>
                <span className={`dash-count${count === 0 ? ' zero' : ''}`}>{count}</span>
                <span className="header-spacer" />
                {actions}
            </header>
            <div className="dash-card">{children}</div>
        </section>
    );
}

function Empty({ text }: { text: string }) {
    return <div className="dash-empty"><CircleCheck size={14} strokeWidth={1.8} />{text}</div>;
}

/** The icon of each reason of the user's pull requests. The color comes from the CSS class of the reason. */
const REASON_ICONS: Record<MyPullRequestReason, typeof CircleX> = {
    'changes-requested': FileWarning,
    conflicts: TriangleAlert,
    'ci-failing': CircleX,
    'ready-to-merge': GitMerge
};

/** A title in two columns: the ticket ID (a fixed width, so the IDs line up) and the text without "fix:" and the ID. */
function Title({ title }: { title: string }) {
    const parsed = parsePullRequestTitle(title);
    return (
        <>
            <span className={`dash-ticket${parsed.ticket ? '' : ' none'}`}>{parsed.ticket ?? ''}</span>
            <span className="dash-title" title={title}>{parsed.text}</span>
        </>
    );
}

/** The right columns of a row: the repository and number, and the age. The owner shows on hover. */
function Meta({ repo, number, age, ageTitle, children }: { repo: RepoRef; number: number; age?: string; ageTitle?: string; children?: ReactNode }) {
    return (
        <span className="dash-meta">
            {children}
            <span className="dash-repo" title={`${repo.owner}/${repo.name} #${number}`}>{repo.name} <span className="dash-number">#{number}</span></span>
            {age !== undefined && <span className="dash-age" title={ageTitle}>{shortAge(age)}</span>}
        </span>
    );
}

/** A comment on the Dashboard. A click shows all of it and records it as seen. */
function CommentRow({ seenKey, author, createdAt, label, preview, body, onOpen, openTitle, onHideAuthor, onCreateRule }: {
    seenKey: string;
    author: string;
    createdAt: string;
    label?: string;
    preview: string;
    body: ReactNode;
    onOpen(): void;
    openTitle: string;
    onHideAuthor(author: string): void;
    onCreateRule(author: string, text: string): void;
}) {
    const [open, setOpen] = useState(false);
    const seen = seenStore.has(seenKey);
    const toggle = () => {
        setOpen(value => !value);
        seenStore.mark([seenKey]);
    };
    return (
        <div className={`dash-comment${seen ? ' seen' : ''}${open ? ' open' : ''}`}>
            <div className="dash-comment-head" onClick={toggle}>
                <ChevronRight size={13} strokeWidth={1.8} className={`group-chevron${open ? ' open' : ''}`} />
                {!seen && <span className="dash-unseen" title="New" />}
                <strong className="dash-author">{author}</strong>
                {label && <span className={`dash-tag ${label === 'approved' ? 'approved' : label === 'requested changes' ? 'changes' : ''}`}>{label}</span>}
                <span className="dash-preview">{open ? '' : preview}</span>
                <span className="dash-age" title={new Date(createdAt).toLocaleString()}>{shortAge(createdAt)}</span>
                <span className="dash-actions">
                    <button
                        className="icon-button dash-hide"
                        title="Hide comments like this one with a rule"
                        onClick={event => {
                            event.stopPropagation();
                            onCreateRule(author, preview);
                        }}
                    >
                        <Filter size={13} strokeWidth={1.7} />
                    </button>
                    <button
                        className="icon-button dash-hide"
                        title={`Hide all comments from ${author}, for example an automation account`}
                        onClick={event => {
                            event.stopPropagation();
                            void confirmDialog({
                                title: `Hide all comments from "${author}" on the Dashboard?`,
                                message: 'You can show them again in Settings › Dashboard.',
                                confirmLabel: 'Hide comments'
                            }).then(ok => ok && onHideAuthor(author));
                        }}
                    >
                        <EyeOff size={13} strokeWidth={1.7} />
                    </button>
                    <button className="icon-button" title={openTitle} onClick={event => { event.stopPropagation(); seenStore.mark([seenKey]); onOpen(); }}>
                        <ExternalLink size={13} strokeWidth={1.7} />
                    </button>
                    {!seen && (
                        <button className="icon-button" title="Mark as seen" onClick={event => { event.stopPropagation(); seenStore.mark([seenKey]); }}>
                            <Check size={14} strokeWidth={2} />
                        </button>
                    )}
                </span>
            </div>
            {open && <div className="dash-comment-body">{body}</div>}
        </div>
    );
}

function reviewLabel(item: PullRequestCommentItem): string | undefined {
    if (item.reviewState === 'APPROVED') return 'approved';
    if (item.reviewState === 'CHANGES_REQUESTED') return 'requested changes';
    if (item.path) return item.path.split('/').pop();
    return item.reviewState ? 'review' : undefined;
}


/** Groups items by a key, in the order of their first item. */
function groupBy<T>(items: T[], key: (item: T) => string): [string, T[]][] {
    const groups = new Map<string, T[]>();
    for (const item of items) {
        groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
    }
    return [...groups.entries()];
}

/**
 * The Dashboard: the things that need the user. Review requests, the user's pull requests that need an action,
 * and new comments on pull requests and tasks. A comment is new until the user sees it in ShipWarden.
 */
export function DashboardView({ onOpenPullRequest, filter, onHideAuthor, onCreateRule, onOpenSettings }: Props) {
    const state = useDashboard();
    useSeenVersion();
    // Comments that the user saw while the Dashboard was open stay in the list (dimmed) until the next load.
    const [shownAt] = useState(() => new Set<string>());
    const visible = (key: string) => {
        if (!seenStore.has(key)) {
            shownAt.add(key);
            return true;
        }
        return shownAt.has(key);
    };

    const pullRequests = state.pullRequests;
    const hiddenKey = JSON.stringify(filter);
    const prComments = useMemo(
        () => (state.prComments ?? []).filter(item => !isHiddenComment(item.author, item.text, filter)),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [state.prComments, hiddenKey]
    );
    const shownPrComments = prComments.filter(item => visible(gitHubSeenKey(item.id)));
    const unseenPr = prComments.filter(item => !seenStore.has(gitHubSeenKey(item.id)));
    const taskComments = state.tasks.flatMap(source => (source.comments ?? [])
        .filter(comment => !isHiddenComment(comment.author, comment.body, filter))
        .map(comment => ({ source, comment })));
    const shownTaskComments = taskComments.filter(({ source, comment }) => visible(taskSeenKey(source.connectionId, comment.id)));
    const unseenTask = taskComments.filter(({ source, comment }) => !seenStore.has(taskSeenKey(source.connectionId, comment.id)));

    const hiddenCount = (filter.hiddenAuthors?.length ?? 0) + (filter.hiddenRules?.length ?? 0);
    /** The sections move between the columns only when their content loads or changes, not when a comment opens. */
    const layoutKey = [
        pullRequests?.reviewRequests.length ?? -1,
        pullRequests?.myPullRequests.length ?? -1,
        state.prComments ? shownPrComments.length : -1,
        state.updatedAt ? shownTaskComments.length : -1,
        state.pullRequestsError ?? '',
        state.prCommentsError ?? ''
    ].join('|');
    const markAllPr = () => seenStore.mark(prComments.map(item => gitHubSeenKey(item.id)));
    const markAllTasks = () => seenStore.mark(taskComments.map(({ source, comment }) => taskSeenKey(source.connectionId, comment.id)));
    const myPrTab = (pr: MyPullRequestItem): ReviewTabRequest => (pr.reasons.includes('ci-failing') ? 'checks' : 'overview');

    return (
        <div className="dashboard-view">
            <header className="tasks-header dash-header">
                <div className="tasks-header-group where">
                    <LayoutDashboard size={16} strokeWidth={1.7} />
                    <h1>Dashboard</h1>
                    {state.updatedAt && <span className="dash-time">Updated {timeAgo(new Date(state.updatedAt).toISOString())}</span>}
                </div>
                <div className="tasks-header-group how">
                    <span className="header-spacer" />
                    {hiddenCount > 0 && (
                        <button className="link-button" title="Show the hidden authors and rules" onClick={onOpenSettings}>
                            {hiddenCount} hiding rule{hiddenCount === 1 ? '' : 's'}
                        </button>
                    )}
                    <button className="icon-button" title="Dashboard settings" onClick={onOpenSettings}>
                        <Settings2 size={15} strokeWidth={1.6} />
                    </button>
                    <button className="icon-button" title="Refresh" onClick={() => void dashboardStore.refresh()}>
                        <RefreshCw size={15} strokeWidth={1.6} className={state.loading ? 'spin' : ''} />
                    </button>
                </div>
            </header>

            <div className="dash-scroll">
                <Masonry minColumnWidth={420} gap={18} layoutKey={layoutKey}>
                    <Section icon={<GitPullRequest size={15} strokeWidth={1.7} />} title="Review requests" count={pullRequests?.reviewRequests.length ?? 0}>
                        {state.pullRequestsError && <div className="form-error">{state.pullRequestsError}</div>}
                        {!pullRequests && !state.pullRequestsError && <div className="panel-note">Loading…</div>}
                        {pullRequests?.reviewRequests.length === 0 && <Empty text="No pull requests wait for your review." />}
                        {pullRequests?.reviewRequests.map(pr => (
                            <button key={pr.url} className="dash-row" onClick={() => onOpenPullRequest(pr.repo, pr.number, 'files')}>
                                <Title title={pr.title} />
                                <Meta repo={pr.repo} number={pr.number} age={pr.updatedAt} ageTitle={`Updated ${timeAgo(pr.updatedAt)}`}>
                                    <span className="dash-person">{pr.author ?? 'unknown'}</span>
                                </Meta>
                            </button>
                        ))}
                    </Section>

                    <Section icon={<GitPullRequest size={15} strokeWidth={1.7} />} title="Your pull requests" count={pullRequests?.myPullRequests.length ?? 0}>
                        {state.pullRequestsError && <div className="form-error">{state.pullRequestsError}</div>}
                        {!pullRequests && !state.pullRequestsError && <div className="panel-note">Loading…</div>}
                        {pullRequests?.myPullRequests.length === 0 && <Empty text="None of your pull requests needs an action." />}
                        {pullRequests && MY_PULL_REQUEST_GROUP_ORDER.map(group => {
                            const items = pullRequests.myPullRequests.filter(pr => myPullRequestGroup(pr.reasons) === group);
                            if (items.length === 0) return null;
                            const Icon = REASON_ICONS[group];
                            return (
                                <div key={group} className="dash-subgroup">
                                    <div className={`dash-subgroup-head ${group}`}>
                                        <Icon size={13} strokeWidth={2} />
                                        {MY_PULL_REQUEST_REASON_LABELS[group]}
                                        <span className="dash-subgroup-count">{items.length}</span>
                                    </div>
                                    {items.map(pr => (
                                        <button key={pr.url} className="dash-row" onClick={() => onOpenPullRequest(pr.repo, pr.number, myPrTab(pr))}>
                                            <Title title={pr.title} />
                                            <Meta repo={pr.repo} number={pr.number} age={pr.updatedAt} ageTitle={`Updated ${timeAgo(pr.updatedAt)}`}>
                                                {pr.reasons.filter(reason => reason !== group).map(reason => {
                                                    const Extra = REASON_ICONS[reason];
                                                    return (
                                                        <span key={reason} className={`dash-extra ${reason}`} title={`Also: ${MY_PULL_REQUEST_REASON_LABELS[reason]}`}>
                                                            <Extra size={13} strokeWidth={2} />
                                                        </span>
                                                    );
                                                })}
                                            </Meta>
                                        </button>
                                    ))}
                                </div>
                            );
                        })}
                    </Section>

                    <Section
                        icon={<MessageSquare size={15} strokeWidth={1.7} />}
                        title="New pull request comments"
                        count={unseenPr.length}
                        actions={unseenPr.length > 0 && (
                            <button className="link-button" onClick={markAllPr}><CheckCheck size={13} strokeWidth={1.8} /> Mark all as seen</button>
                        )}
                    >
                        {state.prCommentsError && <div className="form-error">{state.prCommentsError}</div>}
                        {!state.prComments && !state.prCommentsError && <div className="panel-note">Loading comments… The first load can take some seconds.</div>}
                        {state.prComments && shownPrComments.length === 0 && <Empty text={`No new comments in the last ${DASHBOARD_WINDOW_DAYS} days.`} />}
                        {groupBy(shownPrComments, item => item.prUrl).map(([url, items]) => (
                            <div key={url} className="dash-group">
                                <button className="dash-row dash-group-head" onClick={() => onOpenPullRequest(items[0].repo, items[0].number, 'overview')}>
                                    <Title title={items[0].prTitle} />
                                    <Meta repo={items[0].repo} number={items[0].number} />
                                </button>
                                {items.map(item => (
                                    <CommentRow
                                        key={item.id}
                                        seenKey={gitHubSeenKey(item.id)}
                                        author={item.author}
                                        createdAt={item.createdAt}
                                        label={reviewLabel(item)}
                                        preview={item.text}
                                        body={<Markdown className="comment-body" text={item.text} html={item.html} />}
                                        onOpen={() => onOpenPullRequest(item.repo, item.number, item.path ? 'files' : 'overview')}
                                        openTitle="Open the pull request"
                                        onHideAuthor={onHideAuthor}
                                        onCreateRule={onCreateRule}
                                    />
                                ))}
                            </div>
                        ))}
                    </Section>

                    <Section
                        icon={<SquareCheckBig size={15} strokeWidth={1.7} />}
                        title="New task comments"
                        count={unseenTask.length}
                        actions={unseenTask.length > 0 && (
                            <button className="link-button" onClick={markAllTasks}><CheckCheck size={13} strokeWidth={1.8} /> Mark all as seen</button>
                        )}
                    >
                        {state.tasks.filter(source => source.error).map(source => (
                            <div key={source.connectionId} className="form-error">{source.name}: {source.error}</div>
                        ))}
                        {state.tasks.length === 0 && state.updatedAt && <Empty text="No task manager with comments for the Dashboard. Add ClickUp in Settings › Task managers." />}
                        {state.tasks.length > 0 && shownTaskComments.length === 0 && <Empty text={`No new comments on your tasks in the last ${DASHBOARD_WINDOW_DAYS} days.`} />}
                        {groupBy(shownTaskComments, ({ source, comment }) => `${source.connectionId}\0${comment.taskId}`).map(([key, items]) => {
                            const task: TaskCommentItem = items[0].comment;
                            return (
                                <div key={key} className="dash-group">
                                    <button className="dash-row dash-group-head" onClick={() => openUrl(task.taskUrl)} title="Open the task in the browser">
                                        <span className={`dash-ticket${task.taskKey ? '' : ' none'}`}>{task.taskKey ?? ''}</span>
                                        <span className="dash-title">{task.taskTitle}</span>
                                        <span className="dash-meta"><span className="dash-repo">{items[0].source.name}</span></span>
                                    </button>
                                    {items.map(({ source, comment }) => (
                                        <CommentRow
                                            key={comment.id}
                                            seenKey={taskSeenKey(source.connectionId, comment.id)}
                                            author={comment.author ?? 'unknown'}
                                            createdAt={comment.createdAt}
                                            preview={comment.body}
                                            body={<Markdown className="comment-body" text={comment.body} />}
                                            onOpen={() => openUrl(comment.taskId && task.taskUrl)}
                                            openTitle="Open the task in the browser"
                                            onHideAuthor={onHideAuthor}
                                            onCreateRule={onCreateRule}
                                        />
                                    ))}
                                </div>
                            );
                        })}
                    </Section>
                </Masonry>
            </div>
        </div>
    );
}
