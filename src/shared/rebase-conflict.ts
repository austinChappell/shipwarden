/**
 * The agent prompt for a rebase that stopped on a conflict. The prompt is a template, so the user can change it: a
 * prompt template file with the ID `CONFLICT_TEMPLATE_ID` replaces the default text.
 *
 * This module uses no Electron API and no browser API.
 */
import { renderTemplate } from './automation-templates';
import type { RebaseConflictInput } from './git';
import { worktreeName, type WorktreeOverlap } from './worktree-overlap';

/** The ID of the prompt template file that replaces the default conflict prompt: ~/.shipwarden/prompts/pr-conflict.json. */
export const CONFLICT_TEMPLATE_ID = 'pr-conflict';

/** The rule for each conflict of a rebase. The "Rebase with agent" prompt of the Review page uses it too. */
export function resolveRule(branch: string): string {
    return `Keep the intent of the commits on ${branch}, and keep the changes of the other side.`;
}

/** The variables of the conflict prompt, with a description for the docs. */
export const CONFLICT_VARIABLES: readonly { name: string; description: string }[] = [
    { name: 'conflict.branch', description: 'The branch that the rebase moves' },
    { name: 'conflict.onto', description: 'The branch that the rebase moves onto, for example origin/main' },
    { name: 'conflict.commit', description: 'The commit that stopped the rebase: its short hash and subject' },
    { name: 'conflict.files', description: 'The files with conflicts, one on each line' },
    { name: 'conflict.branchCommits', description: 'The commits of the branch that change these files' },
    { name: 'conflict.baseCommits', description: 'The commits of the other side that change these files' },
    { name: 'conflict.overlap', description: 'The other worktrees that change the same files' },
    { name: 'conflict.rule', description: 'The rule for each conflict' }
];

/** The default text of the conflict prompt. */
export const DEFAULT_CONFLICT_TEMPLATE = [
    'The rebase of {{conflict.branch}} onto {{conflict.onto}} stopped on a merge conflict at commit {{conflict.commit}}.',
    '',
    'The files with conflicts:',
    '{{conflict.files}}',
    '',
    'The commits of {{conflict.branch}} that change these files:',
    '{{conflict.branchCommits}}',
    '',
    'The commits of {{conflict.onto}} that change these files:',
    '{{conflict.baseCommits}}',
    '',
    'Other worktrees that change the same files:',
    '{{conflict.overlap}}',
    '',
    'Do these steps:',
    '',
    '1. Resolve the conflict markers in each file. {{conflict.rule}}',
    '2. Make sure that the code compiles and that the tests of these files pass.',
    '3. Run "git add" for each resolved file.',
    '',
    'Do not run "git rebase --continue", "git rebase --skip", or "git rebase --abort". Do not commit and do not push. I continue the rebase in ShipWarden. If you cannot resolve a conflict, stop and tell me why.'
].join('\n');

/** Returns a list with one item on each line, or "None." for an empty list. */
function lines(items: readonly string[]): string {
    return items.length ? items.map(item => `- ${item}`).join('\n') : 'None.';
}

/**
 * Returns the other worktrees that change one or more of the files, with these files. A worktree without such a file is
 * not in the list.
 */
export function overlapLines(overlap: Pick<WorktreeOverlap, 'peers'> | undefined, files: readonly string[]): string[] {
    const wanted = new Set(files);
    return (overlap?.peers ?? [])
        .map(peer => ({ peer, shared: peer.files.filter(file => wanted.has(file)) }))
        .filter(item => item.shared.length > 0)
        .map(({ peer, shared }) => `${worktreeName(peer)} (${peer.path}): ${shared.join(', ')}`);
}

/** Returns the values of the variables of the conflict prompt. */
export function conflictValues(input: RebaseConflictInput, overlap?: Pick<WorktreeOverlap, 'peers'>): Record<string, string> {
    const branch = input.branch ?? 'HEAD';
    return {
        'conflict.branch': branch,
        'conflict.onto': input.onto,
        'conflict.commit': input.stopped ? `${input.stopped.hash} "${input.stopped.subject}"` : 'unknown',
        'conflict.files': lines(input.files),
        'conflict.branchCommits': lines(input.branchCommits),
        'conflict.baseCommits': lines(input.baseCommits),
        'conflict.overlap': lines(overlapLines(overlap, input.files)),
        'conflict.rule': resolveRule(branch)
    };
}

/**
 * Makes the agent prompt for a rebase conflict. `template` is the text of the user's "pr-conflict" template. Without
 * it, the default text applies.
 */
export function rebaseConflictPrompt(input: RebaseConflictInput, overlap?: Pick<WorktreeOverlap, 'peers'>, template?: string): string {
    return renderTemplate(template?.trim() ? template : DEFAULT_CONFLICT_TEMPLATE, conflictValues(input, overlap));
}
