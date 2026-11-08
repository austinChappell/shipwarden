import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Check, Pencil, Search, Settings2, Users, X } from 'lucide-react';
import { targetKey, type GitHubLabel, type PullRequest, type PullRequestCandidates, type PullRequestChange, type RepoTarget } from '@shared/github';
import { errorText } from '../util';

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
function MultiPicker({ title, options, selected, loading, error, onOpen, onToggle }: {
    title: string;
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
        } else if (event.key === 'Escape') {
            event.preventDefault();
            setOpen(false);
        }
    };

    return (
        <div className="tag-picker" ref={root}>
            <button
                className={`icon-button pr-meta-edit${open ? ' on' : ''}`}
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
                <Settings2 size={13} strokeWidth={1.7} />
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

function MetaRow({ title, picker, empty, children }: { title: string; picker?: ReactNode; empty: string; children: ReactNode[] }) {
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

/**
 * The reviewers, the assignees and the labels of a pull request, as on the GitHub sidebar.
 * A user with triage access or more can change them.
 */
export function PullRequestMeta({ target, pr, busy, onChange }: {
    target: RepoTarget;
    pr: PullRequest;
    busy: boolean;
    onChange(change: PullRequestChange): void;
}) {
    const [candidates, setCandidates] = useState<PullRequestCandidates>();
    const [loadError, setLoadError] = useState<string>();
    // GitHub accepts assignees and labels also on a closed pull request. Reviewers need an open pull request.
    const manage = pr.viewerCanManage && !busy;

    const load = () => {
        setLoadError(undefined);
        loadCandidates(target).then(setCandidates, err => setLoadError(errorText(err)));
    };

    // A different repository has different users and labels.
    useEffect(() => {
        setCandidates(undefined);
    }, [targetKey(target)]); // eslint-disable-line react-hooks/exhaustive-deps

    const reviewed = reviewedBy(pr);
    const requestedUsers = new Set(pr.reviewRequests.filter(item => item.kind === 'user').map(item => item.login));
    const assigned = new Set(pr.assignees.map(user => user.login));
    const labelled = new Set(pr.labels.map(label => label.name));

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
            .map(option => ({ ...option, color: option.color ?? pr.labels.find(label => label.name === option.value)?.color }));

    return (
        <section className="pr-section pr-meta-section">
            <MetaRow
                title="Reviewers"
                empty="No reviewers"
                picker={manage && pr.state === 'OPEN' && (
                    <MultiPicker
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
                    ...pr.reviewRequests.map(reviewer => (
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

            <MetaRow
                title="Assignees"
                empty="No one is assigned"
                picker={manage && (
                    <MultiPicker
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
                {pr.assignees.map(user => (
                    <Chip key={user.login} onRemove={manage ? () => onChange({ kind: 'assignee', login: user.login, add: false }) : undefined}>
                        {user.login}
                    </Chip>
                ))}
            </MetaRow>

            <MetaRow
                title="Labels"
                empty="No labels"
                picker={manage && (
                    <MultiPicker
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
                {pr.labels.map(label => (
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
