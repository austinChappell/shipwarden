import { execFile } from 'child_process';

const MARKER = '__SHIPWARDEN_PATH__';
const CA_MARKER = '__SHIPWARDEN_CA__';

/** NODE_EXTRA_CA_CERTS of the login shell. An app that starts from Finder does not get it in its own environment. */
let shellCaFile: string | undefined = process.env.NODE_EXTRA_CA_CERTS || undefined;

/** Returns NODE_EXTRA_CA_CERTS of the login shell (or of this process), after `loadLoginShellPath`. */
export function loginShellCaFile(): string | undefined {
    return shellCaFile;
}

/** Merges two PATH values. The entries of `first` come first. The function removes duplicates. */
export function mergePath(first: string, second: string): string {
    const entries = [...first.split(':'), ...second.split(':')].filter(Boolean);
    return [...new Set(entries)].join(':');
}

/** Finds the PATH value between the markers. Shell startup files can print other text before it. */
export function extractMarkedPath(output: string, marker = MARKER): string | undefined {
    const start = output.indexOf(marker);
    const end = output.indexOf(marker, start + marker.length);
    return start === -1 || end === -1 ? undefined : output.slice(start + marker.length, end);
}

/**
 * Adds the PATH of the user's login shell to this process, and reads NODE_EXTRA_CA_CERTS of the login shell.
 * An app that starts from Finder gets only a minimal PATH. Language servers such as rust-analyzer
 * are often in folders that only the shell startup files add, for example ~/.cargo/bin.
 */
export function loadLoginShellPath(): Promise<void> {
    const shell = process.env.SHELL || '/bin/zsh';
    return new Promise(resolve => {
        const script = `printf '${MARKER}%s${MARKER}${CA_MARKER}%s${CA_MARKER}' "$PATH" "$NODE_EXTRA_CA_CERTS"`;
        execFile(shell, ['-l', '-i', '-c', script], { timeout: 5000 }, (_error, stdout) => {
            const loginPath = extractMarkedPath(stdout ?? '');
            if (loginPath) {
                process.env.PATH = mergePath(loginPath, process.env.PATH ?? '');
            }
            shellCaFile = extractMarkedPath(stdout ?? '', CA_MARKER)?.trim() || shellCaFile;
            resolve();
        });
    });
}
