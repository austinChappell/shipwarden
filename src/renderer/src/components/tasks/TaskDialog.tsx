import type { ReactNode, RefObject } from 'react';
import { X } from 'lucide-react';
import { IconButton } from '../ui';
import { useModal } from '../use-modal';

interface Props {
    /** The dialog element. The view moves the focus into it after a selection with the keyboard. */
    dialogRef: RefObject<HTMLDivElement | null>;
    /** The accessible name of the dialog, for example the key and the title of the task. */
    label: string;
    /** False keeps the dialog open on Escape and on a click outside, for example while the user edits the task. */
    canClose: boolean;
    onClose(): void;
    children: ReactNode;
}

/** The details of a task in a dialog that fills most of the window. */
export function TaskDialog({ dialogRef, label, canClose, onClose, children }: Props) {
    useModal(dialogRef);
    return (
        <div className="modal-backdrop task-dialog-backdrop" onMouseDown={event => event.target === event.currentTarget && canClose && onClose()}>
            <div
                ref={dialogRef}
                className="modal task-dialog task-detail"
                role="dialog"
                aria-modal="true"
                aria-label={label}
                tabIndex={-1}
                onKeyDown={event => {
                    if (event.key === 'Escape' && canClose && !event.defaultPrevented) {
                        event.preventDefault();
                        onClose();
                    }
                }}
            >
                <IconButton className="task-dialog-close" icon={<X size={16} strokeWidth={1.75} />} label="Close" title="Close (Esc)" onClick={onClose} />
                {children}
            </div>
        </div>
    );
}
