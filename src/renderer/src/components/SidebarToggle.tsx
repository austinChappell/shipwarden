import { createContext, useContext } from 'react';
import { PanelLeft } from 'lucide-react';

export interface SidebarState {
    collapsed: boolean;
    toggle(): void;
}

/** The state of the left sidebar. The app provides it, and the top bar of each view shows the toggle. */
export const SidebarContext = createContext<SidebarState>({ collapsed: false, toggle: () => undefined });

/**
 * The button that hides and shows the left sidebar. It is the first item of the top bar of each view, so it sits just
 * inside the main area, as the right panel button does at the other end.
 */
export function SidebarToggle() {
    const { collapsed, toggle } = useContext(SidebarContext);
    return (
        <button
            className="icon-button sidebar-toggle"
            title={collapsed ? 'Show the sidebar (⌘B)' : 'Hide the sidebar (⌘B)'}
            aria-pressed={!collapsed}
            onClick={toggle}
        >
            <PanelLeft size={16} strokeWidth={1.5} />
        </button>
    );
}
