import { describe, expect, it } from 'vitest';
import { SlackTokenStore, type SecurityRunner } from './slack-tokens';

/** A fake `security` tool with a keychain in memory. */
function fakeSecurity() {
    const items = new Map<string, string>();
    const calls: { args: string[]; input?: string }[] = [];
    const run: SecurityRunner = async (args, input) => {
        calls.push({ args, ...(input !== undefined ? { input } : {}) });
        if (args[0] === '-i' && input) {
            const match = /-s "([^"]+)" -a "([^"]+)" .* -w "([^"]+)"/.exec(input);
            if (match) items.set(`${match[1]}|${match[2]}`, match[3]);
            return '';
        }
        const key = `${args[args.indexOf('-s') + 1]}|${args[args.indexOf('-a') + 1]}`;
        if (args[0] === 'find-generic-password') return items.has(key) ? `${items.get(key)}\n` : undefined;
        if (args[0] === 'delete-generic-password') return items.delete(key) ? '' : undefined;
        return undefined;
    };
    return { run, items, calls };
}

describe('SlackTokenStore', () => {
    it('saves the tokens through standard input, not as arguments, and reads them back', async () => {
        const security = fakeSecurity();
        const store = new SlackTokenStore('/data', security.run);
        await store.save({ bot: ' xoxb-1111-2222-abcd ', app: 'xapp-1-A111-2222-ffff' });
        expect(await store.get()).toEqual({ bot: 'xoxb-1111-2222-abcd', app: 'xapp-1-A111-2222-ffff' });
        for (const call of security.calls) expect(call.args.join(' ')).not.toContain('xoxb-');
    });

    it('keeps a saved token for an empty value, and removes both tokens', async () => {
        const security = fakeSecurity();
        const store = new SlackTokenStore('/data', security.run);
        await store.save({ bot: 'xoxb-1111-2222-abcd', app: 'xapp-1-A111-2222-ffff' });
        await store.save({ bot: '', app: 'xapp-1-A111-2222-eeee' });
        expect(await store.get()).toEqual({ bot: 'xoxb-1111-2222-abcd', app: 'xapp-1-A111-2222-eeee' });
        await store.clear();
        expect(await store.get()).toEqual({});
    });

    it('refuses a value of the wrong type', async () => {
        const store = new SlackTokenStore('/data', fakeSecurity().run);
        await expect(store.save({ bot: 'xapp-1-A111-2222-ffff' })).rejects.toThrow('xoxb-');
        await expect(store.save({ app: 'xoxb-1111-2222-abcd' })).rejects.toThrow('xapp-');
        await expect(store.save({ bot: 'xoxb-1111" -w "x' })).rejects.toThrow();
    });

    it('uses different items for different app data folders', async () => {
        const security = fakeSecurity();
        await new SlackTokenStore('/data', security.run).save({ bot: 'xoxb-1111-2222-abcd' });
        expect(await new SlackTokenStore('/other', security.run).get()).toEqual({});
    });

    it('throws when the keychain does not keep the token', async () => {
        const store = new SlackTokenStore('/data', async () => undefined);
        await expect(store.save({ bot: 'xoxb-1111-2222-abcd' })).rejects.toThrow('keychain');
    });
});
