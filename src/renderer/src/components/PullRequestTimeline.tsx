import type { CSSProperties, ReactNode } from 'react';
import {
    Bookmark,
    Bot,
    CircleSlash,
    Eye,
    EyeOff,
    GitBranch,
    GitCommitHorizontal,
    GitMerge,
    GitPullRequest,
    GitPullRequestClosed,
    GitPullRequestDraft,
    Pencil,
    Tag,
    UserMinus,
    UserPlus,
    type LucideIcon
} from 'lucide-react';
import { hostLabel, type GitHubLabel, type GitHubUser, type PullRequest, type PullRequestCommit, type Reaction, type TimelineEvent } from '@shared/github';
import { ReactionAddButton, ReactionList, useReactionState, type ReactionActions } from './Reactions';
import { commentPrompt, reviewPrompt, reviewThreads } from '../github/agent-prompts';
import { timeAgo } from '../util';
import { openLink } from '../links';
import { Markdown } from './Markdown';
import { buildTimeline, type TimelineItem } from './pr-timeline';
import { Avatar } from './Avatar';

export const REVIEW_STATE_TEXT: Record<string, string> = {
    APPROVED: 'approved',
    CHANGES_REQUESTED: 'requested changes',
    COMMENTED: 'reviewed',
    DISMISSED: 'dismissed',
    APPROVED_WITH_SUGGESTIONS: 'approved with suggestions',
    WAITING_FOR_AUTHOR: 'is waiting for the author',
    REJECTED: 'rejected'
};

function When({ iso }: { iso: string }) {
    if (!iso) return null;
    return (
        <time className="pr-timeline-time" dateTime={iso} title={new Date(iso).toLocaleString()}>
            {timeAgo(iso)}
        </time>
    );
}

/**
 * Finds the avatar URL of a login. The pull request data has the avatars of the author, the commenters, the reviewers
 * and the assignees. For another GitHub login, the URL "github.com/<login>.png" sends the avatar. Azure DevOps has no such URL.
 */
function avatarUrlOf(pr: PullRequest, login: string): string | undefined {
    const users = [pr.author, ...pr.assignees, ...pr.issueComments.map(comment => comment.author), ...pr.reviews.map(review => review.author)];
    const known = users.find(user => user?.login === login && user.avatarUrl)?.avatarUrl;
    if (known) return known;
    if (pr.host === 'azure' || !/^[A-Za-z0-9-]+$/.test(login)) return undefined;
    return `https://github.com/${login}.png`;
}

/** The small avatar before the name of the actor of an event. */
function ActorAvatar({ pr, login }: { pr: PullRequest; login: string | null }) {
    if (!login) return null;
    return <Avatar login={login} url={avatarUrlOf(pr, login)} size={20} className="pr-timeline-actor-avatar" />;
}

/** A bot login on GitHub ends with "[bot]", for example "codecov[bot]". */
function authorName(login: string | undefined | null): { name: string; bot: boolean } {
    if (!login) return { name: 'unknown', bot: false };
    const bot = login.endsWith('[bot]');
    return { name: bot ? login.slice(0, -'[bot]'.length) : login, bot };
}

/**
 * A comment or a review: the avatar of the author on the line, and a card at its right.
 * The header shows the buttons that add a reaction and that send the text to the agent. The reaction chips follow the body.
 */
function CardRow({
    author,
    subjectId,
    body,
    reactions,
    reactionActions,
    agentPrompt,
    onSendToAgent,
    className,
    header
}: {
    author: GitHubUser | null;
    subjectId: string;
    body: string;
    reactions: readonly Reaction[] | undefined;
    reactionActions?: ReactionActions;
    /** The prompt that the agent button sends. Without it, the card has no agent button. */
    agentPrompt?: () => string;
    onSendToAgent?(prompt: string): void;
    className?: string;
    header: ReactNode;
}) {
    const { name, bot } = authorName(author?.login);
    const hasBody = body.trim() !== '';
    const reactionState = useReactionState(subjectId, reactions, hasBody ? reactionActions : undefined);
    const sendable = onSendToAgent && agentPrompt;
    return (
        <li className="pr-timeline-item pr-timeline-event">
            <Avatar login={name} url={author?.avatarUrl} size={34} className={`pr-timeline-badge${bot ? ' bot' : ''}`} />
            <div className={`pr-timeline-card${className ? ` ${className}` : ''}`}>
                <div className="pr-timeline-card-header">
                    <span className="pr-timeline-card-title">
                        <strong>{name}</strong>
                        {bot && <span className="tag pr-timeline-bot">bot</span>} {header}
                    </span>
                    {(reactionState || sendable) && (
                        <span className="pr-timeline-card-actions">
                            {reactionState && <ReactionAddButton state={reactionState} className="icon-button" />}
                            {sendable && (
                                <button type="button" className="icon-button" title="Send this to the agent" onClick={() => onSendToAgent(agentPrompt())}>
                                    <Bot size={14} strokeWidth={1.6} />
                                </button>
                            )}
                        </span>
                    )}
                </div>
                {hasBody && <Markdown className="pr-timeline-body" text={body} />}
                {reactionState && <ReactionList state={reactionState} className="pr-timeline-reactions" />}
            </div>
        </li>
    );
}

