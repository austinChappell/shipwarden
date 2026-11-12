import { useMemo, type ReactNode } from 'react';
import { ExternalLink, List, ListTodo, Plus, RefreshCw, Settings, SquareKanban } from 'lucide-react';
import {
    showsAllLabels,
    type AssigneeFilter,
    type ConnectionInfo,
    type LabelFilter,
    type TaskCollection,
    type TaskLabel,
    type TaskPerson,
    type TaskSource
} from '@shared/tasks';
import { formatAgo } from '@shared/format';
import { openLink } from '../../links';
import { radioGroupKeys } from '../keyboard';
import { Button, ButtonGroup, Combobox, FilterField, IconButton, PageHeader, Select, sortedGroups } from '../ui';
import { AssigneeFilterPicker } from './AssigneeFilterPicker';
import { LabelFilterPicker } from './LabelFilterPicker';
import { collectionPlaceholder, collectionTitle, type ViewMode } from './task-view-logic';

interface PickerProps {
    collections: TaskCollection[] | undefined;
    /** The ID of the selected collection. */
    collection: string | undefined;
    onSelect(id: string): void;
}

/** The picker of the collection that the view shows. */
export function CollectionPicker({ collections, collection, onSelect }: PickerProps) {
    const current = collections?.find(item => item.id === collection);
    /** The picker groups the collections by path, for example a ClickUp space and folder or a GitHub owner. */
    const pickerGroups = useMemo(
        () =>
            sortedGroups(
                collections ?? [],
                item => item.path ?? '',
                item => ({ value: item.id, label: item.name })
            ),
        [collections]
    );
    return (
        <Combobox
            className="collection-select"
            size="lg"
            value={collection}
            groups={pickerGroups}
            placeholder={collectionPlaceholder(collections)}
            searchPlaceholder="Search collections"
            disabled={!collections?.length}
            title={collectionTitle(current)}
            onChange={onSelect}
        />
    );
}

interface Props {
    connections: ConnectionInfo[] | undefined;
    connectionId: string | undefined;
    selectConnection(id: string): void;
    /** The connection of `connectionId`, if the project has it. */
    currentConnection: ConnectionInfo | undefined;
    source: TaskSource | null | undefined;
    collections: TaskCollection[] | undefined;
    collection: string | undefined;
    selectCollection(id: string): void;
    filter: string | undefined;
    setFilter(filter: string): void;
    /** The people that the assignee filter lists. */
    people: TaskPerson[];
    /** The person key of the user of the connection, if the plugin sends it. */
    me: string | undefined;
    /** True when the plugin selects the tasks by assignee. Then the filter has "Me". */
    assigneesSupported: boolean;
    assignee: AssigneeFilter;
    setAssignee(value: AssigneeFilter): void;
    /** The labels that the label filter lists. */
    labels: TaskLabel[];
    label: LabelFilter;
    setLabel(value: LabelFilter): void;
    viewMode: ViewMode;
    changeViewMode(mode: ViewMode): void;
    query: string;
    setQuery(query: string): void;
    loading: boolean;
    /** The time of the last load of the tasks, in milliseconds. */
    updatedAt: number | undefined;
    createTask(): void;
    /** Loads the tasks again, or the collections when the source has no collections. */
    refresh(): void;
    onOpenSettings(): void;
}

/**
 * The header of the Tasks view (docs/design, board 3). The scope has the task manager, the collection, the filter,
 * the assignee, the label, and the view mode. The filter field, the icon buttons, and the refresh button are on the right.
 */
export function TasksHeader(props: Props) {
    const { connections, connectionId, currentConnection, source, filter, viewMode, query, loading, updatedAt } = props;
    const current = props.collections?.find(item => item.id === props.collection);
    const views: { mode: ViewMode; label: string; icon: ReactNode }[] = [
        { mode: 'board', label: 'Board', icon: <SquareKanban size={14} strokeWidth={1.8} /> },
        { mode: 'list', label: 'List', icon: <List size={14} strokeWidth={1.8} /> }
    ];
    return (
        <PageHeader
            className="tasks-page-header"
            icon={ListTodo}
            title="Tasks"
            meta={source && updatedAt ? `Updated ${formatAgo(new Date(updatedAt).toISOString())}` : undefined}
            scope={
                <>
                    {connections && connections.length > 0 && (
                        <Select
                            size="lg"
                            value={connectionId ?? ''}
                            options={connections.map(item => ({ value: item.id, label: item.name }))}
                            onChange={props.selectConnection}
                            title="Task manager"
                        />
                    )}
                    {source && <CollectionPicker collections={props.collections} collection={props.collection} onSelect={props.selectCollection} />}
                    {source && source.filters.length > 0 && (
                        <Select
                            size="lg"
                            value={filter}
                            options={source.filters.map(item => ({ value: item.id, label: item.label }))}
                            onChange={props.setFilter}
                            title="Filter"
                        />
                    )}
                    {source && (
                        <AssigneeFilterPicker
                            people={props.people}
                            me={props.me}
                            showMe={props.assigneesSupported}
                            value={props.assignee}
                            onChange={props.setAssignee}
                        />
                    )}
                    {/* Tasks without labels give an empty list. Then the filter shows only while it hides tasks. */}
                    {source && (props.labels.length > 0 || !showsAllLabels(props.label)) && (
                        <LabelFilterPicker labels={props.labels} value={props.label} onChange={props.setLabel} />
                    )}
                    {source && (
                        <ButtonGroup size="lg" role="radiogroup" label="View" onKeyDown={radioGroupKeys}>
                            {views.map(view => (
                                <Button
                                    key={view.mode}
                                    role="radio"
                                    icon={view.icon}
                                    title={view.label}
                                    aria-label={view.label}
                                    aria-checked={viewMode === view.mode}
                                    tabIndex={viewMode === view.mode ? 0 : -1}
                                    onClick={() => props.changeViewMode(view.mode)}
                                />
                            ))}
                        </ButtonGroup>
                    )}
                </>
            }
            filter={source && <FilterField value={query} placeholder="Filter tasks" onChange={props.setQuery} />}
            actions={
                (source || currentConnection) && (
                    <>
                        {source?.capabilities.create && (
                            <IconButton
                                size="lg"
                                icon={<Plus size={16} strokeWidth={1.6} />}
                                label="New task"
                                disabled={!props.collection}
                                onClick={props.createTask}
                            />
                        )}
                        {source && current?.url && (
                            <IconButton
                                size="lg"
                                icon={<ExternalLink size={16} strokeWidth={1.6} />}
                                label={`Open in ${source.name}`}
                                onClick={event => openLink(current.url!, event)}
                            />
                        )}
                        {currentConnection && (
                            <IconButton
                                size="lg"
                                icon={<Settings size={16} strokeWidth={1.6} />}
                                label="Task manager settings"
                                onClick={props.onOpenSettings}
                            />
                        )}
                        {source && (
                            <IconButton
                                size="lg"
                                icon={<RefreshCw size={16} strokeWidth={1.6} className={loading ? 'spin' : ''} />}
                                label="Refresh"
                                onClick={props.refresh}
                            />
                        )}
                    </>
                )
            }
        />
    );
}
