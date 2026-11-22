import type { RepoRef } from '@shared/github';
import type { AzureDevOpsClient } from '../azure/azure-client';
import type { GitHubClient } from '../github/github-client';
import { GitHubError } from '../github/github-client';
import type { GitLabClient } from '../gitlab/gitlab-client';

/** An image to upload for a PR comment. */
export interface UploadFile {
    /** A file name that is unique in the upload, for example "01-base-home.png". */
    name: string;
    data: Buffer;
}

/** The branch that keeps the screenshots of ShipWarden in a GitHub repository. It has no common history with the code. */
export const GITHUB_SCREENSHOT_BRANCH = 'shipwarden-screenshots';

/** A folder name for one upload, from the time, for example "20261120-142530". */
export function uploadStamp(now = new Date()): string {
    return now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

/**
 * Uploads images to GitHub. GitHub has no API to attach an image to a comment, so ShipWarden commits the images to the
 * branch "shipwarden-screenshots" of the same repository with the git data API. The first upload makes the branch as a
 * commit with no parent. Returns the address of each image, in the order of the files.
 *
 * The addresses use the commit SHA, so a later upload does not change them. GitHub shows them to each user who can
 * read the repository. For a private repository, the user must be signed in to GitHub.
 */
export async function uploadToGitHub(client: GitHubClient, repo: RepoRef, number: number, files: UploadFile[], stamp = uploadStamp()): Promise<string[]> {
    const base = `/repos/${repo.owner}/${repo.name}`;
    let parent: string | undefined;
    try {
        const ref = await client.rest<{ object: { sha: string } }>('GET', `${base}/git/ref/heads/${GITHUB_SCREENSHOT_BRANCH}`);
        parent = ref.object.sha;
    } catch (error) {
        if (!(error instanceof GitHubError && error.status === 404)) throw error;
    }
    const parentTree = parent ? (await client.rest<{ tree: { sha: string } }>('GET', `${base}/git/commits/${parent}`)).tree.sha : undefined;
    const folder = `pr-${number}/${stamp}`;
    const entries: { path: string; mode: string; type: string; sha: string }[] = [];
    for (const file of files) {
        const blob = await client.rest<{ sha: string }>('POST', `${base}/git/blobs`, { content: file.data.toString('base64'), encoding: 'base64' });
        entries.push({ path: `${folder}/${file.name}`, mode: '100644', type: 'blob', sha: blob.sha });
    }
    const tree = await client.rest<{ sha: string }>('POST', `${base}/git/trees`, { ...(parentTree ? { base_tree: parentTree } : {}), tree: entries });
    // "[skip ci]" stops the push workflows of GitHub Actions for this commit.
    const commit = await client.rest<{ sha: string }>('POST', `${base}/git/commits`, {
        message: `Screenshots for #${number} [skip ci]`,
        tree: tree.sha,
        parents: parent ? [parent] : []
    });
    if (parent) {
        await client.rest('PATCH', `${base}/git/refs/heads/${GITHUB_SCREENSHOT_BRANCH}`, { sha: commit.sha });
    } else {
        await client.rest('POST', `${base}/git/refs`, { ref: `refs/heads/${GITHUB_SCREENSHOT_BRANCH}`, sha: commit.sha });
    }
    return entries.map(
        entry => `https://github.com/${repo.owner}/${repo.name}/blob/${commit.sha}/${entry.path.split('/').map(encodeURIComponent).join('/')}?raw=true`
    );
}

/** Adds a comment to the conversation of a GitHub pull request. Returns the address of the comment. */
export async function commentOnGitHub(client: GitHubClient, repo: RepoRef, number: number, body: string): Promise<string | undefined> {
    const comment = await client.rest<{ html_url?: string }>('POST', `/repos/${repo.owner}/${repo.name}/issues/${number}/comments`, { body });
    return comment?.html_url;
}

/**
 * Uploads images as attachments of an Azure DevOps pull request (`pullRequests/{id}/attachments/{fileName}`).
 * `prApi` is the API address of the pull request. The file names get the stamp, because a name must be new in the pull
 * request. Returns the address of each attachment. Azure DevOps shows these addresses in the comments of the pull request.
 */
export async function uploadToAzure(client: AzureDevOpsClient, prApi: string, files: UploadFile[], stamp = uploadStamp()): Promise<string[]> {
    const urls: string[] = [];
    for (const file of files) {
        const name = encodeURIComponent(`${stamp}-${file.name}`);
        // The attachments API is a preview API in version 7.1.
        const attachment = await client.upload<{ url: string }>(`${prApi}/attachments/${name}?api-version=7.1-preview.1`, file.data);
        urls.push(attachment.url);
    }
    return urls;
}

/** Adds a comment thread to an Azure DevOps pull request. */
export async function commentOnAzure(client: AzureDevOpsClient, prApi: string, body: string): Promise<void> {
    await client.request('POST', `${prApi}/threads`, { comments: [{ parentCommentId: 0, content: body, commentType: 'text' }], status: 'active' });
}

/**
 * Uploads images to a GitLab project (`POST /projects/:id/uploads`). `projectApi` is the API path of the project.
 * Returns the address that GitLab gives for each file. It is relative to the project, and GitLab shows it in the
 * comments of the project.
 */
export async function uploadToGitLab(client: GitLabClient, projectApi: string, files: UploadFile[]): Promise<string[]> {
    const urls: string[] = [];
    for (const file of files) {
        const form = new FormData();
        form.append('file', new Blob([new Uint8Array(file.data)], { type: 'image/png' }), file.name);
        const upload = await client.form<{ url: string }>(`${projectApi}/uploads`, form);
        urls.push(upload.url);
    }
    return urls;
}

/** Adds a note to a GitLab merge request. */
export async function commentOnGitLab(client: GitLabClient, mrApi: string, body: string): Promise<void> {
    await client.request('POST', `${mrApi}/notes`, { body });
}
