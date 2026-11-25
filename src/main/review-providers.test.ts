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
    '/work/shop': 'https://contoso@dev.azure.com/contoso/Web/_git/shop',
    '/work/lab': 'git@gitlab.com:acme/platform/api.git',
    '/work/self': 'https://git.example.com/team/sub/web.git',
    '/work/bucket': 'git@bitbucket.org:acme/api.git',
    '/work/bucket-https': 'https://dana@bitbucket.org/partner/site.git',
    '/work/tea': 'git@git.acme.dev:acme/api.git',
    '/work/berg': 'https://codeberg.org/dana/notes.git'
};

describe('ReviewProviders', () => {
    let folder: string;
    let legacyOwners: string[] | 'all' | undefined;
    let projectRepos: string[] = [];
    const probed: string[] = [];
    const create = () =>
        new ReviewProviders({
            file: join(folder, 'providers.json'),
            secretsFile: join(folder, 'secrets.json'),
            ready: Promise.resolve(),
            legacyReviewOwners: async () => legacyOwners,
            onChanged: () => undefined,
            readRemote: async root => REMOTES[root] ?? '',
            projectRepos: async () => projectRepos,
            probeGitea: async url => {
                probed.push(url);
                return url === 'https://git.acme.dev';
            }
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
        projectRepos = [];
        probed.length = 0;
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

    it('sends an Azure reference of the Review view to the Azure DevOps provider', async () => {
        const { providers } = await createWithBoth();
        expect((await providers.for({ owner: 'contoso/Web', name: 'shop', host: 'azure' })).kind).toBe('azure');
    });

    it('finds the repository of a worktree on each host', async () => {
        const providers = create();
        expect(await providers.repoFor('/work/shop')).toEqual({ owner: 'contoso/Web', name: 'shop', host: 'azure' });
        expect(await providers.repoFor('/work/acme')).toEqual({ owner: 'acme', name: 'api' });
        expect(await providers.repoFor('/work/none')).toBeNull();
        // The task plugins read only GitHub repositories.
        expect(await providers.githubRepoFor('/work/shop')).toBeNull();
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

    it('finds GitLab projects with subgroups on gitlab.com and on a configured server', async () => {
        const providers = create();
        expect(await providers.repoFor('/work/lab')).toEqual({ owner: 'gitlab.com/acme/platform', name: 'api', host: 'gitlab' });
        // Without a provider for git.example.com, ShipWarden does not know that the server is a GitLab server.
        expect(await providers.repoFor('/work/self')).toBeNull();
        const self = await providers.add('gitlab', 'Work GitLab');
        await providers.update(self.id, { baseUrl: 'git.example.com/' });
        expect((await providers.list()).find(item => item.id === self.id)?.baseUrl).toBe('https://git.example.com');
        expect(await create().repoFor('/work/self')).toEqual({ owner: 'git.example.com/team/sub', name: 'web', host: 'gitlab' });
    });

    it('selects the GitLab provider of the server of the remote', async () => {
        const providers = create();
        await providers.add('github', 'GitHub');
        const cloud = await providers.add('gitlab', 'GitLab');
        const self = await providers.add('gitlab', 'Work GitLab');
        await providers.update(self.id, { baseUrl: 'https://git.example.com' });
        const fromCloud = await providers.for('/work/lab');
        const fromSelf = await providers.for('/work/self');
        expect(fromCloud.kind).toBe('gitlab');
        expect(fromSelf.kind).toBe('gitlab');
        expect(fromSelf).not.toBe(fromCloud);
        expect(await providers.for({ owner: 'gitlab.com/acme/platform', name: 'api', host: 'gitlab' })).toBe(fromCloud);
        expect(await providers.for({ owner: 'git.example.com/team', name: 'web', host: 'gitlab' })).toBe(fromSelf);
        await providers.update(cloud.id, { enabled: false });
        await expect(providers.for('/work/lab')).rejects.toThrow('No GitLab provider for gitlab.com is on');
    });

    it('refuses a server URL that is not a URL', async () => {
        const providers = create();
        const lab = await providers.add('gitlab', 'GitLab');
        await expect(providers.update(lab.id, { baseUrl: 'ftp://example.com' })).rejects.toThrow('is not a valid URL');
        await providers.update(lab.id, { baseUrl: null });
        expect((await providers.list())[0].baseUrl).toBeUndefined();
    });

    it('finds Bitbucket repositories and selects the Bitbucket provider of the workspace', async () => {
        const providers = create();
        expect(await providers.repoFor('/work/bucket')).toEqual({ owner: 'acme', name: 'api', host: 'bitbucket' });
        expect(await providers.repoFor('/work/bucket-https')).toEqual({ owner: 'partner', name: 'site', host: 'bitbucket' });
        await expect(providers.for('/work/bucket')).rejects.toThrow('No Bitbucket provider is on');
        await providers.add('github', 'GitHub');
        const work = await providers.add('bitbucket', 'Work Bitbucket');
        const partner = await providers.add('bitbucket', 'Partner');
        await providers.update(work.id, { scope: ['acme'] });
        await providers.update(partner.id, { scope: ['partner'] });
        const fromWork = await providers.for('/work/bucket');
        expect(fromWork.kind).toBe('bitbucket');
        expect(await providers.for('/work/bucket-https')).not.toBe(fromWork);
        expect(await providers.for({ owner: 'acme', name: 'api', host: 'bitbucket' })).toBe(fromWork);
    });

    it('keeps the username of a Bitbucket provider and resets the token source after a change', async () => {
        const providers = create();
        const bucket = await providers.add('bitbucket', 'Bitbucket');
        await providers.update(bucket.id, { username: '  dana@example.com ' });
        expect((await providers.list())[0].username).toBe('dana@example.com');
        await providers.saveToken(bucket.id, 'ATATT-1');
        expect(await providers.tokenSource(bucket.id)).toBe('saved');
        await providers.update(bucket.id, { username: null });
        expect((await providers.list())[0].username).toBeUndefined();
        // A username on a provider of another kind does nothing.
        const github = await providers.add('github', 'GitHub');
        await providers.update(github.id, { username: 'x' });
        expect((await providers.list()).find(item => item.id === github.id)?.username).toBeUndefined();
    });

    it('removes the provider and its token', async () => {
        const { providers, azureId } = await createWithBoth();
        await providers.saveToken(azureId, 'secret');
        expect((await providers.list()).find(item => item.id === azureId)?.tokenSaved).toBe(true);
        await providers.remove(azureId);
        expect((await providers.list()).map(item => item.kind)).toEqual(['github']);
    });
    it('finds the server of a new Gitea provider from the remotes of the projects', async () => {
        projectRepos = ['/work/acme', '/work/lab', '/work/bucket', '/work/self', '/work/tea'];
        const providers = create();
        const tea = await providers.add('gitea', 'Gitea');
        // GitHub, gitlab.com, and Bitbucket remotes are not possible servers.
        expect(probed.sort()).toEqual(['https://git.acme.dev', 'https://git.example.com']);
        expect(tea.baseUrl).toBe('https://git.acme.dev');
        expect(await providers.repoFor('/work/tea')).toEqual({ owner: 'git.acme.dev/acme', name: 'api', host: 'gitea' });
        // A second provider does not get the server of the first provider again.
        probed.length = 0;
        expect((await providers.add('gitea', 'Gitea 2')).baseUrl).toBeUndefined();
        expect(probed).toEqual(['https://git.example.com']);
    });

    it('selects the Gitea provider of the server of the remote', async () => {
        const providers = create();
        await providers.add('github', 'GitHub');
        const work = await providers.add('gitea', 'Work');
        const berg = await providers.add('gitea', 'Codeberg');
        expect(await providers.repoFor('/work/berg')).toBeNull();
        await providers.update(work.id, { baseUrl: 'git.acme.dev/' });
        await providers.update(berg.id, { baseUrl: 'https://codeberg.org' });
        expect((await providers.list()).find(item => item.id === work.id)?.baseUrl).toBe('https://git.acme.dev');
        const fromWork = await providers.for('/work/tea');
        const fromBerg = await providers.for('/work/berg');
        expect(fromWork.kind).toBe('gitea');
        expect(fromBerg.kind).toBe('gitea');
        expect(fromBerg).not.toBe(fromWork);
        expect(await providers.for({ owner: 'codeberg.org/dana', name: 'notes', host: 'gitea' })).toBe(fromBerg);
        await providers.update(berg.id, { enabled: false });
        await expect(providers.for({ owner: 'codeberg.org/dana', name: 'notes', host: 'gitea' })).rejects.toThrow(
            'No Gitea or Forgejo provider for codeberg.org is on'
        );
        await expect(providers.update(work.id, { baseUrl: 'ftp://example.com' })).rejects.toThrow('is not a valid URL');
    });
});
