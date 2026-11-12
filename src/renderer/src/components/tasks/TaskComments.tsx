import { useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { assigneeOptions, type Task, type TaskOption } from '@shared/tasks';
import type { ActiveMention } from '@shared/mentions';
import { timeAgo } from '../../util';
import { Markdown } from '../Markdown';
import { MentionTextarea, type MentionItem, type MentionItems } from '../MentionTextarea';
import { commentLinks, rankPeople, rankTasks, referenceText } from './task-view-logic';
import { StatusDot, TaskAvatar } from './TaskParts';
import { Button } from '../ui';
import { TaskCard } from './TaskBody';
import type { useTaskDetail } from './use-task-detail';

interface Props {
    state: ReturnType<typeof useTaskDetail>;
    /** True when the plugin returns options (tasks/options). Then "@" lists the people of the task from the plugin. */
    canLoadPeople: boolean;
    /** The loaded tasks. "#" lists them. */
    tasks: readonly Task[];
}

/** A picked person or task, with the text that is in the body. */
interface Picked {
    mentions: { id: string; name: string }[];
    references: { id: string; text: string; url?: string }[];
}

/**
 * The comments of the task and a comment box. In the box, "@" lists the people of the task and "#" lists the loaded
 * tasks. The plugin gets the picked people and tasks, so it can make native mentions and links.
 */
export function TaskComments({ state, canLoadPeople, tasks }: Props) {
    const { detail, comments, commentText, setCommentText, busy } = state;
    const picked = useRef<Picked>({ mentions: [], references: [] });

    // Without options from the plugin, the people are the assignees of the loaded tasks and of the open task.
    const knownPeople = useMemo((): TaskOption[] => {
        const people = assigneeOptions(detail ? [...tasks, detail] : tasks);
        return people.filter(person => person.id).map(person => ({ ...person, id: person.id as string }));
    }, [tasks, detail]);

    /** The tasks for "#": the loaded tasks, and the subtasks and the linked tasks of the open task. */
    const referable = useMemo((): Task[] => {
        const related = [detail?.details?.parent, ...(detail?.details?.subtasks ?? []), ...(detail?.details?.links ?? []).map(link => link.task)]
            .filter(item => !!item?.title && !tasks.some(task => task.id === item.id || (!!item.key && task.key === item.key)))
            .map(item => ({ id: item!.id, key: item!.key, title: item!.title as string, url: item!.url, status: item!.status! }));
        return [...tasks, ...related];
    }, [tasks, detail]);

    // The people load when the text has an "@", so a comment without a mention sends no request.
    const people = useQuery({ ...state.optionsQuery('assignees'), enabled: canLoadPeople && commentText.includes('@') });

    /** The rows of the list for the reference at the cursor. It uses no hooks, so a new function on each render is fine. */
    const items = (mention: ActiveMention | undefined): MentionItems => {
        if (!mention) return { list: [], status: undefined };
        if (mention.trigger === '@') {
            const all = canLoadPeople ? (people.data?.options ?? []) : knownPeople;
            const list = rankPeople(all, mention.query).map(
                (person): MentionItem => ({
                    key: `person:${person.id}`,
                    insert: `@${person.name}`,
                    label: person.name,
                    icon: <TaskAvatar person={person} size={16} />
                })
            );
            const status = list.length ? undefined : people.isError ? 'ShipWarden cannot load the people.' : people.isFetching ? 'Loading…' : 'No matches';
            return { list, status };
        }
        const list = rankTasks(referable, mention.query, detail?.id).map(
            (task): MentionItem => ({
                key: `task:${task.id}`,
                insert: referenceText(task),
                label: task.title,
                detail: task.key,
                icon: task.status ? <StatusDot status={task.status} /> : undefined
            })
        );
        return { list, status: list.length ? undefined : 'No matches in the loaded tasks' };
    };

    const onPick = (item: MentionItem) => {
        const [kind, id] = [item.key.slice(0, item.key.indexOf(':')), item.key.slice(item.key.indexOf(':') + 1)];
        if (kind === 'person') {
            picked.current.mentions.push({ id, name: item.label });
        } else {
            const task = referable.find(entry => entry.id === id);
            picked.current.references.push({ id, text: item.insert, ...(task?.url ? { url: task.url } : {}) });
        }
    };

    const send = () => {
        const links = commentLinks(commentText.trim(), picked.current.mentions, picked.current.references);
        picked.current = { mentions: [], references: [] };
        state.addComment(links);
    };

    return (
        <TaskCard title="Comments" count={comments.length} className="task-comments">
            {comments.map(comment => (
                <div key={comment.id} className="thread-comment">
                    <div className="comment-author">
                        {comment.author && <TaskAvatar person={comment.author} size={18} />}
                        {comment.author?.name ?? 'unknown'} {comment.createdAt && <span>{timeAgo(comment.createdAt)}</span>}
                    </div>
                    <Markdown className="comment-body" text={comment.body} />
                </div>
            ))}
            <MentionTextarea
                className="review-body"
                value={commentText}
                placeholder="Add a comment. Type @ to mention a person or # to link a task."
                onValueChange={setCommentText}
                useItems={items}
                onPick={onPick}
                listLabels={{ '@': 'People', '#': 'Tasks' }}
                onKeyDown={event => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && commentText.trim()) {
                        event.preventDefault();
                        send();
                    }
                }}
            />
            <div className="row-buttons">
                <Button disabled={busy || !commentText.trim()} title="Comment (⌘↩)" onClick={send}>
                    Comment
                </Button>
            </div>
        </TaskCard>
    );
}
