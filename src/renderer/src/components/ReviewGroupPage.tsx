import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowLeft, ArrowUp, Bot, Layers, LoaderCircle, Trash2, X } from 'lucide-react';
import { repoLabel, type RepoRef } from '@shared/github';
import { formatAgo, pluralize } from '@shared/format';
import {
    changedSinceReview,
    groupSize,
    MAX_GROUP_NAME,
    MAX_GROUP_PULL_REQUESTS,
    movePullRequest,
    parsePullRequestLink,
    prKey,
    withPullRequest,
    type GroupPullRequest,
    type PrGroup
} from '@shared/pr-groups';
import { errorText } from '../util';
import { pullRequestQuery } from '../github/review-store';
import { useDefaultReviewStrictness } from '../github/review-strictness';
import { cancelGroupReview, dismissGroupError, removeGroup, runGroupReview, updateGroup, useGroup, useGroupRun } from '../github/pr-group-store';
import { confirmDialog } from './ConfirmDialog';
import { EmptyState } from './EmptyState';
import { Markdown } from './Markdown';
import { StateBadge } from './PullRequestParts';
import { Button, Card, CardBody, CardHeader, Chip, Field, IconButton, Input, PageHeader, SplitButton, TextArea } from './ui';
import { STRICTNESS_MENU_TITLE, strictnessMenuItems, strictnessTitle } from './review-strictness-menu';

const GROUP_REVIEW_TITLE = 'The agent reads all pull requests of the group together. It does not change files and posts nothing.';

interface Props {
    groupId: string;
    onBack(): void;
    onOpenPullRequest(repo: RepoRef, number: number): void;
}

/**
 * The page of a PR group in the Review view. The user names the group, writes a note for the agent, and adds pull
 * requests from any repository. "Review with agent" reads all pull requests in one run. The comments of the agent go to
 * the review of each pull request, and the page shows the summary of the group.
 */
export function ReviewGroupPage({ groupId, onBack, onOpenPullRequest }: Props) {
    const group = useGroup(groupId);
    const run = useGroupRun(groupId);
    const running = run.status === 'running';
    const defaultStrictness = useDefaultReviewStrictness(group?.pullRequests.map(item => item.repo) ?? []);

    if (!group) {
        return (
            <div className="review-group-page">
                <PageHeader
                    leading={<IconButton size="lg" icon={<ArrowLeft size={16} strokeWidth={1.7} />} label="Back to Review (Esc)" onClick={onBack} />}
                    icon={Layers}
                    title="PR group"
                />
                <EmptyState icon={Layers} title="The group does not exist">
                    Someone deleted the group, or the link is old.
                </EmptyState>
            </div>
        );
    }

    const reviewDisabled = running || group.pullRequests.length === 0;

    const remove = async () => {
        const ok = await confirmDialog({
            title: `Delete "${group.name}"?`,
            message: 'The group goes away. The pull requests and your pending comments stay.',
            confirmLabel: 'Delete',
            danger: true
        });
        if (!ok) return;
        await removeGroup(group.id);
        onBack();
    };

    return (
        <div className="review-group-page">
            <PageHeader
                leading={<IconButton size="lg" icon={<ArrowLeft size={16} strokeWidth={1.7} />} label="Back to Review" onClick={onBack} />}
                icon={Layers}
                title={group.name}
                meta={[groupSize(group), group.lastReview && `reviewed ${formatAgo(new Date(group.lastReview.at).toISOString())}`].filter(Boolean).join(' · ')}
                actions={<IconButton size="lg" icon={<Trash2 size={16} strokeWidth={1.6} />} label="Delete the group" onClick={() => void remove()} />}
                primary={
                    <SplitButton
                        tone="primary"
                        size="lg"
                        icon={<Bot size={14} strokeWidth={1.6} />}
                        label="Review with agent"
                        disabled={reviewDisabled}
                        title={strictnessTitle(GROUP_REVIEW_TITLE, defaultStrictness)}
                        onClick={() => void runGroupReview(group.id)}
                        menuTitle={STRICTNESS_MENU_TITLE}
                        items={strictnessMenuItems(defaultStrictness, level => void runGroupReview(group.id, level), reviewDisabled)}
                    />
                }
            />

            <div className="review-group-scroll">
                <div className="flow-page">
                    {running && (
                        <div className="agent-review-status running review-group-status" role="status">
                            <LoaderCircle size={13} className="spin" />
                            <span>
                                {run.stage === 'load'
                                    ? 'Loading the pull requests…'
                                    : `The agent reads ${pluralize(group.pullRequests.length, 'pull request')}. This can take a few minutes. You can leave this page.`}
                            </span>
                            <Button variant="link" onClick={() => cancelGroupReview(group.id)}>
                                Cancel
                            </Button>
                        </div>
                    )}
                    {run.status === 'error' && (
                        <div className="agent-review-status error review-group-status" role="alert">
                            <span className="agent-review-error">The group review failed: {run.error}</span>
                            <IconButton size="sm" icon={<X size={14} />} label="Hide the error" onClick={() => dismissGroupError(group.id)} />
                        </div>
                    )}

                    <div className="flow-layout">
                        <div className="flow-main">
                            <PullRequestList group={group} onOpen={onOpenPullRequest} />
                            {group.lastReview && <LastReview group={group} />}
                        </div>
                        <aside className="flow-side">
                            <GroupDetails group={group} />
                        </aside>
                    </div>
                </div>
            </div>
        </div>
    );
}

