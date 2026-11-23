import type { MyPullRequestItem, PipelineApprovalItem, ReviewRequestItem } from './dashboard';
import type { OpenPullRequest } from './review-queue';

/**
 * A snooze hides a pull request from the lists of work that needs the user ("Needs me", the Dashboard, and the
 * review queue). A snooze ends at a time, or when the pull request has new activity. A snooze also hides a pipeline
 * run that waits for the approval of the user. That snooze ends at a time, or when the run waits at a different stage.
 * A snooze of a pipeline hides all runs of the pipeline, also the runs in the future. It ends at a time, or it has no end.
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

/**
 * The activity state of a pipeline run that waits for the approval of the user. The approvals change when the run
 * waits at a different stage. A new run of the pipeline has a different key, so it shows on the Dashboard.
 */
export function pipelineRunActivity(item: PipelineApprovalItem): PullRequestActivity {
    const ids = item.target.kind === 'github' ? item.target.environmentIds.map(String) : item.target.approvalIds;
    return { needs: [...ids].sort().join(',') };
}

/** A snooze of one pull request, one pipeline run, or one pipeline. */
export interface Snooze {
    /** The time of the snooze, in milliseconds since 1970. */
    at: number;
    /** The end of a snooze for a fixed time, in milliseconds since 1970. */
    until?: number;
    /** The state of the pull request at the time of a snooze "until new activity". */
    activity?: PullRequestActivity;
    /** True for a snooze with no end. Only the user can remove it. */
    forever?: true;
    /** The pipeline of a snooze of a pipeline. The Snoozed card shows it also when no run of the pipeline waits. */
    pipeline?: SnoozedPipeline;
}

/** The pipeline of a snooze of a pipeline, as the Snoozed card shows it. */
export interface SnoozedPipeline {
    /** The name of the workflow or pipeline. */
    name: string;
    /** The short name of the place: the GitHub repository or the Azure DevOps project. */
    source: string;
    /** The full name of the place, for the tooltip. */
    sourceTitle: string;
    /** The page of the pipeline. */
    url: string;
}

/** The longest text of a field of a snoozed pipeline. */
const MAX_PIPELINE_TEXT = 2000;

/** True when the value has the shape of a snoozed pipeline. */
function isSnoozedPipeline(value: unknown): value is SnoozedPipeline {
    if (!value || typeof value !== 'object') return false;
    const pipeline = value as SnoozedPipeline;
    return (['name', 'source', 'sourceTitle', 'url'] as const).every(
        field => typeof pipeline[field] === 'string' && pipeline[field].length <= MAX_PIPELINE_TEXT
    );
}

/** The pipeline of a waiting run, for a snooze of the pipeline. Undefined when the provider does not give the pipeline. */
export function snoozedPipelineOf(item: PipelineApprovalItem): SnoozedPipeline | undefined {
    return item.pipeline && { name: item.workflow, source: item.source, sourceTitle: item.sourceTitle, url: item.pipeline.url };
}

/** The snoozes by key (see `snoozeKey`). */
export type Snoozes = Record<string, Snooze>;

/** The store removes a snooze "until new activity" after this time, because the pull request is usually closed then. */
export const SNOOZE_KEEP_MS = 90 * 24 * 3600 * 1000;

/** The key of the snooze of a pull request. The URL identifies the pull request in all providers. */
export function snoozeKey(url: string): string {
    return `pr:${url}`;
}

/** The key of the snooze of a pipeline run. The ID identifies the run in all providers. */
export function runSnoozeKey(id: string): string {
    return `run:${id}`;
}

/** The prefix of the key of the snooze of a pipeline. */
const PIPELINE_KEY_PREFIX = 'pipeline:';

/** The key of the snooze of a pipeline. It hides all runs of the pipeline (see `PipelineRef.id`). */
export function pipelineSnoozeKey(pipelineId: string): string {
    return `${PIPELINE_KEY_PREFIX}${pipelineId}`;
}

