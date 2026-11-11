import { branchValues, parseShortDescription, renderBranchTemplate, shortDescriptionPrompt, usesVariable } from '@shared/branch-template';
import { branchNameForTask, type Task } from '@shared/tasks';
import { keyRoots, queryClient } from '../query-client';

const api = window.shipwarden;

/** The app info. It does not change in a session, so it loads one time. */
export function fetchAppInfo() {
    return queryClient.fetchQuery({ queryKey: keyRoots.appInfo, queryFn: () => api.app.info(), staleTime: Number.POSITIVE_INFINITY });
}

/** The result of `taskBranchName`. */
export interface TaskBranch {
    branch: string;
    /** A note for the user when the agent did not write the short description. The branch then uses the title. */
    note?: string;
}

/**
 * Makes the branch name for a task from the branch template in Settings › Worktrees.
 * Without a template, the name comes from the task key and the title (`branchNameForTask`).
 * When the template has {taskShortDescription}, the agent of the repository writes the short description. This takes a few seconds.
 * When the agent fails, the short description comes from the title. The function does not throw for an agent failure.
 */
export async function taskBranchName(task: Task, repoPath: string, template: string | undefined): Promise<TaskBranch> {
    if (!template?.trim()) return { branch: branchNameForTask(task) };
    const username = usesVariable(template, 'username')
        ? await fetchAppInfo().then(
              info => info.username,
              () => ''
          )
        : '';
    let shortDescription: string | undefined;
    let note: string | undefined;
    if (usesVariable(template, 'taskShortDescription')) {
        try {
            const result = await api.ask.run({ id: `branch-${crypto.randomUUID()}`, worktree: repoPath, prompt: shortDescriptionPrompt(task) });
            shortDescription = parseShortDescription(result.answer);
            if (!shortDescription) note = 'The agent gave no short description. The branch uses the title.';
        } catch (err) {
            note = `The agent did not write a short description, so the branch uses the title. ${err instanceof Error ? err.message : String(err)}`;
        }
    }
    const branch = renderBranchTemplate(template, branchValues(task, username, shortDescription)) || branchNameForTask(task);
    return { branch, ...(note ? { note } : {}) };
}
