import { dialog, type BrowserWindow } from 'electron';
import { IpcChannels, type ConfirmRequest } from '@shared/api';
import { nativeConfirmOptions } from './confirm-options';

/**
 * Asks the user a question in the dialog of the page, so it has the style of the app. Without a loaded window,
 * a native dialog asks.
 */
export class ConfirmDialogs {
    private counter = 0;
    private readonly answers = new Map<number, (confirmed: boolean) => void>();

    constructor(private readonly window: () => BrowserWindow | undefined) {}

    async ask(request: ConfirmRequest): Promise<boolean> {
        const window = this.window();
        if (!window || window.isDestroyed() || window.webContents.isLoading()) {
            return (await dialog.showMessageBox(nativeConfirmOptions(request))).response === 0;
        }
        if (window.isMinimized()) window.restore();
        window.show();
        this.counter += 1;
        const id = this.counter;
        return new Promise(resolve => {
            const done = (confirmed: boolean) => {
                this.answers.delete(id);
                window.removeListener('closed', onClosed);
                resolve(confirmed);
            };
            // A closed window gives no answer. That is "no".
            const onClosed = () => done(false);
            window.once('closed', onClosed);
            this.answers.set(id, done);
            window.webContents.send(IpcChannels.appConfirmRequest, id, request);
        });
    }

    /** Gives the answer of the page to the question with this id. It ignores an unknown id. */
    answer(id: number, confirmed: boolean): void {
        this.answers.get(id)?.(confirmed);
    }
}
