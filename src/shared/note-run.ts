import { shellQuote } from './agents';

/** The programs that run a file, by its extension in lower case. The run command adds the path of the file. */
const RUNNERS: Record<string, string> = {
    sh: 'bash',
    bash: 'bash',
    zsh: 'zsh',
    fish: 'fish',
    py: 'python3',
    js: 'node',
    mjs: 'node',
    cjs: 'node',
    // Node.js 22.18 and later removes the types of a TypeScript file before it runs the file.
    ts: 'node',
    mts: 'node',
    cts: 'node',
    rb: 'ruby',
    pl: 'perl',
    php: 'php',
    lua: 'lua',
    go: 'go run',
    swift: 'swift',
    r: 'Rscript',
    java: 'java',
    kts: 'kotlinc -script',
    exs: 'elixir',
    ex: 'elixir',
    groovy: 'groovy',
    dart: 'dart run',
    ps1: 'pwsh -File',
    applescript: 'osascript',
    scpt: 'osascript'
};

/** The token in a run command that ShipWarden replaces with the quoted path of the file. */
export const FILE_TOKEN = '{file}';

/**
 * Returns the default program that runs a file: the program of its shebang line, else the program of its extension.
 * Returns undefined when ShipWarden does not know how to run the file, for example a Markdown file.
 */
export function defaultRunner(fileName: string, firstLine = ''): string | undefined {
    const shebang = firstLine.match(/^#!\s*(\S.*?)\s*$/);
    if (shebang) return shebang[1];
    const dot = fileName.lastIndexOf('.');
    if (dot <= 0) return undefined;
    return RUNNERS[fileName.slice(dot + 1).toLowerCase()];
}

/**
 * Returns the command that runs a file in a shell. `runner` is a program ("python3") or a command with the
 * `{file}` token ("psql -f {file}"). Without the token, the path comes after the program.
 */
export function runCommandLine(runner: string, filePath: string): string {
    const quoted = shellQuote(filePath);
    const value = runner.trim();
    return value.includes(FILE_TOKEN) ? value.split(FILE_TOKEN).join(quoted) : `${value} ${quoted}`;
}

/**
 * Wraps a run command for a terminal tab. The command runs in /bin/sh, so it works with each login shell (also fish).
 * The command runs in a subshell, so an `exit` in it does not stop the script. After the command, a dim line shows the exit code, the same as the run tool of an IDE.
 */
export function runInTerminal(command: string): string {
    const script = `(\n${command}\n)\nstatus=$?\nprintf '\\n\\033[2mThe process stopped with exit code %s.\\033[0m\\n' "$status"`;
    return `/bin/sh -c ${shellQuote(script)}`;
}

/** The prompt for an agent about a scratch file: the request of the user and the path of the file. */
export function scratchAgentPrompt(request: string, filePath: string): string {
    return `${request.trim()}\n\nThe scratch file: ${filePath}`;
}

/** The start of the title of a terminal tab that runs a scratch file. */
export const RUN_TAB_PREFIX = 'Run ';

/** The title of the terminal tab that runs a scratch file. The same title finds the tab again for the next run. */
export function runTabTitle(noteName: string): string {
    return `${RUN_TAB_PREFIX}${noteName}`;
}
