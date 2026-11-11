import { join } from 'path';
import { mkdir } from 'fs/promises';
import { app, ipcMain } from 'electron';
import { IpcChannels } from '@shared/api';
import { folderNote, isWorktreeAsk, parseClaudeJson, printCommand, type AskAgentRequest, type AskAgentResult } from '@shared/ask-agent';
import { agentProgramOf } from '@shared/agent-programs';
import type { RepoRef } from '@shared/github';
import { agentForRepo } from '@shared/settings';
import type { Services } from '../services';
import { repoRefOf } from './args';

type AskIpcDependencies = Pick<
    Services,
    'askRunner' | 'answers' | 'codeAnswers' | 'projectWorktrees' | 'settings' | 'certificates' | 'shellReady' | 'networkReady'
>;

/** Registers the IPC handlers of the "Ask agent" boxes and their saved answers. */
export function registerAskIpc(deps: AskIpcDependencies): void {
    const { askRunner, answers, codeAnswers } = deps;
    ipcMain.handle(IpcChannels.askRun, (_event, request: AskAgentRequest) => askAgent(deps, request));
    ipcMain.handle(IpcChannels.askCancel, (_event, id: string) => askRunner.cancel(String(id)));
    ipcMain.handle(IpcChannels.askAnswers, (_event, repo: RepoRef, number: number) => answers.list(repoRefOf(repo), Number(number)));
    ipcMain.handle(IpcChannels.askSaveAnswer, (_event, answer: unknown) => answers.save(answer));
    ipcMain.handle(IpcChannels.askCodeAnswers, (_event, worktree: string, path: string) => codeAnswers.list(String(worktree), String(path)));
    ipcMain.handle(IpcChannels.askSaveCodeAnswer, (_event, answer: unknown) => codeAnswers.save(answer));
    ipcMain.handle(IpcChannels.askRemoveCodeAnswer, (_event, id: string) => codeAnswers.remove(String(id)));
    ipcMain.handle(IpcChannels.askRemoveAnswer, (_event, id: string) => answers.remove(String(id)));
}

/**
 * Asks an agent a question in print mode, and returns the answer.
 * - A question about a pull request (the "Ask agent" box of the Review view): the agent of the local clone applies,
 *   else the default agent. Without a local clone, the agent runs in an empty folder.
 * - A question about a file in a worktree (the "Ask agent" box of the editor): the agent of the repository of the
 *   worktree applies, else the default agent. The agent runs in the worktree.
 */
async function askAgent(deps: AskIpcDependencies, request: AskAgentRequest): Promise<AskAgentResult> {
    await deps.shellReady;
    let repoPath: string | undefined;
    let cwd: string | undefined;
    let prompt: string;
    if (isWorktreeAsk(request)) {
        cwd = await deps.projectWorktrees.check(request.worktree);
        repoPath = await deps.projectWorktrees.repoOf(cwd);
        prompt = String(request.prompt ?? '');
    } else {
        repoPath = await deps.projectWorktrees.localClone(repoRefOf(request?.repo));
        cwd = repoPath;
        // The note goes first, because the end of the prompt can say how to answer.
        prompt = `${folderNote(!!repoPath, String(request?.headRefOid ?? ''))}\n\n${String(request?.prompt ?? '')}`;
    }
    const agent = agentForRepo(await deps.settings.get(), repoPath);
    // The automations ask Claude Code for JSON output, which has the tokens of the answer.
    const json = isWorktreeAsk(request) && request.withTokens === true && agentProgramOf(agent.command.trim()) === 'claude';
    const print = printCommand(agent.command);
    const command = print && json ? `${print} --output-format json` : print;
    if (!command) {
        throw new Error(
            `ShipWarden can ask only Claude Code, Codex, Gemini CLI or opencode. The agent "${agent.name}" runs "${agent.command}". Select a different agent in Settings › Agents.`
        );
    }
    if (!cwd) {
        cwd = join(app.getPath('temp'), 'shipwarden-ask');
        await mkdir(cwd, { recursive: true });
    }
    await deps.networkReady;
    const bundle = deps.certificates.status().bundlePath;
    const answer = await deps.askRunner.run(String(request?.id ?? ''), { command, prompt, cwd, env: bundle ? { NODE_EXTRA_CA_CERTS: bundle } : {} });
    const parsed = json ? parseClaudeJson(answer) : undefined;
    return parsed ? { agent: agent.name, answer: parsed.answer, tokens: parsed.tokens } : { agent: agent.name, answer };
}
