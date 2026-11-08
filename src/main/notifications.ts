import { Notification } from 'electron';
import { spawn } from 'child_process';
import { NOTIFICATION_SOUNDS } from '@shared/notifications';
import type { NotificationRequest, NotificationTarget } from '@shared/api';

/**
 * Shows macOS notifications. Electron can play a named macOS sound with a notification, which the web Notification
 * of the page cannot. A click calls `onClick` with the target, so the app can show the right place.
 */
export class NotificationService {
    /** Open notifications. Without a reference, a notification can lose its click handler. */
    private readonly open = new Set<Notification>();

    constructor(private readonly onClick: (target: NotificationTarget | undefined) => void) {}

    show(request: NotificationRequest): void {
        if (!Notification.isSupported()) return;
        const sound = request.sound && NOTIFICATION_SOUNDS.includes(request.sound) ? request.sound : undefined;
        const notification = new Notification({
            title: String(request.title).slice(0, 200),
            body: String(request.body ?? '').slice(0, 400),
            silent: !sound,
            ...(sound ? { sound } : {})
        });
        this.open.add(notification);
        const forget = () => this.open.delete(notification);
        notification.on('click', () => {
            forget();
            this.onClick(request.target);
        });
        notification.on('close', forget);
        // macOS keeps old notifications in the Notification Center. After one hour, a click does nothing.
        setTimeout(forget, 60 * 60 * 1000);
        notification.show();
    }

    /** Plays a macOS sound, for the preview in the settings. */
    playSound(name: string): void {
        if (NOTIFICATION_SOUNDS.includes(name)) {
            spawn('afplay', [`/System/Library/Sounds/${name}.aiff`], { stdio: 'ignore' }).on('error', () => undefined);
        }
    }
}
