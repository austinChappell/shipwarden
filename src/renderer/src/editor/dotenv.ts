import type * as Monaco from 'monaco-editor';

/**
 * Adds the "dotenv" language for env files, for example ".env", ".env.local" and "app.env".
 * Monaco has no language for these files.
 */
export function registerDotenv(monaco: typeof Monaco): void {
    monaco.languages.register({
        id: 'dotenv',
        aliases: ['Env', 'dotenv'],
        filenames: ['.env'],
        filenamePatterns: ['.env.*', '*.env']
    });
    monaco.languages.setLanguageConfiguration('dotenv', {
        comments: { lineComment: '#' },
        brackets: [['{', '}']],
        autoClosingPairs: [
            { open: '"', close: '"', notIn: ['string'] },
            { open: "'", close: "'", notIn: ['string'] },
            { open: '{', close: '}' }
        ]
    });
    monaco.languages.setMonarchTokensProvider('dotenv', {
        tokenizer: {
            root: [
                [/^\s*#.*$/, 'comment'],
                [/^\s*export\b/, 'keyword'],
                [/[A-Za-z_][\w.-]*(?=\s*=)/, 'key'],
                [/=/, 'delimiter', '@value'],
                [/\s+/, 'white']
            ],
            // The value continues to the end of the line. A double-quoted value can continue on more lines.
            // Monarch does not run the rules at the end of a line. Thus the next line removes the "value" state.
            value: [
                [/^/, '', '@pop'],
                [/"/, 'string', '@doubleQuoted'],
                [/'/, 'string', '@singleQuoted'],
                [/`/, 'string', '@backQuoted'],
                [/\s+#.*$/, 'comment', '@pop'],
                [/\$\{[^}]*\}|\$[A-Za-z_]\w*/, 'variable'],
                [/[^\s#$"'`]+|[#$]/, 'string'],
                [/\s+/, 'white']
            ],
            doubleQuoted: [
                [/[^"\\$]+/, 'string'],
                [/\\./, 'string.escape'],
                [/\$\{[^}]*\}|\$[A-Za-z_]\w*/, 'variable'],
                [/\$/, 'string'],
                [/"/, 'string', '@pop']
            ],
            singleQuoted: [
                [/[^']+/, 'string'],
                [/'/, 'string', '@pop']
            ],
            backQuoted: [
                [/[^`]+/, 'string'],
                [/`/, 'string', '@pop']
            ]
        }
    });
}
