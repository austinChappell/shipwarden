import { join } from 'path';
import { mkdir } from 'fs/promises';
import { app, ipcMain } from 'electron';
import { IpcChannels } from '@shared/api';
import { folderNote, isWorktreeAsk, parseClaudeJson, printCommand, type AskAgentRequest, type AskAgentResult } from '@shared/ask-agent';
import { agentProgramOf } from '@shared/agent-programs';
import { cleanDraft, commitDraftPrompt, pullRequestDraftPrompt, resolveDraftSettings, type DraftRequest, type DraftResult } from '@shared/drafts';
import type { RepoRef } from '@shared/github';
import { agentForRepo, type AgentDefinition } from '@shared/settings';
import type { Services } from '../services';
import { repoRefOf } from './args';

type AskIpcDependencies = Pick<
    Services,
    'askRunner' | 'answers' | 'codeAnswers' | 'projectWorktrees' | 'settings' | 'certificates' | 'shellReady' | 'networkReady' | 'gitChanges'
>;

/** Registers the IPC handlers of the "Ask agent" boxes and their saved answers. */
export function registerAskIpc(deps: AskIpcDependencies): void {
    const { askRunner, answers, codeAnswers } = deps;
    ipcMain.handle(IpcChannels.askRun, (_event, request: AskAgentRequest) => askAgent(deps, request));
    ipcMain.handle(IpcChannels.askDraft, (_event, request: DraftRequest) => draft(deps, request));
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
    const settings = await deps.settings.get();
    const agent = agentForRepo(settings, repoPath);
    // The automations ask Claude Code for JSON output, which has the tokens of the answer.
    const json = isWorktreeAsk(request) && request.withTokens === true && agentProgramOf(agent.command.trim()) === 'claude';
    const print = printCommand(agent.command);
    const command = print && json ? `${print} --output-format json` : print;
    const answer = await runPrint(deps, String(request?.id ?? ''), agent, command, prompt, cwd);
    const parsed = json ? parseClaudeJson(answer) : undefined;
    return parsed ? { agent: agent.name, answer: parsed.answer, tokens: parsed.tokens, cacheReads: parsed.cacheReads } : { agent: agent.name, answer };
}

/**
 * Asks the agent of the repository of a worktree for a draft: a commit message of the staged changes, or a pull
 * request description of the branch. The prompt has the diff and the draft settings of the repository. For a pull
 * request, it also has the pull request template of the repository.
 */
async function draft(deps: AskIpcDependencies, request: DraftRequest): Promise<DraftResult> {
    await deps.shellReady;
    const cwd = await deps.projectWorktrees.check(request?.worktree);
    const repoPath = await deps.projectWorktrees.repoOf(cwd);
    const settings = await deps.settings.get();
    const draftSettings = resolveDraftSettings(settings.drafts, repoPath ? settings.repos[repoPath]?.drafts : undefined);
    const prompt =
        request?.kind === 'pullRequest'
            ? pullRequestDraftPrompt({ ...(await deps.gitChanges.pullRequestDraftInput(cwd)), settings: draftSettings })
            : commitDraftPrompt({ ...(await deps.gitChanges.commitDraftInput(cwd, request?.amend === true)), settings: draftSettings });
    const agent = agentForRepo(settings, repoPath);
    const answer = await runPrint(deps, String(request?.id ?? ''), agent, printCommand(agent.command), prompt, cwd);
    const text = cleanDraft(answer);
    if (!text) throw new Error(`${agent.name} gave an empty draft.`);
    return { agent: agent.name, text };
}

/** Runs an agent in print mode with the prompt on stdin, and returns its output. Without a folder, the agent runs in an empty temporary folder. */
async function runPrint(
    deps: AskIpcDependencies,
    id: string,
    agent: AgentDefinition,
    command: string | undefined,
    prompt: string,
    cwd: string | undefined
): Promise<string> {
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
    return deps.askRunner.run(id, { command, prompt, cwd, env: bundle ? { NODE_EXTRA_CA_CERTS: bundle } : {} });
}
