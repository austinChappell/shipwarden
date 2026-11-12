import { useRef, useState } from 'react';
import { Layers, X } from 'lucide-react';
import { repoLabel, type RepoRef } from '@shared/github';
import { groupSize, newGroup, prKey, withPullRequest } from '@shared/pr-groups';
import { errorText } from '../util';
import { createGroup, updateGroup, useGroups } from '../github/pr-group-store';
import { Button, Combobox, Field, IconButton } from './ui';
import { useModal } from './use-modal';

/** The value of the "New group" item of the list. A group ID never has a space. */
const NEW_GROUP = 'new group';

interface Props {
    repo: RepoRef;
    pr: { number: number; title: string };
    onClose(): void;
    /** Opens the page of the group after the add. */
    onOpenGroup(id: string): void;
}

/** The dialog that adds a pull request to a PR group, or to a new group. */
export function AddToGroupDialog({ repo, pr, onClose, onOpenGroup }: Props) {
    const dialog = useRef<HTMLDivElement>(null);
    useModal(dialog);
    const { groups } = useGroups();
    const key = prKey({ repo, number: pr.number });
    const [chosenTarget, setTarget] = useState<string>();
    // The groups can load after the first render. Until the user selects, the newest group is the default.
    const target = chosenTarget ?? groups[0]?.id ?? NEW_GROUP;
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();
    const chosen = groups.find(group => group.id === target);
    const already = !!chosen?.pullRequests.some(item => prKey(item) === key);

    const add = async () => {
        setBusy(true);
        setError(undefined);
        const item = { repo, number: pr.number, title: pr.title };
        try {
            if (target === NEW_GROUP) {
                const group = newGroup(Date.now(), pr.title, [item]);
                await createGroup(group);
                onOpenGroup(group.id);
            } else {
                await updateGroup(target, current => withPullRequest(current, item));
                onOpenGroup(target);
            }
            onClose();
        } catch (err) {
            setError(errorText(err));
            setBusy(false);
        }
    };

    const submit = () => {
        if (already && chosen) {
            onOpenGroup(chosen.id);
            onClose();
            return;
        }
        void add();
    };

    const options = [
        { label: 'New', items: [{ value: NEW_GROUP, label: 'New group' }] },
        ...(groups.length ? [{ label: 'Groups', items: groups.map(group => ({ value: group.id, label: `${group.name} (${groupSize(group)})` })) }] : [])
    ];

    return (
        <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && !busy && onClose()}>
            <div
                ref={dialog}
                className="modal add-group-dialog"
                role="dialog"
                aria-modal="true"
                aria-label="Add to a PR group"
                onKeyDown={event => {
                    if (event.key === 'Escape' && !busy) onClose();
                }}
            >
                <header className="modal-header">
                    <Layers size={15} strokeWidth={1.8} />
                    <h2>Add to a PR group</h2>
                    <span className="header-spacer" />
                    <IconButton icon={<X size={14} strokeWidth={1.8} />} label="Close" title="Close (Esc)" disabled={busy} onClick={onClose} />
                </header>
                <div className="modal-body">
                    <p className="panel-note">
                        An agent reviews the pull requests of a group together. Add {repoLabel(repo)}#{pr.number} to a group.
                    </p>
                    <Field label="Group">
                        <Combobox value={target} groups={options} placeholder="Select a group" searchPlaceholder="Filter groups" onChange={setTarget} />
                    </Field>
                    {already && <p className="panel-note">The pull request is in this group already.</p>}
                    {error && (
                        <div className="form-error" role="alert">
                            {error}
                        </div>
                    )}
                </div>
                <footer className="modal-footer">
                    <Button onClick={onClose} disabled={busy}>
                        Cancel
                    </Button>
                    <Button variant="primary" disabled={busy} onClick={submit}>
                        {already ? 'Open group' : 'Add'}
                    </Button>
                </footer>
            </div>
        </div>
    );
}
