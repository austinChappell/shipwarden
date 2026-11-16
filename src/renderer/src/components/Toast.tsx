import { useEffect, useSyncExternalStore } from 'react';
import { CircleCheck } from 'lucide-react';
import { CornerNotice } from './CornerNotice';

/** The time that a toast stays on the screen, in milliseconds. */
const TOAST_MS = 2500;

interface Toast {
    id: number;
    title: string;
    detail?: string;
}

let current: Toast | undefined;
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
    for (const listener of listeners) listener();
}

/** Shows a short message in the bottom-right corner. A new toast replaces the toast on the screen. */
export function showToast(title: string, detail?: string): void {
    current = { id: nextId++, title, detail };
    emit();
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** Shows the toast of `showToast`. It closes after a few seconds. Put one host in the page. */
export function ToastHost() {
    const toast = useSyncExternalStore(subscribe, () => current);

    useEffect(() => {
        if (!toast) return;
        const timer = setTimeout(() => {
            if (current?.id !== toast.id) return;
            current = undefined;
            emit();
        }, TOAST_MS);
        return () => clearTimeout(timer);
    }, [toast]);

    if (!toast) return null;
    return (
        <CornerNotice>
            <div key={toast.id} className="update-notice toast" role="status">
                <CircleCheck size={16} strokeWidth={1.8} className="update-notice-icon" />
                <div className="update-notice-text">
                    <strong>{toast.title}</strong>
                    {toast.detail && <span className="update-notice-detail toast-detail">{toast.detail}</span>}
                </div>
            </div>
        </CornerNotice>
    );
}
