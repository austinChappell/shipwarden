// A ShipWarden task plugin that keeps tasks in JSON files on this computer. It needs no account and no network.
import { execFile } from 'node:child_process';
import { promises as fs, watchFile } from 'node:fs';
import * as os from 'node:os';
import { log, runPlugin } from '../sdk/index.js';
import { createHandlers } from './handlers.js';

/** The time between two checks of a task file for changes by other processes. */
const WATCH_INTERVAL_MS = 2000;

let authorName;
/** Returns the name for new comments: the Git user name, else the user name of the computer. */
function author() {
    authorName ??= new Promise(resolve => {
        execFile('git', ['config', '--get', 'user.name'], { timeout: 5000 }, (error, stdout) => {
            const name = !error && stdout.trim();
            resolve(name || os.userInfo().username);
        });
    });
    return authorName;
}

const { handlers, files } = createHandlers({ home: os.homedir(), author });

const connection = runPlugin({
    ...handlers,
    async initialize(params) {
        const result = await handlers.initialize(params);
        for (const file of files()) {
            watch(file);
        }
        log(`Local tasks plugin ready with ${files().length} task file(s).`);
        return result;
    }
});

/** Tells ShipWarden to load the list again when a different process (for example an agent or Git) changes a task file. */
function watch(taskFile) {
    watchFile(taskFile.file, { interval: WATCH_INTERVAL_MS, persistent: false }, async (current, previous) => {
        if (current.mtimeMs === previous.mtimeMs) {
            return;
        }
        const text = await fs.readFile(taskFile.file, 'utf8').catch(() => undefined);
        if (text !== undefined && text === taskFile.lastWritten) {
            return;
        }
        connection.notify('tasks/changed', {});
    });
}
