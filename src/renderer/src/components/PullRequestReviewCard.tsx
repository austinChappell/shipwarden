import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Bot, Check, LoaderCircle, MessageSquare } from 'lucide-react';
import type { PendingComment, PullRequest, PullRequestFile, ReviewEvent } from '@shared/github';
import { decisionEvents, firstUndecided, pendingText, REVIEW_EVENT_TEXT, reviewButtons, reviewEvents, undecidedText } from '../github/review-state';

interface Props {
    pr: PullRequest;
    overview: boolean;
    /** The text of the review. */
    body: string;
    onBody(value: string): void;
    pending: PendingComment[];
    files: PullRequestFile[] | undefined;
    busy: boolean;
    onSubmit(event: ReviewEvent): void;
    onOpenDiff(pr: PullRequest, file: PullRequestFile, line?: number): void;
    /** Starts an agent review. Without it, the card has no link for an agent review. */
    agentReview?: { running: boolean; run(): void };
}

/** The card where the user writes a review and submits it. The Overview tab shows it in the side column. */
export function PullRequestReviewCard({ pr, overview, body, onBody, pending, files, busy, onSubmit, onOpenDiff, agentReview }: Props) {
    const events = reviewEvents(pr);
    const { undecided, canComment, canDecide } = reviewButtons({ events, body, pending, busy });
    const first = firstUndecided(pending, files);
    const firstFile = first?.file;
    // ⌘↵ in the review text submits a comment without a decision.
    const onReviewKey = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key === 'Enter' && event.metaKey && canComment) {
            event.preventDefault();
            onSubmit('COMMENT');
        }
    };
    const eventButton = (event: ReviewEvent) =>
        event === 'COMMENT' ? (
            <button key={event} className="button" disabled={!canComment} onClick={() => onSubmit(event)}>
                Comment
            </button>
        ) : event === 'APPROVE' ? (
            <button key={event} className="button approve" disabled={!canDecide} onClick={() => onSubmit(event)}>
                <Check size={14} strokeWidth={2} />
                Approve
            </button>
        ) : (
            <button key={event} className="button" disabled={!canDecide} onClick={() => onSubmit(event)}>
                {REVIEW_EVENT_TEXT[event].button}
            </button>
        );
    const decisions = decisionEvents(events, overview);
    const pendingPill = pending.length > 0 && (
        <span className="pending-pill" title="These comments go out with this review.">
            <MessageSquare size={12} strokeWidth={1.8} />
            {pendingText(pending.length)}
        </span>
    );
    const undecidedNote = undecided > 0 && (
        <div className="panel-note review-undecided">
            {undecidedText(undecided)}
            {first && firstFile && (
                <>
                    {' '}
                    <button className="link-button" onClick={() => onOpenDiff(pr, firstFile, first.comment.line)}>
                        Show the first one
                    </button>
                </>
            )}
        </div>
    );

    if (!overview) {
        return (
            <section className="footer-card review-card" aria-label="Your review">
                <header className="footer-card-header">
                    <span className="footer-card-title">Your review</span>
                    {pendingPill}
                </header>
                <textarea
                    className="review-body"
                    value={body}
                    placeholder="Write a summary of your review (optional)"
                    onChange={event => onBody(event.target.value)}
                    onKeyDown={onReviewKey}
                />
                {undecidedNote}
                <div className="review-actions">{events.map(eventButton)}</div>
            </section>
        );
    }
    return (
        <section className="side-card review-card" aria-label="Your review">
            <header className="side-card-header">
                <span className="side-card-title">Your review</span>
                <span className="header-spacer" />
                {pr.viewerIsRequested && <span className="review-requested">Requested from you</span>}
            </header>
            {pendingPill && <div>{pendingPill}</div>}
            <label className="side-card-field">
                <span>Summary (optional)</span>
                <textarea
                    className="review-body"
                    value={body}
                    placeholder={pr.author?.login ? `Leave a note for ${pr.author.login}…` : 'Leave a note…'}
                    onChange={event => onBody(event.target.value)}
                    onKeyDown={onReviewKey}
                />
            </label>
            {undecidedNote}
            <div className={`review-decisions count-${decisions.length}`}>{decisions.map(eventButton)}</div>
            {(agentReview || decisions.length < events.length) && (
                <div className="review-card-foot">
                    {agentReview && (
                        <button
                            className="link-button"
                            title="An agent reviews the changes. You accept or remove each of its comments. Nothing goes to GitHub until you submit the review."
                            disabled={agentReview.running}
                            onClick={agentReview.run}
                        >
                            {agentReview.running ? <LoaderCircle size={13} className="spin" /> : <Bot size={13} strokeWidth={1.6} />}
                            {agentReview.running ? 'The agent reviews the changes…' : 'Run agent review first'}
                        </button>
                    )}
                    <span className="header-spacer" />
                    {decisions.length < events.length && (
                        <span className="review-shortcut" title="Press ⌘↵ in the summary to submit a comment without a decision.">
                            Comment only: ⌘↵
                        </span>
                    )}
                </div>
            )}
        </section>
    );
}
