import { useEffect, useSyncExternalStore } from 'react';
import { Lightbulb, X } from 'lucide-react';
import { CornerNotice } from './CornerNotice';
import { Button, IconButton } from './ui';
import { INLINE_TIPS, type InlineTip as InlineTipContent, type InlineTipId, type Tip, type TipAction } from '@shared/tips';

/** The tip state that the inline tips need. App.tsx gives it. */
export interface TipsState {
    /** Returns true when the inline tip shows: the tips are on and the user did not close it. */
    shows(id: InlineTipId): boolean;
    /** Closes an inline tip for all time. */
    close(id: InlineTipId): void;
    /** Runs the action of a tip, for example opens a view or a settings section. */
    run(action: TipAction): void;
}

/** The tip state of the newest App render. A store, not a context: the inline tips are deep in the views. */
let current: TipsState = { shows: () => false, close: () => undefined, run: () => undefined };
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** Gives the tip state to the inline tips. App.tsx calls it at each render. */
export function useProvideTips(state: TipsState): void {
    useEffect(() => {
        current = state;
        for (const listener of listeners) listener();
    });
}

/**
 * A tip in a view, about a feature of that view. It shows until the user closes it. A closed tip does not show again.
 * It does not show when the user turned off the tips.
 */
interface InlineTipProps {
    id: InlineTipId;
    /** Adds side margins, for a list without its own padding. */
    inset?: boolean;
}

export function InlineTip({ id, inset = false }: InlineTipProps) {
    const tips = useSyncExternalStore(subscribe, () => current);
    if (!tips.shows(id)) return null;
    const tip: InlineTipContent = INLINE_TIPS[id];
    const titleId = `inline-tip-${id}`;
    return (
        <aside className={`inline-tip${inset ? ' inset' : ''}`} aria-labelledby={titleId}>
            <Lightbulb size={15} strokeWidth={1.8} className="inline-tip-icon" aria-hidden="true" />
            <div className="inline-tip-text">
                <strong id={titleId}>{tip.title}</strong>
                <span>{tip.body}</span>
            </div>
            {tip.action && <Button onClick={() => tips.run(tip.action!)}>{tip.action.label}</Button>}
            <IconButton
                icon={<X size={14} strokeWidth={1.8} />}
                label="Close the tip"
                title="Close the tip. It does not show again."
                onClick={() => tips.close(id)}
            />
        </aside>
    );
}

interface NoticeProps {
    tip: Tip;
    onRun(action: TipAction): void;
    onClose(): void;
    /** Turns off all tips. */
    onTurnOff(): void;
}

/** The tip notice in the bottom-right corner of the window. It shows one tip. The user can close it or turn off the tips. */
export function TipNotice({ tip, onRun, onClose, onTurnOff }: NoticeProps) {
    return (
        <CornerNotice>
            <section className="update-notice tip-notice" aria-labelledby="tip-notice-title">
                <Lightbulb size={18} strokeWidth={1.8} className="update-notice-icon" aria-hidden="true" />
                <div className="update-notice-text">
                    <span className="tip-notice-label">Tip</span>
                    <strong id="tip-notice-title">{tip.title}</strong>
                    <span className="update-notice-detail">{tip.body}</span>
                    <span className="tip-notice-buttons">
                        {tip.action && (
                            <Button
                                variant="primary"
                                onClick={() => {
                                    onRun(tip.action!);
                                    onClose();
                                }}
                            >
                                {tip.action.label}
                            </Button>
                        )}
                        <span className="header-spacer" />
                        <Button variant="link" onClick={onTurnOff}>
                            Turn off tips
                        </Button>
                    </span>
                </div>
                <IconButton icon={<X size={14} strokeWidth={1.8} />} label="Close the tip" onClick={onClose} />
            </section>
        </CornerNotice>
    );
}
