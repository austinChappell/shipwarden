// Prepares the native parts of the dev setup after npm install.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;

// 1. Electron 45 downloads its binary on first use. electron-vite needs the binary before that.
// GitHub Releases sometimes answers with an error such as 504. Try again with a longer wait each time.
// The last attempts use a mirror. The electron package checks the download against its checksums.json,
// so a mirror cannot change the file. A mirror that the user sets in ELECTRON_MIRROR stays.
const ATTEMPTS = 4;
const MIRROR_FROM_ATTEMPT = 3;
const MIRROR = 'https://npmmirror.com/mirrors/electron/';
for (let attempt = 1; ; attempt++) {
    const useMirror = attempt >= MIRROR_FROM_ATTEMPT && !process.env.ELECTRON_MIRROR;
    try {
        if (useMirror) console.warn(`The Electron download uses the mirror ${MIRROR}.`);
        execFileSync(process.execPath, [join(root, 'node_modules/electron/install.js')], {
            stdio: 'inherit',
            env: useMirror ? { ...process.env, ELECTRON_MIRROR: MIRROR } : process.env
        });
        break;
    } catch (error) {
        if (attempt >= ATTEMPTS) throw error;
        const seconds = 10 * 2 ** (attempt - 1);
        console.warn(`The Electron download failed (attempt ${attempt} of ${ATTEMPTS}). The next attempt starts in ${seconds} seconds.`);
        await new Promise(resolve => setTimeout(resolve, seconds * 1000));
    }
}

// 2. npm can unpack the node-pty prebuilds without the execute bit. Without it, every terminal fails with "posix_spawnp failed".
const prebuilds = join(root, 'node_modules/node-pty/prebuilds');
if (existsSync(prebuilds)) {
    for (const platform of readdirSync(prebuilds)) {
        const helper = join(prebuilds, platform, 'spawn-helper');
        if (existsSync(helper)) {
            chmodSync(helper, 0o755);
        }
    }
}
