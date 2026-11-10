import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { helperPlist, LaunchAgent, launchAgentPath, type LaunchctlResult } from './launch-agent';
import { helperSocketPath } from './protocol';

const options = {
    label: 'dev.shipwarden.helper',
    execPath: '/Applications/ShipWarden.app/Contents/MacOS/ShipWarden',
    helperScript: '/Applications/ShipWarden.app/Contents/Resources/app.asar/out/main/helper.js',
    userData: '/Users/me/Library/Application Support/ShipWarden',
    version: '0.1.6',
    logPath: '/Users/me/Library/Application Support/ShipWarden/helper.log',
    shell: '/bin/zsh'
};

describe('helperPlist', () => {
    it('runs the helper script with the Node runtime of Electron', () => {
        const plist = helperPlist(options);
        expect(plist).toContain('<key>Label</key>\n    <string>dev.shipwarden.helper</string>');
        expect(plist).toContain(`<string>${options.execPath}</string>\n        <string>${options.helperScript}</string>\n        <string>${options.userData}</string>\n        <string>0.1.6</string>`);
        expect(plist).toContain('<key>ELECTRON_RUN_AS_NODE</key>\n        <string>1</string>');
        expect(plist).toContain('<key>SHELL</key>\n        <string>/bin/zsh</string>');
    });

    it('keeps the helper alive and does not stop the PTY host with it', () => {
        const plist = helperPlist(options);
        expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
        expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
        expect(plist).toMatch(/<key>AbandonProcessGroup<\/key>\s*<true\/>/);
        expect(plist).toMatch(/<key>ProcessType<\/key>\s*<string>Background<\/string>/);
    });

    it('escapes XML characters in paths', () => {
        const plist = helperPlist({ ...options, userData: '/Users/a&b/<x>', shell: undefined });
        expect(plist).toContain('<string>/Users/a&amp;b/&lt;x&gt;</string>');
        expect(plist).not.toContain('<key>SHELL</key>');
    });
});

describe('helperSocketPath', () => {
    it('uses the app data folder when the path is short', () => {
        expect(helperSocketPath('/Users/me/Data')).toBe('/Users/me/Data/helper-v1.sock');
    });

    it('uses the temporary folder when the path is too long', () => {
        const path = helperSocketPath(`/Users/${'x'.repeat(120)}`);
        expect(path.startsWith(tmpdir())).toBe(true);
        expect(path.endsWith('/helper-v1.sock')).toBe(true);
    });
});

describe('LaunchAgent', () => {
    let home: string | undefined;
    afterEach(() => {
        if (home) rmSync(home, { recursive: true, force: true });
        home = undefined;
    });

    function setup(loaded: boolean) {
        home = mkdtempSync(join(tmpdir(), 'shipwarden-launch-'));
        const calls: string[][] = [];
        let isLoaded = loaded;
        const agent = new LaunchAgent('dev.test.helper', {
            uid: 501,
            home,
            launchctl: async (args): Promise<LaunchctlResult> => {
                calls.push(args);
                if (args[0] === 'print') return { code: isLoaded ? 0 : 113, output: '' };
                if (args[0] === 'bootstrap') isLoaded = true;
                if (args[0] === 'bootout') isLoaded = false;
                return { code: 0, output: '' };
            }
        });
        return { agent, calls, home };
    }

    it('writes the plist and loads it in the GUI domain', async () => {
        const { agent, calls, home } = setup(false);
        await agent.install('<plist/>');
        expect(agent.plistPath).toBe(launchAgentPath('dev.test.helper', home));
        expect(readFileSync(agent.plistPath, 'utf8')).toBe('<plist/>');
        expect(calls).toContainEqual(['bootstrap', 'gui/501', agent.plistPath]);
    });

    it('does nothing when the same plist is loaded', async () => {
        const { agent, calls } = setup(false);
        await agent.install('<plist/>');
        calls.length = 0;
        await agent.install('<plist/>');
        expect(calls).toEqual([['print', 'gui/501/dev.test.helper']]);
    });

    it('loads a changed plist again', async () => {
        const { agent, calls } = setup(false);
        await agent.install('<plist/>');
        calls.length = 0;
        await agent.install('<plist version="2"/>');
        expect(calls.map(call => call[0])).toEqual(['print', 'bootout', 'bootstrap']);
    });

    it('stops the agent and removes the plist', async () => {
        const { agent, calls } = setup(false);
        await agent.install('<plist/>');
        await agent.remove();
        expect(existsSync(agent.plistPath)).toBe(false);
        expect(calls).toContainEqual(['bootout', 'gui/501/dev.test.helper']);
    });
});
