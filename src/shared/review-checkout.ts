import type { RepoRef } from './github';

/** A local copy of the files of a pull request, at its head commit. */
export interface ReviewCheckout {
    /** The folder of the copy. It is a detached git worktree. */
    root: string;
    /** The commit in the folder. */
    sha: string;
}

export interface ReviewCheckoutStatus {
    /** The copy of the pull request, when it exists. Its commit can be older than the head of the pull request. */
    checkout?: ReviewCheckout;
    /**
     * True when no project has a clone of the repository and ShipWarden has no clone of its own.
     * Then a checkout must clone the repository first.
     */
    needsClone: boolean;
}

/** The characters that GitHub allows in an owner or a repository name. */
const NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

/** True when the value can be a folder name. The value must not be "." or "..". */
export function isSafeRepoPart(value: string): boolean {
    return NAME_PATTERN.test(value) && value !== '.' && value !== '..';
}

/** Returns the repository as a valid `RepoRef`. Throws an error when the owner or the name is not valid. */
export function checkRepoRef(value: unknown): RepoRef {
    const repo = value as Partial<RepoRef> | undefined;
    const owner = String(repo?.owner ?? '');
    const name = String(repo?.name ?? '');
    if (!isSafeRepoPart(owner) || !isSafeRepoPart(name)) {
        throw new Error(`"${owner}/${name}" is not a valid repository name.`);
    }
    return { owner, name };
}

/** Returns the number of a pull request. Throws an error when the value is not a positive integer. */
export function checkPullNumber(value: unknown): number {
    const number = Number(value);
    if (!Number.isInteger(number) || number <= 0) {
        throw new Error(`"${String(value)}" is not a valid pull request number.`);
    }
    return number;
}

/** Returns a full commit SHA in lowercase. Throws an error when the value is not a full SHA. */
export function checkCommitSha(value: unknown): string {
    const sha = String(value ?? '').toLowerCase();
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) {
        throw new Error(`"${sha}" is not a full commit SHA.`);
    }
    return sha;
}

/** The key of a pull request in the checkout index, for example "octo/app#12". Owner and name are in lowercase. */
export function reviewCheckoutKey(repo: RepoRef, number: number): string {
    return `${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}#${number}`;
}
