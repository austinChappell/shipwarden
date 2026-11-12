import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { CircleStop, ExternalLink, LoaderCircle, Plug } from 'lucide-react';
import { portUrl, type PortOwner } from '@shared/processes';
import { openLink } from '../links';
import { errorText } from '../util';
import { useStopPortProcess } from '../worktree-ports-query';
import { moveMenuFocus, useMenuClose } from './use-menu';
import { Chip, IconButton } from './ui';

interface Props {
    worktreePath: string;
    /** The listening ports of the worktree, in port order. The list is not empty. */
    ports: PortOwner[];
}

/** The width of the port menu in pixels. The menu moves left when it does not fit in the window. */
const MENU_WIDTH = 240;

/** The text of the port badge: the first port, and the number of the other ports. */
function badgeText(ports: PortOwner[]): string {
    return ports.length > 1 ? `:${ports[0].port} +${ports.length - 1}` : `:${ports[0].port}`;
}

/** The ports as a list for a tooltip, for example ":5173, :3000". */
export function portList(ports: { port: number }[]): string {
    return ports.map(item => `:${item.port}`).join(', ');
}

/**
 * The port badge of a worktree row in the sidebar, and its stop button.
 * - One port: a click on the badge opens the port. The stop button stops the process of the port.
 * - More ports: a click on the badge opens a menu. Each port in the menu has an open item and a stop item.
 *   The stop button stops the processes of all ports.
 * The clicks do not select the worktree.
 */
export function WorktreePorts({ worktreePath, ports }: Props) {
    const [open, setOpen] = useState(false);
    const [place, setPlace] = useState<{ top: number; left: number }>();
    const [stopping, setStopping] = useState<ReadonlySet<number>>(new Set());
    const [error, setError] = useState<string>();
    const root = useRef<HTMLSpanElement>(null);
    const stopMutation = useStopPortProcess();
    const multi = ports.length > 1;
    const pids = [...new Set(ports.map(item => item.pid))];
    const busy = pids.some(pid => stopping.has(pid));

    useMenuClose(open, root, () => setOpen(false));
    useEffect(() => {
        if (open) root.current?.querySelector<HTMLElement>('.port-menu [role="menuitem"]')?.focus();
    }, [open]);
    // The menu closes when the last port goes away.
    useEffect(() => {
        if (!multi) setOpen(false);
    }, [multi]);

    const stop = async (list: number[]) => {
        setError(undefined);
        setStopping(set => new Set([...set, ...list]));
        try {
            for (const pid of list) await stopMutation.mutateAsync({ worktreePath, pid });
        } catch (err) {
            setError(errorText(err));
        } finally {
            setStopping(set => new Set([...set].filter(pid => !list.includes(pid))));
        }
    };

    // The sidebar must not get the keys of the badge and the menu, for example the arrow keys. Escape must go to the window, because it closes the menu.
    const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
        if (event.key !== 'Escape') event.stopPropagation();
    };

    const onBadge = (event: MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        if (!multi) {
            openLink(portUrl(ports[0]), event);
            return;
        }
        const rect = event.currentTarget.getBoundingClientRect();
        setPlace({ top: rect.bottom + 4, left: Math.max(8, Math.min(rect.left, window.innerWidth - MENU_WIDTH - 8)) });
        setOpen(value => !value);
    };

    const badgeTitle = multi
        ? `Processes listen on ${portList(ports)}. Click to open or stop a port.`
        : `Open ${portUrl(ports[0])} in the browser (⇧⌘-click: in ShipWarden). ${ports[0].name} listens on this port.`;
    const stopTitle = error
        ? `The stop failed: ${error}`
        : multi
          ? `Stop the processes that listen on ${portList(ports)}`
          : `Stop ${ports[0].name} (PID ${ports[0].pid}), which listens on :${ports[0].port}`;

    return (
        <span ref={root} className="worktree-ports-group" onClick={event => event.stopPropagation()} onKeyDown={onKeyDown}>
            <button
                className="worktree-ports"
                title={badgeTitle}
                aria-haspopup={multi ? 'menu' : undefined}
                aria-expanded={multi ? open : undefined}
                onClick={onBadge}
            >
                <Chip tone="info" mono icon={<Plug size={12} strokeWidth={2} aria-hidden="true" />}>
                    {badgeText(ports)}
                </Chip>
            </button>
            <button
                className={`icon-button row-action worktree-port-stop${busy ? ' busy' : ''}${error ? ' failed' : ''}`}
                title={stopTitle}
                aria-label={stopTitle}
                disabled={busy}
                onClick={() => void stop(pids)}
            >
                {busy ? <LoaderCircle size={12} className="spin" /> : <CircleStop size={13} strokeWidth={1.7} />}
            </button>
            {open && place && (
                <div
                    className="port-menu"
                    role="menu"
                    style={{ top: place.top, left: place.left, width: MENU_WIDTH }}
                    onKeyDown={event =>
                        moveMenuFocus(event, [...(root.current?.querySelectorAll<HTMLElement>('.port-menu [role="menuitem"]:not(:disabled)') ?? [])])
                    }
                >
                    {ports.map(item => (
                        <div key={item.port} className="port-menu-row">
                            <button
                                className="port-menu-open"
                                role="menuitem"
                                title={`Open ${portUrl(item)} in the browser (⇧⌘-click: in ShipWarden)`}
                                onClick={event => {
                                    if (openLink(portUrl(item), event)) setOpen(false);
                                }}
                            >
                                <span className="port-menu-port">localhost:{item.port}</span>
                                <span className="port-menu-name">{item.name}</span>
                                <ExternalLink size={11} strokeWidth={1.8} />
                            </button>
                            <IconButton
                                size="sm"
                                tone="danger"
                                className="port-menu-stop"
                                role="menuitem"
                                icon={stopping.has(item.pid) ? <LoaderCircle size={12} className="spin" /> : <CircleStop size={13} strokeWidth={1.7} />}
                                label={`Stop ${item.name}, which listens on :${item.port}`}
                                title={`Stop ${item.name} (PID ${item.pid}), which listens on :${item.port}`}
                                disabled={stopping.has(item.pid)}
                                onClick={() => void stop([item.pid])}
                            />
                        </div>
                    ))}
                    {error && <div className="port-menu-error">The stop failed: {error}</div>}
                </div>
            )}
        </span>
    );
}