/** True when the key is the key of the snooze of a pipeline. */
export function isPipelineSnoozeKey(key: string): boolean {
    return key.startsWith(PIPELINE_KEY_PREFIX);
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
    if (snooze.forever !== undefined && snooze.forever !== true) return false;
    if (snooze.pipeline !== undefined && !isSnoozedPipeline(snooze.pipeline)) return false;
    // A snooze has one end: a time, new activity, or no end.
    return [snooze.until, snooze.activity, snooze.forever].filter(end => end !== undefined).length === 1;
}

/** True when the store can remove the snooze: its time ended, or it is older than the keep time. A snooze with no end stays. */
export function isSnoozeOld(snooze: Snooze, now: number): boolean {
    if (snooze.forever) return false;
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
    if (snooze.forever) return true;
    if (snooze.until !== undefined) return now < snooze.until;
    return !!snooze.activity && !hasNewActivity(snooze.activity, current);
}

/** The choices of the Snooze menu. */
export type SnoozeChoice = 'activity' | 'hour' | 'hours' | 'tomorrow' | 'week' | 'forever';

/** The thing that a snooze hides. The text of the "activity" choice changes with it. */
export type SnoozeSubject = 'pull-request' | 'pipeline-run' | 'pipeline';

/** The text of the end of a snooze "until new activity", by subject. A pipeline has no activity. */
const UNTIL_ACTIVITY: Record<SnoozeSubject, string> = {
    'pull-request': 'until new activity',
    'pipeline-run': 'until the run changes',
    pipeline: 'until the pipeline changes'
};

/** The text of the end of a snooze with no end. */
const FOREVER_TEXT = 'until you unsnooze it';

/**
 * Returns the choices of the Snooze menu for the subject. A pipeline has the timed choices and "Until I unsnooze it",
 * because it has no activity. The other subjects do not have "Until I unsnooze it".
 */
export function snoozeChoices(subject: SnoozeSubject): { id: SnoozeChoice; label: string }[] {
    if (subject === 'pipeline') {
        return [...SNOOZE_CHOICES.filter(choice => choice.id !== 'activity'), { id: 'forever', label: 'Until I unsnooze it' }];
    }
    const activity = UNTIL_ACTIVITY[subject];
    return SNOOZE_CHOICES.map(choice => (choice.id === 'activity' ? { ...choice, label: activity.charAt(0).toUpperCase() + activity.slice(1) } : choice));
}

export const SNOOZE_CHOICES: { id: SnoozeChoice; label: string }[] = [
    { id: 'activity', label: 'Until new activity' },
    { id: 'hour', label: 'For 1 hour' },
    { id: 'hours', label: 'For 4 hours' },
    { id: 'tomorrow', label: 'Until tomorrow' },
    { id: 'week', label: 'Until next week' }
];

/** The hour of the morning when a snooze until tomorrow or until next week ends. */
const MORNING_HOUR = 9;

/** Returns the end of a timed choice: 9:00 tomorrow, or 9:00 on the next Monday. Returns undefined for "activity" and "forever". */
export function snoozeEnd(choice: SnoozeChoice, now: Date): number | undefined {
    const morning = (days: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, MORNING_HOUR).getTime();
    switch (choice) {
        case 'activity':
        case 'forever':
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

/** Makes the snooze of a choice. A snooze of a pipeline also keeps the pipeline. */
export function makeSnooze(choice: SnoozeChoice, activity: PullRequestActivity, now: Date, pipeline?: SnoozedPipeline): Snooze {
    const extra = pipeline ? { pipeline } : {};
    if (choice === 'forever') return { at: now.getTime(), forever: true, ...extra };
    const until = snoozeEnd(choice, now);
    return until === undefined ? { at: now.getTime(), activity, ...extra } : { at: now.getTime(), until, ...extra };
}

/**
 * The text of the end of a snooze, for example "until new activity", "until 3:45 PM", "until tomorrow at 9:00 AM", or
 * "until you unsnooze it".
 */
export function snoozeText(snooze: Snooze, now: Date, locale?: string, subject: SnoozeSubject = 'pull-request'): string {
    if (snooze.forever) return FOREVER_TEXT;
    if (snooze.until === undefined) return UNTIL_ACTIVITY[subject];
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
