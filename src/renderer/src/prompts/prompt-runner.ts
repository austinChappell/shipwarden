import { fillPrompt, missingVariables, promptValues, type PromptContext, type PromptTemplate } from '@shared/prompt-templates';
import type { TerminalSession } from '@shared/terminal';
import { bracketedPaste, showsAgentDialog } from '../app/agent-text';
import { screenTextOf } from '../app/use-agent-actions';
import { terminalPool } from '../terminal/terminal-pool';
import { fillPromptDialog } from './PromptFillDialog';

const api = window.shipwarden;

/** The terminal that gets a template, and the worktree data for the variables. */
export interface PromptTarget {
    session: TerminalSession;
    context: PromptContext;
}

/**
 * Finds the target of a template. With `sessionId`, the target is that terminal. Without it, the target is the agent
 * terminal on the screen. Throws an error with a message for the user when there is no target.
 */
export type PromptTargetResolver = (sessionId?: string) => Promise<PromptTarget>;

let resolver: PromptTargetResolver | undefined;
let manage: (() => void) | undefined;

/**
 * The app sets the resolver, because only the app knows the panes, the worktrees, and the task links. `onManage` opens
 * Settings › Prompt templates.
 */
export function setPromptActions(next: PromptTargetResolver, onManage: () => void): void {
    resolver = next;
    manage = onManage;
}

/** Opens Settings › Prompt templates. */
export function manageTemplates(): void {
    manage?.();
}

/** The time between the paste and Enter. The agent must read the paste first, as in "send to agent". */
const ENTER_DELAY_MS = 200;

/**
 * Inserts a template into an agent terminal.
 * 1. ShipWarden fills the variables from the worktree of the terminal.
 * 2. A variable without a value gets a field in a dialog. ShipWarden never sends an empty value.
 * 3. The text goes in as a bracketed paste, so a new line does not send it early.
 * 4. By default, ShipWarden does not press Enter, so the user can edit the prompt. A template with `send`, or the
 *    "Send" button of the dialog, presses Enter.
 * Throws an error with a message for the user.
 */
export async function runPromptTemplate(template: PromptTemplate, sessionId?: string): Promise<void> {
    if (!resolver) throw new Error('ShipWarden is starting. Try again in a few seconds.');
    const { session, context } = await resolver(sessionId);
    let values = promptValues(context);
    let send = template.send === true;
    const missing = missingVariables(template.prompt, values);
    if (missing.length > 0) {
        const answer = await fillPromptDialog({ name: template.name, prompt: template.prompt, known: values, missing, send });
        if (!answer) return;
        values = { ...values, ...answer.values };
        send = answer.send;
    }
    const screen = await screenTextOf(session.id);
    if (screen !== undefined && showsAgentDialog(screen)) {
        throw new Error('The agent is asking a question. Answer it in the agent tab, then insert the template again.');
    }
    api.terminals.write(session.id, bracketedPaste(fillPrompt(template.prompt, values)));
    if (send) setTimeout(() => api.terminals.write(session.id, '\r'), ENTER_DELAY_MS);
    terminalPool.focus(session.id);
}
