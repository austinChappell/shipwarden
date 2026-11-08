// Prepares the native parts of the dev setup after npm install.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;

// 1. Electron 45 downloads its binary on first use. electron-vite needs the binary before that.
execFileSync(process.execPath, [join(root, 'node_modules/electron/install.js')], { stdio: 'inherit' });

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
