import type * as Monaco from 'monaco-editor';

/** Keywords that start a command list. The next word is a command. */
const KEYWORDS = ['if', 'then', 'elif', 'else', 'fi', 'while', 'until', 'do', 'done', 'esac', 'time', 'coproc', '!', '{', '}'];

/** Built-in commands that declare variables. The words after them can be assignments. */
const DECLARATIONS = ['export', 'local', 'declare', 'typeset', 'readonly', 'unset'];

/** Characters that end a word. */
const WORD_END = `\\s;&|()<>"'\`\\\\$`;

/**
 * The Monarch grammar for shell scripts (sh, bash and zsh).
 *
 * The built-in grammar of Monaco does not know where a command starts. It colors a word only if the word is in a
 * fixed list. It also does not find variables in double-quoted strings and finds comments only at the start of a line.
 *
 * This grammar follows the position in the command. The "root" state is the start of a command. The first word is the
 * command name. After the command name, the "args" state reads the arguments until the command ends.
 * Some states have the argument "args" (for example "dString.args"). When such a state ends, the next state is
 * "args", because the token was the command name.
 */
export const shellLanguage: Monaco.languages.IMonarchLanguage = {
    defaultToken: '',
    tokenPostfix: '.shell',
    keywords: KEYWORDS,
    declarations: DECLARATIONS,
    brackets: [
        { token: 'delimiter.bracket', open: '{', close: '}' },
        { token: 'delimiter.parenthesis', open: '(', close: ')' },
        { token: 'delimiter.square', open: '[', close: ']' }
    ],
    tokenizer: {
        // The start of a command.
        root: [
            { include: '@space' },
            [/;;&?|;&/, 'operator'],
            [/&&|\|\||\|&|[|;&!]/, 'operator'],
            [/\(\(/, { token: 'operator', next: '@arith' }],
            [/\[\[(?=\s)/, { token: 'keyword', next: '@test' }],
            [/\[(?=\s)/, { token: 'keyword', next: '@args' }],
            { include: '@redirects' },
            // A function definition, for example "name() {".
            [/([A-Za-z_][\w:.-]*)(\s*)(\(\s*\))/, ['function', 'white', 'delimiter.parenthesis']],
            [/\(/, { token: 'delimiter.parenthesis', next: '@subshell' }],
            [/[)]/, 'delimiter.parenthesis'],
            // An assignment, for example "NAME=value" or "list+=(a b)".
            [/([A-Za-z_]\w*(?:\[[^\]]*\])?)(\+?=)/, ['variable', { token: 'operator', next: '@value' }]],
            // A command name that starts with an expansion or a string.
            [/\$\(\(/, { token: 'variable', next: '@arith.args' }],
            [/\$\(/, { token: 'variable', next: '@subCommand.args' }],
            [/\$\{/, { token: 'variable', next: '@parameter.args' }],
            [/\$(?:[A-Za-z_]\w*|\d|[*@#?$!_-])/, { token: 'variable', next: '@args' }],
            [/\$'/, { token: 'string', next: '@ansiString.args' }],
            [/'/, { token: 'string', next: '@sString.args' }],
            [/"/, { token: 'string', next: '@dString.args' }],
            [/`/, { token: 'string', next: '@backtick.args' }],
            [
                new RegExp(`[^${WORD_END}#][^${WORD_END}]*`),
                {
                    cases: {
                        '@keywords': 'keyword',
                        'for|select': { token: 'keyword', next: '@forHeader' },
                        case: { token: 'keyword', next: '@caseWord' },
                        function: { token: 'keyword', next: '@functionName' },
                        '@declarations': { token: 'keyword', next: '@declaration' },
                        '@default': { token: 'function', next: '@args' }
                    }
                }
            ],
            [/\\./, { token: 'string.escape', next: '@args' }]
        ],

        // The arguments of a command. The command ends at the end of the line, or before a control operator.
        args: [
            [/^/, '', '@pop'],
            [/\\$/, 'delimiter', '@continuation'],
            { include: '@space' },
            { include: '@redirects' },
            [/(?=[;&|)`])/, '', '@pop'],
            [/\]\]?(?=[\s;&|)]|$)/, 'keyword'],
            { include: '@word' }
        ],

        // A line that continues the arguments of the line before it.
        continuation: [
            [/^\s+/, { token: 'white', switchTo: '@args' }],
            [/^/, { token: '', switchTo: '@args' }]
        ],

        // The arguments of "export", "local" and other declarations.
        declaration: [
            [/([A-Za-z_]\w*(?:\[[^\]]*\])?)(\+?=)/, ['variable', { token: 'operator', next: '@value' }]],
            [/[A-Za-z_]\w*(?=[\s;&|)]|$)/, 'variable'],
            { include: '@args' }
        ],

        // The value of an assignment. The value ends at the first space that is not in quotes.
        value: [
            [/^/, '', '@pop'],
            [/(?=[\s;&|)<>`])/, '', '@pop'],
            [/\(/, { token: 'delimiter.parenthesis', switchTo: '@array' }],
            { include: '@expansions' },
            { include: '@strings' },
            [/\\./, 'string.escape'],
            [new RegExp(`[^${WORD_END}]+`), 'string']
        ],

        // An array value, for example "(a b c)".
        array: [
            [/\)/, 'delimiter.parenthesis', '@pop'],
            { include: '@space' },
            { include: '@expansions' },
            [/\\./, 'string.escape'],
            { include: '@strings' },
            [/[[\]=]/, 'delimiter'],
            [new RegExp(`[^${WORD_END}\\[\\]=]+`), 'string']
        ],

        // A "[[ ... ]]" test. "&&", "||" and "!" do not end the command here.
        test: [
            [/\]\](?=[\s;&|)]|$)/, 'keyword', '@pop'],
            { include: '@space' },
            [/&&|\|\||!|=~|==|!=|[<>=]/, 'operator'],
            [/[()]/, 'delimiter.parenthesis'],
            { include: '@word' }
        ],

        // "for NAME in WORDS" and "select NAME in WORDS".
        forHeader: [
            [/^/, '', '@pop'],
            [/\(\(/, { token: 'operator', switchTo: '@arith' }],
            { include: '@space' },
            [/in\b/, { token: 'keyword', switchTo: '@args' }],
            [/[A-Za-z_]\w*/, 'variable'],
            [/(?=[;&|])/, '', '@pop']
        ],

        // "function NAME".
        functionName: [
            [/[ \t]+/, 'white'],
            [new RegExp(`[^${WORD_END}]+`), 'function', '@pop'],
            [/(?=.)/, '', '@pop'],
            [/^/, '', '@pop']
        ],

        // "case WORD in". The patterns come after "in".
        caseWord: [{ include: '@space' }, [/in\b/, { token: 'keyword', switchTo: '@caseBody' }], { include: '@word' }],

        // The patterns of a case statement, for example "start|restart)".
        caseBody: [
            { include: '@space' },
            [/esac\b/, 'keyword', '@pop'],
            [/[(]/, 'delimiter.parenthesis'],
            [/[)]/, { token: 'delimiter.parenthesis', next: '@caseCommand' }],
            [/\|/, 'operator'],
            { include: '@expansions' },
            { include: '@strings' },
            [/\\./, 'string.escape'],
            [new RegExp(`[^${WORD_END}]+`), 'string']
        ],

        // The commands of one case item. They end at ";;", ";&", ";;&" or "esac".
        caseCommand: [[/;;&?|;&/, 'operator', '@pop'], [/(?=esac\b)/, '', '@pop'], { include: '@root' }],

        // A subshell, for example "(cd dir && make)".
        subshell: [[/\)/, 'delimiter.parenthesis', '@pop'], { include: '@root' }],

        // A command substitution, for example "$(date)".
        subCommand: [
            [/\)/, { cases: { '$S2==args': { token: 'variable', switchTo: '@args' }, '@default': { token: 'variable', next: '@pop' } } }],
            { include: '@root' }
        ],

        // An arithmetic expression, for example "$((a + 1))" or "(( i++ ))".
        arith: [
            [
                /\)\)/,
                {
                    cases: {
                        '$S2==args': { token: 'variable', switchTo: '@args' },
                        '$S2==expansion': { token: 'variable', next: '@pop' },
                        '@default': { token: 'operator', next: '@pop' }
                    }
                }
            ],
            [/\(/, 'delimiter.parenthesis', '@arithParen'],
            { include: '@arithBody' }
        ],
        arithParen: [[/\)/, 'delimiter.parenthesis', '@pop'], [/\(/, 'delimiter.parenthesis', '@push'], { include: '@arithBody' }],
        arithBody: [
            [/\s+/, 'white'],
            { include: '@expansions' },
            [/0[xX][0-9a-fA-F]+|\d+(?:#\w+)?/, 'number'],
            [/[A-Za-z_]\w*/, 'variable'],
            [/[-+*/%<>=!&|^~?:,;]+/, 'operator'],
            [/./, '']
        ],

        // A parameter expansion, for example "${name:-default}".
        parameter: [
            [/\}/, { cases: { '$S2==args': { token: 'variable', switchTo: '@args' }, '@default': { token: 'variable', next: '@pop' } } }],
            { include: '@expansions' },
            { include: '@strings' },
            [/\\./, 'string.escape'],
            [/\w+/, 'variable'],
            [/[^\w}$"'`\\]+/, 'delimiter']
        ],

        // Strings.
        sString: [
            [/[^']+/, 'string'],
            [/'/, { cases: { '$S2==args': { token: 'string', switchTo: '@args' }, '@default': { token: 'string', next: '@pop' } } }]
        ],
        ansiString: [
            [/[^'\\]+/, 'string'],
            [/\\./, 'string.escape'],
            [/'/, { cases: { '$S2==args': { token: 'string', switchTo: '@args' }, '@default': { token: 'string', next: '@pop' } } }]
        ],
        dString: [
            [/[^"\\$`]+/, 'string'],
            [/\\./, 'string.escape'],
            [/\\$/, 'string.escape'],
            { include: '@expansions' },
            [/[$`]/, 'string'],
            [/"/, { cases: { '$S2==args': { token: 'string', switchTo: '@args' }, '@default': { token: 'string', next: '@pop' } } }]
        ],

        // A command substitution with backticks, for example "`date`". It shows the command as a string.
        backtick: [
            [/[^`\\$]+/, 'string'],
            [/\\./, 'string.escape'],
            { include: '@expansions' },
            [/\$/, 'string'],
            [/`/, { cases: { '$S2==args': { token: 'string', switchTo: '@args' }, '@default': { token: 'string', next: '@pop' } } }]
        ],

        // A here-document. The body continues to the line that has only the delimiter word.
        // The state name keeps the delimiter word, for example "heredoc.EOF".
        heredoc: [
            [/^\s*[\w-]+$/, { cases: { '$#~\\s*$S2': { token: 'string.heredoc.delimiter', next: '@pop' }, '@default': 'string.heredoc' } }],
            [/[^$`\\]+/, 'string.heredoc'],
            [/\\./, 'string.escape'],
            { include: '@expansions' },
            [/./, 'string.heredoc']
        ],
        // A here-document with a quoted delimiter, for example "<<'EOF'". The shell does not expand the body.
        heredocLiteral: [
            [/^\s*[\w-]+$/, { cases: { '$#~\\s*$S2': { token: 'string.heredoc.delimiter', next: '@pop' }, '@default': 'string.heredoc' } }],
            [/.+/, 'string.heredoc']
        ],

        // Shared rules.
        space: [
            [/\s+/, 'white'],
            [/#.*$/, 'comment']
        ],
        redirects: [
            [
                /(<<-?)(\s*)(['"])([\w-]+)(['"])/,
                ['operator', 'white', 'string.heredoc.delimiter', 'string.heredoc.delimiter', { token: 'string.heredoc.delimiter', next: '@heredocLiteral.$4' }]
            ],
            [/(<<-?)(\s*)\\?([\w-]+)/, ['operator', 'white', { token: 'string.heredoc.delimiter', next: '@heredoc.$3' }]],
            [/<<</, 'operator'],
            [/[<>]\(/, { token: 'operator', next: '@subCommand' }],
            [/\d*(?:&>>?|>>|>&|<&|<>|>\||[<>])(?:\d+-?|-)?/, 'operator']
        ],
        word: [
            [/-{1,2}[A-Za-z0-9][\w-]*/, 'parameter'],
            [/\d+(?=[\s;&|)]|$)/, 'number'],
            { include: '@expansions' },
            { include: '@strings' },
            [/\\./, 'string.escape'],
            [new RegExp(`[^${WORD_END}]+`), ''],
            [/\$/, '']
        ],
        strings: [
            [/\$'/, 'string', '@ansiString'],
            [/'/, 'string', '@sString'],
            [/"/, 'string', '@dString'],
            [/`/, 'string', '@backtick']
        ],
        expansions: [
            [/\$\(\(/, 'variable', '@arith.expansion'],
            [/\$\(/, 'variable', '@subCommand'],
            [/\$\{/, 'variable', '@parameter'],
            [/\$(?:[A-Za-z_]\w*|\d|[*@#?$!_-])/, 'variable']
        ]
    }
};

/**
 * Replaces the built-in shell grammar of Monaco and adds more file names to the language.
 * A tokens provider that is set directly takes priority over the lazy built-in grammar.
 */
export function registerShell(monaco: typeof Monaco): void {
    monaco.languages.register({
        id: 'shell',
        extensions: ['.sh', '.bash', '.zsh', '.ksh', '.command'],
        filenames: ['.bashrc', '.bash_profile', '.bash_login', '.bash_logout', '.profile', '.zshrc', '.zshenv', '.zprofile', '.zlogin', '.zlogout', '.envrc'],
        firstLine: '^#!.*\\b(?:bash|sh|zsh|ksh|dash)\\b'
    });
    monaco.languages.setMonarchTokensProvider('shell', shellLanguage);
}
