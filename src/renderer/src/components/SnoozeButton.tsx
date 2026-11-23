import { AlarmClock, AlarmClockOff } from 'lucide-react';
import { makeSnooze, SNOOZE_CHOICES, snoozeText, type PullRequestActivity, type Snooze, type SnoozeChoice } from '@shared/snooze';
import { snoozeStore } from '../snooze-store';
import { showContextMenu } from './ContextMenu';
import { IconButton } from './ui';

/** Shows the Snooze menu below the anchor and snoozes the pull request with the choice of the user. */
export async function chooseSnooze(anchor: Element, url: string, activity: PullRequestActivity): Promise<void> {
    const id = await showContextMenu(
        SNOOZE_CHOICES.map(choice => ({ id: choice.id, label: choice.label })),
        anchor
    );
    if (!id) return;
    snoozeStore.set(url, makeSnooze(id as SnoozeChoice, activity, new Date()));
}

/** The tooltip of a snoozed pull request, for example "Snoozed until tomorrow at 9:00 AM". */
export function snoozedTitle(snooze: Snooze): string {
    return `Snoozed ${snoozeText(snooze, new Date())}`;
}

interface Props {
    url: string;
    /** The name of the pull request for a screen reader, for example "app #12". */
    name: string;
    activity: PullRequestActivity;
    /** The active snooze. With it, the button removes the snooze. */
    snooze?: Snooze;
    className?: string;
}

/**
 * The button that snoozes a pull request. It opens a menu: until new activity, or for a fixed time. On a snoozed pull
 * request, the button removes the snooze.
 */
export function SnoozeButton({ url, name, activity, snooze, className }: Props) {
    if (snooze) {
        return (
            <IconButton
                className={className}
                active
                icon={<AlarmClockOff size={14} strokeWidth={1.8} />}
                label={`Unsnooze ${name}`}
                title={`${snoozedTitle(snooze)}. Click to show it again now.`}
                onClick={event => {
                    event.stopPropagation();
                    snoozeStore.set(url, null);
                }}
            />
        );
    }
    return (
        <IconButton
            className={className}
            icon={<AlarmClock size={14} strokeWidth={1.8} />}
            label={`Snooze ${name}`}
            title="Snooze: hide the pull request for a time, or until it has new activity"
            aria-haspopup="menu"
            onClick={event => {
                event.stopPropagation();
                void chooseSnooze(event.currentTarget, url, activity);
            }}
        />
    );
}
