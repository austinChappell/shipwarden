import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/api';
import { agentProgramOf } from '@shared/agent-programs';
import { printCommand } from '@shared/ask-agent';
import { exploreCommand, type PlanExploreRequest, type PlanExploreResult } from '@shared/plans';
import { agentForRepo } from '@shared/settings';
import type { Services } from '../services';
import { onlyStrings } from './args';

type PlanIpcDependencies = Pick<Services, 'plans' | 'askRunner' | 'projectWorktrees' | 'settings' | 'certificates' | 'shellReady' | 'networkReady'>;

/** An exploration reads many files. It can take longer than a question about lines of code. */
const EXPLORE_TIMEOUT_MS = 30 * 60_000;

/** The prefix of the IDs of the explorations in the ask runner. Other IDs of the runner do not collide with them. */
const RUN_PREFIX = 'plan-';

/** Registers the IPC handlers of the plans. */
export function registerPlanIpc(deps: PlanIpcDependencies): void {
    const { plans, askRunner } = deps;
    ipcMain.handle(IpcChannels.plansList, () => plans.list());
    ipcMain.handle(IpcChannels.plansSave, (_event, plan: unknown) => plans.save(plan));
    ipcMain.handle(IpcChannels.plansRemove, (_event, id: unknown) => plans.remove(String(id)));
    ipcMain.handle(IpcChannels.plansExplore, (_event, request: unknown) => explore(deps, request));
    ipcMain.handle(IpcChannels.plansCancelExplore, (_event, id: unknown) => askRunner.cancel(`${RUN_PREFIX}${String(id)}`));
}

/**
 * Runs the agent of the first repository in print mode, in the folder of that repository. The agent can read the
 * other repositories of the project too. It does not change files.
 */
async function explore(deps: PlanIpcDependencies, value: unknown): Promise<PlanExploreResult> {
    const raw = (value ?? {}) as Partial<PlanExploreRequest>;
    const id = String(raw.id ?? '');
    const prompt = String(raw.prompt ?? '');
    if (!id || !prompt.trim()) throw new Error('The exploration has no ID or no prompt.');
    await deps.shellReady;
    const repos: string[] = [];
    for (const repo of onlyStrings(raw.repos)) {
        repos.push(await deps.projectWorktrees.check(repo));
    }
    if (repos.length === 0) throw new Error('The project has no repositories. Add a repository to the project first.');
    const agent = agentForRepo(await deps.settings.get(), repos[0]);
    const print = printCommand(agent.command);
    if (!print) {
        throw new Error(
            `ShipWarden can explore only with Claude Code, Codex, Gemini CLI or opencode. The agent "${agent.name}" runs "${agent.command}". Select a different agent in Settings › Agents.`
        );
    }
    const command = exploreCommand(print, agentProgramOf(agent.command.trim()), repos.slice(1));
    await deps.networkReady;
    const bundle = deps.certificates.status().bundlePath;
    const answer = await deps.askRunner.run(`${RUN_PREFIX}${id}`, {
        command,
        prompt,
        cwd: repos[0],
        env: bundle ? { NODE_EXTRA_CA_CERTS: bundle } : {},
        timeoutMs: EXPLORE_TIMEOUT_MS
    });
    return { agent: agent.name, answer };
}
