import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { baseName } from '@shared/files';
import {
    closePane,
    findLeaf,
    focusedTab,
    focusSide,
    groupOf,
    insertNode,
    leafOfTab,
    leaves,
    pruneGroups,
    splitPane,
    tabLayout,
    type PaneLayout,
    type SplitGroups,
    type SplitSide
} from '@shared/panes';
import type { ShortcutAction } from '@shared/shortcuts';
import { moveStripEntry, orderTabs } from '@shared/tab-order';
import type { TerminalSession } from '@shared/terminal';
import type { Worktree } from '@shared/worktrees';
import { browserTabKey } from '@shared/browser';
import { confirmDialog } from '../components/ConfirmDialog';
import { documents } from '../editor/documents';
import { terminalPool } from '../terminal/terminal-pool';
import { agentStateStore } from '../terminal/agent-state-store';
import {
    activeLayout,
    fileKey,
    isStripItemActive,
    isTabSelectAction,
    pickActiveTab,
    stripEntries,
    stripItemsOf,
    stripTargetIndex,
    upsertTab,
    withGroup,
    worktreeTabKeys,
    type ExtraTab,
    type TabKey
} from './tabs';
import { errorText } from './worktree-edits';
import { editorPositions } from '../editor/editor-positions';
import { outputActivity } from '../terminal/output-activity';

const api = window.shipwarden;

/** A line of a file that the editor shows. */
export interface Reveal {
    root: string;
    path: string;
    line: number;
    /** When set, the editor puts the cursor at this column. Without it, the editor selects the full line. */
    column?: number;
    nonce: number;
}

interface Options {
    selectedPath: string | undefined;
    setSelectedPath: (path: string | undefined) => void;
    sessions: TerminalSession[];
    setSessions: Dispatch<SetStateAction<TerminalSession[]>>;
    setError: (error: string | undefined) => void;
}

/**
 * The tabs and the split panes of each worktree, and the actions that open, close and move them.
 * The values for the selected worktree come first: its tabs, its active tab and the panes of the active tab.
 */
