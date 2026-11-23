/**
 * The external code editors that "Open in editor" can start: VS Code and its forks, Zed, and the JetBrains IDEs.
 * ShipWarden finds them by the name of the app in /Applications and ~/Applications.
 */

/** How ShipWarden starts an editor. Each kind has its own command line. */
export type EditorKind = 'vscode' | 'zed' | 'jetbrains';

/** An editor that the user has installed. */
export interface ExternalEditor {
    /** The path of the app, for example "/Applications/Zed.app". It is also the ID in the settings. */
    appPath: string;
    /** The name of the app without ".app", for example "Zed" or "IntelliJ IDEA CE". */
    name: string;
    kind: EditorKind;
    /** The command line program in the app, relative to the app path. Undefined for JetBrains IDEs. */
    cli?: string;
}

interface CatalogEntry {
    /** Matches the app name without ".app". */
    pattern: RegExp;
    kind: EditorKind;
    cli?: string;
}

/** The known editors. The order is the order in Settings, and the first installed editor is the default. */
const CATALOG: readonly CatalogEntry[] = [
    { pattern: /^Visual Studio Code$/, kind: 'vscode', cli: 'Contents/Resources/app/bin/code' },
    { pattern: /^Visual Studio Code - Insiders$/, kind: 'vscode', cli: 'Contents/Resources/app/bin/code-insiders' },
    { pattern: /^Cursor$/, kind: 'vscode', cli: 'Contents/Resources/app/bin/cursor' },
    { pattern: /^Windsurf$/, kind: 'vscode', cli: 'Contents/Resources/app/bin/windsurf' },
    { pattern: /^Zed( Preview)?$/, kind: 'zed', cli: 'Contents/MacOS/cli' },
    { pattern: /^IntelliJ IDEA\b/, kind: 'jetbrains' },
    { pattern: /^WebStorm\b/, kind: 'jetbrains' },
    { pattern: /^PyCharm\b/, kind: 'jetbrains' },
    { pattern: /^GoLand\b/, kind: 'jetbrains' },
    { pattern: /^PhpStorm\b/, kind: 'jetbrains' },
    { pattern: /^RubyMine\b/, kind: 'jetbrains' },
    { pattern: /^CLion\b/, kind: 'jetbrains' },
    { pattern: /^Rider\b/, kind: 'jetbrains' },
    { pattern: /^RustRover\b/, kind: 'jetbrains' },
    { pattern: /^Android Studio\b/, kind: 'jetbrains' }
];

/**
 * Returns the editors in a list of app paths, in the order of the catalog. Apps that are not editors are not in the
 * result. When two folders have an app with the same name, only the first app stays.
 */
export function editorsOf(appPaths: readonly string[]): ExternalEditor[] {
    const found: { rank: number; editor: ExternalEditor }[] = [];
    const names = new Set<string>();
    for (const appPath of appPaths) {
        const name = appPath
            .replace(/\/+$/, '')
            .split('/')
            .pop()
            ?.replace(/\.app$/, '');
        if (!name || names.has(name)) continue;
        const rank = CATALOG.findIndex(entry => entry.pattern.test(name));
        if (rank < 0) continue;
        const { kind, cli } = CATALOG[rank];
        names.add(name);
        found.push({ rank, editor: { appPath, name, kind, ...(cli ? { cli } : {}) } });
    }
    return found.sort((a, b) => a.rank - b.rank).map(item => item.editor);
}

/** Returns the editor of the settings. When that editor is not installed, returns the first installed editor. */
export function selectedEditor(editors: readonly ExternalEditor[], appPath: string | undefined): ExternalEditor | undefined {
    return editors.find(editor => editor.appPath === appPath) ?? editors[0];
}

/** The installed editors and the editor that "Open in editor" uses now. */
export interface EditorList {
    editors: ExternalEditor[];
    /** The app path of the editor in use. Undefined when no editor is installed. */
    selected?: string;
}

/** What to open: a folder, or a file in that folder, optionally at a line. All paths are absolute. */
export interface EditorTarget {
    folder: string;
    file?: string;
    /** The line of the file, from 1. */
    line?: number;
}

/** A program and its arguments. ShipWarden runs it without a shell. */
export interface EditorCommand {
    command: string;
    args: string[];
}

/**
 * Returns the command that opens the target in the editor. `hasCli` tells if the command line program of the editor
 * exists. Without it, the command uses `open -a`, and the editor ignores the line.
 * VS Code and Zed open the folder and the file in one window. A JetBrains IDE opens the file in the project that
 * contains it.
 */
export function editorCommand(editor: ExternalEditor, target: EditorTarget, hasCli: boolean): EditorCommand {
    const line = target.line && target.line > 0 ? Math.floor(target.line) : undefined;
    const fileAt = target.file && line ? `${target.file}:${line}` : target.file;
    if (editor.kind === 'jetbrains') {
        const args = target.file ? [...(line ? ['--line', String(line)] : []), target.file] : [target.folder];
        return { command: 'open', args: ['-na', editor.appPath, '--args', ...args] };
    }
    if (!editor.cli || !hasCli) {
        return { command: 'open', args: ['-a', editor.appPath, target.file ?? target.folder] };
    }
    const cli = `${editor.appPath}/${editor.cli}`;
    if (editor.kind === 'zed') {
        return { command: cli, args: fileAt ? [target.folder, fileAt] : [target.folder] };
    }
    return { command: cli, args: fileAt ? [target.folder, '--goto', fileAt] : [target.folder] };
}
