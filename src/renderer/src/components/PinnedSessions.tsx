import { useMemo, useState } from 'react';
import { Loader2, MoreHorizontal, Pin, Play } from 'lucide-react';
import type { PinnedSession } from '@shared/pinned-sessions';
import type { Worktree } from '@shared/worktrees';
import { renamePin, unpinSession } from '../terminal/pinned-sessions';
import { showContextMenu } from './ContextMenu';
import { showToast } from './Toast';
import { Age, Button, Combobox, IconButton, Input, sortedGroups } from './ui';

/** A worktree that can get a resumed session. */
export interface ResumePlace {
    repo: string;
    worktree: Worktree;
}

interface Props {
    pins: PinnedSession[];
    /** The worktrees of all projects, by worktree path. */
    places: Record<string, ResumePlace>;
    /** The worktree that the app shows now. The picker selects it first when the worktree of the session is gone. */
    selectedPath: string | undefined;
    repoLabel(repo: string): string;
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
export function PinnedSessions({ pins, places, selectedPath, repoLabel, onResume }: Props) {
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
                    <PinnedRow key={pin.id} pin={pin} places={places} selectedPath={selectedPath} repoLabel={repoLabel} onResume={onResume} />
                ))}
            </ul>
        </section>
    );
}

function PinnedRow({ pin, places, selectedPath, repoLabel, onResume }: Omit<Props, 'pins'> & { pin: PinnedSession }) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(pin.name);
    const [picking, setPicking] = useState(false);
    const [target, setTarget] = useState<string | undefined>();
    const [busy, setBusy] = useState(false);

    const home = places[pin.cwd];
    const where = home
        ? `${repoLabel(home.repo)} · ${home.worktree.branch ?? home.worktree.path.split('/').pop()}`
        : [pin.repoPath && repoLabel(pin.repoPath), pin.branch].filter(Boolean).join(' · ') || pin.cwd;

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
            await onResume(pin, place);
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
        const name = draft.trim();
        setEditing(false);
        if (!name || name === pin.name) return;
        try {
            await renamePin(pin.id, name);
        } catch (error) {
            showToast('The name did not change', errorText(error));
        }
    };

    const openMenu = async (anchor: Element) => {
        const choice = await showContextMenu(
            [
                { id: 'resume-in', label: 'Resume in another worktree…' },
                { type: 'separator' },
                { id: 'rename', label: 'Rename' },
                { type: 'separator' },
                { id: 'unpin', label: 'Unpin', danger: true }
            ],
            anchor
        );
        if (choice === 'resume-in') startPicking();
        else if (choice === 'rename') {
            setDraft(pin.name);
            setEditing(true);
        } else if (choice === 'unpin') {
            unpinSession(pin.id).catch(error => showToast('The pin did not go', errorText(error)));
        }
    };

    const pinnedAt = new Date(pin.resumedAt ?? pin.pinnedAt).toISOString();

    return (
        <li className="pinned-row">
            <div className="pinned-line">
                <Pin size={13} strokeWidth={1.8} className="pinned-icon" aria-hidden />
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
                        <span className="agent-name" title={pin.name}>
                            {pin.name}
                            {pin.naming && (
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
                        <Age date={pinnedAt} format="prose" title={pin.resumedAt ? 'Last resume' : 'Pinned'} />
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
