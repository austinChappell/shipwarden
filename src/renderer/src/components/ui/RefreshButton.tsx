import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { IconButton, type IconButtonProps } from './Button';
import { cx } from './cx';

/** The time of one turn of the `.spin` animation in `styles.css`. */
const TURN_MS = 1000;
/** The refresh icon looks the same after a half turn. The icon stops only at a half turn, so it does not jump. */
const STOP_STEP_MS = TURN_MS / 2;

/**
 * Returns true while the refresh icon must turn.
 * The icon starts to turn when `busy` becomes true. When `busy` becomes false, the icon turns until the next half
 * turn. It turns for one full turn minimum, so a fast refresh also shows that it ran.
 */
export function useRefreshSpin(busy: boolean): boolean {
    const [spinning, setSpinning] = useState(busy);
    const startedAt = useRef(busy ? performance.now() : 0);

    useEffect(() => {
        if (busy) {
            if (!spinning) {
                startedAt.current = performance.now();
                setSpinning(true);
            }
            return;
        }
        if (!spinning) return;
        const elapsed = performance.now() - startedAt.current;
        const end = Math.max(TURN_MS, Math.ceil(elapsed / STOP_STEP_MS) * STOP_STEP_MS);
        const timer = setTimeout(() => setSpinning(false), end - elapsed);
        return () => clearTimeout(timer);
    }, [busy, spinning]);

    return spinning;
}

export interface RefreshButtonProps extends Omit<IconButtonProps, 'icon' | 'label' | 'onClick'> {
    /** The name of the action. The default is "Refresh". */
    label?: string;
    /**
     * Loads the data again. When it returns a promise, the icon turns until the promise settles. A second click while
     * the promise is pending does nothing.
     */
    onRefresh(): unknown;
    /** True while the data loads, also when the load did not start from this button. The icon turns. */
    refreshing?: boolean;
    /** The size of the icon. The default is 16 px for "lg" and 14 px for the other sizes. */
    iconSize?: number;
    /** The stroke width of the icon. */
    iconStroke?: number;
}

/** The refresh button of the app. Use it for each refresh button, so that each one turns while it refreshes. */
export function RefreshButton({ label = 'Refresh', onRefresh, refreshing = false, iconSize, iconStroke = 1.6, size, ...rest }: RefreshButtonProps) {
    const [pending, setPending] = useState(false);
    // A click is true for one render. Thus a click starts the spin also when the refresh gives no promise and no
    // `refreshing` state.
    const [clicked, setClicked] = useState(false);
    const spinning = useRefreshSpin(refreshing || pending || clicked);

    useEffect(() => {
        if (clicked) setClicked(false);
    }, [clicked]);

    const click = () => {
        if (pending) return;
        setClicked(true);
        const result = onRefresh();
        if (result instanceof Promise) {
            setPending(true);
            result.catch(() => undefined).finally(() => setPending(false));
        }
    };

    return (
        <IconButton
            size={size}
            icon={<RefreshCw size={iconSize ?? (size === 'lg' ? 16 : 14)} strokeWidth={iconStroke} className={cx(spinning && 'spin')} />}
            label={label}
            aria-busy={spinning || undefined}
            onClick={click}
            {...rest}
        />
    );
}
