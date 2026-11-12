import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ExternalLink, GitPullRequest, RefreshCw } from 'lucide-react';
import { hostLabel, type BranchStatus, type NewPullRequest, type RepoTarget } from '@shared/github';
import { createPullRequest } from '../github/pull-request-mutations';
import { optionalErrorText } from '../util';
import { confirmDialog } from './ConfirmDialog';
import { openLink } from '../links';
import { MentionTextarea } from './MentionTextarea';
import { MentionContext, mentionSourceOfRepo } from './mention-context';
import { Button, Checkbox, IconButton, Input } from './ui';

const ICON = { size: 14, strokeWidth: 1.6 };

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
    const mutation = useMutation({ mutationFn: ({ root, ...request }: { root: string } & NewPullRequest) => createPullRequest(root, request) });
    const busy = mutation.isPending;
    const error = optionalErrorText(mutation.error);
    const host = hostLabel(status.host);
    const webUrl = status.createUrl ?? `https://github.com/${status.repo.owner}/${status.repo.name}/compare/${encodeURIComponent(status.branch)}?expand=1`;

    const create = async () => {
        if (typeof target !== 'string' || !title.trim()) return;
        if (
            !(await confirmDialog({
                title: `Create a ${draft ? 'draft ' : ''}pull request on ${host} for ${status.branch}?`,
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
                    No pull request for <code>{status.branch}</code>. Push the branch before you create one.
                </p>
                <IconButton
                    size="sm"
                    icon={<RefreshCw size={14} strokeWidth={1.6} className={loading ? 'spin' : ''} />}
                    label="Check for a pull request"
                    onClick={() => onRefresh()}
                />
            </div>
            {typeof target === 'string' && (
                <div className="pr-create-form">
                    <Input value={title} placeholder="Title" onChange={event => setTitle(event.target.value)} disabled={busy} />
                    <MentionContext value={mentionSourceOfRepo(target, { ...status.repo, host: status.host })}>
                        <MentionTextarea className="input textarea" rows={5} value={body} placeholder="Description" onValueChange={setBody} disabled={busy} />
                    </MentionContext>
                    <Checkbox label="Draft" checked={draft} onChange={setDraft} disabled={busy} />
                    {error && <div className="form-error">{error}</div>}
                    <div className="row-buttons">
                        <Button variant="primary" icon={<GitPullRequest {...ICON} />} disabled={busy || !title.trim()} onClick={create}>
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
