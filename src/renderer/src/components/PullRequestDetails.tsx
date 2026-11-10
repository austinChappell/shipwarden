import { useEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Check, Pencil, Plus, Search, Settings2, Users, X } from 'lucide-react';
import { targetKey, type GitHubLabel, type PullRequest, type PullRequestCandidates, type RepoTarget } from '@shared/github';
import { errorText } from '../util';
import { applyMetaChanges, metaChangeKey, type MetaChange } from './pr-meta-changes';

/** The candidates of each repository, by target key. The list loads one time for each repository and session. */
const candidateCache = new Map<string, Promise<PullRequestCandidates>>();

function loadCandidates(target: RepoTarget): Promise<PullRequestCandidates> {
    const key = targetKey(target);
    let promise = candidateCache.get(key);
    if (!promise) {
        promise = window.shipwarden.github.pullRequestCandidates(target);
        promise.catch(() => candidateCache.delete(key));
        candidateCache.set(key, promise);
    }
    return promise;
}

interface PickerOption {
    value: string;
    label: string;
    /** A hex color without "#", for a label. */
    color?: string;
    detail?: string;
}

/**
 * A list with a search field. Each click adds or removes one item. The list stays open, so the user can change
 * more than one item.
 */
function MultiPicker({ title, options, selected, loading, error, onOpen, onToggle, textTrigger }: {
    title: string;
    /** True shows "Add" or "Edit" as the trigger, not an icon. */
    textTrigger?: boolean;
    options: PickerOption[];
    selected: Set<string>;
    loading: boolean;
    error?: string;
    onOpen(): void;
    onToggle(value: string, add: boolean): void;
}) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [active, setActive] = useState(0);
    const root = useRef<HTMLDivElement>(null);
    const trigger = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        if (!open) return;
        const onDown = (event: MouseEvent) => {
            if (!root.current?.contains(event.target as Node)) setOpen(false);
        };
        window.addEventListener('mousedown', onDown);
        return () => window.removeEventListener('mousedown', onDown);
    }, [open]);

    // The selected items come first. Each word of the search must be in the label.
    const shown = useMemo(() => {
        const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
        return options
            .filter(option => words.every(word => option.label.toLowerCase().includes(word)))
            .sort((a, b) => Number(selected.has(b.value)) - Number(selected.has(a.value)));
    }, [options, query, open]); // eslint-disable-line react-hooks/exhaustive-deps

    const onKey = (event: KeyboardEvent) => {
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActive(index => Math.min(shown.length - 1, index + 1));
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActive(index => Math.max(0, index - 1));
        } else if (event.key === 'Enter' && shown[active]) {
            event.preventDefault();
            onToggle(shown[active].value, !selected.has(shown[active].value));
        } else if (event.key === 'Escape' || (event.key === 'Tab' && event.shiftKey)) {
            // Escape closes only the popover, not a dialog around it. Shift+Tab also closes it.
            // The focus goes back to the button. After Tab, `onBlur` closes the popover.
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            trigger.current?.focus();
        }
    };

    return (
        <div
            className="tag-picker"
            ref={root}
            onBlur={event => {
                // A click on an option gives no new focus. Only a focus outside the picker closes the popover.
                if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
            }}
        >
            <button
                ref={trigger}
                className={textTrigger ? `link-button pr-meta-add${open ? ' on' : ''}` : `icon-button pr-meta-edit${open ? ' on' : ''}`}
                title={title}
                aria-haspopup="listbox"
                aria-expanded={open}
                onClick={() => {
                    if (!open) {
                        setQuery('');
                        setActive(0);
                        onOpen();
                    }
                    setOpen(!open);
                }}
            >
                {textTrigger ? (selected.size > 0 ? 'Edit' : <><Plus size={12} strokeWidth={2} />Add</>) : <Settings2 size={13} strokeWidth={1.7} />}
            </button>
            {open && (
                <div className="combobox-popover tag-picker-popover align-right">
                    <label className="combobox-search">
                        <Search size={13} strokeWidth={1.6} />
                        <input
                            autoFocus
                            value={query}
                            placeholder="Search"
                            spellCheck={false}
                            onChange={event => {
                                setQuery(event.target.value);
                                setActive(0);
                            }}
                            onKeyDown={onKey}
                        />
                    </label>
                    <div className="combobox-list" role="listbox" aria-multiselectable>
                        {error && <div className="combobox-empty form-error">{error}</div>}
                        {!error && loading && <div className="combobox-empty">Loading…</div>}
                        {!error && !loading && shown.length === 0 && <div className="combobox-empty">No matches</div>}
                        {shown.map((option, index) => {
                            const on = selected.has(option.value);
                            return (
                                <div
                                    key={option.value}
                                    role="option"
                                    aria-selected={on}
                                    className={`combobox-option pr-picker-option${index === active ? ' active' : ''}`}
                                    onMouseMove={() => setActive(index)}
                                    onClick={() => onToggle(option.value, !on)}
                                >
                                    <span className="pr-picker-check">{on && <Check size={13} strokeWidth={2} />}</span>
                                    {option.color && <span className="pr-label-dot" style={{ background: `#${option.color}` }} />}
                                    <span className="combobox-label">{option.label}</span>
                                    {option.detail && <span className="pr-picker-detail">{option.detail}</span>}
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}

function MetaRow({ title, picker, empty, card, children }: { title: string; picker?: ReactNode; empty: string; card?: boolean; children: ReactNode[] }) {
    if (card) {
        // A row of the card: the title on the left, the values and the picker on the right.
        return (
            <div className="pr-meta-row card-row">
                <span className="pr-meta-card-title">{title}</span>
                <div className="pr-meta-values">
                    {children.length > 0 ? children : !picker && <span className="panel-note">{empty}</span>}
                    {picker}
                </div>
            </div>
        );
    }
    return (
        <div className="pr-meta-row">
            <div className="pr-meta-heading">
                <span>{title}</span>
                {picker}
            </div>
            <div className="pr-meta-values">
                {children.length > 0 ? children : <span className="panel-note">{empty}</span>}
            </div>
        </div>
    );
}

function Chip({ children, color, onRemove, title }: { children: ReactNode; color?: string; onRemove?(): void; title?: string }) {
    const style = color ? { '--label-color': `#${color}` } as React.CSSProperties : undefined;
    return (
        <span className={`pr-chip${color ? ' label' : ''}`} style={style} title={title}>
            {children}
            {onRemove && (
                <button title="Remove" onClick={onRemove}>
                    <X size={11} strokeWidth={2} />
                </button>
            )}
        </span>
    );
}

const REVIEW_STATE: Record<string, string> = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes', COMMENTED: 'commented', DISMISSED: 'dismissed' };

/** The latest review state of each reviewer that is not the author, from the newest review to the oldest. */
function reviewedBy(pr: PullRequest): Map<string, string> {
    const states = new Map<string, string>();
    for (const review of [...pr.reviews].reverse()) {
        const login = review.author?.login;
        if (!login || login === pr.author?.login || states.has(login)) continue;
        // A comment does not replace an earlier approval or request for changes.
        if (review.state === 'COMMENTED' && [...pr.reviews].some(item => item.author?.login === login && item.state !== 'COMMENTED')) continue;
        states.set(login, review.state);
    }
    return states;
}

/** A change that the sidebar shows before GitHub confirms it. `sent` is true when the request is done. */
interface PendingChange {
    id: number;
    change: MetaChange;
    sent: boolean;
}

/**
 * Sends the changes to the reviewers, the assignees and the labels, and shows them before GitHub confirms them.
 * The user can make the next change at once. Changes to the same item go to GitHub in order.
 * When no request is open, the pull request refreshes one time. The refresh then replaces the changes that it confirms.
 * A change that fails goes away, and `error` shows why.
 */
function usePendingMetaChanges(target: RepoTarget, pr: PullRequest, onRefresh: () => Promise<void>) {
    const pending = useRef<PendingChange[]>([]);
    const queues = useRef(new Map<string, Promise<void>>());
    const open = useRef(0);
    const nextId = useRef(0);
    const [, render] = useReducer((count: number) => count + 1, 0);
    const [error, setError] = useState<string>();
    const scope = `${targetKey(target)}#${pr.number}`;
    const scopeRef = useRef(scope);

    const update = (change: (list: PendingChange[]) => PendingChange[]) => {
        pending.current = change(pending.current);
        render();
    };

    // The changes of a different pull request do not apply.
    useEffect(() => {
        scopeRef.current = scope;
        pending.current = [];
        queues.current.clear();
        open.current = 0;
        setError(undefined);
        render();
    }, [scope]);

    const send = (change: MetaChange) => {
        const id = nextId.current++;
        const key = metaChangeKey(change);
        const sentScope = scope;
        setError(undefined);
        update(list => [...list, { id, change, sent: false }]);
        open.current++;
        const request = (queues.current.get(key) ?? Promise.resolve())
            .then(() => window.shipwarden.github.changePullRequest(target, pr.number, change));
        queues.current.set(key, request.catch(() => undefined));
        request
            .then(
                () => update(list => list.map(item => (item.id === id ? { ...item, sent: true } : item))),
                err => {
                    update(list => list.filter(item => item.id !== id));
                    setError(errorText(err));
                }
            )
            .finally(async () => {
                if (scopeRef.current !== sentScope) return;
                open.current--;
                if (open.current > 0) return;
                const confirmed = new Set(pending.current.filter(item => item.sent).map(item => item.id));
                try {
                    await onRefresh();
                } catch {
                    // The changes stay on the screen. The next refresh confirms them.
                    return;
                }
                if (scopeRef.current === sentScope) update(list => list.filter(item => !confirmed.has(item.id)));
            });
    };

    return { changes: pending.current.map(item => item.change), send, error };
}

/**
 * The reviewers, the assignees and the labels of a pull request, as on the GitHub sidebar.
 * A user with triage access or more can change them. The sidebar shows each change at once, before GitHub confirms it.
 */
export function PullRequestMeta({ target, pr, onRefresh, card }: {
    target: RepoTarget;
    pr: PullRequest;
    onRefresh(): Promise<void>;
    /** True shows a card with the author and one row for each part, for the side column of the Overview tab. */
    card?: boolean;
}) {
    const [candidates, setCandidates] = useState<PullRequestCandidates>();
    const [loadError, setLoadError] = useState<string>();
    const { changes, send: onChange, error } = usePendingMetaChanges(target, pr, onRefresh);
    const shown = applyMetaChanges(pr, changes, candidates?.labels);
    // GitHub accepts assignees and labels also on a closed pull request. Reviewers need an open pull request.
    const manage = pr.viewerCanManage;

    const load = () => {
        setLoadError(undefined);
        loadCandidates(target).then(setCandidates, err => setLoadError(errorText(err)));
    };

    // A different repository has different users and labels.
    useEffect(() => {
        setCandidates(undefined);
    }, [targetKey(target)]); // eslint-disable-line react-hooks/exhaustive-deps

    const reviewed = reviewedBy(pr);
    const requestedUsers = new Set(shown.reviewRequests.filter(item => item.kind === 'user').map(item => item.login));
    const assigned = new Set(shown.assignees.map(user => user.login));
    const labelled = new Set(shown.labels.map(label => label.name));

    const userOptions = (exclude?: string): PickerOption[] => {
        return (candidates?.users ?? []).filter(user => user.login !== exclude).map(user => ({ value: user.login, label: user.login }));
    };
    // Labels and users that the pull request has keep their place in the list, also when the candidate list does not have them.
    const withCurrent = (options: PickerOption[], current: Iterable<string>): PickerOption[] => {
        const known = new Set(options.map(option => option.value));
        return [...options, ...[...current].filter(value => !known.has(value)).map(value => ({ value, label: value }))];
    };
    const labelOptions = (labels: GitHubLabel[]): PickerOption[] =>
        withCurrent(labels.map(label => ({ value: label.name, label: label.name, color: label.color })), labelled)
            .map(option => ({ ...option, color: option.color ?? shown.labels.find(label => label.name === option.value)?.color }));

    return (
        <section className={card ? 'side-card pr-meta-card' : 'pr-section pr-meta-section'}>
            {error && <div className="form-error">{error}</div>}
            {card && (
                <div className="pr-meta-row card-row">
                    <span className="pr-meta-card-title">Author</span>
                    <div className="pr-meta-values"><span className="pr-meta-author">{pr.author?.login ?? 'unknown'}</span></div>
                </div>
            )}
            <MetaRow
                title="Reviewers"
                card={card}
                empty="No reviewers"
                picker={manage && pr.state === 'OPEN' && (
                    <MultiPicker
                        textTrigger={card}
                        title="Ask for a review"
                        options={withCurrent(userOptions(pr.author?.login), requestedUsers)}
                        selected={requestedUsers}
                        loading={!candidates}
                        error={loadError}
                        onOpen={load}
                        onToggle={(login, add) => onChange({ kind: 'reviewer', reviewer: { kind: 'user', login }, add })}
                    />
                )}
            >
                {[
                    ...shown.reviewRequests.map(reviewer => (
                        <Chip
                            key={`${reviewer.kind}:${reviewer.login}`}
                            title={reviewer.kind === 'team' ? `Team ${reviewer.name ?? reviewer.login}. The review is pending.` : 'The review is pending.'}
                            onRemove={manage && pr.state === 'OPEN' ? () => onChange({ kind: 'reviewer', reviewer, add: false }) : undefined}
                        >
                            {reviewer.kind === 'team' && <Users size={11} strokeWidth={1.8} />}
                            {reviewer.kind === 'team' ? reviewer.name ?? reviewer.login : reviewer.login}
                            <span className="pr-chip-state pending">pending</span>
                        </Chip>
                    )),
                    ...[...reviewed]
                        .filter(([login]) => !requestedUsers.has(login))
                        .map(([login, state]) => (
                            <Chip key={`reviewed:${login}`}>
                                {login}
                                <span className={`pr-chip-state review-${state.toLowerCase()}`}>{REVIEW_STATE[state] ?? state.toLowerCase()}</span>
                            </Chip>
                        ))
                ]}
            </MetaRow>

            {pr.hasAssignees !== false && <MetaRow
                title="Assignees"
                card={card}
                empty="No one is assigned"
                picker={manage && (
                    <MultiPicker
                        textTrigger={card}
                        title="Assign users"
                        options={withCurrent(userOptions(), assigned)}
                        selected={assigned}
                        loading={!candidates}
                        error={loadError}
                        onOpen={load}
                        onToggle={(login, add) => onChange({ kind: 'assignee', login, add })}
                    />
                )}
            >
                {shown.assignees.map(user => (
                    <Chip key={user.login} onRemove={manage ? () => onChange({ kind: 'assignee', login: user.login, add: false }) : undefined}>
                        {user.login}
                    </Chip>
                ))}
            </MetaRow>}

            <MetaRow
                title="Labels"
                card={card}
                empty="No labels"
                picker={manage && (
                    <MultiPicker
                        textTrigger={card}
                        title="Change the labels"
                        options={labelOptions(candidates?.labels ?? [])}
                        selected={labelled}
                        loading={!candidates}
                        error={loadError}
                        onOpen={load}
                        onToggle={(name, add) => onChange({ kind: 'label', name, add })}
                    />
                )}
            >
                {shown.labels.map(label => (
                    <Chip
                        key={label.name}
                        color={label.color}
                        title={label.description ?? undefined}
                        onRemove={manage ? () => onChange({ kind: 'label', name: label.name, add: false }) : undefined}
                    >
                        {label.name}
                    </Chip>
                ))}
            </MetaRow>
        </section>
    );
}

/** The form that changes the title and the description of a pull request. */
export function DescriptionEditor({ pr, busy, onSave, onCancel }: {
    pr: PullRequest;
    busy: boolean;
    onSave(title: string, body: string): void;
    onCancel(): void;
}) {
    const [title, setTitle] = useState(pr.title);
    const [body, setBody] = useState(pr.body);
    const changed = title.trim() !== pr.title || body !== pr.body;
    const save = () => {
        if (title.trim() && changed) onSave(title.trim(), body);
    };
    return (
        <div
            className="pr-description-editor"
            onKeyDown={event => {
                if (event.key === 'Escape') onCancel();
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) save();
            }}
        >
            <input className="pr-title-input" value={title} placeholder="Title" onChange={event => setTitle(event.target.value)} />
            <textarea autoFocus className="review-body pr-body-input" value={body} placeholder="Description (Markdown)" onChange={event => setBody(event.target.value)} />
            <div className="row-buttons">
                <button className="button" onClick={onCancel}>Cancel</button>
                <button className="button primary" disabled={busy || !title.trim() || !changed} onClick={save}>Save</button>
            </div>
        </div>
    );
}

/** The button that opens the description editor. */
export function EditDescriptionButton({ onClick }: { onClick(): void }) {
    return (
        <button className="icon-button pr-meta-edit" title="Edit the title and the description" onClick={event => { event.stopPropagation(); onClick(); }}>
            <Pencil size={12} strokeWidth={1.7} />
        </button>
    );
}
