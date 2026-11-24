import { CircleAlert, Mic, X } from 'lucide-react';
import { isDictationEnded } from '@shared/dictation';
import { Button, IconButton } from '../components/ui';
import { cx } from '../components/ui/cx';
import { useKeyLabel } from '../keyboard/keymap';
import { dictationStore, useDictation } from './dictation-store';

/** The number of characters of the partial text that the bar shows. The newest words are at the end. */
const PARTIAL_CHARS = 240;

/**
 * The microphone button of an agent tab. A click starts the dictation, and a second click stops it. The final text
 * goes to the chat field when the chat shows, else to the agent prompt in the terminal.
 */
export function DictationButton({ sessionId, variant = 'ghost' }: { sessionId: string; variant?: 'ghost' | 'outline' }) {
    const view = useDictation(sessionId);
    const key = useKeyLabel('dictation');
    const running = !!view && !isDictationEnded(view.state);
    const label = running ? 'Stop dictation' : 'Dictate';
    return (
        <IconButton
            className={cx('dictation-button', running && 'listening')}
            variant={variant}
            size="sm"
            active={running}
            icon={<Mic size={14} strokeWidth={1.8} />}
            label={label}
            title={key ? `${label} (${key})` : label}
            // The text field or the terminal keeps the focus, so the text goes to the cursor.
            onMouseDown={event => event.preventDefault()}
            onClick={() => dictationStore.toggle(sessionId)}
        />
    );
}

/** The text of a state of the dictation. */
function stateText(state: string): string {
    if (state === 'starting') return 'Starting dictation';
    if (state === 'stopping') return 'Inserting the text';
    return 'Listening';
}

/**
 * The bar of the dictation of an agent tab: "Listening" and the text until now, or the error. `floating` puts it at
 * the bottom of a terminal.
 */
export function DictationBar({ sessionId, floating = false }: { sessionId: string; floating?: boolean }) {
    const view = useDictation(sessionId);
    if (!view) return null;
    if (view.state === 'error') {
        return (
            <div className={cx('dictation-bar', 'error', floating && 'floating')} role="alert">
                <CircleAlert size={14} strokeWidth={1.8} className="dictation-bar-icon" />
                <span className="dictation-bar-text">{view.error}</span>
                <IconButton icon={<X size={14} strokeWidth={1.8} />} label="Close the message" onClick={() => dictationStore.cancel()} />
            </div>
        );
    }
    const partial = view.partial.length > PARTIAL_CHARS ? `…${view.partial.slice(-PARTIAL_CHARS)}` : view.partial;
    return (
        <div className={cx('dictation-bar', floating && 'floating')} role="status">
            <span className={cx('dictation-dot', view.state)} aria-hidden="true" />
            <span className="dictation-bar-state">{stateText(view.state)}</span>
            <span className="dictation-bar-text partial">
                <span>{partial}</span>
            </span>
            <Button size="sm" disabled={view.state !== 'listening'} onMouseDown={event => event.preventDefault()} onClick={() => dictationStore.stop()}>
                Done
            </Button>
            <IconButton icon={<X size={14} strokeWidth={1.8} />} label="Cancel the dictation" onClick={() => dictationStore.cancel()} />
        </div>
    );
}
