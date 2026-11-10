import type { ReactNode } from 'react';
import { CircleAlert, Download, LoaderCircle } from 'lucide-react';
import type { LspMissingServer } from '@shared/lsp';
import { lspBridge } from '../lsp/bridge';
import { missingServers, type MissingServerState } from '../lsp/missing-servers';
import { confirmDialog } from './ConfirmDialog';

/**
 * Asks the user before the install of a missing language server. ShipWarden never installs a server without consent.
 * When the user agrees, the bridge installs the server into the folder of the app.
 */
export async function installMissingServer(server: LspMissingServer): Promise<void> {
    if (!server.install) {
        return;
    }
    const agreed = await confirmDialog({
        title: `Install ${server.name}?`,
        message: `${server.install.description}\n\nShipWarden uses the certificates of Settings › Network for the download.`,
        detail: `Source: ${server.install.source}\nFolder: ${server.install.folder}`,
        confirmLabel: 'Install'
    });
    if (agreed) {
        await lspBridge.install(server.serverId);
    }
}

interface Props extends MissingServerState {
    /** The features that the server gives in this view, for the text. */
    features: string;
}

/** Tells the user that the file needs a language server that is not installed, and shows the install state. */
export function MissingServerBanner({ server, install, features }: Props) {
    const running = install?.status === 'running';
    const failed = install?.status === 'error';
    let icon = <Download size={14} strokeWidth={1.8} />;
    let text: ReactNode;
    if (running) {
        icon = <LoaderCircle size={14} strokeWidth={1.8} className="spin" />;
        const percent = install.progress === undefined ? '' : ` (${Math.round(install.progress * 100)}%)`;
        text = (
            <>
                Installing <strong>{server.name}</strong>: {install.step ?? 'Starting'}
                {percent}.
            </>
        );
    } else if (failed) {
        icon = <CircleAlert size={14} strokeWidth={1.8} />;
        text = (
            <>
                The install of <strong>{server.name}</strong> failed. <span className="editor-server-error">{install.error}</span>
            </>
        );
    } else if (server.install) {
        text = (
            <>
                Install <strong>{server.name}</strong> to get {features} in this file.
            </>
        );
    } else {
        text = (
            <>
                Install <strong>{server.name}</strong> to get {features}. {server.unavailable}
            </>
        );
    }
    return (
        <div className={`editor-server-banner${failed ? ' failed' : ''}`} role="status">
            {icon}
            <span className="editor-server-text">{text}</span>
            {!running && server.install && (
                <button className="button primary" title={server.install.source} onClick={() => void installMissingServer(server)}>
                    {failed ? 'Try again' : 'Install'}
                </button>
            )}
            {!running && (
                <button className="button" onClick={() => missingServers.dismiss(server.serverId)}>
                    Not now
                </button>
            )}
        </div>
    );
}
