// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';

let monaco: typeof Monaco;

beforeAll(async () => {
    // Monaco reads these browser APIs when it loads.
    Object.assign(window, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
    Object.assign(document, { queryCommandSupported: () => false });
    Object.assign(globalThis, { CSS: { escape: (value: string) => value } });
    monaco = (await import('monaco-editor/editor/editor.api.js')) as unknown as typeof Monaco;
    const { registerShell } = await import('./shell');
    registerShell(monaco);
});

/** Returns the text and the token type (without ".shell") of each token, line by line. */
function tokens(source: string): [string, string][][] {
    const lines = source.split('\n');
    return monaco.editor.tokenize(source, 'shell').map((lineTokens, row) =>
        lineTokens.map((token, i) => {
            const end = i + 1 < lineTokens.length ? lineTokens[i + 1].offset : lines[row].length;
            return [lines[row].slice(token.offset, end), token.type.replace(/\.shell$/, '')] as [string, string];
        })
    );
}

/** Returns the token type of the first token with this text. */
function typeOf(source: string, text: string, line = 0): string | undefined {
    return tokens(source)[line].find(([value]) => value === text)?.[1];
}

describe('shell grammar', () => {
    it('colors the command name and its flags', () => {
        const line = 'git commit --amend -m "msg"';
        expect(typeOf(line, 'git')).toBe('function');
        expect(typeOf(line, 'commit')).toBe('');
        expect(typeOf(line, '--amend')).toBe('parameter');
        expect(typeOf(line, '-m')).toBe('parameter');
    });

    it('colors the next command after a control operator', () => {
        const line = 'cd dir && make build | tee log; echo done';
        expect(typeOf(line, 'cd')).toBe('function');
        expect(typeOf(line, 'make')).toBe('function');
        expect(typeOf(line, 'tee')).toBe('function');
        expect(typeOf(line, 'echo')).toBe('function');
        expect(typeOf(line, 'done')).toBe('');
    });

    it('colors keywords only where a command starts', () => {
        const source = 'if [ -f "$file" ]; then\n  echo if\nfi';
        expect(typeOf(source, 'if')).toBe('keyword');
        expect(typeOf(source, 'then')).toBe('keyword');
        expect(typeOf(source, 'if', 1)).toBe('');
        expect(typeOf(source, 'fi', 2)).toBe('keyword');
    });

    it('finds variables in double-quoted strings and not in single-quoted strings', () => {
        expect(typeOf('echo "Hello $name, ${greeting:-hi}"', '$name')).toBe('variable');
        expect(typeOf('echo "Hello $name, ${greeting:-hi}"', '${greeting')).toBe('variable');
        expect(typeOf("echo '$name'", '$name')).toBeUndefined();
        expect(typeOf('echo "a \\" $b"', '$b')).toBe('variable');
    });

    it('colors comments after a command', () => {
        expect(typeOf('make # build all', '# build all')).toBe('comment');
        expect(typeOf('echo a#b', '#b')).toBeUndefined();
        expect(typeOf('echo $#', '$#')).toBe('variable');
    });

    it('colors assignments and declarations', () => {
        const line = 'NAME=value cmd arg';
        expect(typeOf(line, 'NAME')).toBe('variable');
        expect(typeOf(line, 'value')).toBe('string');
        expect(typeOf(line, 'cmd')).toBe('function');
        expect(typeOf('export PATH="$HOME/bin:$PATH"', 'PATH')).toBe('variable');
        expect(typeOf('local count', 'count')).toBe('variable');
    });

    it('reads commands in command substitutions', () => {
        const line = 'files=$(ls -1 | wc -l)';
        expect(typeOf(line, 'ls')).toBe('function');
        expect(typeOf(line, 'wc')).toBe('function');
        expect(typeOf(line, '-l')).toBe('parameter');
        expect(typeOf('echo "$(date +%s) ok"', 'date')).toBe('function');
        expect(typeOf('echo "$(date +%s) ok"', ' ok"')).toBe('string');
    });

    it('colors function definitions', () => {
        expect(typeOf('deploy() {', 'deploy')).toBe('function');
        expect(typeOf('function deploy {', 'deploy')).toBe('function');
    });

    it('colors here-documents to the delimiter line', () => {
        const source = 'cat <<EOF\nHello $USER\nEOF\necho done';
        expect(typeOf(source, 'Hello ', 1)).toBe('string.heredoc');
        expect(typeOf(source, '$USER', 1)).toBe('variable');
        expect(typeOf(source, 'EOF', 2)).toBe('string.heredoc.delimiter');
        expect(typeOf(source, 'echo', 3)).toBe('function');
        const literal = "cat <<-'END'\n\t$x\n\tEND\nls";
        expect(typeOf(literal, '\t$x', 1)).toBe('string.heredoc');
        expect(typeOf(literal, 'ls', 3)).toBe('function');
    });

    it('reads case statements', () => {
        const source = 'case "$1" in\n  start|run) serve --port 80 ;;\n  *) usage ;;\nesac\nls';
        expect(typeOf(source, 'case')).toBe('keyword');
        expect(typeOf(source, 'in')).toBe('keyword');
        expect(typeOf(source, 'start', 1)).toBe('string');
        expect(typeOf(source, 'serve', 1)).toBe('function');
        expect(typeOf(source, 'usage', 2)).toBe('function');
        expect(typeOf(source, 'esac', 3)).toBe('keyword');
        expect(typeOf(source, 'ls', 4)).toBe('function');
    });

    it('keeps "&&" in a [[ test ]]', () => {
        const line = '[[ -n $a && -z $b ]] && run';
        expect(typeOf(line, '-z')).toBe('parameter');
        expect(typeOf(line, 'run')).toBe('function');
    });

    it('continues the arguments after a backslash at the end of a line', () => {
        const source = 'docker run \\\n  --rm image\nls';
        expect(typeOf(source, '--rm', 1)).toBe('parameter');
        expect(typeOf(source, 'ls', 2)).toBe('function');
    });

    it('colors for loops and arithmetic', () => {
        const source = 'for f in *.txt; do\n  (( count += 2 ))\ndone';
        expect(typeOf(source, 'f')).toBe('variable');
        expect(typeOf(source, 'in')).toBe('keyword');
        expect(typeOf(source, 'do')).toBe('keyword');
        expect(typeOf(source, 'count', 1)).toBe('variable');
        expect(typeOf(source, '2', 1)).toBe('number');
        expect(typeOf('echo $((1 + 2))', '))')).toBe('variable');
    });

    it('colors redirections', () => {
        const line = 'run 2>&1 >/dev/null';
        expect(typeOf(line, '2>&1')).toBe('operator');
        expect(typeOf(line, '>')).toBe('operator');
    });
});
