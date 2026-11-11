import { useContext, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type Ref, type TextareaHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AtSign, CircleCheck, CircleDot, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from 'lucide-react';
import { targetKey, type IssueReference } from '@shared/github';
import { activeMention, applyMention, isLoginQuery, rankUsers, type ActiveMention } from '@shared/mentions';
import { keyRoots, queryClient, STALE_MS } from '../query-client';
import { caretRect } from './caret-position';
import { MentionContext, type MentionSource } from './mention-context';

interface Props extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> {
    value: string;
    onValueChange(value: string): void;
    ref?: Ref<HTMLTextAreaElement>;
}

/** One row of the list. `insert` is the text that goes into the comment. */
interface MentionItem {
    key: string;
    insert: string;
    label: string;
    /** The full name of the user, after the login. */
    name?: string;
    detail?: string;
    reference?: IssueReference;
}

/** The time after the last key before the "#" list loads. */
const SEARCH_DELAY_MS = 200;

/**
 * A text box for a comment. In a GitHub repository (a `MentionContext` provider), "@" opens a list of users and "#"
 * opens a list of issues and pull requests. ↑ and ↓ select an item. Enter or Tab puts it in the text. Esc closes the list.
 * Without a provider, the box is a plain text box.
 */
export function MentionTextarea({ value, onValueChange, ref, onKeyDown, onBlur, onSelect, ...rest }: Props) {
    const source = useContext(MentionContext);
    const boxRef = useRef<HTMLTextAreaElement | null>(null);
    const [mention, setMention] = useState<ActiveMention>();
    /** The start of the reference that the user closed with Esc. The list stays closed for it. */
    const [dismissed, setDismissed] = useState<number>();
    const [active, setActive] = useState(0);
    const items = useMentionItems(source, mention);
    // After a space, ".", or "'", the user can type a full name, or can continue the sentence after a complete login.
    // Then the list shows only when a name matches, so "@ann thanks" and "@ann." close it.
    const open = !!mention && (items.list.length > 0 || mention.trigger === '#' || isLoginQuery(mention.query));

    const setRefs = (node: HTMLTextAreaElement | null) => {
        boxRef.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) ref.current = node;
    };

    /** Finds the reference at the cursor. */
    const update = (box: HTMLTextAreaElement) => {
        const found = source && box.selectionStart === box.selectionEnd ? activeMention(box.value, box.selectionStart) : undefined;
        if (found?.start !== dismissed) setDismissed(undefined);
        const next = found && found.start !== dismissed ? found : undefined;
        if (next?.query !== mention?.query || next?.trigger !== mention?.trigger) setActive(0);
        setMention(next);
    };

    const pick = (item: MentionItem) => {
        const box = boxRef.current;
        if (!box || !mention) return;
        const next = applyMention(value, box.selectionStart, mention, item.insert);
        onValueChange(next.text);
        setMention(undefined);
        requestAnimationFrame(() => {
            box.focus();
            box.setSelectionRange(next.caret, next.caret);
        });
    };

    const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (mention && open && !event.metaKey && !event.ctrlKey && !event.altKey) {
            const count = items.list.length;
            let handled = true;
            if (event.key === 'ArrowDown' && count) setActive(index => (index + 1) % count);
            else if (event.key === 'ArrowUp' && count) setActive(index => (index - 1 + count) % count);
            else if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey && count) pick(items.list[Math.min(active, count - 1)]);
            else if (event.key === 'Escape') {
                setDismissed(mention.start);
                setMention(undefined);
            } else handled = false;
            if (handled) {
                // The key must not reach the comment box: Esc closes only the list, and Enter adds no new line.
                event.preventDefault();
                event.stopPropagation();
                return;
            }
        }
        onKeyDown?.(event);
    };

    return (
        <>
            <textarea
                ref={setRefs}
                value={value}
                onChange={event => {
                    onValueChange(event.target.value);
                    update(event.target);
                }}
                onSelect={event => {
                    update(event.currentTarget);
                    onSelect?.(event);
                }}
                onBlur={event => {
                    setMention(undefined);
                    onBlur?.(event);
                }}
                onKeyDown={keyDown}
                aria-autocomplete={source ? 'list' : undefined}
                {...rest}
            />
            {mention && open && boxRef.current && (
                <MentionList
                    box={boxRef.current}
                    mention={mention}
                    items={items.list}
                    status={items.status}
                    active={active}
                    onPick={pick}
                    onHover={setActive}
                />
            )}
        </>
    );
}

