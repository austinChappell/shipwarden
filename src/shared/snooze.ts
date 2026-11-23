import type { MyPullRequestItem, ReviewRequestItem } from './dashboard';
import type { OpenPullRequest } from './review-queue';

/**
 * A snooze hides a pull request from the lists of work that needs the user ("Needs me", the Dashboard, and the
 * review queue). A snooze ends at a time, or when the pull request has new activity.
 */

/**
 * The state of a pull request that tells if it changed. A snooze "until new activity" keeps a copy of this state and
 * compares it with the state of each load.
 */
export interface PullRequestActivity {
    /** The head commit. A new commit, a rebase, or a force push changes it. Undefined when the provider does not give it. */
    head?: string;
    /** The time of the newest comment or review from another person. Comments from bots and from the user do not count. */
    lastActivityAt?: string;
    /** The time of the last update of the pull request. The snooze uses it only when no view knows the head commit. */
    updatedAt?: string;
    /**
     * What the pull request needs from the user, for example "conflicts,ci-failing" for a pull request of the user, or
     * "review" when GitHub asks the user for a review. A change shows the pull request again.
     */
    needs?: string;
}

/** The needs of a pull request of the user: its reasons in a fixed order. */
function authorNeeds(reasons: readonly string[]): string {
    return [...reasons].sort().join(',');
}

/** The activity state of a pull request of the Review view. */
export function openPullRequestActivity(pr: OpenPullRequest): PullRequestActivity {
    return {
        head: pr.headRefOid || undefined,
        lastActivityAt: pr.lastActivityAt,
        updatedAt: pr.updatedAt,
        needs: pr.viewerDidAuthor ? authorNeeds(pr.actions) : pr.reviewRequested ? 'review' : ''
    };
}

/** The activity state of a review item of the Dashboard. An item without `activity` is a request from the provider. */
export function reviewItemActivity(item: ReviewRequestItem): PullRequestActivity {
    return { head: item.headSha || undefined, lastActivityAt: item.lastActivityAt, updatedAt: item.updatedAt, needs: item.activity ? '' : 'review' };
}

/** The activity state of a pull request of the user on the Dashboard. */
export function myItemActivity(item: MyPullRequestItem): PullRequestActivity {
    return { head: item.headSha || undefined, lastActivityAt: item.lastActivityAt, updatedAt: item.updatedAt, needs: authorNeeds(item.reasons) };
}

/** A snooze of one pull request. */
export interface Snooze {
    /** The time of the snooze, in milliseconds since 1970. */
    at: number;
    /** The end of a snooze for a fixed time, in milliseconds since 1970. */
    until?: number;
    /** The state of the pull request at the time of a snooze "until new activity". */
    activity?: PullRequestActivity;
}

/** The snoozes by key (see `snoozeKey`). */
export type Snoozes = Record<string, Snooze>;

/** The store removes a snooze "until new activity" after this time, because the pull request is usually closed then. */
export const SNOOZE_KEEP_MS = 90 * 24 * 3600 * 1000;

/** The key of the snooze of a pull request. The URL identifies the pull request in all providers. */
export function snoozeKey(url: string): string {
    return `pr:${url}`;
}

/** True when the value has the shape of a snooze. The main process checks the data from the renderer with it. */
export function isSnooze(value: unknown): value is Snooze {
    if (!value || typeof value !== 'object') return false;
    const snooze = value as Snooze;
    if (typeof snooze.at !== 'number' || !Number.isFinite(snooze.at)) return false;
    if (snooze.until !== undefined && (typeof snooze.until !== 'number' || !Number.isFinite(snooze.until))) return false;
    if (snooze.activity !== undefined) {
        if (!snooze.activity || typeof snooze.activity !== 'object') return false;
        const fields = ['head', 'lastActivityAt', 'updatedAt', 'needs'] as const;
        if (fields.some(field => snooze.activity![field] !== undefined && typeof snooze.activity![field] !== 'string')) return false;
    }
    // A snooze has one end: a time or new activity.
    return (snooze.until === undefined) !== (snooze.activity === undefined);
}

