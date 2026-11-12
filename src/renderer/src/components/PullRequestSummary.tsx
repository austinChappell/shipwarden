import type { ReactNode } from 'react';
import type { PullRequest } from '@shared/github';
import { pluralize as plural } from '@shared/format';
import type { CheckCounts } from '../github/use-check-counts';
import type { ReviewTab } from './ReviewPullRequest';

/** The color of a status text. "review" is for "changes requested". */
export type Tone = 'ok' | 'fail' | 'wait' | 'mine' | 'muted' | 'merged' | 'review';

/** One condition of a merge. "ok" passes, "fail" stops the merge, "wait" is not done yet. */
export interface MergeCondition {
    state: 'ok' | 'fail' | 'wait';
    text: string;
}

/** The conditions of a merge of an open pull request, in the order of the checklist. */
export function mergeConditions(pr: PullRequest, checks: CheckCounts | undefined): MergeCondition[] {
    const base = pr.baseRefName;
    const list: MergeCondition[] = [];
    if (pr.isDraft) list.push({ state: 'wait', text: 'The pull request is a draft' });
    if (checks && checks.total > 0) {
        if (checks.failed > 0) list.push({ state: 'fail', text: `${checks.failed} of ${plural(checks.total, 'check')} failed` });
        else if (checks.running > 0) list.push({ state: 'wait', text: `${checks.running} of ${plural(checks.total, 'check')} running` });
        else list.push({ state: 'ok', text: `${plural(checks.total, 'check')} passing` });
    } else if (!checks && pr.checkCount > 0) {
        list.push({ state: 'wait', text: 'Loading the checks' });
    }
    if (pr.mergeable === 'CONFLICTING') list.push({ state: 'fail', text: `Conflicts with ${base}` });
    else if (pr.mergeable === 'UNKNOWN') list.push({ state: 'wait', text: `Checking for conflicts with ${base}` });
    else list.push({ state: 'ok', text: `No conflicts with ${base}` });
    if (pr.mergeStateStatus === 'BEHIND') list.push({ state: 'wait', text: `The branch is behind ${base}` });
    if (pr.reviewDecision === 'APPROVED') list.push({ state: 'ok', text: 'Approved' });
    else if (pr.reviewDecision === 'CHANGES_REQUESTED') list.push({ state: 'fail', text: 'Changes requested' });
    else if (pr.reviewDecision === 'REVIEW_REQUIRED') list.push({ state: 'wait', text: 'Approving review required' });
    return list;
}

/** The short merge state of the summary strip. */
function mergeState(pr: PullRequest, checks: CheckCounts | undefined): { text: string; tone: Tone } {
    if (pr.state === 'MERGED') return { text: 'Merged', tone: 'merged' };
    if (pr.state === 'CLOSED') return { text: 'Closed', tone: 'fail' };
    if (pr.isDraft) return { text: 'Draft', tone: 'muted' };
    if (pr.autoMerge) return { text: 'Auto-merge is on', tone: 'ok' };
    if (pr.mergeable === 'CONFLICTING') return { text: 'Merge conflicts', tone: 'fail' };
    if (checks && checks.failed > 0) return { text: 'Blocked by checks', tone: 'fail' };
    if (pr.reviewDecision === 'CHANGES_REQUESTED') return { text: 'Blocked by changes requested', tone: 'fail' };
    if (pr.reviewDecision === 'REVIEW_REQUIRED') return { text: 'Blocked by a required approval', tone: 'wait' };
    if (checks && checks.running > 0) return { text: 'Waiting for checks', tone: 'wait' };
    if (pr.mergeStateStatus === 'BEHIND') return { text: `Behind ${pr.baseRefName}`, tone: 'wait' };
    if (pr.mergeStateStatus === 'BLOCKED') return { text: 'Blocked by branch rules', tone: 'wait' };
    if (pr.mergeable === 'UNKNOWN') return { text: 'Checking', tone: 'muted' };
    return { text: 'Ready to merge', tone: 'ok' };
}

function reviewState(pr: PullRequest): { text: string; tone: Tone } {
    if (pr.state === 'OPEN' && pr.viewerIsRequested) return { text: 'Waiting on you', tone: 'mine' };
    switch (pr.reviewDecision) {
        case 'APPROVED':
            return { text: 'Approved', tone: 'ok' };
        case 'CHANGES_REQUESTED':
            return { text: 'Changes requested', tone: 'review' };
        case 'REVIEW_REQUIRED':
            return { text: pr.viewerDidAuthor ? 'Waiting on reviewers' : 'Review required', tone: 'wait' };
        default:
            return { text: 'No review required', tone: 'muted' };
    }
}

function checkState(pr: PullRequest, checks: CheckCounts | undefined): { text: string; tone: Tone } {
    if (!checks) return pr.checkCount > 0 ? { text: 'Loading…', tone: 'muted' } : { text: 'No checks', tone: 'muted' };
    if (checks.total === 0) return { text: 'No checks', tone: 'muted' };
    if (checks.failed > 0) return { text: `${checks.failed} of ${checks.total} failed`, tone: 'fail' };
    if (checks.running > 0) return { text: `${checks.running} of ${checks.total} running`, tone: 'wait' };
    return { text: `${checks.passed} of ${checks.total} passing`, tone: 'ok' };
}

function Cell({ label, tone, dot, onClick, children }: { label: string; tone?: Tone; dot?: boolean; onClick?(): void; children: ReactNode }) {
    const body = (
        <>
            <span className="pr-summary-label">{label}</span>
            <span className={`pr-summary-value${tone ? ` tone-${tone}` : ''}`}>
                {dot && <span className="pr-summary-dot" />}
                {children}
            </span>
        </>
    );
    return onClick ? (
        <button className="pr-summary-cell" onClick={onClick}>
            {body}
        </button>
    ) : (
        <div className="pr-summary-cell">{body}</div>
    );
}

/** The strip below the title: the review state, the checks, the size and the merge state of a pull request. */
export function PullRequestSummary({ pr, checks, onSelectTab }: { pr: PullRequest; checks: CheckCounts | undefined; onSelectTab(tab: ReviewTab): void }) {
    const review = reviewState(pr);
    const check = checkState(pr, checks);
    const merge = mergeState(pr, checks);
    return (
        <div className="pr-summary">
            <Cell label="Review" tone={review.tone} dot={review.tone !== 'muted'}>
                {review.text}
            </Cell>
            <Cell label="Checks" tone={check.tone} dot={check.tone !== 'muted'} onClick={() => onSelectTab('checks')}>
                {check.text}
            </Cell>
            <Cell label="Size" onClick={() => onSelectTab('files')}>
                <span className="additions">+{pr.additions}</span> <span className="deletions">−{pr.deletions}</span>
                <span className="pr-summary-detail">
                    {' '}
                    · {plural(pr.changedFiles, 'file')} · {plural(pr.commitCount, 'commit')}
                </span>
            </Cell>
            <Cell label="Merge" tone={merge.tone === 'wait' ? undefined : merge.tone}>
                {merge.text}
            </Cell>
        </div>
    );
}