function LabelChip({ label }: { label: GitHubLabel }) {
    return (
        <span className="pr-chip label" style={{ '--label-color': `#${label.color}` } as CSSProperties}>
            {label.name}
        </span>
    );
}

/** The icon and the text of one event. The text starts after the name of the actor. */
function describe(event: TimelineEvent, pr: PullRequest): { icon: LucideIcon; tone?: string; text: ReactNode } {
    switch (event.kind) {
        case 'assigned':
            return {
                icon: UserPlus,
                text:
                    event.user === event.actor ? (
                        'self-assigned this'
                    ) : (
                        <>
                            assigned <strong>{event.user}</strong>
                        </>
                    )
            };
        case 'unassigned':
            return {
                icon: UserMinus,
                text:
                    event.user === event.actor ? (
                        'removed their assignment'
                    ) : (
                        <>
                            unassigned <strong>{event.user}</strong>
                        </>
                    )
            };
        case 'labeled':
            return {
                icon: Tag,
                text: (
                    <>
                        added the <LabelChip label={event.label} /> label
                    </>
                )
            };
        case 'unlabeled':
            return {
                icon: Tag,
                text: (
                    <>
                        removed the <LabelChip label={event.label} /> label
                    </>
                )
            };
        case 'reviewRequested':
            return {
                icon: Eye,
                text: (
                    <>
                        requested a review from <strong>{event.reviewer}</strong>
                    </>
                )
            };
        case 'reviewRequestRemoved':
            return {
                icon: EyeOff,
                text: (
                    <>
                        removed the review request for <strong>{event.reviewer}</strong>
                    </>
                )
            };
        case 'closed':
            return { icon: GitPullRequestClosed, tone: 'closed', text: 'closed this' };
        case 'reopened':
            return { icon: GitPullRequest, tone: 'open', text: 'reopened this' };
        case 'merged':
            return {
                icon: GitMerge,
                tone: 'merged',
                text: (
                    <>
                        merged{' '}
                        {event.commit && (
                            <>
                                commit{' '}
                                {event.commitUrl ? (
                                    <button
                                        className="link-button mono"
                                        title={`Open the commit on ${hostLabel(pr.host)}`}
                                        onClick={click => openLink(event.commitUrl!, click)}
                                    >
                                        {event.commit}
                                    </button>
                                ) : (
                                    <code>{event.commit}</code>
                                )}{' '}
                            </>
                        )}
                        into <code>{event.base}</code>
                    </>
                )
            };
        case 'readyForReview':
            return { icon: GitPullRequest, text: 'marked this pull request as ready for review' };
        case 'convertToDraft':
            return { icon: GitPullRequestDraft, text: 'marked this pull request as a draft' };
        case 'autoMergeEnabled':
            return { icon: GitMerge, text: 'turned on auto-merge' };
        case 'autoMergeDisabled':
            return { icon: GitMerge, text: 'turned off auto-merge' };
        case 'renamed':
            return {
                icon: Pencil,
                text: (
                    <>
                        changed the title from <del>{event.from}</del> to <strong>{event.to}</strong>
                    </>
                )
            };
        case 'forcePushed':
            return {
                icon: GitBranch,
                text: (
                    <>
                        force-pushed the branch
                        {event.before && event.after && (
                            <>
                                {' '}
                                from <code>{event.before}</code> to <code>{event.after}</code>
                            </>
                        )}
                    </>
                )
            };
        case 'headRefDeleted':
            return {
                icon: GitBranch,
                text: (
                    <>
                        deleted the <code>{event.branch}</code> branch
                    </>
                )
            };
        case 'headRefRestored':
            return { icon: GitBranch, text: 'restored the head branch' };
        case 'baseChanged':
            return {
                icon: GitBranch,
                text: (
                    <>
                        changed the base branch from <code>{event.from}</code> to <code>{event.to}</code>
                    </>
                )
            };
        case 'reviewDismissed':
            return {
                icon: CircleSlash,
                text: (
                    <>
                        dismissed the review of <strong>{event.reviewer ?? 'unknown'}</strong>
                        {event.message && <>: {event.message}</>}
                    </>
                )
            };
        case 'referenced':
            return {
                icon: Bookmark,
                text: (
                    <>
                        mentioned this in{' '}
                        <button className="link-button" title={event.url} onClick={click => openLink(event.url, click)}>
                            {event.title} {event.repo}#{event.number}
                        </button>
                    </>
                )
            };
    }
}