/** True when the store can remove the snooze: its time ended, or it is older than the keep time. */
export function isSnoozeOld(snooze: Snooze, now: number): boolean {
    if (snooze.until !== undefined) return snooze.until <= now;
    return now - snooze.at > SNOOZE_KEEP_MS;
}

/** True when the pull request has new activity after the snooze. */
export function hasNewActivity(saved: PullRequestActivity, current: PullRequestActivity): boolean {
    if (saved.head && current.head) {
        if (saved.head !== current.head) return true;
    } else if (saved.updatedAt && current.updatedAt && Date.parse(current.updatedAt) > Date.parse(saved.updatedAt)) {
        // Without the head commit, any update shows the pull request again.
        return true;
    }
    // A later time only. A view with older data must not end the snooze.
    if (current.lastActivityAt && (!saved.lastActivityAt || Date.parse(current.lastActivityAt) > Date.parse(saved.lastActivityAt))) return true;
    return saved.needs !== undefined && current.needs !== undefined && saved.needs !== current.needs;
}

/** True when the snooze hides the pull request now. */
export function isSnoozeActive(snooze: Snooze | undefined, current: PullRequestActivity, now: number): boolean {
    if (!snooze) return false;
    if (snooze.until !== undefined) return now < snooze.until;
    return !!snooze.activity && !hasNewActivity(snooze.activity, current);
}

/** The choices of the Snooze menu. */
export type SnoozeChoice = 'activity' | 'hour' | 'hours' | 'tomorrow' | 'week';

export const SNOOZE_CHOICES: { id: SnoozeChoice; label: string }[] = [
    { id: 'activity', label: 'Until new activity' },
    { id: 'hour', label: 'For 1 hour' },
    { id: 'hours', label: 'For 4 hours' },
    { id: 'tomorrow', label: 'Until tomorrow' },
    { id: 'week', label: 'Until next week' }
];

/** The hour of the morning when a snooze until tomorrow or until next week ends. */
const MORNING_HOUR = 9;

/** Returns the end of a timed choice: 9:00 tomorrow, or 9:00 on the next Monday. Returns undefined for "activity". */
export function snoozeEnd(choice: SnoozeChoice, now: Date): number | undefined {
    const morning = (days: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, MORNING_HOUR).getTime();
    switch (choice) {
        case 'activity':
            return undefined;
        case 'hour':
            return now.getTime() + 3600_000;
        case 'hours':
            return now.getTime() + 4 * 3600_000;
        case 'tomorrow':
            return morning(1);
        case 'week':
            // The days to the next Monday. On a Monday, the next Monday is in 7 days.
            return morning((8 - now.getDay()) % 7 || 7);
    }
}

/** Makes the snooze of a choice. */
export function makeSnooze(choice: SnoozeChoice, activity: PullRequestActivity, now: Date): Snooze {
    const until = snoozeEnd(choice, now);
    return until === undefined ? { at: now.getTime(), activity } : { at: now.getTime(), until };
}

/** The text of the end of a snooze, for example "until new activity", "until 3:45 PM", or "until tomorrow at 9:00 AM". */
export function snoozeText(snooze: Snooze, now: Date, locale?: string): string {
    if (snooze.until === undefined) return 'until new activity';
    const end = new Date(snooze.until);
    const time = end.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
    const day = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const days = Math.round((day(end) - day(now)) / 86_400_000);
    if (days <= 0) return `until ${time}`;
    if (days === 1) return `until tomorrow at ${time}`;
    if (days < 7) return `until ${end.toLocaleDateString(locale, { weekday: 'long' })} at ${time}`;
    return `until ${end.toLocaleDateString(locale, { month: 'short', day: 'numeric' })} at ${time}`;
}

/** Returns the first end of a timed snooze after `now`. The views show the pull request again at that time. */
export function nextSnoozeEnd(snoozes: Snoozes, now: number): number | undefined {
    let next: number | undefined;
    for (const snooze of Object.values(snoozes)) {
        if (snooze.until !== undefined && snooze.until > now && (next === undefined || snooze.until < next)) next = snooze.until;
    }
    return next;
}
