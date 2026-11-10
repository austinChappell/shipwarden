import type { ServerCapabilities } from 'vscode-languageserver-protocol';

/** A running language server for one worktree. */
export interface LspServerInfo {
    /** A unique key: "<server id>:<worktree root>". */
    key: string;
    serverId: string;
    root: string;
    capabilities: ServerCapabilities;
}

/** A language server that a worktree needs, but that is not installed. */
export interface LspMissingServer {
    serverId: string;
    /** The name that the UI shows, for example "rust-analyzer". */
    name: string;
    /** The shell command that installs the server. Undefined when no install tool is in the PATH. */
    installCommand?: string;
    /** The install tools that ShipWarden knows, for the case that `installCommand` is undefined. */
    tools: string[];
}

/** A notification or request from a language server that the UI must handle. */
export interface LspServerMessage {
    key: string;
    method: string;
    params: unknown;
    /** Set when the server waits for a result. The UI sends the result with `lsp.respond`. */
    id?: number;
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
    ts: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
    tsx: 'typescriptreact',
    js: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    jsx: 'javascriptreact',
    rs: 'rust',
    py: 'python',
    pyi: 'python',
    go: 'go'
};

/** Returns the LSP language ID for a file path, or undefined when no language server supports the file. */
export function lspLanguageId(path: string): string | undefined {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const dot = name.lastIndexOf('.');
    if (dot <= 0) {
        return undefined;
    }
    // Declaration files such as "index.d.ts" are TypeScript.
    return LANGUAGE_BY_EXTENSION[name.slice(dot + 1).toLowerCase()];
}

/**
 * Returns the worktree root that contains the absolute path.
 * When roots are nested, the longest root wins.
 */
export function rootForPath(roots: readonly string[], path: string): string | undefined {
    let best: string | undefined;
    for (const root of roots) {
        if ((path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`)) && (!best || root.length > best.length)) {
            best = root;
        }
    }
    return best;
}

/** A content change with its offset in the old text. */
export interface OffsetChange {
    rangeOffset: number;
}

/**
 * Sorts the changes of one edit so that the change with the largest offset comes first.
 * The changes of one edit do not overlap and use offsets in the old text.
 * A server applies them in order, so the last change must come first. Then the earlier offsets stay correct.
 */
export function sortChangesForLsp<T extends OffsetChange>(changes: readonly T[]): T[] {
    return [...changes].sort((a, b) => b.rangeOffset - a.rangeOffset);
}
