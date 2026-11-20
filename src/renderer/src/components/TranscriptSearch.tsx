import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileText, Loader2, MessageSquare, Search, User } from 'lucide-react';
import { pluralize } from '@shared/format';
import type { PinnedSession } from '@shared/pinned-sessions';
import type { RecentSession } from '@shared/recent-sessions';
import { ENTRY_KIND_LABELS, snippetParts, type SearchEntryKind, type TranscriptSearchHit, type TranscriptSearchQuery } from '@shared/transcript-search';
import { keyRoots } from '../query-client';
import { EmptyState } from './EmptyState';
import { type ResumePlace, SessionRow } from './PinnedSessions';
import { Combobox, Select, type SelectOption, SkeletonRows } from './ui';

const api = window.shipwarden;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The time ranges of the date filter. */
const DATE_OPTIONS: SelectOption<'all' | '1' | '7' | '30'>[] = [
    { value: 'all', label: 'Any time' },
    { value: '1', label: 'Last 24 hours' },
    { value: '7', label: 'Last 7 days' },
    { value: '30', label: 'Last 30 days' }
];

/** The value of the filters for "all repositories" and "all models". */
const ALL = '';

/** The time that the field waits after the last key before it searches. */
const TYPE_DELAY_MS = 200;

const KIND_ICONS: Record<SearchEntryKind, typeof User> = { prompt: User, text: MessageSquare, file: FileText };

interface Props {
    /** The text in the search field of the page header. */
    text: string;
    /** The repositories of all projects. */
    repos: string[];
    /** The worktrees of all projects, by worktree path. */
    places: Record<string, ResumePlace>;
    selectedPath: string | undefined;
    repoLabel(repo: string): string;
    pins: PinnedSession[];
    onResume(pin: PinnedSession, place: ResumePlace): Promise<void>;
    onResumeRecent(session: RecentSession, place: ResumePlace): Promise<void>;
    onPin(session: RecentSession): void;
}

/** Returns the text after a delay. A new text in that time starts the delay again. */
function useDelayed(text: string): string {
    const [value, setValue] = useState(text);
    useEffect(() => {
        const timer = setTimeout(() => setValue(text), TYPE_DELAY_MS);
        return () => clearTimeout(timer);
    }, [text]);
    return value;
}

/**
 * The search across all Claude Code transcripts. It shows in the Agents view while the search field has text. A result
 * resumes its session like a recent session. A session that runs now opens its tab.
 */
