import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/api';
import { agentProgramOf } from '@shared/agent-programs';
import { printCommand } from '@shared/ask-agent';
import { exploreCommand } from '@shared/plans';
import { groupFolderNote, MAX_GROUP_PULL_REQUESTS, prKey, type GroupReviewAnswer, type GroupReviewRequest } from '@shared/pr-groups';
import { checkCommitSha, checkPullNumber, checkRepoRef } from '@shared/review-checkout';
import { agentForRepo } from '@shared/settings';
import type { Services } from '../services';

type GroupIpcDependencies = Pick<
    Services,
    'prGroups' | 'askRunner' | 'reviewCheckouts' | 'projectWorktrees' | 'settings' | 'certificates' | 'shellReady' | 'networkReady'
>;

/** A group review reads many files in more than one repository. */
const REVIEW_TIMEOUT_MS = 30 * 60_000;

/** The prefix of the IDs of the group reviews in the ask runner. Other IDs of the runner do not collide with them. */
const RUN_PREFIX = 'group-';

/** Registers the IPC handlers of the PR groups. */
export function registerPrGroupIpc(deps: GroupIpcDependencies): void {
    const { prGroups, askRunner } = deps;
    ipcMain.handle(IpcChannels.prGroupsList, () => prGroups.list());
    ipcMain.handle(IpcChannels.prGroupsSave, (_event, group: unknown) => prGroups.save(group));
    ipcMain.handle(IpcChannels.prGroupsRemove, (_event, id: unknown) => prGroups.remove(String(id)));
    ipcMain.handle(IpcChannels.prGroupsReview, (_event, request: unknown) => review(deps, request));
    ipcMain.handle(IpcChannels.prGroupsCancelReview, (_event, id: unknown) => askRunner.cancel(`${RUN_PREFIX}${String(id)}`));
}

/**
 * Makes a local copy of each pull request at its head commit, and runs the agent in print mode in the copy of the
 * first pull request. The agent can read the other copies too. It does not change files.
 * A repository without a clone gets a clone of ShipWarden, the same as for the code view of the Review view.
 */
async function review(deps: GroupIpcDependencies, value: unknown): Promise<GroupReviewAnswer> {
    const raw = (value ?? {}) as Partial<GroupReviewRequest>;
    const id = String(raw.id ?? '');
    const prompt = String(raw.prompt ?? '');
    if (!id || !prompt.trim()) throw new Error('The group review has no ID or no prompt.');
    const targets = (Array.isArray(raw.pullRequests) ? raw.pullRequests : []).map(item => ({
        repo: checkRepoRef(item?.repo),
        number: checkPullNumber(item?.number),
        headRefOid: checkCommitSha(item?.headRefOid)
    }));
    if (targets.length === 0) throw new Error('The group has no pull requests. Add a pull request to the group first.');
    if (targets.length > MAX_GROUP_PULL_REQUESTS) throw new Error(`A group can have at most ${MAX_GROUP_PULL_REQUESTS} pull requests.`);
    await deps.shellReady;
    await deps.networkReady;

    // The copies of one repository run one after the other in the checkout queue. Different repositories run at the same time.
    const folders = await Promise.all(
        targets.map(async target => {
            const checkout = await deps.reviewCheckouts.ensure(target.repo, target.number, target.headRefOid, true);
            return { key: prKey(target), path: checkout.root };
        })
    );
    const repoPath = await deps.projectWorktrees.localClone(targets[0].repo);
    const agent = agentForRepo(await deps.settings.get(), repoPath);
    const print = printCommand(agent.command);
    if (!print) {
        throw new Error(
            `ShipWarden can review a group only with Claude Code, Codex, Gemini CLI or opencode. The agent "${agent.name}" runs "${agent.command}". Select a different agent in Settings › Agents.`
        );
    }
    const others = [...new Set(folders.slice(1).map(folder => folder.path))];
    const command = exploreCommand(print, agentProgramOf(agent.command.trim()), others);
    const bundle = deps.certificates.status().bundlePath;
    // The note goes first, because the end of the prompt says how to answer.
    const answer = await deps.askRunner.run(`${RUN_PREFIX}${id}`, {
        command,
        prompt: `${groupFolderNote(folders)}\n\n${prompt}`,
        cwd: folders[0].path,
        env: bundle ? { NODE_EXTRA_CA_CERTS: bundle } : {},
        timeoutMs: REVIEW_TIMEOUT_MS
    });
    return { agent: agent.name, answer };
}
