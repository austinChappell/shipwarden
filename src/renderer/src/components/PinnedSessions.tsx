import { type ReactNode, useMemo, useState } from 'react';
import { ChevronRight, History, Loader2, MoreHorizontal, Pin, PinOff, Play } from 'lucide-react';
import { pluralize } from '@shared/format';
import { type PinnedSession, type SessionTags, UNPINNED_KEEP_DAYS } from '@shared/pinned-sessions';
import { RECENT_SESSION_DAYS, type RecentSession } from '@shared/recent-sessions';
import type { Worktree } from '@shared/worktrees';
import { removePin, renamePin, restorePin, setSessionTags, unpinSession } from '../terminal/pinned-sessions';
import { type ContextMenuItem, showContextMenu } from './ContextMenu';
import { TagEditor } from './TagEditor';
import { showToast } from './Toast';
import { Age, Button, Combobox, Count, IconButton, Input, sortedGroups } from './ui';

/** A worktree that can get a resumed session. */
export interface ResumePlace {
    repo: string;
    worktree: Worktree;
}

interface PlaceProps {
    /** The worktrees of all projects, by worktree path. */
    places: Record<string, ResumePlace>;
    /** The worktree that the app shows now. The picker selects it first when the worktree of the session is gone. */
    selectedPath: string | undefined;
    repoLabel(repo: string): string;
}

/** The tags of the sessions. Each list of sessions gets them. */
export interface TagProps {
    /** The tags of the sessions, by the session ID. */
    tags: SessionTags;
    /** All tags of all sessions, for the tag picker. */
    allTags: string[];
}

/** Returns the props that let a session row show and change the tags of a session. */
export function tagRowProps({ tags, allTags }: TagProps, sessionId: string): Pick<SessionRowProps, 'tags' | 'allTags' | 'onTags'> {
    return {
        tags: tags[sessionId] ?? [],
        allTags,
        onTags: next => setSessionTags(sessionId, next).catch(error => showToast('The tags did not change', errorText(error)))
    };
}

interface Props extends PlaceProps, TagProps {
    pins: PinnedSession[];
    /** Resumes the session in a worktree. Resolves when the agent tab shows. */
    onResume(pin: PinnedSession, place: ResumePlace): Promise<void>;
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error);
}

/**
 * The pinned Claude Code sessions of all projects. A row resumes its session in the worktree in which it ran last, or
 * in another worktree of any project. The menu renames the pin or removes it.
 */
export function PinnedSessions({ pins, places, selectedPath, repoLabel, onResume, ...tagProps }: Props) {
    if (pins.length === 0) return null;
    return (
        <section className="agents-group pinned-sessions" aria-labelledby="agents-group-pinned">
            <h2 id="agents-group-pinned">
                <Pin size={13} strokeWidth={1.8} aria-hidden />
                Pinned sessions
            </h2>
            {/* biome-ignore lint/a11y/noRedundantRoles: Safari removes the list role when the list has no bullets. */}
            <ul className="agents-list" role="list">
                {pins.map(pin => (
                    <SessionRow
                        key={pin.id}
                        icon={<Pin size={13} strokeWidth={1.8} className="pinned-icon" aria-hidden />}
                        name={pin.name}
                        naming={pin.naming}
                        cwd={pin.cwd}
                        fallbackWhere={[pin.repoPath && repoLabel(pin.repoPath), pin.branch].filter(Boolean).join(' · ') || pin.cwd}
                        time={pin.resumedAt ?? pin.pinnedAt}
                        timeTitle={pin.resumedAt ? 'Last resume' : 'Pinned'}
                        places={places}
                        selectedPath={selectedPath}
                        repoLabel={repoLabel}
                        resume={place => onResume(pin, place)}
                        rename={name => renamePin(pin.id, name).then(() => undefined)}
                        {...tagRowProps(tagProps, pin.sessionId)}
                        menu={[{ id: 'unpin', label: 'Unpin', danger: true }]}
                        onMenu={choice => {
                            if (choice === 'unpin') unpinSession(pin.id).catch(error => showToast('The pin did not go', errorText(error)));
                        }}
                    />
                ))}
            </ul>
        </section>
    );
}

