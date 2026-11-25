import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { ArrowLeft, Bot, ClipboardList, GitMerge, GitPullRequestArrow, GripVertical, Layers, LoaderCircle, Trash2, X } from 'lucide-react';
import { repoLabel, type RepoRef } from '@shared/github';
import { formatAgo, pluralize } from '@shared/format';
import { stackLabels } from '@shared/plan-group-order';
import {
    changedSinceReview,
    groupSize,
    MAX_GROUP_NAME,
    MAX_GROUP_PULL_REQUESTS,
    parsePullRequestLink,
    prKey,
    withPullRequest,
    type GroupPullRequest,
    type PrGroup
} from '@shared/pr-groups';
import { errorText } from '../util';
import { updatePlan, usePlans } from '../plans/plan-queries';
import { moveGroupPullRequest } from '../plans/plan-group';
import {
    dismissStackRun,
    mergeStackBlocker,
    planStack,
    runMergeStack,
    runRebaseStack,
    sendStackConflict,
    useStackRun,
    type StackRun
} from '../plans/stack-actions';
import type { StackItemState } from '@shared/stack-actions';
import type { Plan } from '@shared/plans';
import { pullRequestQuery } from '../github/review-store';
import { useDefaultReviewStrictness } from '../github/review-strictness';
import { promptGroupAgents } from '../github/pr-group-agents';
import { cancelGroupReview, dismissGroupError, removeGroup, runGroupReview, updateGroup, useGroup, useGroupRun } from '../github/pr-group-store';
import { alertDialog, confirmDialog } from './ConfirmDialog';
import { EmptyState } from './EmptyState';
import { PromptAgentsCard, type PromptTarget } from './PromptAgentsCard';
import { Markdown } from './Markdown';
import { StateBadge } from './PullRequestParts';
import { Button, Card, CardBody, CardFooter, CardHeader, Chip, type ChipTone, Field, IconButton, Input, PageHeader, SplitButton, TextArea } from './ui';
import { STRICTNESS_MENU_TITLE, strictnessMenuItems, strictnessTitle } from './review-strictness-menu';
import { useReorder } from './use-reorder';

const GROUP_REVIEW_TITLE = 'The agent reads all pull requests of the group together. It does not change files and posts nothing.';

interface Props {
    groupId: string;
    onBack(): void;
    onOpenPullRequest(repo: RepoRef, number: number): void;
    /** Opens the plan that made the group. */
    onOpenPlan?(planId: string): void;
}

/**
 * The page of a PR group in the Review view. The user names the group, writes a note for the agent, and adds pull
 * requests from any repository. "Review with agent" reads all pull requests in one run. The comments of the agent go to
 * the review of each pull request, and the page shows the summary of the group.
 */
export function ReviewGroupPage({ groupId, onBack, onOpenPullRequest, onOpenPlan }: Props) {
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
            message: group.planId
                ? 'The group goes away. The pull requests and your pending comments stay. New pull requests of the plan do not go into a new group.'
                : 'The group goes away. The pull requests and your pending comments stay.',
            confirmLabel: 'Delete',
            danger: true
        });
        if (!ok) return;
        await removeGroup(group.id);
        // Without this, the next pull request of the plan makes the group again.
        const { planId } = group;
        if (planId) await updatePlan(planId, plan => ({ ...plan, noPrGroup: true }));
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
                <div className="flow-page review-group-flow">
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
                    <StackStatus groupId={group.id} />
                    {run.status === 'error' && (
                        <div className="agent-review-status error review-group-status" role="alert">
                            <span className="agent-review-error">The group review failed: {run.error}</span>
                            <IconButton size="sm" icon={<X size={14} />} label="Hide the error" onClick={() => dismissGroupError(group.id)} />
                        </div>
                    )}

                    <div className="flow-layout">
                        <div className="flow-main">
                            <PullRequestList group={group} onOpen={onOpenPullRequest} />
                            <GroupPromptAgents group={group} />
                            {group.lastReview && <LastReview group={group} />}
                        </div>
                        <aside className="flow-side">
                            <StackCard group={group} />
                            <GroupDetails group={group} onOpenPlan={onOpenPlan} />
                        </aside>
                    </div>
                </div>
            </div>
        </div>
    );
}

