import { Circle, CircleCheck, CircleX, Ellipsis, GitMerge, GitPullRequest } from 'lucide-react';
import type { MergeMethod, PullRequest } from '@shared/github';
import type { CheckCounts } from '../github/use-check-counts';
import { autoMergeButtonText, canActOnMerge, MERGE_LABELS, mergeBlocker, mergeButtonState, mergeCardTitle } from '../github/merge-state';
import { MergeButton } from './MergeButton';
import { mergeConditions } from './PullRequestSummary';

const CONDITION_ICON = { size: 16, strokeWidth: 1.8 };

interface Props {
    pr: PullRequest;
    overview: boolean;
    /** The counts of the checks of the head commit, for the merge checklist of the Overview tab. */
    checks: CheckCounts | undefined;
    busy: boolean;
    /** The merge method of the button. Undefined when the host allows no method. */
    method: MergeMethod | undefined;
    onSelectMethod(method: MergeMethod): void;
    onMerge(): void;
    onAutoMerge(on: boolean): void;
    onDraft(draft: boolean): void;
    /** Opens the menu with the actions that the user seldom needs. */
    onMoreActions(button: Element): void;
}

/** The card with the merge actions. The Overview tab shows it in the side column, with the merge checklist. */
export function PullRequestMergeCard({ pr, overview, checks, busy, method, onSelectMethod, onMerge, onAutoMerge, onDraft, onMoreActions }: Props) {
    const blocker = mergeBlocker(pr);
    const moreButton = pr.viewerCanUpdate && (
        <button
            className="icon-button"
            title="More actions"
            aria-label="More actions"
            aria-haspopup="menu"
            disabled={busy}
            onClick={event => onMoreActions(event.currentTarget)}
        >
            <Ellipsis size={15} strokeWidth={1.8} />
        </button>
    );
    const conditions = overview ? mergeConditions(pr, checks) : [];
    const button = method && mergeButtonState(pr, method, overview, busy);
    const mergeActions = pr.autoMerge ? (
        <>
            <div className="panel-note">
                Auto-merge is on{pr.autoMerge.enabledBy ? ` (${pr.autoMerge.enabledBy})` : ''}. GitHub merges the pull request with "
                {MERGE_LABELS[pr.autoMerge.method]}" when all the requirements pass.
            </div>
            {pr.viewerCanDisableAutoMerge && (
                <div className="merge-row">
                    <button className="button" disabled={busy} onClick={() => onAutoMerge(false)}>
                        Disable auto-merge
                    </button>
                </div>
            )}
        </>
    ) : (
        (pr.viewerCanMerge || pr.viewerCanEnableAutoMerge) && (
            <>
                {!overview && pr.viewerCanMerge && blocker && <div className="panel-note">{blocker}</div>}
                {method && button && (
                    <div className="merge-row">
                        {pr.viewerCanMerge && pr.viewerCanEnableAutoMerge && (
                            <button className="button auto-merge-button" disabled={busy} onClick={() => onAutoMerge(true)}>
                                {!overview && <GitMerge size={14} strokeWidth={1.8} />}
                                {autoMergeButtonText(pr, conditions, overview)}
                            </button>
                        )}
                        <MergeButton
                            methods={pr.allowedMergeMethods}
                            method={method}
                            label={button.label}
                            disabled={button.disabled}
                            title={button.title}
                            onSelect={onSelectMethod}
                            onRun={button.merges ? onMerge : () => onAutoMerge(true)}
                        />
                    </div>
                )}
            </>
        )
    );
    const readyButton = pr.viewerCanUpdate && pr.isDraft && (
        <div className="merge-row">
            <button className="button" disabled={busy} onClick={() => onDraft(false)}>
                <GitPullRequest size={14} strokeWidth={1.8} />
                Ready for review
            </button>
        </div>
    );

    if (overview) {
        return (
            <section className="side-card merge-card" aria-label="Merge">
                <header className="side-card-header">
                    <span className="side-card-title">{mergeCardTitle(conditions)}</span>
                    <span className="header-spacer" />
                    {moreButton}
                </header>
                <ul className="merge-conditions">
                    {conditions.map(item => (
                        <li key={item.text} className={`merge-condition ${item.state}`}>
                            {item.state === 'ok' ? (
                                <CircleCheck {...CONDITION_ICON} />
                            ) : item.state === 'fail' ? (
                                <CircleX {...CONDITION_ICON} />
                            ) : (
                                <Circle {...CONDITION_ICON} />
                            )}
                            {item.text}
                        </li>
                    ))}
                </ul>
                {mergeActions}
                {readyButton}
            </section>
        );
    }
    if (!canActOnMerge(pr)) return null;
    return (
        <section className="footer-card merge-card" aria-label="Merge">
            <header className="footer-card-header">
                <span className="footer-card-title">Merge</span>
                <span className="header-spacer" />
                {moreButton}
            </header>
            {mergeActions}
            {readyButton}
        </section>
    );
}
