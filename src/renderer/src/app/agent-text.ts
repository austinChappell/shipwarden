import type { CheckRun } from '@shared/github';

/**
 * Text of agent dialogs that wait for a decision of the user, for example Claude Code's folder trust question.
 * The patterns have no spaces, because ShipWarden removes the whitespace from the screen text before the test.
 * ShipWarden must not answer these dialogs. A pasted prompt and Enter would select the default answer.
 */
const AGENT_DIALOG_PATTERN = /trustthisfolder|Entertoconfirm|Doyouwanttoproceed/i;

/**
 * True when the screen text of an agent shows a dialog that waits for the user.
 * ghostty-web 0.4 can return the text without its spaces. Thus the test removes all whitespace first.
 */
export function showsAgentDialog(screen: string): boolean {
    return AGENT_DIALOG_PATTERN.test(screen.replace(/\s+/g, ''));
}

/** Returns the prompt as a bracketed paste. Then new lines in the prompt do not submit it early. */
export function bracketedPaste(prompt: string): string {
    return `\x1b[200~${prompt}\x1b[201~`;
}

/** Returns the prompt that sends the log of one failed CI job to an agent. */
export function logPrompt(checkName: string, logPath: string): string {
    return `The CI job "${checkName}" failed on this branch. The full log is in ${logPath}. Find the cause of the failure and fix it.`;
}

/**
 * Returns the line of one failed check in the prompt for all failed checks.
 * `logPath` is the path of the saved log of a GitHub Actions job. Other checks give their link.
 */
export function checkLine(check: Pick<CheckRun, 'name' | 'url'>, logPath?: string): string {
    if (logPath !== undefined) {
        return `- "${check.name}": the full log is in ${logPath}`;
    }
    return `- "${check.name}"${check.url ? `: the details are at ${check.url}` : ''}`;
}

/** Returns the prompt that sends all failed checks of a pull request to an agent. Each line comes from `checkLine`. */
export function checksPrompt(lines: readonly string[]): string {
    return [
        `${lines.length === 1 ? 'A CI check' : `${lines.length} CI checks`} failed on the pull request of this branch:`,
        ...lines,
        'Find the cause of each failure and fix it. Run the tests, and then commit the fix.'
    ].join('\n');
}

/** Returns the name of the repository folder: the last part of its path. */
export function repoFolderName(repoPath: string): string {
    return repoPath.split('/').filter(Boolean).pop() ?? repoPath;
}