/** The name and the note of the group. A change saves when the field loses the focus. */
function GroupDetails({ group, onOpenPlan }: { group: PrGroup; onOpenPlan?(planId: string): void }) {
    const { plans } = usePlans();
    const plan = group.planId ? plans.find(item => item.id === group.planId) : undefined;
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
                {plan && onOpenPlan && (
                    <Field
                        label="Plan"
                        hint="ShipWarden made this group from the plan. New pull requests of the plan come into the group. The group and the plan keep the same order."
                    >
                        <div>
                            <Button
                                size="sm"
                                className="review-group-plan"
                                icon={<ClipboardList size={14} />}
                                title={`Open the plan "${plan.title}"`}
                                onClick={() => onOpenPlan(plan.id)}
                            >
                                <span className="review-group-plan-name">{plan.title}</span>
                            </Button>
                        </div>
                    </Field>
                )}
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
    const { plans } = usePlans();
    const plan = group.planId ? plans.find(item => item.id === group.planId) : undefined;
    // A move changes the order of the plan too. The plan runner keeps the index of the step that runs, so the order
    // changes only when no step of the plan runs.
    const planRuns = !!plan && (plan.status === 'running' || plan.steps.some(step => step.status === 'running'));
    const keys = group.pullRequests.map(prKey);
    const bases = useMemo(() => (plan ? stackLabels(plan) : undefined), [plan]);
    const stackRun = useStackRun(group.id);
    const reorder = useReorder(keys, (key, to) => void moveGroupPullRequest(group.id, key, to), keys.length > 1 && !planRuns && stackRun.status !== 'running');
    const orderNote = !plan
        ? 'Drag a pull request to change the order.'
        : planRuns
          ? `You can change the order when the plan "${plan.title}" stops running.`
          : `Drag a pull request to change the order. The plan "${plan.title}" gets the same order, and a move in the plan changes this list too.`;
    const remove = (pr: GroupPullRequest) =>
        void updateGroup(group.id, current => ({ ...current, pullRequests: current.pullRequests.filter(item => prKey(item) !== prKey(pr)) }));

    return (
        <Card as="section">
            <CardHeader
                title="Pull requests"
                count={group.pullRequests.length}
                description={`The agent gets them in this order. It runs in the first pull request and reads the others. ${orderNote}`}
            />
            {group.pullRequests.length > 0 && (
                <ul className="review-group-list">
                    {group.pullRequests.map(pr => {
                        const key = prKey(pr);
                        return (
                            <GroupRow
                                key={key}
                                group={group}
                                pr={pr}
                                stackLabel={bases?.get(key.toLowerCase())}
                                stackItem={stackRun.status === 'idle' ? undefined : stackRun.items[key]}
                                dropClass={reorder.dropClass(key)}
                                dragProps={reorder.itemProps(key)}
                                reorderHint={reorder.hint}
                                onMoveByKey={event => reorder.moveByKey(event, key)}
                                onOpen={() => onOpen(pr.repo, pr.number)}
                                onRemove={() => remove(pr)}
                            />
                        );
                    })}
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
    /** Where the pull request of a plan merges, for example "Stacks on #41". Undefined for a group without a plan. */
    stackLabel?: string;
    /** The state of the pull request in the last stack action. */
    stackItem?: StackItemState;
    /** The class that shows the drop line, from `useReorder`. */
    dropClass: string;
    /** The drag and drop handlers of the row, from `useReorder`. */
    dragProps: object;
    /** The tooltip that tells how to change the order. Undefined when the order cannot change. */
    reorderHint?: string;
    /** Alt+Up and Alt+Down move the pull request one place. */
    onMoveByKey(event: KeyboardEvent<HTMLElement>): void;
    onOpen(): void;
    onRemove(): void;
}

/**
 * One pull request of the group: its state, its title, the result of the last group review, and the button that
 * removes it. Drag the row to change its place.
 */
function GroupRow({ group, pr, stackLabel, stackItem, dropClass, dragProps, reorderHint, onMoveByKey, onOpen, onRemove }: GroupRowProps) {
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
        <li className={`review-group-row${dropClass}`} title={reorderHint} {...dragProps} onKeyDown={onMoveByKey}>
            <button type="button" className="review-group-open" onClick={onOpen}>
                <span className="review-group-repo">
                    {repoLabel(pr.repo)} <span className="review-pr-number">#{pr.number}</span>
                </span>
                <span className="review-group-title">{data?.title ?? pr.title ?? (query.isError ? 'Could not load the pull request' : 'Loading…')}</span>
            </button>
            <span className="review-group-meta">
                {stackItem && <StackItemChip item={stackItem} />}
                {stackLabel && data?.state === 'OPEN' && <span className="review-group-base">{stackLabel}</span>}
                {data && <StateBadge pr={data} />}
                {changed && (
                    <Chip tone="warning" title="The pull request has new commits since the last group review, or it was not in that review.">
                        Changed
                    </Chip>
                )}
                {result && !changed && <span className="review-group-result">{result}</span>}
            </span>
            <span className="review-group-tools">
                <IconButton size="sm" icon={<X size={14} />} label={`Remove ${repoLabel(pr.repo)}#${pr.number} from the group`} onClick={onRemove} />
                {reorderHint && <GripVertical className="drag-grip" size={12} strokeWidth={1.75} aria-hidden="true" />}
            </span>
        </li>
    );
}

/**
 * One prompt for the agents of the selected pull requests. The agent in the worktree of the head branch of each pull
 * request gets the prompt. A pull request without a worktree gets a new worktree.
 */
function GroupPromptAgents({ group }: { group: PrGroup }) {
    // The rows of the list load the same queries. This adds no request.
    const loaded = useQueries({ queries: group.pullRequests.map(pr => pullRequestQuery(pr.repo, pr.number)) });
    if (group.pullRequests.length === 0) return null;
    const targets: PromptTarget[] = group.pullRequests.map((pr, index) => {
        const data = loaded[index]?.data;
        const closed = data && data.state !== 'OPEN';
        return {
            key: prKey(pr),
            label: `${repoLabel(pr.repo)} #${pr.number}`,
            title: data?.title ?? pr.title ?? '',
            ...(closed ? { disabledReason: `The pull request is ${data.state === 'MERGED' ? 'merged' : 'closed'}.` } : {})
        };
    });
    return (
        <PromptAgentsCard
            targets={targets}
            description="The agent in the worktree of each selected pull request gets the prompt and the list of the pull requests. A pull request without a worktree gets a new worktree."
            draftKey={`group:${group.id}`}
            onSend={(keys, prompt, push) => promptGroupAgents(group, keys, prompt, push)}
        />
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

const STACK_TONES: Record<StackItemState['status'], ChipTone> = { working: 'pending', done: 'success', skipped: 'neutral', stopped: 'danger' };

/** The state of a pull request in the last stack action, next to its state. */
function StackItemChip({ item }: { item: StackItemState }) {
    return (
        <Chip tone={STACK_TONES[item.status]} title={item.text}>
            {item.status === 'working' && <LoaderCircle size={11} className="spin" />}
            {item.status === 'stopped' ? 'Stopped' : item.text}
        </Chip>
    );
}

/** The plan of the group when it stacks its pull requests. Stack actions are only for these groups. */
function useStackedPlan(group: PrGroup): Plan | undefined {
    const { plans } = usePlans();
    const plan = group.planId ? plans.find(item => item.id === group.planId) : undefined;
    return plan && !plan.noStack ? plan : undefined;
}

/**
 * "Rebase stack" and "Merge stack" for the group of a plan that stacks its pull requests. Each action asks first and
 * shows its progress in the list of pull requests.
 */
function StackCard({ group }: { group: PrGroup }) {
    const plan = useStackedPlan(group);
    const run = useStackRun(group.id);
    // The rows load the same queries. This adds no request.
    const loaded = useQueries({ queries: group.pullRequests.map(pr => pullRequestQuery(pr.repo, pr.number)) });
    if (!plan) return null;
    const entries = planStack(plan);
    if (entries.length === 0) return null;
    const planRuns = plan.status === 'running' || plan.steps.some(step => step.status === 'running');
    const busy = run.status === 'running';
    const waitReason = planRuns ? `You can use the stack actions when the plan "${plan.title}" stops running.` : undefined;
    const keys = new Set(entries.map(entry => entry.key));
    const mergeReason = group.pullRequests.map((pr, index) => (keys.has(prKey(pr)) ? mergeStackBlocker(loaded[index]?.data) : undefined)).find(Boolean);
    const rebaseReason = entries.some(entry => entry.worktreePath) ? undefined : 'No branch of the stack has a worktree on this Mac.';
    const start = (action: (groupId: string, planId: string) => Promise<void>) => () => {
        action(group.id, plan.id).catch(error => void alertDialog('The stack action did not start.', errorText(error)));
    };
    return (
        <Card as="section">
            <CardHeader
                title="Stack"
                count={entries.length}
                description="Rebase stack: rebase each branch onto its parent and push it. Merge stack: merge the ready pull requests from the bottom up."
            />
            <CardFooter>
                <Button
                    size="sm"
                    icon={<GitPullRequestArrow size={14} />}
                    disabled={busy || !!waitReason || !!rebaseReason}
                    title={waitReason ?? rebaseReason ?? 'Rebase each branch onto its parent, the bottom first, and push it with --force-with-lease.'}
                    onClick={start(runRebaseStack)}
                >
                    Rebase stack
                </Button>
                <Button
                    size="sm"
                    icon={<GitMerge size={14} />}
                    disabled={busy || !!waitReason || !!mergeReason}
                    title={
                        waitReason ??
                        mergeReason ??
                        'Merge the ready pull requests from the bottom up. The merge stops at the first pull request that is not ready.'
                    }
                    onClick={start(runMergeStack)}
                >
                    Merge stack
                </Button>
            </CardFooter>
        </Card>
    );
}

/** The progress and the result of the last stack action of the group. */
function StackStatus({ groupId }: { groupId: string }) {
    const run = useStackRun(groupId);
    if (run.status === 'idle') return null;
    const name = run.kind === 'rebase' ? 'Rebase stack' : 'Merge stack';
    if (run.status === 'running') {
        return (
            <div className="agent-review-status running review-group-status" role="status">
                <LoaderCircle size={13} className="spin" />
                <span>{run.kind === 'rebase' ? 'Rebasing the stack. Each row shows its progress.' : 'Merging the stack. Each row shows its progress.'}</span>
            </div>
        );
    }
    return <StackResult groupId={groupId} name={name} run={run} />;
}

function StackResult({ groupId, name, run }: { groupId: string; name: string; run: StackRun }) {
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string>();
    const result = run.result;
    if (!result) return null;
    const stopped = result.status === 'stopped';
    const send = async () => {
        setSending(true);
        setError(undefined);
        try {
            await sendStackConflict(groupId);
        } catch (err) {
            setError(errorText(err));
        } finally {
            setSending(false);
        }
    };
    return (
        <div className={`agent-review-status review-group-status${stopped ? ' error' : ''}`} role={stopped ? 'alert' : 'status'}>
            <span className={stopped ? 'agent-review-error' : undefined}>
                {name}: {result.text}
                {error && ` The agent did not get the conflict: ${error}`}
            </span>
            {run.conflict && (
                <Button variant="link" disabled={sending} onClick={() => void send()}>
                    Send to agent
                </Button>
            )}
            <IconButton size="sm" icon={<X size={14} />} label="Hide the result" onClick={() => dismissStackRun(groupId)} />
        </div>
    );
}