/** The items of the list: users for "@", issues and pull requests for "#". The data loads only when the list needs it. */
function useMentionItems(source: MentionSource | undefined, mention: ActiveMention | undefined) {
    const repoKey = source ? targetKey(source.target) : '';
    const wantsPeople = !!source && mention?.trigger === '@';
    // The same query as the assignee and reviewer pickers, so the list loads one time for each repository and session.
    const candidates = useQuery(
        {
            queryKey: [...keyRoots.pullRequestCandidates, repoKey],
            queryFn: () => window.shipwarden.github.pullRequestCandidates(source!.target),
            enabled: wantsPeople,
            staleTime: Number.POSITIVE_INFINITY,
            refetchInterval: false
        },
        queryClient
    );
    const search = useDelayed(source && mention?.trigger === '#' ? mention.query : undefined, SEARCH_DELAY_MS);
    const references = useQuery(
        {
            queryKey: [...keyRoots.issueReferences, repoKey, search ?? ''],
            queryFn: () => window.shipwarden.github.issueReferences(source!.target, search ?? ''),
            enabled: !!source && search !== undefined,
            staleTime: STALE_MS,
            refetchInterval: false,
            placeholderData: keepPreviousData
        },
        queryClient
    );

    if (!source || !mention) return { list: [], status: undefined };
    if (mention.trigger === '@') {
        // The people of the pull request have no names. rankUsers takes their names from the repository users.
        const users = [...source.people.map(login => ({ login })), ...(candidates.data?.users ?? [])];
        const people = new Set(source.people.map(login => login.toLowerCase()));
        const list = rankUsers(users, mention.query).map(user => ({
            key: user.login,
            insert: `@${user.login}`,
            label: user.login,
            name: user.name,
            detail: people.has(user.login.toLowerCase()) ? 'In this pull request' : undefined
        }));
        const status = list.length ? undefined : candidates.isError ? 'ShipWarden cannot load the users.' : candidates.isFetching ? 'Loading…' : 'No matches';
        return { list, status };
    }
    const list = (references.data ?? []).map(reference => ({
        key: `${reference.kind}-${reference.number}`,
        insert: `#${reference.number}`,
        label: reference.title,
        detail: `#${reference.number}`,
        reference
    }));
    const loading = references.isFetching || search !== mention.query;
    const status = list.length ? undefined : references.isError ? 'ShipWarden cannot load the issues.' : loading ? 'Loading…' : 'No matches';
    return { list, status };
}

/** Returns the value after it stays the same for `delay` milliseconds. */
function useDelayed<T>(value: T, delay: number): T {
    const [delayed, setDelayed] = useState(value);
    useEffect(() => {
        const timer = setTimeout(() => setDelayed(value), delay);
        return () => clearTimeout(timer);
    }, [value, delay]);
    return delayed;
}

const LIST_WIDTH = 320;
const LIST_MAX_HEIGHT = 240;

/**
 * The list below the cursor. It is in `document.body`, so the overflow of a card or of the editor cannot cut it.
 * When the space below the cursor is too small, the list shows above the cursor.
 */
function MentionList({
    box,
    mention,
    items,
    status,
    active,
    onPick,
    onHover
}: {
    box: HTMLTextAreaElement;
    mention: ActiveMention;
    items: MentionItem[];
    status: string | undefined;
    active: number;
    onPick(item: MentionItem): void;
    onHover(index: number): void;
}) {
    const [position, setPosition] = useState<{ left: number; top?: number; bottom?: number }>();
    const listRef = useRef<HTMLDivElement>(null);

    useLayoutEffect(() => {
        const caret = caretRect(box, mention.start);
        const left = Math.max(8, Math.min(caret.left, window.innerWidth - LIST_WIDTH - 8));
        const below = caret.top + caret.height + 4;
        setPosition(
            window.innerHeight - below >= LIST_MAX_HEIGHT || caret.top < LIST_MAX_HEIGHT
                ? { left, top: below }
                : { left, bottom: window.innerHeight - caret.top + 4 }
        );
    }, [box, mention.start]);

    // ↑ and ↓ keep the selected item in view.
    useEffect(() => {
        listRef.current?.children.item(active + (status ? 1 : 0))?.scrollIntoView({ block: 'nearest' });
    }, [active, status]);

    if (!position) return null;
    return createPortal(
        <div
            ref={listRef}
            className="mention-list"
            role="listbox"
            aria-label={mention.trigger === '@' ? 'Users' : 'Issues and pull requests'}
            style={{ left: position.left, top: position.top, bottom: position.bottom, width: LIST_WIDTH, maxHeight: LIST_MAX_HEIGHT }}
            // A click in the list must not take the focus from the text box.
            onMouseDown={event => event.preventDefault()}
        >
            {status && <div className="combobox-empty">{status}</div>}
            {items.map((item, index) => (
                <div
                    key={item.key}
                    role="option"
                    aria-selected={index === active}
                    className={`combobox-option mention-option${index === active ? ' active' : ''}`}
                    onMouseEnter={() => onHover(index)}
                    onClick={() => onPick(item)}
                >
                    {item.reference ? <ReferenceIcon reference={item.reference} /> : <AtSign size={13} strokeWidth={1.8} className="mention-icon" />}
                    <span className="combobox-label">
                        {item.label}
                        {item.name && <span className="mention-name">{item.name}</span>}
                    </span>
                    {item.detail && <span className="mention-detail">{item.detail}</span>}
                </div>
            ))}
        </div>,
        document.body
    );
}

/** The icon and the color of the state of an issue or a pull request, as on GitHub. */
function ReferenceIcon({ reference }: { reference: IssueReference }) {
    const props = { size: 13, strokeWidth: 1.8 };
    if (reference.kind === 'issue') {
        return reference.state === 'OPEN' ? (
            <CircleDot {...props} className="mention-icon open" aria-label="Open issue" />
        ) : (
            <CircleCheck {...props} className="mention-icon merged" aria-label="Closed issue" />
        );
    }
    if (reference.state === 'MERGED') return <GitMerge {...props} className="mention-icon merged" aria-label="Merged pull request" />;
    if (reference.state === 'CLOSED') return <GitPullRequestClosed {...props} className="mention-icon closed" aria-label="Closed pull request" />;
    if (reference.isDraft) return <GitPullRequestDraft {...props} className="mention-icon draft" aria-label="Draft pull request" />;
    return <GitPullRequest {...props} className="mention-icon open" aria-label="Open pull request" />;
}
