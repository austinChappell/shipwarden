import { parseGitHubRemote, type RepoRef } from './github';
import type { OnboardingSettings } from './onboarding';
import type { SetupCheckId, SetupCheckResult } from './setup-checks';

/** The steps of the welcome page, in the order of the page. */
export const WELCOME_STEP_IDS = ['welcome', 'tools', 'repository', 'agent', 'optional', 'start'] as const;

export type WelcomeStepId = (typeof WELCOME_STEP_IDS)[number];

/**
 * The state of a step on the welcome page:
 * - info: the step only gives information.
 * - todo: the user has not done the step yet, or the checks did not finish.
 * - done: the step is complete.
 * - warning: the step is complete enough, but a part needs attention.
 * - problem: a part that ShipWarden needs is missing.
 * - blocked: an earlier step must be done first.
 */
export type WelcomeStepState = 'info' | 'todo' | 'done' | 'warning' | 'problem' | 'blocked';

/** The checks that the "Check your tools" step shows. The repository check has its own step. */
export const TOOL_CHECK_IDS: readonly SetupCheckId[] = ['git', 'agent', 'github', 'notifications'];

/** Returns true when the app opens the welcome page at its start. */
export function shouldOpenWelcome(onboarding: OnboardingSettings | undefined): boolean {
    return onboarding?.welcome === 'new';
}

/**
 * Returns the state of each step on the welcome page from the setup check results and the number of repositories.
 * `checks` is undefined while the checks run for the first time.
 */
export function welcomeStepStates(checks: readonly SetupCheckResult[] | undefined, repoCount: number): Record<WelcomeStepId, WelcomeStepState> {
    const byId = new Map((checks ?? []).map(check => [check.id, check]));
    const tools = TOOL_CHECK_IDS.map(id => byId.get(id)).filter((check): check is SetupCheckResult => !!check);
    let toolsState: WelcomeStepState = 'todo';
    if (checks && tools.length === TOOL_CHECK_IDS.length) {
        if (tools.some(check => check.state === 'missing')) toolsState = 'problem';
        else if (tools.some(check => check.state !== 'ok')) toolsState = 'warning';
        else toolsState = 'done';
    }
    const agent = byId.get('agent');
    const agentState: WelcomeStepState = !agent ? 'todo' : agent.state === 'ok' ? 'done' : agent.state === 'missing' ? 'problem' : 'warning';
    return {
        welcome: 'info',
        tools: toolsState,
        repository: repoCount > 0 ? 'done' : 'todo',
        agent: agentState,
        optional: 'info',
        start: repoCount > 0 ? 'todo' : 'blocked'
    };
}

/** The words that a screen reader says for the state of a step. */
export const WELCOME_STATE_LABELS: Record<WelcomeStepState, string> = {
    info: 'Information',
    todo: 'To do',
    done: 'Done',
    warning: 'Needs attention',
    problem: 'Problem',
    blocked: 'Do the earlier steps first'
};

/**
 * Reads the repository that the user typed in the clone dialog. It accepts "owner/name", "github.com/owner/name" and
 * the HTTPS and SSH addresses of GitHub. Returns undefined for other text.
 */
export function parseRepoInput(text: string): RepoRef | undefined {
    const value = text.trim();
    if (!value) return undefined;
    const remote = parseGitHubRemote(value) ?? parseGitHubRemote(`https://${value.replace(/^(?:www\.)?/, '')}`);
    if (remote) return remote;
    const match = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/.exec(value);
    if (!match || match[2] === '.' || match[2] === '..') return undefined;
    return { owner: match[1], name: match[2] };
}