export function useWorkspaceTabs({ selectedPath, setSelectedPath, sessions, setSessions, setError }: Options) {
    /** The open files of each worktree, as paths relative to the worktree. */
    const [openFiles, setOpenFiles] = useState<Record<string, string[]>>({});
    /** The active tab of each worktree. */
    const [activeTabs, setActiveTabs] = useState<Record<string, TabKey>>({});
    /** The tab order of each worktree after the user moved a tab (⌃⇧← and ⌃⇧→). */
    const [tabOrders, setTabOrders] = useState<Record<string, TabKey[]>>({});
    /**
     * The split tabs of each worktree. A split tab is one tab in the tab strip with two or more panes, like a tab
     * of Ghostty with splits. A tab that is in no split shows its view alone.
     */
    const [panes, setPanes] = useState<Record<string, SplitGroups>>({});
    /** The tab that the user drags, and the pane side under the pointer, for the drop zones of the split view. */
    const [draggingTab, setDraggingTab] = useState<TabKey>();
    const [dropTarget, setDropTarget] = useState<{ leafId: string; side: SplitSide }>();
    const [dirtyFiles, setDirtyFiles] = useState<Set<string>>(new Set());
    const [reveal, setReveal] = useState<Reveal>();
    /** The file that gets the keyboard focus. Each open of a file sets it, also when the file is already open. */
    const [focusRequest, setFocusRequest] = useState<{ root: string; path: string; nonce: number }>();
    /** The diff and log tabs of each worktree. */
    const [extraTabs, setExtraTabs] = useState<Record<string, ExtraTab[]>>({});

    useEffect(
        () =>
            documents.onDirtyChange((root, path, dirty) => {
                setDirtyFiles(set => {
                    const next = new Set(set);
                    if (dirty) {
                        next.add(fileKey(root, path));
                    } else {
                        next.delete(fileKey(root, path));
                    }
                    return next;
                });
            }),
        []
    );

    const worktreeSessions = useMemo(() => sessions.filter(session => session.worktreePath === selectedPath), [sessions, selectedPath]);
    const worktreeFiles = (selectedPath && openFiles[selectedPath]) || [];
    const worktreeExtras = (selectedPath && extraTabs[selectedPath]) || [];
    const tabKeys: TabKey[] = orderTabs(
        worktreeTabKeys(
            worktreeSessions.map(session => session.id),
            worktreeFiles,
            worktreeExtras
        ),
        selectedPath ? tabOrders[selectedPath] : undefined
    );
    const activeTab = pickActiveTab(tabKeys, selectedPath ? activeTabs[selectedPath] : undefined);
    const tabKeysKey = tabKeys.join('\n');
    /** The split tabs of the selected worktree, without the panes of closed tabs. */
    const groups = useMemo(
        () => (selectedPath ? pruneGroups(panes[selectedPath] ?? [], tabKeys) : []),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [selectedPath, panes, tabKeysKey]
    );
    /** The panes of the active tab. */
    const layout = useMemo(() => activeLayout(groups, activeTab), [groups, activeTab]);
    const split = !!layout && layout.root.kind === 'split';
    const activeFile = activeTab?.startsWith('f:') ? activeTab.slice(2) : undefined;
    const stripItems = stripItemsOf(tabKeys, groups, activeTab);

    // A new active tab can be outside the visible part of the tab strip.
    useEffect(() => {
        document.querySelector('.tabs .tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }, [activeTab]);

    const activate = (worktreePath: string, tab: TabKey) => setActiveTabs(map => ({ ...map, [worktreePath]: tab }));

    /** Returns the tab keys of a worktree, in the order of its tab strip. */
    const tabKeysOf = (path: string): TabKey[] =>
        worktreeTabKeys(
            sessions.filter(session => session.worktreePath === path).map(session => session.id),
            openFiles[path] ?? [],
            extraTabs[path] ?? []
        );

    const openExtra = (root: string, tab: ExtraTab) => {
        setExtraTabs(map => ({ ...map, [root]: upsertTab(map[root] ?? [], tab) }));
        setActiveTabs(map => ({ ...map, [root]: tab.key }));
    };

    const closeExtra = (root: string, key: TabKey) => {
        setExtraTabs(map => ({ ...map, [root]: (map[root] ?? []).filter(item => item.key !== key) }));
    };

    const openFile = (path: string, line?: number, column?: number, inRoot?: string) => {
        const root = inRoot ?? selectedPath;
        if (!root) {
            return;
        }
        if (root !== selectedPath) {
            setSelectedPath(root);
        }
        setOpenFiles(map => {
            const list = map[root] ?? [];
            return list.includes(path) ? map : { ...map, [root]: [...list, path] };
        });
        activate(root, `f:${path}`);
        setFocusRequest({ root, path, nonce: Date.now() });
        if (line) {
            setReveal({ root, path, line, column, nonce: Date.now() });
        }
    };

    const closeFile = async (root: string, path: string) => {
        if (
            documents.isDirty(root, path) &&
            !(await confirmDialog({
                title: `"${baseName(path)}" has unsaved changes.`,
                message: 'Close it and lose the changes?',
                confirmLabel: 'Close without saving',
                danger: true
            }))
        ) {
            return;
        }
        documents.close(root, path);
        editorPositions.forget(root, path);
        setDirtyFiles(set => {
            const next = new Set(set);
            next.delete(fileKey(root, path));
            return next;
        });
        setOpenFiles(map => ({ ...map, [root]: (map[root] ?? []).filter(item => item !== path) }));
    };

    const closeSession = async (session: TerminalSession) => {
        await api.terminals.kill(session.id);
        terminalPool.dispose(session.id);
        agentStateStore.delete(session.id);
        outputActivity.delete(session.id);
        setSessions(list => list.filter(item => item.id !== session.id));
    };

    /**
     * Saves the split of the tab `anchor` (the layout of its tab, or undefined when the split ends).
     * The tab of the focused pane becomes the active tab.
     */
    const commitGroup = (anchor: TabKey, next: PaneLayout | undefined) => {
        if (!selectedPath) return;
        setPanes(map => withGroup(map, selectedPath, anchor, next));
        const tab = next && focusedTab(next);
        if (tab) setActiveTabs(map => ({ ...map, [selectedPath]: tab }));
    };
    /** The layout of the active tab for a change: a new layout with a new pane ID for a tab that is in no split yet. */
    const editableLayout = (): PaneLayout | undefined => (layout && split ? layout : activeTab ? tabLayout([], activeTab) : undefined);

    const focusPane = (leafId: string) => {
        if (layout && split && layout.focused !== leafId && activeTab) commitGroup(activeTab, { ...layout, focused: leafId });
    };
    // A click in a browser page does not reach the pane, because the page is a native view. Its focus event moves the focus.
    const focusBrowserPane = (id: string) => {
        const leaf = layout && leafOfTab(layout, browserTabKey(id));
        if (leaf) focusPane(leaf.id);
    };

    /**
     * Moves the keyboard focus to the workspace (⇧⌘0). In the worktree view, the focused pane gets the focus: its
     * terminal, its editor, its browser page or its first control. In other views, the main area gets the focus.
     */
    const focusWorkspace = (inWorktreeView: boolean) => {
        const leaf = inWorktreeView && layout ? findLeaf(layout, layout.focused) : undefined;
        if (leaf && selectedPath) {
            const extra = worktreeExtras.find(item => item.key === leaf.tab);
            if (leaf.tab.startsWith('t:')) {
                terminalPool.focus(leaf.tab.slice(2));
                return;
            }
            if (leaf.tab.startsWith('f:')) {
                setFocusRequest({ root: selectedPath, path: leaf.tab.slice(2), nonce: Date.now() });
                return;
            }
            if (extra?.kind === 'browser') {
                api.browser.focus(extra.id);
                return;
            }
            const pane = document.querySelector(`.terminal-area [data-pane="${leaf.id}"]`);
            const target =
                pane?.querySelector<HTMLElement>('.monaco-editor textarea') ??
                pane?.querySelector<HTMLElement>('textarea, input, select, button, a[href], [tabindex]:not([tabindex="-1"])');
            if (target) {
                target.focus();
                return;
            }
        }
        // The views that do not show have "display: none" or are not in the page.
        const main = [...document.querySelectorAll<HTMLElement>('main.workspace')].find(element => element.offsetParent !== null);
        if (!main) return;
        if (!main.hasAttribute('tabindex')) main.tabIndex = -1;
        main.focus();
    };

    /**
     * Drops a dragged tab at a side of a pane of the active tab. The dragged tab, with all its panes when it is a split,
     * joins the split of the active tab, and leaves the tab strip.
     */
    const dropTab = (dragged: TabKey, leafId: string, side: SplitSide) => {
        const base = editableLayout();
        if (!base || leafOfTab(base, dragged)) return;
        const target = split ? leafId : base.focused;
        const draggedGroup = groupOf(groups, dragged);
        const source = draggedGroup ? draggedGroup.root : tabLayout([], dragged).root;
        commitGroup(activeTab!, insertNode(base, target, source, side, draggedGroup?.focused));
    };

    /** Closes the view of a tab: a terminal stops, a file closes (it asks about unsaved changes), a diff or log closes. */
    const closeTabView = (tab: TabKey) => {
        if (!selectedPath) return;
        if (tab.startsWith('t:')) {
            const session = worktreeSessions.find(item => `t:${item.id}` === tab);
            if (session) void closeSession(session);
        } else if (tab.startsWith('f:')) {
            closeFile(selectedPath, tab.slice(2));
        } else {
            closeExtra(selectedPath, tab);
        }
    };
    /** Closes one pane of a split. The focus goes to another pane of the split first, so the tab stays. */
    const closePaneView = (leafId: string) => {
        const leaf = layout && findLeaf(layout, leafId);
        if (!layout || !leaf || !activeTab) return;
        commitGroup(activeTab, closePane(layout, leafId));
        closeTabView(leaf.tab);
    };
    /** Takes a pane out of the split. Its view becomes a tab of its own, and the active tab. */
    const movePaneToTab = (leafId: string) => {
        const leaf = layout && findLeaf(layout, leafId);
        if (!layout || !leaf || !selectedPath) return;
        commitGroup(leaf.tab, closePane(layout, leafId));
        activate(selectedPath, leaf.tab);
    };
    /** Closes a tab from a button in its view: its pane when it is in a split, else the tab. */
    const closeFromView = (tab: TabKey) => {
        const leaf = layout && split ? leafOfTab(layout, tab) : undefined;
        if (leaf) closePaneView(leaf.id);
        else closeTabView(tab);
    };
    /** Closes a split tab with all its panes. */
    const closeGroup = (group: PaneLayout) => {
        const tabs = leaves(group.root).map(leaf => leaf.tab);
        void confirmDialog({
            title: `Close this tab with its ${tabs.length} panes?`,
            message: 'Its terminals stop.',
            confirmLabel: 'Close tab',
            danger: true
        }).then(ok => ok && tabs.forEach(closeTabView));
    };

    /** True when the tab can close: a running agent stops only after the user agrees. */
    const confirmClose = async (tab: TabKey): Promise<boolean> => {
        const session = tab.startsWith('t:') ? worktreeSessions.find(item => `t:${item.id}` === tab) : undefined;
        if (!session?.isAgent || session.exited) return true;
        return confirmDialog({ title: `Close "${session.title}"?`, message: 'The agent stops.', confirmLabel: 'Close', danger: true });
    };

    /**
     * A terminal process ended, for example after "exit". Its pane closes, and the tab when it was its only pane,
     * as in Ghostty. In a split, the focus goes to another pane of the same tab.
     */
    const sessionExited = (id: string) => {
        const session = sessions.find(item => item.id === id);
        if (!session) return;
        const tab = `t:${id}`;
        const leaf = layout && split ? leafOfTab(layout, tab) : undefined;
        if (layout && leaf && activeTab) {
            commitGroup(activeTab, closePane(layout, leaf.id));
        }
        terminalPool.dispose(id);
        agentStateStore.delete(id);
        outputActivity.delete(id);
        setSessions(list => list.filter(item => item.id !== id));
        // The host keeps an ended session for its output. The tab is gone, so the host can forget it.
        void api.terminals.kill(id).catch(() => undefined);
    };

    /**
     * Runs a shortcut of the tab strip or of the split panes in a worktree: select a tab, close the focused pane,
     * move the focus to another pane, or open a new shell pane. Ignores other shortcuts.
     */
    const paneShortcut = async (action: ShortcutAction, worktree: Worktree) => {
        if (isTabSelectAction(action)) {
            if (!stripItems.length) return;
            const current = stripItems.findIndex(item => isStripItemActive(item, activeTab));
            const item = stripItems[stripTargetIndex(action, current, stripItems.length)];
            if (item) activate(worktree.path, item.key);
            return;
        }
        if (action === 'close') {
            if (!layout || !activeTab || !(await confirmClose(activeTab))) return;
            if (split) closePaneView(layout.focused);
            else closeTabView(activeTab);
            return;
        }
        if (action === 'focusLeft' || action === 'focusRight' || action === 'focusUp' || action === 'focusDown') {
            const side = ({ focusLeft: 'left', focusRight: 'right', focusUp: 'up', focusDown: 'down' } as const)[action];
            if (layout && split && activeTab) commitGroup(activeTab, focusSide(layout, side));
            return;
        }
        if (action !== 'right' && action !== 'down') return;
        try {
            const session = await api.terminals.create({ cwd: worktree.path, worktreePath: worktree.path, title: 'shell', cols: 120, rows: 32 });
            setSessions(list => [...list, session]);
            const tab = `t:${session.id}`;
            const base = editableLayout();
            if (base && activeTab) {
                commitGroup(activeTab, splitPane(base, base.focused, tab, action));
            } else {
                activate(worktree.path, tab);
            }
        } catch (err) {
            setError(errorText(err));
        }
    };

    /** Moves an entry of the tab strip one step to the left or to the right (⌃⇧← and ⌃⇧→). A split tab moves with all its panes. */
    const moveStripItem = (index: number, step: 1 | -1) => {
        if (!selectedPath) return;
        const order = moveStripEntry(stripEntries(stripItems), index, step);
        if (order) setTabOrders(map => ({ ...map, [selectedPath]: order }));
    };

    return {
        openFiles,
        setOpenFiles,
        activeTabs,
        setActiveTabs,
        panes,
        setPanes,
        extraTabs,
        setExtraTabs,
        draggingTab,
        setDraggingTab,
        dropTarget,
        setDropTarget,
        dirtyFiles,
        reveal,
        focusRequest,
        setFocusRequest,
        worktreeSessions,
        worktreeExtras,
        activeTab,
        groups,
        layout,
        split,
        activeFile,
        stripItems,
        activate,
        tabKeysOf,
        openExtra,
        openFile,
        commitGroup,
        editableLayout,
        focusPane,
        focusBrowserPane,
        focusWorkspace,
        dropTab,
        closeTabView,
        closePaneView,
        movePaneToTab,
        closeFromView,
        closeGroup,
        confirmClose,
        sessionExited,
        paneShortcut,
        moveStripItem
    };
}
