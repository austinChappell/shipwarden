import type { CliArgs, CliCommand } from '@shared/cli';

/** A command of the CLI: its words, the request that it sends, and its help. */
interface CommandSpec {
    words: string;
    command: CliCommand;
    /** The name of the value that the positional words give. */
    positional?: string;
    /** True when the positional value is required. */
    required?: boolean;
    /** The flags with a value. */
    values?: string[];
    /** The flags without a value. */
    switches?: string[];
    usage: string;
    summary: string;
}

const COMMANDS: readonly CommandSpec[] = [
    { words: 'status', command: 'status', usage: 'status', summary: 'Show the app, the current worktree, and the agents.' },
    {
        words: 'worktree list',
        command: 'worktree.list',
        switches: ['all'],
        usage: 'worktree list [--all]',
        summary: 'List the worktrees of the current repository, or of all projects.'
    },
    {
        words: 'worktree create',
        command: 'worktree.create',
        positional: 'branch',
        required: true,
        values: ['repo', 'base', 'agent', 'prompt', 'timeout'],
        switches: ['wait'],
        usage: 'worktree create <branch> [--repo <path>] [--base <ref>] [--agent <id>] [--prompt <text>] [--wait]',
        summary: 'Create a worktree. With --prompt, an agent starts in it. --wait waits for its turn.'
    },
    {
        words: 'worktree remove',
        command: 'worktree.remove',
        positional: 'worktree',
        required: true,
        switches: ['delete-branch'],
        usage: 'worktree remove <worktree> [--delete-branch]',
        summary: 'Remove a worktree. A worktree with uncommitted changes stays.'
    },
    {
        words: 'agent start',
        command: 'agent.start',
        values: ['worktree', 'agent', 'prompt', 'timeout'],
        switches: ['wait'],
        usage: 'agent start [--worktree <worktree>] [--agent <id>] [--prompt <text>] [--wait]',
        summary: 'Start a new agent tab in a worktree. --wait waits for the turn of the prompt.'
    },
    {
        words: 'agent send',
        command: 'agent.send',
        positional: 'prompt',
        required: true,
        values: ['worktree', 'timeout'],
        switches: ['wait'],
        usage: 'agent send <prompt | -> [--worktree <worktree>] [--wait] [--timeout <seconds>]',
        summary: 'Send a prompt to the agent of a worktree. "-" reads the prompt from stdin. --wait waits for the turn.'
    },
    {
        words: 'agent wait',
        command: 'agent.wait',
        values: ['worktree', 'timeout'],
        usage: 'agent wait [--worktree <worktree>] [--timeout <seconds>]',
        summary: 'Wait until the agents of a worktree finish their turn.'
    },
    { words: 'task get', command: 'task.get', values: ['worktree'], usage: 'task get [--worktree <worktree>]', summary: 'Show the task of a worktree.' },
    {
        words: 'task status',
        command: 'task.status',
        positional: 'status',
        required: true,
        values: ['worktree'],
        usage: 'task status <status> [--worktree <worktree>]',
        summary: 'Move the task of a worktree to a status.'
    },
    { words: 'automation list', command: 'automation.list', usage: 'automation list', summary: 'List the automations.' },
    {
        words: 'automation run',
        command: 'automation.run',
        positional: 'automation',
        required: true,
        values: ['worktree'],
        usage: 'automation run <id> [--worktree <worktree>]',
        summary: 'Run an automation now.'
    }
];

/** The result of the parse. */
export type ParsedArgs =
    | { kind: 'help'; text: string }
    | { kind: 'version' }
    | { kind: 'error'; message: string }
    | { kind: 'skill'; action: 'print' | 'install'; dir?: string; json: boolean }
    | { kind: 'request'; command: CliCommand; args: CliArgs; json: boolean; readStdin: boolean };