/** The name and the note of the group. A change saves when the field loses the focus. */
function GroupDetails({ group }: { group: PrGroup }) {
    const [name, setName] = useState(group.name);
    const [note, setNote] = useState(group.note);
    // A save from another place (for example a new title after a review) must not reset the text that the user types.
    useEffect(() => setName(group.name), [group.name]);
    useEffect(() => setNote(group.note), [group.note]);

    const saveName = () => {
        const value = name.trim();
        if (!value) {
            setName(group.name);
            return;
        }
        if (value !== group.name) void updateGroup(group.id, current => ({ ...current, name: value }));
    };
    const saveNote = () => {
        if (note !== group.note) void updateGroup(group.id, current => ({ ...current, note }));
    };

    return (
        <Card as="section">
            <CardHeader title="Details" />
            <CardBody className="review-group-fields">
                <Field label="Name" htmlFor="group-name">
                    <Input id="group-name" value={name} maxLength={MAX_GROUP_NAME} onChange={event => setName(event.target.value)} onBlur={saveName} />
                </Field>
                <Field
                    label="Note for the agent"
                    htmlFor="group-note"
                    hint="For example, the merge order, or how the pull requests depend on each other. The agent reads it with the diffs."
                >
                    <TextArea id="group-note" rows={6} value={note} onChange={event => setNote(event.target.value)} onBlur={saveNote} />
                </Field>
            </CardBody>
        </Card>
    );
}

/** The pull requests of the group, and the field that adds one. */
function PullRequestList({ group, onOpen }: { group: PrGroup; onOpen(repo: RepoRef, number: number): void }) {
    const [link, setLink] = useState('');
    const [error, setError] = useState<string>();
    const full = group.pullRequests.length >= MAX_GROUP_PULL_REQUESTS;

    const add = async () => {
        const parsed = parsePullRequestLink(link);
        if (!parsed) {
            setError('Paste the link of a GitHub or Azure Repos pull request, or write owner/name#number.');
            return;
        }
        if (group.pullRequests.some(pr => prKey(pr) === prKey(parsed))) {
            setError('The pull request is in the group already.');
            return;
        }
        try {
            await updateGroup(group.id, current => withPullRequest(current, parsed));
            setLink('');
            setError(undefined);
        } catch (err) {
            setError(errorText(err));
        }
    };
    const move = (pr: GroupPullRequest, delta: number) => void updateGroup(group.id, current => movePullRequest(current, prKey(pr), delta));
    const remove = (pr: GroupPullRequest) =>
        void updateGroup(group.id, current => ({ ...current, pullRequests: current.pullRequests.filter(item => prKey(item) !== prKey(pr)) }));

    return (
        <Card as="section">
            <CardHeader
                title="Pull requests"
                count={group.pullRequests.length}
                description="The agent gets them in this order. It runs in the first pull request and reads the others. Use the arrows to change the order."
            />
            {group.pullRequests.length > 0 && (
                <ul className="review-group-list">
                    {group.pullRequests.map((pr, index) => (
                        <GroupRow
                            key={prKey(pr)}
                            group={group}
                            pr={pr}
                            first={index === 0}
                            last={index === group.pullRequests.length - 1}
                            onOpen={() => onOpen(pr.repo, pr.number)}
                            onMove={delta => move(pr, delta)}
                            onRemove={() => remove(pr)}
                        />
                    ))}
                </ul>
            )}
            <CardBody>
                <form
                    className="review-group-add"
                    onSubmit={event => {
                        event.preventDefault();
                        void add();
                    }}
                >
                    <Input
                        value={link}
                        disabled={full}
                        placeholder={full ? `A group can have at most ${MAX_GROUP_PULL_REQUESTS} pull requests` : 'Paste a pull request link, or owner/name#12'}
                        aria-label="Pull request link"
                        invalid={!!error}
                        onChange={event => {
                            setLink(event.target.value);
                            setError(undefined);
                        }}
                    />
                    <Button type="submit" disabled={full || !link.trim()}>
                        Add
                    </Button>
                </form>
                {error && <div className="field-error">{error}</div>}
            </CardBody>
        </Card>
    );
}

