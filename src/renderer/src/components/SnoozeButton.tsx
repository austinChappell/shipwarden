import { AlarmClock, AlarmClockOff } from 'lucide-react';
import { makeSnooze, snoozeChoices, snoozeText, type PullRequestActivity, type Snooze, type SnoozeChoice, type SnoozeSubject } from '@shared/snooze';
import { snoozeStore } from '../snooze-store';
import { showContextMenu } from './ContextMenu';
import { IconButton } from './ui';

/** Shows the Snooze menu below the anchor and snoozes the item of the key with the choice of the user. */
export async function chooseSnooze(anchor: Element, key: string, activity: PullRequestActivity, subject: SnoozeSubject = 'pull-request'): Promise<void> {
    const id = await showContextMenu(
        snoozeChoices(subject).map(choice => ({ id: choice.id, label: choice.label })),
        anchor
    );
    if (!id) return;
    snoozeStore.set(key, makeSnooze(id as SnoozeChoice, activity, new Date()));
}

/** The tooltip of a snoozed item, for example "Snoozed until tomorrow at 9:00 AM". */
export function snoozedTitle(snooze: Snooze, subject: SnoozeSubject = 'pull-request'): string {
    return `Snoozed ${snoozeText(snooze, new Date(), undefined, subject)}`;
}

/** The tooltip of the Snooze button, by subject. */
const SNOOZE_TITLES: Record<SnoozeSubject, string> = {
    'pull-request': 'Snooze: hide the pull request for a time, or until it has new activity',
    'pipeline-run': 'Snooze: hide the run for a time, or until it waits at a different stage. A new run shows again.'
};

interface Props {
    /** The key of the snooze (see `snoozeKey` and `pipelineSnoozeKey`). */
    snoozeKey: string;
    /** The name of the item for a screen reader, for example "app #12". */
    name: string;
    activity: PullRequestActivity;
    /** The active snooze. With it, the button removes the snooze. */
    snooze?: Snooze;
    subject?: SnoozeSubject;
    className?: string;
}

/**
 * The button that snoozes a pull request or a pipeline run. It opens a menu: until new activity, or for a fixed time.
 * On a snoozed item, the button removes the snooze.
 */
export function SnoozeButton({ snoozeKey, name, activity, snooze, subject = 'pull-request', className }: Props) {
    if (snooze) {
        return (
            <IconButton
                className={className}
                active
                icon={<AlarmClockOff size={14} strokeWidth={1.8} />}
                label={`Unsnooze ${name}`}
                title={`${snoozedTitle(snooze, subject)}. Click to show it again now.`}
                onClick={event => {
                    event.stopPropagation();
                    snoozeStore.set(snoozeKey, null);
                }}
            />
        );
    }
    return (
        <IconButton
            className={className}
            icon={<AlarmClock size={14} strokeWidth={1.8} />}
            label={`Snooze ${name}`}
            title={SNOOZE_TITLES[subject]}
            aria-haspopup="menu"
            onClick={event => {
                event.stopPropagation();
                void chooseSnooze(event.currentTarget, snoozeKey, activity, subject);
            }}
        />
    );
}
