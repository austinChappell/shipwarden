import { useQuery } from '@tanstack/react-query';
import type { EditorList, ExternalEditor } from '@shared/editors';
import { editorPositions } from '../editor/editor-positions';
import { keyRoots, queryClient } from '../query-client';

/** The query of the installed editors. A new app in /Applications shows after a minute, or when Settings opens. */
export const editorListQuery = {
    queryKey: keyRoots.editors,
    queryFn: (): Promise<EditorList> => window.shipwarden.editors.list(),
    staleTime: 60_000
};

/** Returns the editor that "Open in editor" uses now. Undefined while the list loads or when no editor is installed. */
export function selectedOf(list: EditorList | undefined): ExternalEditor | undefined {
    return list?.editors.find(editor => editor.appPath === list.selected);
}

/** The editor that "Open in editor" uses now, for the labels of buttons. */
export function useExternalEditor(): ExternalEditor | undefined {
    return selectedOf(useQuery(editorListQuery).data);
}

/**
 * The same editor from the cache, for code that is not a component, for example a context menu. The menu does not
 * wait for the folders to be read. A stale list loads again in the background for the next menu.
 */
export function cachedExternalEditor(): ExternalEditor | undefined {
    void queryClient.prefetchQuery(editorListQuery);
    return selectedOf(queryClient.getQueryData<EditorList>(keyRoots.editors));
}

/** The label of the menu item and the button, for example "Open in Zed". */
export function openInEditorLabel(editor: ExternalEditor | undefined): string {
    return editor ? `Open in ${editor.name}` : 'Open in Editor';
}

/** Changes the editor in use in the cached list, after the settings save a new editor. */
export function setSelectedEditor(appPath: string): void {
    queryClient.setQueryData<EditorList>(keyRoots.editors, list => (list ? { ...list, selected: appPath } : list));
}

/**
 * Opens the worktree in the external editor. With a file, the editor also opens the file at the last cursor line of
 * the file in ShipWarden.
 */
export function openInExternalEditor(root: string, file?: string): Promise<void> {
    const line = file ? editorPositions.get(root, file)?.line : undefined;
    return window.shipwarden.editors.open(root, file, line);
}
