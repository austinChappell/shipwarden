import { Circle, CircleCheck, CircleX, Ellipsis, GitMerge, GitPullRequest } from 'lucide-react';
import type { MergeMethod, PullRequest } from '@shared/github';
import type { CheckCounts } from '../github/use-check-counts';
import { autoMergeButtonText, canActOnMerge, MERGE_LABELS, mergeBlocker, mergeButtonState, mergeCardTitle } from '../github/merge-state';
import { MergeButton } from './MergeButton';
import { Button, Card, CardBody, CardHeader, IconButton } from './ui';
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
        <IconButton
            size="sm"
            icon={<Ellipsis size={14} strokeWidth={1.8} />}
            label="More actions"
            aria-haspopup="menu"
            disabled={busy}
            onClick={event => onMoreActions(event.currentTarget)}
        />
    );
    const conditions = overview ? mergeConditions(pr, checks) : [];
    const button = method && mergeButtonState(pr, method, overview, busy);
    /** The overview page shows the merge actions as large buttons. */
    const size = overview ? 'lg' : undefined;
    const mergeActions = pr.autoMerge ? (
        <>
            <div className="panel-note">
                Auto-merge is on{pr.autoMerge.enabledBy ? ` (${pr.autoMerge.enabledBy})` : ''}. GitHub merges the pull request with "
                {MERGE_LABELS[pr.autoMerge.method]}" when all the requirements pass.
            </div>
            {pr.viewerCanDisableAutoMerge && (
                <div className="merge-row">
                    <Button size={size} disabled={busy} onClick={() => onAutoMerge(false)}>
                        Disable auto-merge
                    </Button>
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
                            <Button size={size} icon={!overview && <GitMerge size={14} strokeWidth={1.8} />} disabled={busy} onClick={() => onAutoMerge(true)}>
                                {autoMergeButtonText(pr, conditions, overview)}
                            </Button>
                        )}
                        <MergeButton
                            methods={pr.allowedMergeMethods}
                            method={method}
                            label={button.label}
                            disabled={button.disabled}
                            title={button.title}
                            size={size}
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
            <Button size={size} icon={<GitPullRequest size={14} strokeWidth={1.8} />} disabled={busy} onClick={() => onDraft(false)}>
                Ready for review
            </Button>
        </div>
    );

    if (overview) {
        return (
            <Card as="section" className="merge-card" aria-label="Merge">
                <CardHeader title={mergeCardTitle(conditions)} actions={moreButton} />
                <CardBody className="merge-card-body">
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
                </CardBody>
            </Card>
        );
    }
    if (!canActOnMerge(pr)) return null;
    return (
        <Card as="section" className="merge-card" aria-label="Merge">
            <CardHeader title="Merge" actions={moreButton} />
            <CardBody className="merge-card-body">
                {mergeActions}
                {readyButton}
            </CardBody>
        </Card>
    );
}