function EventRow({ event, pr }: { event: TimelineEvent; pr: PullRequest }) {
    const { icon: Icon, tone, text } = describe(event, pr);
    return (
        <li className="pr-timeline-item pr-timeline-event">
            <span className={`pr-timeline-badge${tone ? ` ${tone}` : ''}`}>
                <Icon size={14} strokeWidth={1.8} />
            </span>
            <div className="pr-timeline-text">
                <ActorAvatar pr={pr} login={event.actor} />
                <strong>{event.actor ?? 'unknown'}</strong> {text} <When iso={event.createdAt} />
            </div>
        </li>
    );
}

function Row({
    item,
    pr,
    reactions,
    onOpenCommit,
    onSendToAgent
}: {
    item: TimelineItem;
    pr: PullRequest;
    reactions?: ReactionActions;
    onOpenCommit?(commit: PullRequestCommit): void;
    onSendToAgent?(prompt: string): void;
}) {
    switch (item.type) {
        case 'comment':
            return (
                <CardRow
                    author={item.comment.author}
                    subjectId={item.comment.id}
                    body={item.comment.body}
                    reactions={item.comment.reactions}
                    reactionActions={reactions}
                    agentPrompt={item.comment.body.trim() ? () => commentPrompt(pr, item.comment.author?.login ?? null, item.comment.body) : undefined}
                    onSendToAgent={onSendToAgent}
                    header={
                        <>
                            commented <When iso={item.createdAt} />
                        </>
                    }
                />
            );
        case 'review': {
            const { review } = item;
            const sendable = review.body.trim() !== '' || reviewThreads(pr, review).length > 0;
            return (
                <CardRow
                    author={review.author}
                    subjectId={review.id}
                    body={review.body}
                    reactions={review.reactions}
                    reactionActions={reactions}
                    agentPrompt={sendable ? () => reviewPrompt(pr, review) : undefined}
                    onSendToAgent={onSendToAgent}
                    className={`review-${review.state.toLowerCase()}`}
                    header={
                        <>
                            <span className={`tag review-${review.state.toLowerCase()}`}>{REVIEW_STATE_TEXT[review.state] ?? review.state.toLowerCase()}</span>{' '}
                            <When iso={item.createdAt} />
                        </>
                    }
                />
            );
        }
        case 'commits': {
            const authors = [...new Set(item.commits.map(commit => commit.author ?? 'unknown'))];
            return (
                <li className="pr-timeline-item pr-timeline-event">
                    <span className="pr-timeline-badge">
                        <GitCommitHorizontal size={14} strokeWidth={1.8} />
                    </span>
                    <div className="pr-timeline-text">
                        <ActorAvatar pr={pr} login={authors[0] ?? null} />
                        <strong>{authors.join(', ')}</strong> added {item.commits.length} commit{item.commits.length === 1 ? '' : 's'}{' '}
                        <When iso={item.createdAt} />
                        <ul className="pr-timeline-commits">
                            {item.commits.map(commit => (
                                <li key={commit.oid}>
                                    {onOpenCommit ? (
                                        <button
                                            className="pr-timeline-commit-open"
                                            title="Show the changes of this commit"
                                            onClick={() => onOpenCommit(commit)}
                                        >
                                            <span className="pr-timeline-commit-title">{commit.messageHeadline}</span>
                                            <code className="pr-timeline-commit-sha">{commit.abbreviatedOid}</code>
                                        </button>
                                    ) : (
                                        <>
                                            <span className="pr-timeline-commit-title" title={commit.messageHeadline}>
                                                {commit.messageHeadline}
                                            </span>
                                            <button
                                                className="link-button mono"
                                                title={`Open the commit on ${hostLabel(pr.host)}`}
                                                onClick={event => openLink(commit.url, event)}
                                            >
                                                {commit.abbreviatedOid}
                                            </button>
                                        </>
                                    )}
                                </li>
                            ))}
                        </ul>
                    </div>
                </li>
            );
        }
        case 'event':
            return <EventRow event={item.event} pr={pr} />;
    }
}

/** The activity of a pull request on the Overview tab: comments, reviews, commits and events in one timeline, the oldest first. */
/** With `onOpenCommit`, a click on a commit shows its diff in ShipWarden. Without it, the SHA is a link to the host. */
/** With `onSendToAgent`, each comment and review has a button that sends it to the agent. A review prompt also has its open threads. */
export function PullRequestTimeline({
    pr,
    reactions,
    onOpenCommit,
    onSendToAgent
}: {
    pr: PullRequest;
    reactions?: ReactionActions;
    onOpenCommit?(commit: PullRequestCommit): void;
    onSendToAgent?(prompt: string): void;
}) {
    const items = buildTimeline(pr);
    return (
        <section className="pr-section">
            <div className="section-title">Activity</div>
            {items.length === 0 ? (
                <div className="panel-note">No activity yet.</div>
            ) : (
                <ol className="pr-timeline">
                    {items.map(item => (
                        <Row
                            key={`${item.type}:${item.id}`}
                            item={item}
                            pr={pr}
                            reactions={reactions}
                            onOpenCommit={onOpenCommit}
                            onSendToAgent={onSendToAgent}
                        />
                    ))}
                </ol>
            )}
        </section>
    );
}