interface UnpinnedProps extends PlaceProps, TagProps {
    /** The recently unpinned sessions, the newest unpin first. */
    pins: PinnedSession[];
    onResume(pin: PinnedSession, place: ResumePlace): Promise<void>;
}

/**
 * The sessions that the user unpinned in the last UNPINNED_KEEP_DAYS days. The section is closed at first. A row can
 * pin its session again, resume it, or remove it now.
 */
export function UnpinnedSessions({ pins, places, selectedPath, repoLabel, onResume, ...tagProps }: UnpinnedProps) {
    const [open, setOpen] = useState(false);
    if (pins.length === 0) return null;
    return (
        <section className="agents-group pinned-sessions unpinned-sessions" aria-labelledby="agents-group-unpinned">
            <h2 id="agents-group-unpinned">
                <button type="button" className="unpinned-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>
                    <ChevronRight size={14} strokeWidth={1.8} className={`group-chevron${open ? ' open' : ''}`} aria-hidden />
                    Recently unpinned
                    <Count value={pins.length} label={pluralize(pins.length, 'session')} />
                    <span className="recent-sessions-scope">ShipWarden removes them after {UNPINNED_KEEP_DAYS} days</span>
                </button>
            </h2>
            {open && (
                // biome-ignore lint/a11y/noRedundantRoles: Safari removes the list role when the list has no bullets.
                <ul className="agents-list" role="list">
                    {pins.map(pin => (
                        <SessionRow
                            key={pin.id}
                            icon={<PinOff size={13} strokeWidth={1.8} className="pinned-icon" aria-hidden />}
                            name={pin.name}
                            cwd={pin.cwd}
                            fallbackWhere={[pin.repoPath && repoLabel(pin.repoPath), pin.branch].filter(Boolean).join(' · ') || pin.cwd}
                            time={pin.unpinnedAt ?? pin.pinnedAt}
                            timeTitle="Unpinned"
                            places={places}
                            selectedPath={selectedPath}
                            repoLabel={repoLabel}
                            resume={place => onResume(pin, place)}
                            {...tagRowProps(tagProps, pin.sessionId)}
                            menu={[{ id: 'restore', label: 'Pin again' }, { type: 'separator' }, { id: 'remove', label: 'Remove now', danger: true }]}
                            onMenu={choice => {
                                if (choice === 'restore') restorePin(pin.id).catch(error => showToast('The session did not pin', errorText(error)));
                                if (choice === 'remove') removePin(pin.id).catch(error => showToast('The session did not go', errorText(error)));
                            }}
                        />
                    ))}
                </ul>
            )}
        </section>
    );
}

interface RecentProps extends PlaceProps, TagProps {
    /** The recent sessions without a pin that do not run now. */
    sessions: RecentSession[];
    onResume(session: RecentSession, place: ResumePlace): Promise<void>;
    onPin(session: RecentSession): void;
}

/** The number of recent sessions that show before "Show all". */
const RECENT_PREVIEW = 5;

/**
 * The Claude Code sessions of the last days that have no pin and do not run now. A row resumes its session like a
 * pinned session. The menu pins it.
 */
