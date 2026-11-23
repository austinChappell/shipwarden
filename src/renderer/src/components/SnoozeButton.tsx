import { AlarmClock, AlarmClockOff } from 'lucide-react';
import {
    makeSnooze,
    snoozeChoices,
    snoozeText,
    type PullRequestActivity,
    type Snooze,
    type SnoozeChoice,
    type SnoozedPipeline,
    type SnoozeSubject
} from '@shared/snooze';
import { snoozeStore } from '../snooze-store';
import { showContextMenu, type ContextMenuItem } from './ContextMenu';
import { IconButton } from './ui';

/** The prefix of the menu IDs of the pipeline submenu. */
const PIPELINE_PREFIX = 'pipeline:';

/** The pipeline of a run, for the pipeline submenu of the Snooze menu. */
export interface PipelineSnoozeTarget {
    /** The key of the snooze of the pipeline (see `pipelineSnoozeKey`). */
    key: string;
    pipeline: SnoozedPipeline;
}

/**
 * Shows the Snooze menu below the anchor and snoozes the item of the key with the choice of the user. With
 * `pipeline`, the menu also has a submenu that snoozes all runs of the pipeline, also the runs in the future.
 */
export async function chooseSnooze(
    anchor: Element,
    key: string,
    activity: PullRequestActivity,
    subject: SnoozeSubject = 'pull-request',
    pipeline?: PipelineSnoozeTarget
): Promise<void> {
    const items: ContextMenuItem[] = snoozeChoices(subject).map(choice => ({ id: choice.id, label: choice.label }));
    if (pipeline) {
        items.push(
            { type: 'separator' },
            {
                label: 'All runs of the pipeline',
                submenu: snoozeChoices('pipeline').map(choice => ({ id: `${PIPELINE_PREFIX}${choice.id}`, label: choice.label }))
            }
        );
    }
    const id = await showContextMenu(items, anchor);
    if (!id) return;
    if (pipeline && id.startsWith(PIPELINE_PREFIX)) {
        snoozeStore.set(pipeline.key, makeSnooze(id.slice(PIPELINE_PREFIX.length) as SnoozeChoice, {}, new Date(), pipeline.pipeline));
        return;
    }
    snoozeStore.set(key, makeSnooze(id as SnoozeChoice, activity, new Date()));
}

/** The tooltip of a snoozed item, for example "Snoozed until tomorrow at 9:00 AM". */
export function snoozedTitle(snooze: Snooze, subject: SnoozeSubject = 'pull-request'): string {
    return `Snoozed ${snoozeText(snooze, new Date(), undefined, subject)}`;
}

/** The tooltip of the Snooze button, by subject. */
const SNOOZE_TITLES: Record<SnoozeSubject, string> = {
    'pull-request': 'Snooze: hide the pull request for a time, or until it has new activity',
    'pipeline-run': 'Snooze: hide the run for a time, or until it waits at a different stage. A new run shows again.',
    pipeline: 'Snooze: hide all runs of the pipeline for a time, or until you unsnooze it'
};

interface Props {
    /** The key of the snooze (see `snoozeKey`, `runSnoozeKey`, and `pipelineSnoozeKey`). */
    snoozeKey: string;
    /** The pipeline of a run. With it, the menu can snooze all runs of the pipeline. */
    pipeline?: PipelineSnoozeTarget;
    /** The name of the item for a screen reader, for example "app #12". */
    name: string;
    activity: PullRequestActivity;
    /** The active snooze. With it, the button removes the snooze. */
    snooze?: Snooze;
    subject?: SnoozeSubject;
    className?: string;
}

/**
 * The button that snoozes a pull request, a pipeline run, or a pipeline. It opens a menu: until new activity, or for a
 * fixed time. On a snoozed item, the button removes the snooze.
 */
export function SnoozeButton({ snoozeKey, pipeline, name, activity, snooze, subject = 'pull-request', className }: Props) {
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
            title={pipeline ? `${SNOOZE_TITLES[subject]} The menu can also hide all runs of the pipeline.` : SNOOZE_TITLES[subject]}
            aria-haspopup="menu"
            onClick={event => {
                event.stopPropagation();
                void chooseSnooze(event.currentTarget, snoozeKey, activity, subject, pipeline);
            }}
        />
    );
}
