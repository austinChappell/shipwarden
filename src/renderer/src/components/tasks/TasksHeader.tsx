import { useMemo } from 'react';
import { ExternalLink, List, Plus, RefreshCw, Settings, SquareKanban } from 'lucide-react';
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
import { openLink } from '../../links';
import { Button, ButtonGroup, Combobox, IconButton, SearchInput, Select, sortedGroups } from '../ui';
import { AssigneeFilterPicker } from './AssigneeFilterPicker';
import { LabelFilterPicker } from './LabelFilterPicker';
import { collectionPlaceholder, collectionTitle, type ViewMode } from './task-view-logic';

interface PickerProps {
    collections: TaskCollection[] | undefined;
    /** The ID of the selected collection. */
    collection: string | undefined;
    onSelect(id: string): void;
}

/** The picker of the collection that the view shows, with a button that opens the collection in the browser. */
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
        <div className="collection-picker">
            <Combobox
                className="collection-select"
                value={collection}
                groups={pickerGroups}
                placeholder={collectionPlaceholder(collections)}
                searchPlaceholder="Search collections"
                disabled={!collections?.length}
                title={collectionTitle(current)}
                onChange={onSelect}
            />
            {current?.url && (
                <IconButton
                    icon={<ExternalLink size={14} strokeWidth={1.6} />}
                    label="Open the collection in the browser"
                    onClick={event => openLink(current.url!, event)}
                />
            )}
        </div>
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
    createTask(): void;
    /** Loads the tasks again, or the collections when the source has no collections. */
    refresh(): void;
    onOpenSettings(): void;
}

/** The header of the Tasks view: the task manager, the collection, the filter, the assignee, the label, the view mode and the search. */
export function TasksHeader(props: Props) {
    const { connections, connectionId, currentConnection, source, filter, viewMode, query, loading } = props;
    return (
        <header className="tasks-header">
            {/* Two groups: where the tasks come from, and how they show. A narrow window puts the second group on its own row. */}
            <div className="tasks-header-group where">
                {connections && connections.length > 0 && (
                    <Select
                        value={connectionId ?? ''}
                        options={connections.map(item => ({ value: item.id, label: item.name }))}
                        onChange={props.selectConnection}
                        title="Task manager"
                    />
                )}
                {source && <CollectionPicker collections={props.collections} collection={props.collection} onSelect={props.selectCollection} />}
            </div>
            <div className="tasks-header-group how">
                {source && source.filters.length > 0 && (
                    <Select
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
                    <ButtonGroup label="View">
                        <Button
                            icon={<SquareKanban size={14} strokeWidth={1.8} />}
                            title="Board"
                            aria-label="Board"
                            aria-pressed={viewMode === 'board'}
                            onClick={() => props.changeViewMode('board')}
                        />
                        <Button
                            icon={<List size={14} strokeWidth={1.8} />}
                            title="List"
                            aria-label="List"
                            aria-pressed={viewMode === 'list'}
                            onClick={() => props.changeViewMode('list')}
                        />
                    </ButtonGroup>
                )}
                {source && <SearchInput className="tasks-search-field" value={query} placeholder="Search tasks" onChange={props.setQuery} />}
                <span className="header-spacer" />
                {source?.capabilities.create && (
                    <IconButton icon={<Plus size={14} strokeWidth={1.6} />} label="New task" disabled={!props.collection} onClick={props.createTask} />
                )}
                {source && (
                    <IconButton icon={<RefreshCw size={14} strokeWidth={1.6} className={loading ? 'spin' : ''} />} label="Refresh" onClick={props.refresh} />
                )}
                {currentConnection && (
                    <IconButton icon={<Settings size={14} strokeWidth={1.6} />} label="Task manager settings" onClick={props.onOpenSettings} />
                )}
            </div>
        </header>
    );
}
