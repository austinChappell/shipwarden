import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ExternalLink, GitPullRequest } from 'lucide-react';
import { hostLabel, type BranchStatus, type NewPullRequest, type PullRequestInto, type RepoRef, type RepoTarget } from '@shared/github';
import { createPullRequest, setPullRequestInto } from '../github/pull-request-mutations';
import { optionalErrorText } from '../util';
import { confirmDialog } from './ConfirmDialog';
import { openLink } from '../links';
import { MentionTextarea } from './MentionTextarea';
import { MentionContext, mentionSourceOfRepo } from './mention-context';
import { Button, Checkbox, Input, RefreshButton, Select } from './ui';
import { DraftButton } from './DraftButton';

const ICON = { size: 14, strokeWidth: 1.6 };

const repoName = (repo: RepoRef) => `${repo.owner}/${repo.name}`;

/** Returns the GitHub page that creates the pull request. For a fork into its parent, the head is "owner:branch". */
export function githubCompareUrl(status: BranchStatus): string {
    const branch = encodeURIComponent(status.branch);
    const head = status.fork?.into === 'parent' ? `${encodeURIComponent(status.fork.origin.owner)}:${branch}` : branch;
    return `https://github.com/${status.repo.owner}/${status.repo.name}/compare/${head}?expand=1`;
}

/**
 * The form that creates a pull request for the branch of a worktree, on GitHub or Azure DevOps.
 * After the create, the status of the worktree loads again and shows the new pull request.
 * The Refresh button loads the status again. It finds a pull request that an agent or the host created.
 */
export function CreatePullRequest({
    target,
    status,
    loading,
    onRefresh
}: {
    target: RepoTarget;
    status: BranchStatus;
    /** True while the status loads. The Refresh icon turns. */
    loading: boolean;
    /** Loads the status of the branch again. */
    onRefresh(): Promise<void>;
}) {
    const [title, setTitle] = useState(status.branch);
    const [body, setBody] = useState('');
    const [draft, setDraft] = useState(false);
    const [draftError, setDraftError] = useState<string>();
    const mutation = useMutation({ mutationFn: ({ root, ...request }: { root: string } & NewPullRequest) => createPullRequest(root, request) });
    const into = useMutation({ mutationFn: ({ root, value }: { root: string; value: PullRequestInto }) => setPullRequestInto(root, value) });
    const busy = mutation.isPending || into.isPending;
    const error = optionalErrorText(mutation.error) ?? optionalErrorText(into.error);
    const host = hostLabel(status.host);
    const webUrl = status.createUrl ?? githubCompareUrl(status);
    const { fork } = status;
    // A pull request needs the branch on the remote. Undefined means that the host does not check, so the button stays on.
    const unpushed = status.pushed === false;

    const create = async () => {
        if (typeof target !== 'string' || !title.trim()) return;
        if (
            !(await confirmDialog({
                title: fork
                    ? `Create a ${draft ? 'draft ' : ''}pull request in ${repoName(status.repo)} for ${status.branch}?`
                    : `Create a ${draft ? 'draft ' : ''}pull request on ${host} for ${status.branch}?`,
                confirmLabel: 'Create pull request'
            }))
        ) {
            return;
        }
        mutation.mutate({ root: target, title: title.trim(), body, draft });
    };

    return (
        <div className="panel-message pr-create">
            <div className="pr-create-head">
                <p>
                    {unpushed ? (
                        <>
                            The branch <code>{status.branch}</code> is not on {fork ? repoName(fork.origin) : 'the remote'}. Push the branch, then refresh to
                            create a pull request.
                        </>
                    ) : (
                        <>
                            No pull request for <code>{status.branch}</code>. Push the branch{fork ? ` to ${repoName(fork.origin)}` : ''} before you create one.
                        </>
                    )}
                </p>
                <RefreshButton size="sm" label="Check for a pull request" refreshing={loading} onRefresh={onRefresh} />
            </div>
            {typeof target === 'string' && (
                <div className="pr-create-form">
                    {fork && (
                        <div className="field">
                            <span className="field-label">Into</span>
                            <Select
                                aria-label="The repository that gets the pull request"
                                value={fork.into}
                                options={[
                                    { value: 'parent', label: `${repoName(fork.parent)} (parent)` },
                                    { value: 'origin', label: `${repoName(fork.origin)} (fork)` }
                                ]}
                                onChange={value => value !== fork.into && into.mutate({ root: target, value })}
                                disabled={busy}
                            />
                            <span className="field-hint">
                                {fork.into === 'parent'
                                    ? `The branch stays in ${repoName(fork.origin)}. The pull request goes to ${repoName(fork.parent)}.`
                                    : `The pull request stays in ${repoName(fork.origin)}.`}{' '}
                                All worktrees of this repository use this choice.
                            </span>
                        </div>
                    )}
                    <Input value={title} placeholder="Title" onChange={event => setTitle(event.target.value)} disabled={busy} />
                    <MentionContext value={mentionSourceOfRepo(target, { ...status.repo, host: status.host })}>
                        <MentionTextarea className="input textarea" rows={5} value={body} placeholder="Description" onValueChange={setBody} disabled={busy} />
                    </MentionContext>
                    <div className="pr-create-row">
                        <Checkbox label="Draft" checked={draft} onChange={setDraft} disabled={busy} />
                        <span className="header-spacer" />
                        <DraftButton worktree={target} kind="pullRequest" current={body} disabled={busy} onDraft={setBody} onError={setDraftError} />
                    </div>
                    {(error ?? draftError) && <div className="form-error">{error ?? draftError}</div>}
                    <div className="row-buttons">
                        <Button variant="primary" icon={<GitPullRequest {...ICON} />} disabled={busy || unpushed || !title.trim()} onClick={create}>
                            Create pull request
                        </Button>
                        <Button iconEnd={<ExternalLink {...ICON} />} onClick={event => openLink(webUrl, event)}>
                            Create on {host}
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
}