export function TranscriptSearch({ text, repos, places, selectedPath, repoLabel, pins, onResume, onResumeRecent, onPin }: Props) {
    const [repo, setRepo] = useState(ALL);
    const [model, setModel] = useState(ALL);
    const [days, setDays] = useState<(typeof DATE_OPTIONS)[number]['value']>('all');
    const delayed = useDelayed(text.trim());

    const folders = useMemo(() => {
        if (!repo) return undefined;
        // A session can run in the repository folder or in one of its worktrees.
        const paths = Object.values(places)
            .filter(place => place.repo === repo)
            .map(place => place.worktree.path);
        return [...new Set([repo, ...paths])].sort();
    }, [repo, places]);

    // The start of the date range moves only once a minute, so the query key stays the same while the user reads.
    const minute = Math.floor(Date.now() / 60_000);
    const since = days === 'all' ? undefined : minute * 60_000 - Number(days) * DAY_MS;
    const query: TranscriptSearchQuery = {
        text: delayed,
        ...(folders ? { folders } : {}),
        ...(model ? { model } : {}),
        ...(since !== undefined ? { since } : {})
    };
    const result = useQuery({
        queryKey: [...keyRoots.transcriptSearch, query],
        queryFn: () => api.transcriptSearch.search(query),
        enabled: delayed.length > 0,
        staleTime: 30_000,
        placeholderData: previous => previous,
        // While the index reads transcripts, the result can grow. The index is on this Mac, so the poll sends no request to a service.
        refetchInterval: current => (current.state.data?.progress ? 2000 : false)
    });

    const repoGroups = useMemo(
        () => [
            { label: '', items: [{ value: ALL, label: 'All repositories' }] },
            ...[...repos]
                .sort((a, b) => repoLabel(a).localeCompare(repoLabel(b)))
                .map(item => ({ label: '', items: [{ value: item, label: repoLabel(item) }] }))
        ],
        [repos, repoLabel]
    );
    const modelOptions = useMemo<SelectOption[]>(
        () => [{ value: ALL, label: 'All models' }, ...(result.data?.models ?? []).map(value => ({ value, label: value }))],
        [result.data?.models]
    );
    const pinById = useMemo(() => new Map(pins.map(pin => [pin.sessionId, pin])), [pins]);

    const hits = result.data?.hits ?? [];
    const progress = result.data?.progress;
    const waiting = text.trim() !== delayed || (result.isFetching && !result.data);

    const resume = (hit: TranscriptSearchHit, place: ResumePlace) => {
        const pin = pinById.get(hit.sessionId);
        return pin ? onResume(pin, place) : onResumeRecent(hit, place);
    };

    return (
        <section className="agents-group transcript-search" aria-labelledby="agents-group-search">
            <h2 id="agents-group-search">
                <Search size={13} strokeWidth={1.8} aria-hidden />
                Transcript search
                {!waiting && result.data && <span className="agents-group-count">{pluralize(hits.length, 'session')}</span>}
                {progress && (
                    <span className="transcript-search-progress" title="The results can be incomplete until the index is ready.">
                        <Loader2 size={11} strokeWidth={2} className="spin" aria-hidden />
                        Indexing transcripts {progress.done} of {progress.total}
                    </span>
                )}
            </h2>
            <div className="transcript-search-filters">
                <Combobox
                    size="sm"
                    className="transcript-search-repo"
                    value={repo}
                    groups={repoGroups}
                    onChange={setRepo}
                    placeholder="All repositories"
                    searchPlaceholder="Search repositories"
                    aria-label="Repository"
                />
                <Select size="sm" value={model} options={modelOptions} onChange={setModel} aria-label="Model" />
                <Select size="sm" value={days} options={DATE_OPTIONS} onChange={value => setDays(value as typeof days)} aria-label="Dates" />
            </div>
            {result.isError ? (
                <EmptyState icon={Search} title="The search failed" size="compact">
                    {result.error instanceof Error
                        ? result.error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
                        : String(result.error)}
                </EmptyState>
            ) : waiting && hits.length === 0 ? (
                <SkeletonRows count={3} label="Searching" />
            ) : hits.length === 0 ? (
                <EmptyState icon={Search} title="No sessions match" size="compact">
                    The search reads the prompts, the agent text, and the file paths of the tool calls of each Claude Code session.
                </EmptyState>
            ) : (
                /* biome-ignore lint/a11y/noRedundantRoles: Safari removes the list role when the list has no bullets. */
                <ul className="agents-list" role="list">
                    {hits.map(hit => {
                        const Icon = KIND_ICONS[hit.kind];
                        const folder = hit.cwd.split('/').pop() || hit.cwd;
                        return (
                            <SessionRow
                                key={hit.sessionId}
                                icon={<Icon size={13} strokeWidth={1.8} className="pinned-icon" aria-label={ENTRY_KIND_LABELS[hit.kind]} />}
                                name={pinById.get(hit.sessionId)?.name ?? hit.name}
                                cwd={hit.cwd}
                                fallbackWhere={[folder, hit.branch].filter(Boolean).join(' · ')}
                                time={hit.at}
                                timeTitle="Time of the match"
                                places={places}
                                selectedPath={selectedPath}
                                repoLabel={repoLabel}
                                resume={place => resume(hit, place)}
                                menu={pinById.has(hit.sessionId) ? [] : [{ id: 'pin', label: 'Pin session' }]}
                                onMenu={choice => {
                                    if (choice === 'pin') onPin(hit);
                                }}
                                detail={<Snippet hit={hit} />}
                            />
                        );
                    })}
                </ul>
            )}
        </section>
    );
}

/** The text around the match, with the matching words marked. */
function Snippet({ hit }: { hit: TranscriptSearchHit }) {
    const parts = snippetParts(hit.snippet);
    const more = hit.matches > 1 ? ` · ${pluralize(hit.matches - 1, 'more match', 'more matches')}` : '';
    return (
        <p className="transcript-search-snippet">
            <span className="transcript-search-kind">{ENTRY_KIND_LABELS[hit.kind]}</span>
            {parts.map((part, index) =>
                // biome-ignore lint/suspicious/noArrayIndexKey: The parts of one snippet do not change order.
                part.mark ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>
            )}
            {more && <span className="transcript-search-more">{more}</span>}
        </p>
    );
}
