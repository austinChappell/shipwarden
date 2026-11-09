import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
    safeStorage: {
        isAsyncEncryptionAvailable: async () => false,
        encryptStringAsync: async (value: string) => Buffer.from(value),
        decryptStringAsync: async (value: Buffer) => ({ result: value.toString(), shouldReEncrypt: false })
    }
}));

const { ReviewProviders } = await import('./review-providers');
const { PluginSettings } = await import('./tasks/plugin-settings');

const REMOTES: Record<string, string> = {
    '/work/acme': 'git@github.com:acme/api.git',
    '/work/other': 'https://github.com/other/site.git',
    '/work/shop': 'https://contoso@dev.azure.com/contoso/Web/_git/shop'
};

describe('ReviewProviders', () => {
    let folder: string;
    let legacyOwners: string[] | 'all' | undefined;
    const create = () => new ReviewProviders({
        file: join(folder, 'providers.json'),
        secretsFile: join(folder, 'secrets.json'),
        ready: Promise.resolve(),
        legacyReviewOwners: async () => legacyOwners,
        onChanged: () => undefined,
        readRemote: async root => REMOTES[root] ?? ''
    });
    /** A user with both providers, as an older version had them. */
    const createWithBoth = async () => {
        const providers = create();
        await providers.add('github', 'GitHub');
        const azure = await providers.add('azure', 'Azure DevOps');
        return { providers, azureId: azure.id };
    };

    beforeEach(async () => {
        folder = await mkdtemp(join(tmpdir(), 'review-providers-'));
        legacyOwners = undefined;
    });

    afterEach(async () => {
        await rm(folder, { recursive: true, force: true });
    });

    it('starts with no providers', async () => {
        expect(await create().list()).toEqual([]);
    });

    it('keeps the setup of an older version', async () => {
        legacyOwners = ['acme'];
        // The older version saved the Azure DevOps token with the ID "azure-devops".
        await new PluginSettings(join(folder, 'secrets.json')).save('azure-devops', [{ key: 'pat', label: 'Token', type: 'secret' }], { pat: 'secret' });
        const list = await create().list();
        expect(list.map(item => [item.id, item.kind, item.scope, item.tokenSaved])).toEqual([
            ['github', 'github', ['acme'], false],
            ['azure-devops', 'azure', undefined, true]
        ]);
    });

    it('migrates "all organizations" to a GitHub provider without a scope', async () => {
        legacyOwners = 'all';
        expect((await create().list()).map(item => [item.kind, item.scope])).toEqual([['github', undefined]]);
    });

    it('selects the provider by the kind of the remote', async () => {
        const { providers } = await createWithBoth();
        expect((await providers.for('/work/shop')).kind).toBe('azure');
        expect((await providers.for('/work/acme')).kind).toBe('github');
        expect((await providers.for({ owner: 'acme', name: 'api' })).kind).toBe('github');
    });

    it('selects the GitHub provider whose scope has the owner', async () => {
        const { providers } = await createWithBoth();
        const work = await providers.add('github', 'Work');
        await providers.update(work.id, { scope: ['acme'] });
        const fallback = await providers.for('/work/other');
        const scoped = await providers.for('/work/acme');
        expect(scoped).not.toBe(fallback);
        expect(await providers.for({ owner: 'ACME', name: 'api' })).toBe(scoped);
    });

    it('gives no branch status when no provider of the kind is on', async () => {
        const { providers, azureId } = await createWithBoth();
        await providers.update(azureId, { enabled: false });
        expect(await providers.branchStatus('/work/shop')).toBeNull();
        await expect(providers.for('/work/shop')).rejects.toThrow('No Azure DevOps provider is on');
    });

    it('removes the provider and its token', async () => {
        const { providers, azureId } = await createWithBoth();
        await providers.saveToken(azureId, 'secret');
        expect((await providers.list()).find(item => item.id === azureId)?.tokenSaved).toBe(true);
        await providers.remove(azureId);
        expect((await providers.list()).map(item => item.kind)).toEqual(['github']);
    });
});
