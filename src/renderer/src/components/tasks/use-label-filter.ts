import { useState } from 'react';
import { ALL_LABELS, type LabelFilter } from '@shared/tasks';

/** The last label filter of each connection, for the session. */
const lastFilters = new Map<string, LabelFilter>();

/**
 * The label filter of the selected connection. The view selects the tasks itself, so a change of the filter
 * sends no request to the plugin. The filter lists the labels of the loaded tasks.
 */
export function useLabelFilter(connectionId: string | undefined) {
    // A change of the state renders the view again. The map keeps the filter of each connection.
    const [, setVersion] = useState(0);
    const filter = (connectionId && lastFilters.get(connectionId)) || ALL_LABELS;

    const setFilter = (next: LabelFilter) => {
        if (!connectionId) return;
        lastFilters.set(connectionId, next);
        setVersion(version => version + 1);
    };

    return { filter, setFilter };
}
