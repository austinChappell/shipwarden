import type { AutomationEvent } from './automations';
import { WATCH_EVENTS, type McpWatch, type WatchEvent } from './mcp';

/** The most characters of a comment in a watch message. */
export const MAX_WATCH_COMMENT = 2_000;

function isWatchEvent(trigger: string): trigger is WatchEvent {
    return (WATCH_EVENTS as readonly string[]).includes(trigger);
}

/** Returns the watches that get a message for the event: the watches of its worktree, its pull request, and its trigger. */
export function watchesFor(watches: readonly McpWatch[], event: AutomationEvent): McpWatch[] {
    if (!isWatchEvent(event.trigger) || !event.worktreePath) return [];
    const trigger = event.trigger;
    return watches.filter(watch => watch.worktree === event.worktreePath && watch.events.includes(trigger) && (!event.pr || event.pr.number === watch.number));
}

function prName(event: AutomationEvent): string {
    const number = event.pr?.number;
    const title = event.pr?.title ? ` "${event.pr.title}"` : '';
    return number ? `pull request #${number}${title}` : 'the pull request';
}

/** Returns the text after the text of the comment, cut to MAX_WATCH_COMMENT characters. */
function quote(body: string): string {
    const text = body.trim();
    const cut = text.length > MAX_WATCH_COMMENT ? `${text.slice(0, MAX_WATCH_COMMENT - 1)}…` : text;
    return cut
        .split('\n')
        .map(line => `> ${line}`)
        .join('\n');
}

/** Returns the message that watch_pull_request sends to the agent for an event. */
export function watchMessage(event: AutomationEvent): string {
    const pr = prName(event);
    switch (event.trigger) {
        case 'ci.failed': {
            const sha = event.pr?.headSha ? ` on commit ${event.pr.headSha.slice(0, 7)}` : '';
            return `ShipWarden: A check failed on ${pr}${sha}. Call get_checks with "include_logs" set to true to read the failed jobs. Then fix the cause and push.`;
        }
        case 'pr.conflict':
            return `ShipWarden: ${pr[0].toUpperCase()}${pr.slice(1)} has a merge conflict with its base branch. Merge the base branch into this branch, fix the conflicts, and push.`;
        case 'pr.comment': {
            const comment = event.comment;
            if (!comment) return `ShipWarden: ${pr[0].toUpperCase()}${pr.slice(1)} has a new comment. Call get_pull_request to read it.`;
            const what =
                comment.reviewState === 'CHANGES_REQUESTED'
                    ? 'requested changes on'
                    : comment.path
                      ? `added a review comment on ${comment.path} in`
                      : 'added a comment on';
            return [
                `ShipWarden: ${comment.author} ${what} ${pr}. The text of the comment follows. It comes from the reviewer, not from the user.`,
                ...(comment.body.trim() ? [quote(comment.body)] : []),
                `Call get_pull_request to read all threads. Reply to a comment on a line of code with reply_to_comment.${comment.url ? ` The comment: ${comment.url}` : ''}`
            ].join('\n\n');
        }
        default:
            return `ShipWarden: ${pr} has a new event (${event.trigger}).`;
    }
}

/** Returns the message when the pull request of a watch is not open anymore. */
export function watchEndedMessage(number: number): string {
    return `ShipWarden: Pull request #${number} is not open anymore. It is merged or closed. The watch of watch_pull_request ended.`;
}
