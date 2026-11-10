import type { ConfirmRequest } from '@shared/api';

/** The options of the native dialog. It asks the question when the window has no loaded page. The second button cancels. */
export function nativeConfirmOptions(request: ConfirmRequest): Electron.MessageBoxOptions {
    return {
        type: 'warning',
        message: request.title,
        detail: request.message,
        buttons: [request.confirmLabel ?? 'OK', request.cancelLabel ?? 'Cancel'],
        defaultId: 1,
        cancelId: 1
    };
}
