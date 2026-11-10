import { describe, expect, it, vi } from 'vitest';
import type { RemoteSettings, RemoteStatus } from '@shared/remote';
import type { HelperConnection } from './helper-link';
import { HELPER_PROTOCOL } from './protocol';
import { RemoteControl, remoteOwner, type LocalRemote } from './remote-control';

const ON: RemoteSettings = { enabled: true, port: 7429, keepRunning: true };
const OFF: RemoteSettings = { enabled: true, port: 7429, keepRunning: false };

function status(running: boolean): RemoteStatus {
    return { enabled: true, running, port: 7429, hosts: [], devices: [], connected: [] };
}

/** Records the order of the events, so a test can check that the app server stops before the helper starts. */
function fakeLocal(events: string[]): LocalRemote {
    let running = false;
    return {
        apply: vi.fn(async () => {
            running = true;
            events.push('local.apply');
        }),
        status: vi.fn(async () => status(running)),
        startPairing: vi.fn(() => ({ link: 'local', expiresAt: 1 })),
        cancelPairing: vi.fn(),
        removeDevice: vi.fn(async () => undefined),
        agentsChanged: vi.fn(),
        terminalData: vi.fn(),
        terminalResized: vi.fn(),
        terminalExited: vi.fn(),
        stop: vi.fn(async () => {
            running = false;
            events.push('local.stop');
        })
    };
}

function fakeHelper(events: string[], buildId = 'build-1') {
    const closeListeners: (() => void)[] = [];
    const connection: HelperConnection = {
        hello: async () => ({ protocol: HELPER_PROTOCOL, buildId, pid: 42 }),
        apply: vi.fn(async () => {
            events.push('helper.apply');
        }),
        status: async () => status(true),
        startPairing: async () => ({ link: 'helper', expiresAt: 2 }),
        cancelPairing: async () => undefined,
        removeDevice: async () => undefined,
        terminalResized: vi.fn(),
        onClose: listener => closeListeners.push(listener),
        close: () => closeListeners.splice(0).forEach(listener => listener())
    };
    return connection;
}

function setup(options: { helperRuns: boolean; buildId?: string; installFails?: boolean }) {
    const events: string[] = [];
    let helperRuns = options.helperRuns;
    let helper: HelperConnection | undefined;
    const locals: LocalRemote[] = [];
    const agent = {
        install: vi.fn(async () => {
            if (options.installFails) throw new Error('launchctl failed');
            events.push('install');
        }),
        remove: vi.fn(async () => {
            events.push('remove');
        }),
        restart: vi.fn(async () => {
            events.push('restart');
        })
    };
    const control = new RemoteControl({
        createLocal: () => {
            const local = fakeLocal(events);
            locals.push(local);
            return local;
        },
        connectHelper: async () => {
            if (!helperRuns) return undefined;
            helper = fakeHelper(events, options.buildId);
            return helper;
        },
        agent,
        helperBuildId: 'build-1',
        onStatusChanged: () => undefined,
        retryMs: 10,
        startWaitMs: 30
    });
    return {
        control,
        events,
        agent,
        locals,
        helper: () => helper,
        startHelper: () => {
            helperRuns = true;
        },
        stopHelper: () => {
            helperRuns = false;
            helper?.close();
        }
    };
}

const until = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(check()).toBe(true);
};

describe('remoteOwner', () => {
    it('gives the server to the helper only when the setting is on and the helper answers', () => {
        expect(remoteOwner(true, true)).toBe('helper');
        expect(remoteOwner(true, false)).toBe('app');
        expect(remoteOwner(false, true)).toBe('app');
        expect(remoteOwner(false, false)).toBe('app');
    });
});

describe('RemoteControl', () => {
    it('runs the server in the app when the setting is off, and removes a launch agent', async () => {
        const { control, events, agent } = setup({ helperRuns: false });
        await control.apply(OFF);
        expect(control.owner).toBe('app');
        expect(agent.install).not.toHaveBeenCalled();
        expect(events).toEqual(['remove', 'local.apply']);
        await control.stop();
    });

    it('gives the server to a running helper', async () => {
        const { control, events } = setup({ helperRuns: true });
        await control.apply(ON);
        expect(control.owner).toBe('helper');
        expect(events).toEqual(['install', 'helper.apply']);
        expect((await control.status()).owner).toBe('helper');
        expect((await control.startPairing()).link).toBe('helper');
        await control.stop();
    });

    it('stops the server of the app before the helper gets the settings', async () => {
        const { control, events, startHelper } = setup({ helperRuns: false });
        await control.apply(OFF);
        events.length = 0;
        // The user turns the setting on. launchd starts the helper.
        startHelper();
        await control.apply(ON);
        expect(events).toEqual(['install', 'local.stop', 'helper.apply']);
        await control.stop();
    });

    it('runs the server in the app while the helper does not answer, and hands off when it answers', async () => {
        const { control, events, startHelper } = setup({ helperRuns: false });
        await control.apply(ON);
        expect(control.owner).toBe('app');
        expect(events).toEqual(['install', 'local.apply']);
        startHelper();
        await until(() => control.owner === 'helper');
        await until(() => events.includes('helper.apply'));
        expect(events.slice(-2)).toEqual(['local.stop', 'helper.apply']);
        await control.stop();
    });

    it('takes the server back when the helper stops', async () => {
        const { control, events, stopHelper, locals } = setup({ helperRuns: true });
        await control.apply(ON);
        stopHelper();
        await until(() => events.at(-1) === 'local.apply');
        expect(control.owner).toBe('app');
        // A new app server reads the paired phones again.
        expect(locals).toHaveLength(1);
        await control.stop();
    });

    it('removes the helper and runs the server in the app when the user turns the setting off', async () => {
        const { control, events } = setup({ helperRuns: true });
        await control.apply(ON);
        events.length = 0;
        await control.apply(OFF);
        expect(events).toEqual(['remove', 'local.apply']);
        expect(control.owner).toBe('app');
        await control.stop();
    });

    it('restarts a helper of another build one time', async () => {
        const { control, agent } = setup({ helperRuns: true, buildId: 'old-build' });
        await control.apply(ON);
        expect(agent.restart).toHaveBeenCalledTimes(1);
        // After the restart, the app uses the helper, so the phone works.
        await until(() => control.owner === 'helper');
        await control.stop();
    });

    it('shows the launchctl error and runs the server in the app', async () => {
        const { control } = setup({ helperRuns: false, installFails: true });
        await control.apply(ON);
        expect(control.owner).toBe('app');
        const result = await control.status();
        expect(result.helperError).toBe('launchctl failed');
        expect(result.running).toBe(true);
        await control.stop();
    });

    it('sends the terminal size to both servers', async () => {
        const { control, helper } = setup({ helperRuns: true });
        await control.apply(ON);
        control.terminalResized('a', 80, 24);
        expect(helper()?.terminalResized).toHaveBeenCalledWith('a', 80, 24);
        await control.stop();
    });
});
