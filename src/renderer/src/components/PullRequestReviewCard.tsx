import { useId, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Bot, Check, LoaderCircle, MessageSquare, X } from 'lucide-react';
import type { DiffSide, PendingComment, PullRequest, PullRequestFile, ReviewEvent } from '@shared/github';
import { decisionEvents, firstUndecided, pendingText, REVIEW_EVENT_TEXT, reviewButtons, reviewEvents, undecidedText } from '../github/review-state';
import { ButtonGroup } from './ButtonGroup';
import { MentionTextarea } from './MentionTextarea';

/** The tooltip of the buttons that start an agent review. */
export const AGENT_REVIEW_TITLE =
    'An agent reviews the changes. You accept or remove each of its comments. Nothing goes to GitHub until you submit the review.';

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
    onOpenDiff(pr: PullRequest, file: PullRequestFile, line?: number, side?: DiffSide): void;
    /** Starts and stops an agent review. Without it, the card has no Run agent review button. */
    agentReview?: AgentReviewControl;
}

/** The state of the agent review of a pull request, and the functions that start and stop it. */
export interface AgentReviewControl {
    running: boolean;
    run(): void;
    cancel(): void;
}

/** The button that starts an agent review. While the review runs, it shows the progress and a Cancel button. */
function AgentReviewButton({ control }: { control: AgentReviewControl }) {
    if (control.running) {
        return (
            <ButtonGroup className="agent-review-button" label="Agent review">
                <button className="button" disabled>
                    <LoaderCircle size={13} className="spin" />
                    Agent review in progress
                </button>
                <button className="button button-group-arrow" title="Cancel the agent review" aria-label="Cancel the agent review" onClick={control.cancel}>
                    <X size={13} strokeWidth={1.8} />
                </button>
            </ButtonGroup>
        );
    }
    return (
        <button className="button agent-review-button" title={AGENT_REVIEW_TITLE} onClick={control.run}>
            <Bot size={14} strokeWidth={1.6} />
            Run agent review
        </button>
    );
}

/** The card where the user writes a review and submits it. The Overview tab shows it in the side column. */
export function PullRequestReviewCard({ pr, overview, body, onBody, pending, files, busy, onSubmit, onOpenDiff, agentReview }: Props) {
    const summaryId = useId();
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
                    <button className="link-button" onClick={() => onOpenDiff(pr, firstFile, first.comment.line, first.comment.side)}>
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
                <MentionTextarea
                    className="review-body"
                    value={body}
                    placeholder="Write a summary of your review (optional)"
                    onValueChange={onBody}
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
                {agentReview && <AgentReviewButton control={agentReview} />}
            </header>
            {(pr.viewerIsRequested || pendingPill) && (
                <div className="review-card-notes">
                    {pr.viewerIsRequested && <span className="review-requested">Requested from you</span>}
                    {pendingPill}
                </div>
            )}
            <label className="side-card-field" htmlFor={summaryId}>
                <span>Summary (optional)</span>
                <MentionTextarea
                    id={summaryId}
                    className="review-body"
                    value={body}
                    placeholder={pr.author?.login ? `Leave a note for ${pr.author.login}…` : 'Leave a note…'}
                    onValueChange={onBody}
                    onKeyDown={onReviewKey}
                />
            </label>
            {undecidedNote}
            <div className={`review-decisions count-${decisions.length}`}>{decisions.map(eventButton)}</div>
            {decisions.length < events.length && (
                <div className="review-card-foot">
                    <span className="header-spacer" />
                    <span className="review-shortcut" title="Press ⌘↵ in the summary to submit a comment without a decision.">
                        Comment only: ⌘↵
                    </span>
                </div>
            )}
        </section>
    );
}
