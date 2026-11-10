import { withAgentHooks, type HookSettingsPaths } from '@shared/agents';
import type { BrowserBounds } from '@shared/browser';
import { sameRepoRef, type NewPullRequest, type RepoRef } from '@shared/github';
import type { CreateTerminalOptions } from '@shared/terminal';

/**
 * The checks of the IPC arguments. The page can send any value, so the main process checks the values first.
 * These functions use no Electron API.
 */

/** Returns each item of an array as a string. A value that is not an array gives an empty list. */
export function stringsOf(value: unknown): string[] {
    return Array.isArray(value) ? value.map(String) : [];
}

/** Returns only the string items of an array. A value that is not an array gives an empty list. */
export function onlyStrings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** Returns the value when it is a string. Else returns undefined. */
export function optionalString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

/** Returns the bounds when all four values are finite numbers. Else returns null, which hides the view. */
export function validBounds(bounds: unknown): BrowserBounds | null {
    if (!bounds || typeof bounds !== 'object') return null;
    const { x, y, width, height } = bounds as Record<string, unknown>;
    const values = [x, y, width, height];
    return values.every(value => typeof value === 'number' && Number.isFinite(value))
        ? { x: x as number, y: y as number, width: width as number, height: height as number }
        : null;
}

/** Returns true for an http or https URL with "//". Commit statuses and task descriptions can link to any web service. */
export function isWebUrl(url: unknown): boolean {
    return /^https?:\/\//.test(String(url));
}

/** Returns a new pull request with a trimmed title. An empty base gives undefined, which means the default branch. */
export function newPullRequestOf(request: Partial<NewPullRequest> | undefined): NewPullRequest {
    return {
        title: String(request?.title ?? '').trim(),
        body: String(request?.body ?? ''),
        base: typeof request?.base === 'string' && request.base ? request.base : undefined,
        draft: request?.draft === true
    };
}

/** Returns a repository reference with string fields. A missing field gives an empty string. */
export function repoRefOf(repo: Partial<RepoRef> | undefined): RepoRef {
    const ref: RepoRef = { owner: String(repo?.owner ?? ''), name: String(repo?.name ?? '') };
    return repo?.host === 'azure' ? { ...ref, host: 'azure' } : ref;
}

/** Returns true when two references name the same repository on the same host. The names ignore case. */
export function sameRepo(a: RepoRef, b: RepoRef): boolean {
    return sameRepoRef(a, b);
}

/** The default number of commits in the git log. */
export const DEFAULT_LOG_LIMIT = 300;

/** Returns the limit of the git log when it is a finite number. Else returns the default limit. */
export function logLimit(limit: unknown): number {
    return typeof limit === 'number' && Number.isFinite(limit) ? limit : DEFAULT_LOG_LIMIT;
}

/** A background fetch occurs at most one time in this interval for each repository. */
export const FETCH_INTERVAL_MS = 5 * 60 * 1000;

/** Returns the maximum age of the last fetch. "force" (the Refresh button) gives 0, so the fetch occurs at once. */
export function fetchMaxAge(force: unknown): number {
    return force === true ? 0 : FETCH_INTERVAL_MS;
}

/**
 * Returns the command of a new terminal and whether the agent reports its state.
 * An agent command gets the hook settings. Only an agent that got the hooks reports its state.
 */
export function terminalCommand(
    options: Pick<CreateTerminalOptions, 'command' | 'isAgent'>,
    paths: HookSettingsPaths
): { command?: string; reportsAgentState: boolean } {
    const command = options.isAgent && options.command ? withAgentHooks(options.command, paths) : options.command;
    return { command, reportsAgentState: !!options.isAgent && command !== options.command };
}

/** Returns true when the JSON text of two values is different. */
export function changed(before: unknown, after: unknown): boolean {
    return JSON.stringify(before) !== JSON.stringify(after);
}
