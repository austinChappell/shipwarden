import type { ReactNode } from 'react';
import { X } from 'lucide-react';

/**
 * An error message with a close button. A screen reader reads the message when it shows.
 * A click on the message also closes it.
 */
export function ErrorBanner({ className = 'error-banner', title, onClose, children }: {
    className?: string;
    title?: string;
    onClose(): void;
    children: ReactNode;
}) {
    return (
        <div className={`${className} error-closable`} role="alert" title={title} onClick={onClose}>
            <span className="error-closable-text">{children}</span>
            {/* The click goes up to the message, and the message closes. */}
            <button type="button" className="icon-button error-close" title="Close the message" aria-label="Close the message">
                <X size={13} strokeWidth={1.8} />
            </button>
        </div>
    );
}
