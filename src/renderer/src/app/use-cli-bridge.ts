import { useEffect, useRef } from 'react';
import { manualScheduleEvent, manualWorktreeEvent } from '@shared/automation-events';
import { branchMatches, manualTarget } from '@shared/automations';
import type { CliPageRequest, CliPageResult } from '@shared/cli';
import type { TerminalSession } from '@shared/terminal';
import type { CreatedWorktree, Worktree } from '@shared/worktrees';
import { automationListQuery } from '../automations/automation-queries';
import { automationEngine } from '../automations/engine';
import { branchSummariesQuery } from '../github/use-branch-status';
import { queryClient } from '../query-client';
import { errorText } from '../util';
import { phoneStart, phoneTasks, type PhoneStartActions } from './phone-start';

const api = window.shipwarden;

/** The functions of the app that the CLI commands and the starts from the phone use. App gives them at each render. */
export interface CliBridgeActions extends Pick<PhoneStartActions, 'startTaskQuietly' | 'startInNewWorktree'> {
    promptAgent(
        worktree: Pick<Worktree, 'path'>,
        prompt: string,
        target?: { sessionId?: string; agentId?: string; repoPath?: string; newSession?: boolean; model?: string }
    ): Promise<TerminalSession>;
    prepareWorktree(repoPath: string, worktree: CreatedWorktree): Promise<void>;
    refreshWorktrees(repoPath: string): Promise<unknown>;
    removeWorktreeQuietly(repoPath: string, worktree: Worktree, deleteBranch: boolean): Promise<string>;
}

async function findWorktree(repoPath: string, worktreePath: string): Promise<Worktree> {
    const worktree = (await api.worktrees.list(repoPath)).find(item => item.path === worktreePath);
    if (!worktree) throw new Error(`The worktree ${worktreePath} does not exist anymore.`);
    return worktree;
}

function started(session: TerminalSession, worktreePath: string, message: string): CliPageResult {
    return { message, worktreePath, sessionId: session.id, agent: session.title };
}

/**
 * Runs a command of the `shipwarden` CLI in the page. The main process checked the values and the approval. The
 * commands use the same code as the automations, so the sidebar, the tabs, and the caches update as for a click.
 */
export async function runCliRequest(
    request: CliPageRequest,
    actions: CliBridgeActions,
    latest: () => CliBridgeActions = () => actions
): Promise<CliPageResult> {
    switch (request.action) {
        case 'worktree.create': {
            const worktree = await api.worktrees.create({
                repoPath: request.repoPath,
                branch: request.branch,
                ...(request.baseRef ? { baseRef: request.baseRef } : {})
            });
            await actions.prepareWorktree(request.repoPath, worktree);
            await actions.refreshWorktrees(request.repoPath);
            const created = `Created the worktree ${worktree.branch ?? request.branch} in ${worktree.path}.`;
            const result: CliPageResult = { message: created, worktreePath: worktree.path, ...(worktree.branch ? { branch: worktree.branch } : {}) };
            if (!request.prompt && !request.agentId) return result;
            const session = await actions.promptAgent(worktree, request.prompt ?? '', {
                repoPath: request.repoPath,
                newSession: true,
                ...(request.agentId ? { agentId: request.agentId } : {})
            });
            return { ...result, ...started(session, worktree.path, `${created} Started ${session.title}.`) };
        }
        case 'worktree.remove': {
            const worktree = await findWorktree(request.repoPath, request.worktreePath);
            const message = await actions.removeWorktreeQuietly(request.repoPath, worktree, request.deleteBranch);
            return { message, worktreePath: worktree.path };
        }
        case 'agent.start': {
            const session = await actions.promptAgent({ path: request.worktreePath }, request.prompt ?? '', {
                repoPath: request.repoPath,
                newSession: true,
                ...(request.agentId ? { agentId: request.agentId } : {})
            });
            return started(session, request.worktreePath, `Started ${session.title} in ${request.worktreePath}.`);
        }
        case 'agent.send': {
            const session = await actions.promptAgent({ path: request.worktreePath }, request.prompt, {
                repoPath: request.repoPath,
                ...(request.sessionId ? { sessionId: request.sessionId } : {})
            });
            return started(session, request.worktreePath, `Sent the prompt to ${session.title}.`);
        }
        case 'automation.run':
            return runAutomation(request);
        case 'phone.tasks':
            return phoneTasks();
        case 'phone.start':
            return phoneStart(request, latest);
        case 'worker.start':
            return startWorker(request, actions, latest);
    }
}