export function RecentSessions({ sessions, places, selectedPath, repoLabel, onResume, onPin, ...tagProps }: RecentProps) {
    const [expanded, setExpanded] = useState(false);
    if (sessions.length === 0) return null;
    const shown = expanded ? sessions : sessions.slice(0, RECENT_PREVIEW);
    return (
        <section className="agents-group pinned-sessions recent-sessions" aria-labelledby="agents-group-recent">
            <h2 id="agents-group-recent">
                <History size={13} strokeWidth={1.8} aria-hidden />
                Recent sessions
                <span className="recent-sessions-scope">Last {RECENT_SESSION_DAYS} days</span>
            </h2>
            {/* biome-ignore lint/a11y/noRedundantRoles: Safari removes the list role when the list has no bullets. */}
            <ul className="agents-list" role="list">
                {shown.map(session => {
                    const folder = session.cwd.split('/').pop() || session.cwd;
                    return (
                        <SessionRow
                            key={session.sessionId}
                            icon={<History size={13} strokeWidth={1.8} className="pinned-icon" aria-hidden />}
                            name={session.name}
                            cwd={session.cwd}
                            fallbackWhere={[folder, session.branch].filter(Boolean).join(' · ')}
                            time={session.updatedAt}
                            timeTitle="Last activity"
                            places={places}
                            selectedPath={selectedPath}
                            repoLabel={repoLabel}
                            resume={place => onResume(session, place)}
                            {...tagRowProps(tagProps, session.sessionId)}
                            menu={[{ id: 'pin', label: 'Pin session' }]}
                            onMenu={choice => {
                                if (choice === 'pin') onPin(session);
                            }}
                        />
                    );
                })}
            </ul>
            {sessions.length > RECENT_PREVIEW && (
                <div className="recent-sessions-more">
                    <Button variant="link" onClick={() => setExpanded(value => !value)}>
                        {expanded ? 'Show fewer' : `Show all ${sessions.length}`}
                    </Button>
                </div>
            )}
        </section>
    );
}

export interface SessionRowProps extends PlaceProps {
    icon: ReactNode;
    name: string;
    /** True while the agent makes a name for the session. */
    naming?: boolean;
    /** The folder in which the session ran last. */
    cwd: string;
    /** The place text when the folder is not a known worktree. */
    fallbackWhere: string;
    time: number;
    timeTitle: string;
    /** Resumes the session in a worktree. Resolves when the agent tab shows. */
    resume(place: ResumePlace): Promise<void>;
    /** Gives the session a new name. Without it, the menu has no "Rename". */
    rename?(name: string): Promise<void>;
    /** The tags of the session. */
    tags?: string[];
    /** All tags of all sessions, for the tag picker. */
    allTags?: string[];
    /** Gives the session new tags. Without it, the row shows no tags and the menu has no "Add tag". */
    onTags?(tags: string[]): void;
    /** The items at the end of the menu. */
    menu: ContextMenuItem[];
    onMenu(choice: string): void;
    /** More content below the first line, for example the text that matches a search. */
    detail?: ReactNode;
}

