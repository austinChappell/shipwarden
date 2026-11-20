import { afterEach, describe, expect, it, vi } from 'vitest';
import { screenshotCommentMarkdown, type ScreenshotSet } from '@shared/screenshots';
import { AzureDevOpsClient } from '../azure/azure-client';
import { GitHubClient } from '../github/github-client';
import { GitLabClient } from '../gitlab/gitlab-client';
import {
    commentOnAzure,
    commentOnGitHub,
    commentOnGitLab,
    GITHUB_SCREENSHOT_BRANCH,
    uploadStamp,
    uploadToAzure,
    uploadToGitHub,
    uploadToGitLab,
    type UploadFile
} from './screenshot-upload';

interface Call {
    method: string;
    url: string;
    body: unknown;
    headers: Record<string, string>;
}

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A fake fetch. Each route is a method and a part of the URL. The calls are kept in order. */
function fakeFetch(routes: [string, string | RegExp, (call: Call) => Response][]) {
    const calls: Call[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        const raw = init?.body;
        const body = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const call = { method, url, body, headers: (init?.headers ?? {}) as Record<string, string> };
        calls.push(call);
        const route = routes.find(([m, pattern]) => m === method && (typeof pattern === 'string' ? url.includes(pattern) : pattern.test(url)));
        if (!route) return json(404, { message: 'Not Found' });
        return route[2](call);
    });
    return { fetch, calls };
}

const files: UploadFile[] = [
    { name: '01-base-home.png', data: Buffer.from('base') },
    { name: '01-branch-home.png', data: Buffer.from('branch') }
];

const set: ScreenshotSet = {
    viewportWidth: 1280,
    pages: [{ path: '/', base: { branch: 'main', sha: 'aaaaaaa1', capturedAt: 1 }, branch: { branch: 'feat', sha: 'bbbbbbb2', capturedAt: 2 } }]
};

/** The comment of the set, with the addresses in the order of the files. */
function comment(urls: string[]): string {
    return screenshotCommentMarkdown(set, [
        { page: '/', side: 'base', url: urls[0] },
        { page: '/', side: 'branch', url: urls[1] }
    ]);
}

describe('uploadStamp', () => {
    it('formats the time as a folder name', () => {
        expect(uploadStamp(new Date('2026-11-20T14:25:30.123Z'))).toBe('20261120-142530');
    });
});

describe('GitHub screenshots', () => {
    afterEach(() => vi.unstubAllGlobals());
    const repo = { owner: 'acme', name: 'web' };
    const client = () => new GitHubClient({ ready: Promise.resolve(), savedToken: async () => 'token' });

    it('makes the screenshot branch with a first commit when it does not exist', async () => {
        let blob = 0;
        const { fetch, calls } = fakeFetch([
            ['GET', `/git/ref/heads/${GITHUB_SCREENSHOT_BRANCH}`, () => json(404, { message: 'Not Found' })],
            ['POST', '/git/blobs', () => json(201, { sha: `blob${++blob}` })],
            ['POST', '/git/trees', () => json(201, { sha: 'tree1' })],
            ['POST', '/git/commits', () => json(201, { sha: 'commit1' })],
            ['POST', '/git/refs', () => json(201, {})],
            ['POST', '/issues/7/comments', () => json(201, { html_url: 'https://github.com/acme/web/pull/7#issuecomment-1' })]
        ]);
        vi.stubGlobal('fetch', fetch);
        const github = client();
        const urls = await uploadToGitHub(github, repo, 7, files, '20261120-142530');
        expect(urls).toEqual([
            'https://github.com/acme/web/blob/commit1/pr-7/20261120-142530/01-base-home.png?raw=true',
            'https://github.com/acme/web/blob/commit1/pr-7/20261120-142530/01-branch-home.png?raw=true'
        ]);
        const blobCall = calls.find(call => call.url.endsWith('/git/blobs'));
        expect(blobCall?.body).toEqual({ content: Buffer.from('base').toString('base64'), encoding: 'base64' });
        expect(calls.find(call => call.url.endsWith('/git/trees'))?.body).toEqual({
            tree: [
                { path: 'pr-7/20261120-142530/01-base-home.png', mode: '100644', type: 'blob', sha: 'blob1' },
                { path: 'pr-7/20261120-142530/01-branch-home.png', mode: '100644', type: 'blob', sha: 'blob2' }
            ]
        });
        expect(calls.find(call => call.url.endsWith('/git/commits'))?.body).toEqual({ message: 'Screenshots for #7 [skip ci]', tree: 'tree1', parents: [] });
        expect(calls.find(call => call.url.endsWith('/git/refs'))?.body).toEqual({ ref: `refs/heads/${GITHUB_SCREENSHOT_BRANCH}`, sha: 'commit1' });

        const body = comment(urls);
        await expect(commentOnGitHub(github, repo, 7, body)).resolves.toBe('https://github.com/acme/web/pull/7#issuecomment-1');
        const posted = calls.at(-1);
        expect(posted?.url).toBe('https://api.github.com/repos/acme/web/issues/7/comments');
        expect(posted?.body).toEqual({ body });
        expect(body).toContain('| ![Base /](https://github.com/acme/web/blob/commit1/pr-7/20261120-142530/01-base-home.png?raw=true) |');
    });

    it('adds a commit on top of the screenshot branch when it exists', async () => {
        const { fetch, calls } = fakeFetch([
            ['GET', `/git/ref/heads/${GITHUB_SCREENSHOT_BRANCH}`, () => json(200, { object: { sha: 'old' } })],
            ['GET', '/git/commits/old', () => json(200, { tree: { sha: 'oldtree' } })],
            ['POST', '/git/blobs', () => json(201, { sha: 'blob' })],
            ['POST', '/git/trees', () => json(201, { sha: 'tree2' })],
            ['POST', '/git/commits', () => json(201, { sha: 'commit2' })],
            ['PATCH', `/git/refs/heads/${GITHUB_SCREENSHOT_BRANCH}`, () => json(200, {})]
        ]);
        vi.stubGlobal('fetch', fetch);
        await uploadToGitHub(client(), repo, 7, files.slice(0, 1), 's');
        expect(calls.find(call => call.url.endsWith('/git/trees'))?.body).toMatchObject({ base_tree: 'oldtree' });
        expect(calls.find(call => call.url.endsWith('/git/commits'))?.body).toMatchObject({ parents: ['old'] });
        expect(calls.at(-1)).toMatchObject({ method: 'PATCH', body: { sha: 'commit2' } });
    });

    it('stops on an error that is not 404', async () => {
        const { fetch } = fakeFetch([['GET', '/git/ref/heads/', () => json(403, { message: 'Resource not accessible by integration' })]]);
        vi.stubGlobal('fetch', fetch);
        await expect(uploadToGitHub(client(), repo, 7, files)).rejects.toMatchObject({ status: 403 });
    });
});