interface GroupRowProps {
    group: PrGroup;
    pr: GroupPullRequest;
    /** True for the first pull request. It cannot move up. */
    first: boolean;
    /** True for the last pull request. It cannot move down. */
    last: boolean;
    onOpen(): void;
    /** Moves the pull request one place: -1 is up, 1 is down. */
    onMove(delta: number): void;
    onRemove(): void;
}

/**
 * One pull request of the group: its state, its title, the result of the last group review, and the buttons that
 * change its place. The arrows at the start and the end of the list are disabled, so the buttons do not move.
 */
function GroupRow({ group, pr, first, last, onOpen, onMove, onRemove }: GroupRowProps) {
    const query = useQuery(pullRequestQuery(pr.repo, pr.number));
    const data = query.data;
    const key = prKey(pr);
    const counts = group.lastReview?.counts[key];
    const changed = changedSinceReview(group, key, data?.headRefOid);
    const result = useMemo(() => {
        if (!counts) return undefined;
        const parts = [counts.comments > 0 && pluralize(counts.comments, 'comment'), counts.notes > 0 && pluralize(counts.notes, 'note')].filter(Boolean);
        return parts.length ? parts.join(' · ') : 'No comments';
    }, [counts]);

    return (
        <li className="review-group-row">
            <button type="button" className="review-group-open" onClick={onOpen}>
                <span className="review-group-repo">
                    {repoLabel(pr.repo)} <span className="review-pr-number">#{pr.number}</span>
                </span>
                <span className="review-group-title">{data?.title ?? pr.title ?? (query.isError ? 'Could not load the pull request' : 'Loading…')}</span>
            </button>
            <span className="review-group-meta">
                {data && <StateBadge pr={data} />}
                {changed && (
                    <Chip tone="warning" title="The pull request has new commits since the last group review, or it was not in that review.">
                        Changed
                    </Chip>
                )}
                {result && !changed && <span className="review-group-result">{result}</span>}
            </span>
            <span className="review-group-tools">
                <IconButton size="sm" icon={<ArrowUp size={14} />} label="Move up" disabled={first} onClick={() => onMove(-1)} />
                <IconButton size="sm" icon={<ArrowDown size={14} />} label="Move down" disabled={last} onClick={() => onMove(1)} />
                <IconButton size="sm" icon={<X size={14} />} label={`Remove ${repoLabel(pr.repo)}#${pr.number} from the group`} onClick={onRemove} />
            </span>
        </li>
    );
}

/** The summary of the last group review. */
function LastReview({ group }: { group: PrGroup }) {
    const review = group.lastReview;
    if (!review) return null;
    return (
        <Card as="section">
            <CardHeader title="Last review" description={`${review.agent || 'The agent'} · ${formatAgo(new Date(review.at).toISOString())}`} />
            <CardBody>
                {review.summary ? (
                    <Markdown className="review-group-summary" text={review.summary} />
                ) : (
                    <p className="flow-field-note">The agent wrote no summary.</p>
                )}
                <p className="flow-field-note">
                    The comments for each pull request are pending in your review of that pull request. Open a pull request to accept or remove them, then
                    submit the review. The pending comments stay until ShipWarden quits.
                </p>
            </CardBody>
        </Card>
    );
}
