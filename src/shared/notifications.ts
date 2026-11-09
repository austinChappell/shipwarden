import type { BranchSummary } from './github';

/** The events that can show a macOS notification. */
export type NotificationEvent = 'agentWaiting' | 'agentDone' | 'ciFinished' | 'dashboard';

export const NOTIFICATION_EVENTS: { id: NotificationEvent; label: string; description: string }[] = [
    { id: 'agentWaiting', label: 'Agent needs input', description: 'An agent waits for your answer or for a permission.' },
    { id: 'agentDone', label: 'Agent finished', description: 'An agent ended its turn.' },
    { id: 'ciFinished', label: 'CI finished', description: 'The checks of a pull request passed or failed. The menu selects which pull requests.' },
    { id: 'dashboard', label: 'New Dashboard items', description: 'New review requests, pull requests that need you, and new comments.' }
];

/** The sounds of macOS, in /System/Library/Sounds. */
export const NOTIFICATION_SOUNDS = ['Basso', 'Blow', 'Bottle', 'Frog', 'Funk', 'Glass', 'Hero', 'Morse', 'Ping', 'Pop', 'Purr', 'Sosumi', 'Submarine', 'Tink'];

export interface NotificationEventSettings {
    enabled: boolean;
    /** The name of a macOS sound, or null for a notification without a sound. */
    sound: string | null;
}

/** The pull requests that can show a "CI finished" notification. */
export type CiScope = 'mine' | 'involved' | 'all';

export const CI_SCOPES: { id: CiScope; label: string }[] = [
    { id: 'mine', label: 'My pull requests' },
    { id: 'involved', label: 'Pull requests I am involved in' },
    { id: 'all', label: 'All pull requests' }
];

export interface NotificationSettings {
    /** False turns off all notifications. */
    enabled: boolean;
    /** False: no notification while ShipWarden is the active app. */
    whenFocused: boolean;
    /** The pull requests that can show a "CI finished" notification. */
    ciScope: CiScope;
    events: Record<NotificationEvent, NotificationEventSettings>;
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
    enabled: true,
    whenFocused: true,
    ciScope: 'mine',
    events: {
        agentWaiting: { enabled: true, sound: 'Glass' },
        agentDone: { enabled: true, sound: null },
        ciFinished: { enabled: true, sound: 'Pop' },
        dashboard: { enabled: true, sound: null }
    }
};

export function normalizeNotificationSettings(value: unknown): NotificationSettings {
    const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const rawEvents = raw.events && typeof raw.events === 'object' ? raw.events as Record<string, unknown> : {};
    const events = {} as Record<NotificationEvent, NotificationEventSettings>;
    for (const { id } of NOTIFICATION_EVENTS) {
        const item = rawEvents[id] && typeof rawEvents[id] === 'object' ? rawEvents[id] as Record<string, unknown> : undefined;
        const fallback = DEFAULT_NOTIFICATION_SETTINGS.events[id];
        events[id] = {
            enabled: typeof item?.enabled === 'boolean' ? item.enabled : fallback.enabled,
            sound: item && 'sound' in item
                ? (typeof item.sound === 'string' && NOTIFICATION_SOUNDS.includes(item.sound) ? item.sound : null)
                : fallback.sound
        };
    }
    return {
        enabled: raw.enabled !== false,
        whenFocused: raw.whenFocused !== false,
        ciScope: CI_SCOPES.some(scope => scope.id === raw.ciScope) ? raw.ciScope as CiScope : DEFAULT_NOTIFICATION_SETTINGS.ciScope,
        events
    };
}

/** A change of the checks of a pull request from waiting to a result. */
export interface CiChange {
    branch: string;
    summary: BranchSummary;
    passed: boolean;
}

const WAITING = new Set(['PENDING', 'EXPECTED']);
const RESULT = new Set(['SUCCESS', 'FAILURE', 'ERROR']);

/** Returns the branches whose checks went from waiting to a result between two loads. */
export function ciChanges(before: Record<string, BranchSummary> | undefined, after: Record<string, BranchSummary>): CiChange[] {
    if (!before) return [];
    const changes: CiChange[] = [];
    for (const [branch, summary] of Object.entries(after)) {
        const previous = before[branch];
        if (previous && previous.number === summary.number && WAITING.has(previous.checks ?? '') && RESULT.has(summary.checks ?? '')) {
            changes.push({ branch, summary, passed: summary.checks === 'SUCCESS' });
        }
    }
    return changes;
}

/** Returns true when the CI scope includes the pull request. "involved" includes the pull requests of the user. */
export function inCiScope(scope: CiScope, summary: Pick<BranchSummary, 'viewerRole'>): boolean {
    if (scope === 'all') return true;
    if (scope === 'involved') return summary.viewerRole !== undefined;
    return summary.viewerRole === 'author';
}
