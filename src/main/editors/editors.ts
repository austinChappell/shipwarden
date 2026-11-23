import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { editorCommand, editorsOf, type EditorCommand, type EditorTarget, type ExternalEditor } from '@shared/editors';

/** The folders that ShipWarden searches for editor apps. JetBrains Toolbox puts its IDEs in ~/Applications. */
export function editorFolders(home = os.homedir()): string[] {
    return ['/Applications', '/Applications/Setapp', path.join(home, 'Applications'), path.join(home, 'Applications', 'JetBrains Toolbox')];
}

/** Returns the installed editors. A folder that does not exist gives no editors. */
export async function detectEditors(folders = editorFolders()): Promise<ExternalEditor[]> {
    const lists = await Promise.all(
        folders.map(async folder => {
            const names = await fs.readdir(folder).catch(() => [] as string[]);
            return names.filter(name => name.endsWith('.app')).map(name => path.join(folder, name));
        })
    );
    return editorsOf(lists.flat());
}

/** The time that ShipWarden waits for the editor command before it stops to wait. The command continues to run. */
const LAUNCH_WAIT_MS = 15_000;

/**
 * The environment of the editor command. The variables of Electron are removed, because the CLI of VS Code is also an
 * Electron app. VSCODE_IPC_HOOK_CLI is removed, because with it the CLI sends the request to a remote VS Code.
 */
function launchEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
        if (key.startsWith('ELECTRON_') || key === 'VSCODE_IPC_HOOK_CLI') delete env[key];
    }
    return env;
}

/** Runs the command. Rejects with the error output when the command fails. */
function run({ command, args }: EditorCommand, cwd: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, env: launchEnv(), detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr?.on('data', (chunk: Buffer) => {
            stderr = (stderr + chunk.toString()).slice(-2000);
        });
        // Some editor commands stay open while the editor starts. Do not wait for them too long.
        const timer = setTimeout(() => {
            child.unref();
            child.stderr?.destroy();
            resolve();
        }, LAUNCH_WAIT_MS);
        child.on('error', error => {
            clearTimeout(timer);
            reject(error);
        });
        child.on('exit', code => {
            clearTimeout(timer);
            if (code === 0) resolve();
            else reject(new Error(stderr.trim() || `"${path.basename(command)}" stopped with the exit code ${code}.`));
        });
    });
}

/** Opens a folder, or a file in the folder at a line, in the editor. */
export async function openInEditor(editor: ExternalEditor, target: EditorTarget): Promise<void> {
    const hasCli = editor.cli
        ? await fs.access(path.join(editor.appPath, editor.cli)).then(
              () => true,
              () => false
          )
        : false;
    await run(editorCommand(editor, target, hasCli), target.folder);
}