describe('Azure DevOps screenshots', () => {
    afterEach(() => vi.unstubAllGlobals());
    const prApi = 'https://dev.azure.com/contoso/web/_apis/git/repositories/r1/pullrequests/12';

    it('uploads attachments and adds a thread with their addresses', async () => {
        const { fetch, calls } = fakeFetch([
            ['POST', '/attachments/', call => json(201, { url: `${call.url.split('?')[0]}` })],
            ['POST', '/threads', () => json(200, { id: 1 })]
        ]);
        vi.stubGlobal('fetch', fetch);
        const client = new AzureDevOpsClient({ ready: Promise.resolve(), savedToken: async () => 'pat' });
        const urls = await uploadToAzure(client, prApi, files, 'stamp');
        expect(urls).toEqual([`${prApi}/attachments/stamp-01-base-home.png`, `${prApi}/attachments/stamp-01-branch-home.png`]);
        expect(calls[0].url).toBe(`${prApi}/attachments/stamp-01-base-home.png?api-version=7.1-preview.1`);
        expect(calls[0].headers['Content-Type']).toBe('application/octet-stream');
        expect(Buffer.from(calls[0].body as Uint8Array).toString()).toBe('base');

        const body = comment(urls);
        await commentOnAzure(client, prApi, body);
        expect(calls.at(-1)?.body).toEqual({ comments: [{ parentCommentId: 0, content: body, commentType: 'text' }], status: 'active' });
        expect(body).toContain(`![Branch /](${prApi}/attachments/stamp-01-branch-home.png)`);
    });
});

describe('GitLab screenshots', () => {
    it('uploads the files to the project and adds a note with their addresses', async () => {
        let count = 0;
        const { fetch, calls } = fakeFetch([
            ['POST', '/uploads', () => json(201, { url: `/uploads/hash${++count}/file.png`, markdown: '![file](/uploads/x/file.png)' })],
            ['POST', '/notes', () => json(201, { id: 5 })]
        ]);
        const client = new GitLabClient({ ready: Promise.resolve(), baseUrl: () => undefined, savedToken: async () => 'glpat', fetch });
        const urls = await uploadToGitLab(client, '/projects/acme%2Fweb', files);
        expect(urls).toEqual(['/uploads/hash1/file.png', '/uploads/hash2/file.png']);
        expect(calls[0].url).toBe('https://gitlab.com/api/v4/projects/acme%2Fweb/uploads');
        expect(calls[0].headers['Content-Type']).toBeUndefined();
        const form = calls[0].body as FormData;
        const file = form.get('file') as File;
        expect(file.name).toBe('01-base-home.png');
        expect(await file.text()).toBe('base');

        const body = comment(urls);
        await commentOnGitLab(client, '/projects/acme%2Fweb/merge_requests/3', body);
        expect(calls.at(-1)).toMatchObject({ url: 'https://gitlab.com/api/v4/projects/acme%2Fweb/merge_requests/3/notes', body: { body } });
        expect(body).toContain('| ![Base /](/uploads/hash1/file.png) | ![Branch /](/uploads/hash2/file.png) |');
    });
});
