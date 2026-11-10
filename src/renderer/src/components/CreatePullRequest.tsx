import { useState } from 'react';
import { ExternalLink, GitPullRequest } from 'lucide-react';
import { hostLabel, type BranchStatus, type RepoTarget } from '@shared/github';
import { errorText } from '../util';
import { confirmDialog } from './ConfirmDialog';
import { openLink } from '../links';

const ICON = { size: 15, strokeWidth: 1.6 };

/** The form that creates a pull request for the branch of a worktree, on GitHub or Azure DevOps. */
export function CreatePullRequest({ target, status, onCreated }: { target: RepoTarget; status: BranchStatus; onCreated(): Promise<void> }) {
    const [title, setTitle] = useState(status.branch);
    const [body, setBody] = useState('');
    const [draft, setDraft] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();
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
        setBusy(true);
        setError(undefined);
        try {
            await window.shipwarden.github.createPullRequest(target, { title: title.trim(), body, draft });
            await onCreated();
        } catch (err) {
            setError(errorText(err));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="panel-message pr-create">
            <p>
                No pull request for <code>{status.branch}</code>. Push the branch before you create one.
            </p>
            {typeof target === 'string' && (
                <div className="pr-create-form">
                    <input value={title} placeholder="Title" onChange={event => setTitle(event.target.value)} disabled={busy} />
                    <textarea className="review-body" value={body} placeholder="Description" onChange={event => setBody(event.target.value)} disabled={busy} />
                    <label className="scope-option">
                        <input type="checkbox" checked={draft} onChange={event => setDraft(event.target.checked)} disabled={busy} />
                        Draft
                    </label>
                    {error && <div className="form-error">{error}</div>}
                    <div className="row-buttons">
                        <button className="button approve" disabled={busy || !title.trim()} onClick={create}>
                            <GitPullRequest {...ICON} />
                            Create pull request
                        </button>
                        <button className="button" onClick={event => openLink(webUrl, event)}>
                            Create on {host} <ExternalLink {...ICON} />
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