/** One session row: the name, the place, the age, "Resume", and a menu with "Resume in another worktree…". */
export function SessionRow({
    icon,
    name,
    naming,
    cwd,
    fallbackWhere,
    time,
    timeTitle,
    places,
    selectedPath,
    repoLabel,
    resume: resumeIn,
    rename,
    tags = [],
    allTags = [],
    onTags,
    menu,
    onMenu,
    detail
}: SessionRowProps) {
    const [editing, setEditing] = useState(false);
    /** True while the tag picker is open from the menu. The tag line also shows when the session has tags. */
    const [tagging, setTagging] = useState(false);
    const [draft, setDraft] = useState(name);
    const [picking, setPicking] = useState(false);
    const [target, setTarget] = useState<string | undefined>();
    const [busy, setBusy] = useState(false);

    const home = places[cwd];
    const where = home ? `${repoLabel(home.repo)} · ${home.worktree.branch ?? home.worktree.path.split('/').pop()}` : fallbackWhere;

    const groups = useMemo(
        () =>
            sortedGroups(
                Object.values(places),
                place => repoLabel(place.repo),
                place => ({ value: place.worktree.path, label: place.worktree.branch ?? place.worktree.path.split('/').pop() ?? place.worktree.path })
            ),
        [places, repoLabel]
    );

    const resume = async (place: ResumePlace) => {
        setBusy(true);
        try {
            await resumeIn(place);
            setPicking(false);
        } catch (error) {
            showToast('The session did not resume', errorText(error));
        } finally {
            setBusy(false);
        }
    };

    const startPicking = () => {
        setTarget(home ? home.worktree.path : selectedPath && places[selectedPath] ? selectedPath : undefined);
        setPicking(true);
    };

    const saveName = async () => {
        const value = draft.trim();
        setEditing(false);
        if (!rename || !value || value === name) return;
        try {
            await rename(value);
        } catch (error) {
            showToast('The name did not change', errorText(error));
        }
    };

    const openMenu = async (anchor: Element) => {
        const choice = await showContextMenu(
            [
                { id: 'resume-in', label: 'Resume in another worktree…' },
                { type: 'separator' },
                ...(rename ? [{ id: 'rename', label: 'Rename' }] : []),
                ...(onTags ? [{ id: 'tags', label: 'Add tag…' }] : []),
                ...(rename || onTags ? [{ type: 'separator' as const }] : []),
                ...menu
            ],
            anchor
        );
        if (choice === 'resume-in') startPicking();
        else if (choice === 'rename') {
            setDraft(name);
            setEditing(true);
        } else if (choice === 'tags') setTagging(true);
        else if (choice) onMenu(choice);
    };

    return (
        <li className="pinned-row">
            <div className="pinned-line">
                {icon}
                <span className="agent-main">
                    {editing ? (
                        <Input
                            size="sm"
                            aria-label="Session name"
                            value={draft}
                            maxLength={60}
                            autoFocus
                            onChange={event => setDraft(event.target.value)}
                            onBlur={() => void saveName()}
                            onKeyDown={event => {
                                if (event.key === 'Enter') void saveName();
                                if (event.key === 'Escape') setEditing(false);
                            }}
                        />
                    ) : (
                        <span className="agent-name" title={name}>
                            {name}
                            {naming && (
                                <span className="pinned-naming" title="The agent is naming the session">
                                    <Loader2 size={11} strokeWidth={2} className="spin" aria-hidden />
                                    Naming
                                </span>
                            )}
                        </span>
                    )}
                    <span className="agent-activity">
                        {home ? where : `${where} · The worktree is gone`}
                        {' · '}
                        <Age date={new Date(time).toISOString()} format="prose" title={timeTitle} />
                    </span>
                </span>
                <span className="pinned-actions">
                    <Button
                        size="sm"
                        icon={busy ? <Loader2 size={13} strokeWidth={2} className="spin" /> : <Play size={13} strokeWidth={1.8} />}
                        disabled={busy}
                        onClick={() => (home ? void resume(home) : startPicking())}
                        title={home ? `Resume in ${where}` : 'Choose a worktree for the session'}
                    >
                        {home ? 'Resume' : 'Resume in…'}
                    </Button>
                    <IconButton
                        size="sm"
                        icon={<MoreHorizontal size={14} strokeWidth={1.8} />}
                        label="More actions"
                        onClick={event => void openMenu(event.currentTarget)}
                    />
                </span>
            </div>
            {onTags && (tags.length > 0 || tagging) && (
                <TagEditor className="pinned-tags" tags={tags} allTags={allTags} onChange={onTags} autoOpen={tagging} onClose={() => setTagging(false)} />
            )}
            {detail}
            {picking && (
                <div className="pinned-picker">
                    <span className="pinned-picker-label">Resume in</span>
                    <Combobox
                        size="sm"
                        className="pinned-picker-field"
                        value={target}
                        groups={groups}
                        onChange={setTarget}
                        placeholder="Choose a worktree"
                        searchPlaceholder="Search worktrees"
                    />
                    <Button size="sm" variant="ghost" onClick={() => setPicking(false)}>
                        Cancel
                    </Button>
                    <Button
                        size="sm"
                        variant="primary"
                        disabled={!target || !places[target] || busy}
                        onClick={() => target && places[target] && void resume(places[target])}
                    >
                        Resume
                    </Button>
                </div>
            )}
        </li>
    );
}
