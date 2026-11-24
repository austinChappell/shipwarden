import { readFileSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';
import { exitCodeOf, type CliArgs } from '@shared/cli';
import { cliConfigPath } from '../main/cli/paths';
import { parseArgs } from './args';
import { ClientError, readConfig, sendRequest } from './client';
import { defaultSkillsFolder, installSkill, SKILL_TEXT } from './skill';

/** The version of the app that built this script. The build replaces the value. */
declare const __SHIPWARDEN_VERSION__: string | undefined;
const VERSION = typeof __SHIPWARDEN_VERSION__ === 'string' ? __SHIPWARDEN_VERSION__ : 'dev';

function print(text: string): void {
    process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

function fail(message: string, code: number): number {
    process.stderr.write(`shipwarden: ${message}\n`);
    return code;
}

/** Runs the CLI and returns the exit code. */
async function run(argv: readonly string[]): Promise<number> {
    const parsed = parseArgs(argv);
    switch (parsed.kind) {
        case 'help':
            print(parsed.text);
            return 0;
        case 'version':
            print(VERSION);
            return 0;
        case 'error':
            return fail(parsed.message, 2);
        case 'skill': {
            if (parsed.action === 'print') {
                print(SKILL_TEXT);
                return 0;
            }
            const file = await installSkill(resolve(parsed.dir ?? defaultSkillsFolder(homedir())));
            print(parsed.json ? JSON.stringify({ file }) : `Installed the skill in ${file}.`);
            return 0;
        }
        case 'request': {
            const args: CliArgs = { ...parsed.args };
            if (parsed.readStdin) args.prompt = readFileSync(0, 'utf8').trim();
            const config = await readConfig(cliConfigPath(homedir(), process.env));
            const response = await sendRequest(config, parsed.command, args, process.cwd());
            if (!response.ok) {
                if (parsed.json) print(JSON.stringify({ error: response.error }, null, 2));
                return fail(response.error.message, exitCodeOf(response.error.code));
            }
            if (parsed.json) {
                const data = { ...response.result };
                delete data.message;
                print(JSON.stringify(data, null, 2));
            } else {
                print(response.result.message ?? JSON.stringify(response.result, null, 2));
            }
            return 0;
        }
    }
}

run(process.argv.slice(2)).then(
    code => {
        process.exitCode = code;
    },
    error => {
        process.exitCode = fail(error instanceof Error ? error.message : String(error), error instanceof ClientError ? error.exitCode : 1);
    }
);