/**
 * Starts a worker of the MCP tool start_worker: a new worktree and a new agent tab. The answer comes when the agent
 * session runs. The prompt goes to the agent after that, as for a start from the phone, so a question of the new agent
 * (for example about folder trust) does not stop the answer.
 */
async function startWorker(
    request: Extract<CliPageRequest, { action: 'worker.start' }>,
    actions: CliBridgeActions,
    latest: () => CliBridgeActions
): Promise<CliPageResult> {
    const worktree = await api.worktrees.create({
        repoPath: request.repoPath,
        branch: request.branch,
        ...(request.baseRef ? { baseRef: request.baseRef } : {})
    });
    await actions.prepareWorktree(request.repoPath, worktree);
    await actions.refreshWorktrees(request.repoPath);
    const session = await actions.promptAgent(worktree, '', {
        repoPath: request.repoPath,
        agentId: request.agentId,
        newSession: true,
        ...(request.model ? { model: request.model } : {})
    });
    void latest()
        .promptAgent(worktree, request.prompt, { sessionId: session.id })
        .catch(error => console.warn(`[workers] The task did not reach ${session.title}: ${errorText(error)}`));
    return { ...started(session, worktree.path, `Started ${session.title} in ${worktree.path}.`), ...(worktree.branch ? { branch: worktree.branch } : {}) };
}

async function runAutomation(request: Extract<CliPageRequest, { action: 'automation.run' }>): Promise<CliPageResult> {
    const list = await queryClient.fetchQuery(automationListQuery);
    const automation = list.automations.find(item => item.id === request.automationId);
    if (!automation) throw new Error('The automation does not exist anymore.');
    const now = Date.now();
    const done = (target: string): CliPageResult => ({
        message: `Started "${automation.name}"${target}. The Automations view shows the result.`,
        ...(request.worktreePath ? { worktreePath: request.worktreePath } : {})
    });
    switch (manualTarget(automation.trigger)) {
        case 'none':
            await automationEngine.runNow(automation.id, manualScheduleEvent(automation.id, automation.binding.repos?.[0], now, automation.trigger.type));
            return done('');
        case 'worktree': {
            if (!request.repoPath || !request.worktreePath) throw new Error('The automation runs on a worktree. Give the worktree.');
            const worktree = await findWorktree(request.repoPath, request.worktreePath);
            const pattern = automation.conditions?.branchPattern;
            if (!branchMatches(pattern, worktree.branch)) throw new Error(`The branch of the worktree does not match "${pattern}".`);
            const repos = automation.binding.repos;
            if (repos?.length && !repos.includes(request.repoPath)) throw new Error('The automation is not for the repository of the worktree.');
            const place = { repo: request.repoPath, worktree };
            // The summaries of a repository load one time each minute. The cache usually has them.
            const summaries = await queryClient.fetchQuery(branchSummariesQuery(request.repoPath)).catch(() => undefined);
            const summary = worktree.branch ? summaries?.[worktree.branch] : undefined;
            const trigger = automation.trigger;
            if (trigger.type === 'manual' && trigger.entity === 'pullRequest' && !summary) {
                throw new Error(`${worktree.branch ?? worktree.path} has no open pull request.`);
            }
            await automationEngine.runNow(automation.id, manualWorktreeEvent(automation.id, trigger.type, place, summary, now), place);
            return done(` on ${worktree.branch ?? worktree.path}`);
        }
        case 'task':
            throw new Error('The automation runs on a task. Run it from the Tasks view.');
    }
}

/** Answers the CLI commands that the main process sends to this page. */
export function useCliBridge(actions: CliBridgeActions): void {
    const current = useRef(actions);
    current.current = actions;
    useEffect(
        () =>
            api.cli.onPageRequest((id, request) => {
                runCliRequest(request, current.current, () => current.current).then(
                    result => api.cli.answer(id, result),
                    error => api.cli.answer(id, undefined, errorText(error))
                );
            }),
        []
    );
}
