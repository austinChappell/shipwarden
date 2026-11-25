import { execFileSync } from 'child_process';
import { describe, expect, it } from 'vitest';
import { defaultRunner, runCommandLine, runInTerminal, scratchAgentPrompt } from './note-run';

describe('defaultRunner', () => {
    it('uses the program of the extension', () => {
        expect(defaultRunner('script.py')).toBe('python3');
        expect(defaultRunner('build.SH')).toBe('bash');
        expect(defaultRunner('main.go')).toBe('go run');
        expect(defaultRunner('index.ts')).toBe('node');
    });

    it('uses the shebang line before the extension', () => {
        expect(defaultRunner('tool.txt', '#!/usr/bin/env python3')).toBe('/usr/bin/env python3');
        expect(defaultRunner('tool', '#! /bin/zsh  ')).toBe('/bin/zsh');
    });

    it('returns undefined for a file that does not run', () => {
        expect(defaultRunner('todo.md')).toBeUndefined();
        expect(defaultRunner('queries.sql')).toBeUndefined();
        expect(defaultRunner('Makefile')).toBeUndefined();
        expect(defaultRunner('.env')).toBeUndefined();
    });
});

describe('runCommandLine', () => {
    it('puts the quoted path after the program', () => {
        expect(runCommandLine('python3', "/a/it's.py")).toBe(`python3 '/a/it'\\''s.py'`);
    });

    it('puts the quoted path in place of each {file} token', () => {
        expect(runCommandLine(' psql -f {file} --echo-all ', '/a/q.sql')).toBe(`psql -f '/a/q.sql' --echo-all`);
    });
});

describe('runInTerminal', () => {
    it('runs the command and shows the exit code', () => {
        const output = execFileSync('/bin/sh', ['-c', runInTerminal("echo 'hi there'; exit 3")], { encoding: 'utf8' });
        expect(output).toContain('hi there');
        expect(output).toContain('exit code 3.');
    });
});

describe('scratchAgentPrompt', () => {
    it('adds the path of the file after the request', () => {
        expect(scratchAgentPrompt(' Fix the query \n', '/n/q.sql')).toBe('Fix the query\n\nThe scratch file: /n/q.sql');
    });
});
