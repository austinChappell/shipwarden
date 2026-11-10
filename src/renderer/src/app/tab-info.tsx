import type { ReactNode } from 'react';
import { FileDiff, GitCompareArrows, Globe, ScrollText, SquareTerminal } from 'lucide-react';
import { BLANK_PAGE, browserTabTitle, type BrowserState } from '@shared/browser';
import { baseName } from '@shared/files';
import type { TerminalSession } from '@shared/terminal';
import { fileIcon } from '../files/file-icons';
import { fileKey, type ExtraTab, type TabKey } from './tabs';

/** The icon, the title and the state of a tab, for the tab strip and the pane buttons. */
export interface TabInfo {
    icon: ReactNode;
    title: string;
    tooltip?: string;
    dirty?: boolean;
    exited?: boolean;
}

/** The data of the selected worktree that the tab descriptions use. */
export interface TabContext {
    selectedPath: string | undefined;
    sessions: readonly TerminalSession[];
    extras: readonly ExtraTab[];
    dirtyFiles: ReadonlySet<string>;
    browserStates: ReadonlyMap<string, BrowserState>;
}

/** Returns the icon, the title and the state of a tab of the selected worktree. */
export function tabInfo(key: TabKey, context: TabContext): TabInfo {
    const { selectedPath, sessions, extras, dirtyFiles, browserStates } = context;
    if (key.startsWith('t:')) {
        const session = sessions.find(item => `t:${item.id}` === key);
        return { icon: <SquareTerminal className="tab-icon" size={14} strokeWidth={1.5} />, title: session?.title ?? 'terminal', exited: session?.exited };
    }
    if (key.startsWith('f:')) {
        const path = key.slice(2);
        const Icon = fileIcon(baseName(path));
        return {
            icon: <Icon className="tab-icon" size={14} strokeWidth={1.5} />,
            title: baseName(path),
            tooltip: path,
            dirty: !!selectedPath && dirtyFiles.has(fileKey(selectedPath, path))
        };
    }
    const extra = extras.find(item => item.key === key);
    if (extra?.kind === 'browser') {
        const state = browserStates.get(extra.id);
        return {
            icon: <Globe className="tab-icon" size={14} strokeWidth={1.5} />,
            title: browserTabTitle(state),
            tooltip: state?.url && state.url !== BLANK_PAGE ? state.url : undefined
        };
    }
    if (extra?.kind === 'changes') {
        return { icon: <GitCompareArrows className="tab-icon" size={14} strokeWidth={1.5} />, title: 'Changes', tooltip: 'All local changes of the worktree' };
    }
    if (extra?.kind === 'change') {
        return {
            icon: <GitCompareArrows className="tab-icon" size={14} strokeWidth={1.5} />,
            title: baseName(extra.change.path),
            tooltip: `${extra.side === 'staged' ? 'Staged changes' : 'Changes'} in ${extra.change.path}`
        };
    }
    return extra?.kind === 'diff'
        ? { icon: <FileDiff className="tab-icon" size={14} strokeWidth={1.5} />, title: baseName(extra.file.path), tooltip: `Changes in ${extra.file.path}` }
        : {
              icon: <ScrollText className="tab-icon" size={14} strokeWidth={1.5} />,
              title: extra?.check.name ?? 'log',
              tooltip: extra ? `Log of ${extra.check.name}` : undefined
          };
}