/** The text of `shipwarden help`. */
export function helpText(): string {
    const entry = (usage: string, summary: string) => `  shipwarden ${usage}\n      ${summary}`;
    return [
        'Control ShipWarden from a terminal. ShipWarden must be open.',
        '',
        'Commands:',
        ...COMMANDS.map(spec => entry(spec.usage, spec.summary)),
        entry('skill [install [--dir <folder>]]', 'Print the agent skill file, or install it (default: ~/.claude/skills).'),
        '',
        'Options:',
        '  --json      Print the result as JSON.',
        '  --help      Show this help.',
        '  --version   Show the version of the CLI.',
        '',
        'A <worktree> is a path, a branch, or a name. Without --worktree, the command uses the worktree of the working folder.',
        'The commands that change something ask for your approval in ShipWarden the first time in each worktree.'
    ].join('\n');
}

function camel(name: string): string {
    return name.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

/** The flags that take a value, for all commands. The next word is the value, unless the flag has "=". */
const VALUE_FLAGS = new Set(['dir', ...COMMANDS.flatMap(spec => spec.values ?? [])]);

/** Parses the words after `shipwarden`. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
    const words: string[] = [];
    const flags = new Map<string, string | true>();
    for (let index = 0; index < argv.length; index += 1) {
        const word = argv[index];
        if (word === '--') {
            words.push(...argv.slice(index + 1));
            break;
        }
        if (word === '-h') {
            flags.set('help', true);
        } else if (word === '-v') {
            flags.set('version', true);
        } else if (word.startsWith('--') && word.length > 2) {
            const equals = word.indexOf('=');
            const name = equals > 0 ? word.slice(2, equals) : word.slice(2);
            if (equals > 0) {
                flags.set(name, word.slice(equals + 1));
            } else if (VALUE_FLAGS.has(name)) {
                const next = argv[index + 1];
                if (next === undefined || (next.startsWith('--') && next.length > 2)) return { kind: 'error', message: `Give a value after --${name}.` };
                flags.set(name, next);
                index += 1;
            } else {
                flags.set(name, true);
            }
        } else {
            words.push(word);
        }
    }
    const json = flags.get('json') === true;
    if (flags.get('version') === true) return { kind: 'version' };
    if (words.length === 0 || words[0] === 'help' || flags.get('help') === true) return { kind: 'help', text: helpText() };

    if (words[0] === 'skill') {
        const action = words[1] ?? 'print';
        if (action !== 'print' && action !== 'install') return { kind: 'error', message: `Unknown skill command "${action}". Use "skill" or "skill install".` };
        const dir = flags.get('dir');
        return { kind: 'skill', action, ...(typeof dir === 'string' ? { dir } : {}), json };
    }

    const spec = COMMANDS.find(item => item.words === words.slice(0, 2).join(' ')) ?? COMMANDS.find(item => item.words === words[0]);
    if (!spec) return { kind: 'error', message: `Unknown command "${words.slice(0, 2).join(' ')}". Run "shipwarden help".` };
    const args: CliArgs = {};
    for (const [name, value] of flags) {
        if (name === 'json' || name === 'help') continue;
        if (spec.switches?.includes(name)) {
            if (value !== true) return { kind: 'error', message: `The option --${name} takes no value.` };
            args[camel(name)] = true;
        } else if (spec.values?.includes(name) && typeof value === 'string') {
            args[camel(name)] = value;
        } else {
            return { kind: 'error', message: `Unknown option --${name} for "${spec.words}". Usage: shipwarden ${spec.usage}` };
        }
    }
    const positional = words.slice(spec.words.split(' ').length);
    if (spec.positional) {
        const value = positional.join(' ');
        if (spec.required && !value) return { kind: 'error', message: `Usage: shipwarden ${spec.usage}` };
        if (value) args[spec.positional] = value;
    } else if (positional.length > 0) {
        return { kind: 'error', message: `"${spec.words}" takes no value "${positional[0]}". Usage: shipwarden ${spec.usage}` };
    }
    if (typeof args.timeout === 'string') {
        const seconds = Number(args.timeout);
        if (!Number.isFinite(seconds) || seconds <= 0) return { kind: 'error', message: 'The value of --timeout must be a number of seconds.' };
        args.timeout = seconds;
    }
    const readStdin = spec.command === 'agent.send' && args.prompt === '-';
    return { kind: 'request', command: spec.command, args, json, readStdin };
}
