import type { ReviewTokenSource } from '@shared/review-providers';
import { agentForRepo, type AppSettings, type CommandCheck } from '@shared/settings';
import {
    agentCheckResult,
    failedCheckResult,
    gitCheckResult,
    githubCheckResult,
    notificationsCheckResult,
    repositoryCheckResult,
    SETUP_CHECK_IDS,
    type SetupCheckId,
    type SetupCheckResult
} from '@shared/setup-checks';

export interface SetupCheckDependencies {
    /** The PATH check of Settings › Agents (`checkCommand`). */
    checkCommand(command: string): Promise<CommandCheck>;
    settings(): Promise<AppSettings>;
    /** Returns the number of repositories in the active project. */
    activeRepoCount(): Promise<number>;
    /** Returns the place of the GitHub token. It reads only local data and does not call the GitHub API. */
    githubTokenSource(): Promise<ReviewTokenSource | undefined>;
}

/**
 * Checks the setup of the user for the welcome page and the checklist. The checks run only on request, not on a timer.
 * A check that fails gives the state "unknown". It does not stop the other checks.
 */
export class SetupChecks {
    constructor(private readonly deps: SetupCheckDependencies) {}

    /** Runs all checks at the same time. The results are in the order of `SETUP_CHECK_IDS`. */
    runAll(): Promise<SetupCheckResult[]> {
        return Promise.all(SETUP_CHECK_IDS.map(id => this.run(id)));
    }

    /** Runs one check, for example after the user fixes a problem. */
    async run(id: SetupCheckId): Promise<SetupCheckResult> {
        try {
            return await this.check(id);
        } catch (error) {
            return failedCheckResult(id, error);
        }
    }

    private async check(id: SetupCheckId): Promise<SetupCheckResult> {
        switch (id) {
            case 'git':
                return gitCheckResult(await this.deps.checkCommand('git'));
            case 'agent': {
                const agent = agentForRepo(await this.deps.settings(), undefined);
                return agentCheckResult(agent, await this.deps.checkCommand(agent.command));
            }
            case 'github':
                return githubCheckResult(await this.deps.githubTokenSource());
            case 'repository':
                return repositoryCheckResult(await this.deps.activeRepoCount());
            case 'notifications':
                return notificationsCheckResult((await this.deps.settings()).notifications);
        }
    }
}
