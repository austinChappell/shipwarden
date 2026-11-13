import { useState } from 'react';
import { CircleAlert } from 'lucide-react';
import type { LspServerCrash } from '@shared/lsp';
import { lspBridge } from '../lsp/bridge';
import { serverCrashes } from '../lsp/server-crashes';
import { Button } from './ui';

interface Props {
    crash: LspServerCrash;
}

/**
 * Tells the user that the language server of the file stopped, and shows why.
 * "Show output" shows the command and the last lines that the server wrote to stderr.
 */
export function ServerCrashBanner({ crash }: Props) {
    const [open, setOpen] = useState(false);
    return (
        <>
            <div className="editor-server-banner failed" role="alert">
                <CircleAlert size={14} strokeWidth={1.8} />
                <span className="editor-server-text">
                    <strong>{crash.name}</strong> stopped: {crash.reason}. Go to definition and hover do not work in this file.
                </span>
                <Button size="sm" onClick={() => setOpen(value => !value)}>
                    {open ? 'Hide output' : 'Show output'}
                </Button>
                <Button size="sm" onClick={() => lspBridge.retry(crash.root, crash.serverId)}>
                    Try again
                </Button>
                <Button size="sm" onClick={() => serverCrashes.dismiss(crash.serverId)}>
                    Not now
                </Button>
            </div>
            {open && <pre className="editor-server-output">{`$ ${crash.command}\n\n${crash.output || 'The server did not write to stderr.'}`}</pre>}
        </>
    );
}
