import { dialog, type BrowserWindow } from 'electron';

/** Shows an open dialog. With a window, the dialog is a sheet of the window. */
export function showOpenDialog(window: BrowserWindow | undefined, options: Electron.OpenDialogOptions): Promise<Electron.OpenDialogReturnValue> {
    return window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options);
}
