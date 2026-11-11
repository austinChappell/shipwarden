import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Compass, X } from 'lucide-react';
import { calloutPosition, isOnScreen, spotlightRect, tourKey, tourStep, type CalloutPosition, type Rect, type Size, type TourStep } from '@shared/tour';
import { useModal } from './use-modal';

/** The number of animation frames that a step waits for its target, for example while the right panel opens. */
const TARGET_WAIT_FRAMES = 12;

function viewportSize(): Size {
    return { width: window.innerWidth, height: window.innerHeight };
}

/** Returns the place of the first element with `data-tour="<target>"` that is on the screen. */
function findTarget(target: string | undefined): Rect | undefined {
    if (!target) return undefined;
    const viewport = viewportSize();
    for (const element of document.querySelectorAll<HTMLElement>(`[data-tour="${CSS.escape(target)}"]`)) {
        const box = element.getBoundingClientRect();
        const rect = { top: box.top, left: box.left, width: box.width, height: box.height };
        if (isOnScreen(rect, viewport)) return rect;
    }
    return undefined;
}

interface Props {
    steps: readonly TourStep[];
    /** Opens the part of the window that a step needs, for example the sidebar or the right panel. */
    onPrepare(step: TourStep): void;
    /** Ends the tour. The user finished it or closed it. */
    onClose(): void;
}

/**
 * The guided tour. A callout points at a part of the window and dims the rest. When the part is not on the screen,
 * the callout shows in the center of the window, so it never points at nothing.
 * Keys: → and Enter go to the next step, ← goes back, Escape closes the tour. The focus moves into the callout, and
 * goes back to the element that had it before when the tour ends.
 */
export function Tour({ steps, onPrepare, onClose }: Props) {
    const [index, setIndex] = useState(0);
    const step = steps[index];
    const callout = useRef<HTMLDivElement>(null);
    const nextButton = useRef<HTMLButtonElement>(null);
    useModal(callout);
    const [target, setTarget] = useState<Rect>();
    const [viewport, setViewport] = useState(viewportSize);
    const [position, setPosition] = useState<CalloutPosition>();
    // The effects call the functions of the newest render.
    const prepare = useRef(onPrepare);
    prepare.current = onPrepare;
    const close = useRef(onClose);
    close.current = onClose;

    // Open the part of the window that the step needs, then find the target. A panel can need a few frames to show.
    useEffect(() => {
        if (!step) return;
        prepare.current(step);
        setTarget(undefined);
        let frames = 0;
        let request = 0;
        const find = () => {
            const rect = findTarget(step.target);
            if (rect || !step.target || frames++ >= TARGET_WAIT_FRAMES) {
                setTarget(rect);
                return;
            }
            request = requestAnimationFrame(find);
        };
        request = requestAnimationFrame(find);
        return () => cancelAnimationFrame(request);
    }, [step]);

    // A new window size moves the target and the callout.
    useEffect(() => {
        const onResize = () => {
            setViewport(viewportSize());
            setTarget(findTarget(step?.target));
        };
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, [step]);

    // The callout needs its own size for its place. Measure it after each change.
    // biome-ignore lint/correctness/useExhaustiveDependencies: A new step changes the text and thus the size of the callout.
    useLayoutEffect(() => {
        const element = callout.current;
        if (!element) return;
        const next = calloutPosition(target, { width: element.offsetWidth, height: element.offsetHeight }, viewport);
        setPosition(current => (current && current.top === next.top && current.left === next.left && current.placement === next.placement ? current : next));
    }, [target, viewport, index]);

    // The focus goes to the main button of each step, so Enter and Space continue the tour. A hidden element cannot get
    // the focus, so the focus moves after the callout has its place.
    const placed = !!position;
    // biome-ignore lint/correctness/useExhaustiveDependencies: The focus moves when the step changes.
    useEffect(() => {
        if (placed) nextButton.current?.focus();
    }, [index, placed]);

    const go = (input: 'next' | 'back' | 'close') => {
        const result = tourStep(index, steps.length, input);
        if (result === 'close') close.current();
        else setIndex(result);
    };
    const goRef = useRef(go);
    goRef.current = go;

    // The keys work wherever the focus is. Enter on a button of the callout clicks that button.
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.metaKey || event.ctrlKey || event.altKey) return;
            const input = tourKey(event.key);
            if (!input) return;
            if (event.key === 'Enter' && event.target instanceof HTMLButtonElement && callout.current?.contains(event.target)) return;
            event.preventDefault();
            event.stopPropagation();
            goRef.current(input);
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, []);

    if (!step) return null;
    const last = index === steps.length - 1;
    const spot = target && position && position.placement !== 'center' ? spotlightRect(target, viewport) : undefined;

    return (
        <div className="tour-layer">
            {spot ? <div className="tour-spotlight" style={spot} aria-hidden="true" /> : <div className="tour-backdrop" aria-hidden="true" />}
            <div
                ref={callout}
                className={`tour-callout ${position?.placement ?? 'center'}`}
                role="dialog"
                aria-modal="true"
                aria-labelledby="tour-title"
                aria-describedby="tour-body"
                style={{ top: position?.top ?? 0, left: position?.left ?? 0, visibility: position ? 'visible' : 'hidden' }}
            >
                <div className="tour-callout-header">
                    <Compass size={14} strokeWidth={1.8} aria-hidden="true" />
                    <span className="tour-progress">
                        Step {index + 1} of {steps.length}
                    </span>
                    <span className="header-spacer" />
                    <button className="icon-button" aria-label="Close the tour" title="Close the tour (Escape)" onClick={() => go('close')}>
                        <X size={14} strokeWidth={1.8} />
                    </button>
                </div>
                <div aria-live="polite">
                    <h2 id="tour-title">{step.title}</h2>
                    <p id="tour-body">{step.body}</p>
                </div>
                <div className="tour-callout-footer">
                    <span className="tour-keys" aria-hidden="true">
                        ← → move · Esc closes
                    </span>
                    <span className="header-spacer" />
                    <button className="button" onClick={() => go('back')} disabled={index === 0}>
                        Back
                    </button>
                    <button ref={nextButton} className="button primary" onClick={() => go('next')}>
                        {last ? 'Done' : 'Next'}
                    </button>
                </div>
            </div>
        </div>
    );
}

interface OfferProps {
    onStart(): void;
    onDecline(): void;
}

/** The one-time notice that offers the tour: after the welcome page, and to a user who had ShipWarden before the tour. */
export function TourOffer({ onStart, onDecline }: OfferProps) {
    return (
        <section className="update-notice tour-offer" aria-labelledby="tour-offer-title">
            <Compass size={18} strokeWidth={1.8} className="update-notice-icon" aria-hidden="true" />
            <div className="update-notice-text">
                <strong id="tour-offer-title">Take a short tour of ShipWarden?</strong>
                <span className="update-notice-detail">The tour shows the main parts of the app. It takes about a minute.</span>
            </div>
            <div className="update-notice-buttons">
                <button className="button" onClick={onDecline}>
                    No thanks
                </button>
                <button className="button primary" onClick={onStart}>
                    Take the tour
                </button>
            </div>
        </section>
    );
}
