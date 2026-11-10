import { useEffect, useState } from 'react';
import {
    Bell,
    Bot,
    FolderTree,
    GitPullRequest,
    Info,
    LayoutDashboard,
    ListTodo,
    Network,
    Palette,
    Smartphone,
    SquareTerminal,
    X,
    type LucideIcon
} from 'lucide-react';
import type { AppInfo } from '@shared/api';
import { repoDisplayName, type AppSettings } from '@shared/settings';
import { RepoIcon } from './RepoIcon';
import type { TerminalSettings } from '@shared/terminal';
import { errorText } from '../util';
import type { Mode } from '@shared/themes';
import { AgentsSettings } from './AgentsSettings';
import { CodeReviewSettings } from './CodeReviewSettings';
import { DashboardSettings } from './DashboardSettings';
import { NetworkSettings } from './NetworkSettings';
import { MobileSettings } from './MobileSettings';
import { NotificationSettings } from './NotificationSettings';
import { WorktreeSettings } from './WorktreeSettings';
import { AppearanceSettings } from './AppearanceSettings';
import { RepoSettingsPage } from './RepoSettingsPage';
import { TaskManagersSettings } from './TaskManagersSettings';
import { SettingsGroup, SettingsRow } from './settings-ui';
import { UpdateSettings } from './UpdateNotice';

type FixedSection = 'appearance' | 'notifications' | 'dashboard' | 'tasks' | 'review' | 'worktrees' | 'agents' | 'terminal' | 'network' | 'mobile' | 'about';
/** A fixed section, or "repo:<path>" for the settings of one repository. */
type SectionId = FixedSection | `repo:${string}`;

/** The fixed sections of the settings page, in the order of the section list. */
const SECTIONS: { id: FixedSection; label: string; icon: LucideIcon }[] = [
    { id: 'appearance', label: 'Appearance', icon: Palette },
    { id: 'notifications', label: 'Notifications', icon: Bell },
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'tasks', label: 'Task managers', icon: ListTodo },
    { id: 'review', label: 'Code review', icon: GitPullRequest },
    { id: 'worktrees', label: 'Worktrees', icon: FolderTree },
    { id: 'agents', label: 'Agents', icon: Bot },
    { id: 'terminal', label: 'Terminal', icon: SquareTerminal },
    { id: 'network', label: 'Network', icon: Network },
    { id: 'mobile', label: 'Mobile', icon: Smartphone },
    { id: 'about', label: 'About', icon: Info }
];

const SECTION_STORAGE_KEY = 'shipwarden.settingsSection';

/** Returns the app section that the user selected last. The settings page opens on it when no section is requested. */
export function readSettingsSection(): string {
    try {
        const value = localStorage.getItem(SECTION_STORAGE_KEY);
        return SECTIONS.some(item => item.id === value) ? (value as SectionId) : 'appearance';
    } catch {
        return 'appearance';
    }
}

const api = window.shipwarden;

interface Props {
    settings: AppSettings;
    /** The mode that applies now. */
    mode: Mode;
    terminal?: TerminalSettings;
    /** The repositories of the active project. Each one has a section with its settings. */
    repos: string[];
    /**
     * The section that the page shows: a fixed section, or "repo:<path>" for the settings of one repository. Each section
     * is a page of the history.
     */
    section: string;
    /** Shows a different section. The change adds a history entry. */
    onSelectSection(section: string): void;
    /** A new hiding rule for Settings > Dashboard to fill in, from a comment on the Dashboard. */
    rulePrefill?: { author: string; text: string; nonce: number };
    onSave(change: Partial<AppSettings>): Promise<void>;
    onClose(): void;
}

/**
 * The settings page: a section list at the left and the selected section at the right. The list has the app sections
 * and the repositories of the active project. ⌘, opens it. Escape closes it.
 */
export function SettingsView({ settings, mode, terminal, repos, section: sectionProp, onSelectSection, rulePrefill, onSave, onClose }: Props) {
    const [status, setStatus] = useState<string>();
    const [info, setInfo] = useState<AppInfo>();
    const section = sectionProp as SectionId;
    const selectSection = (id: SectionId) => {
        onSelectSection(id);
        if (id.startsWith('repo:')) return;
        try {
            localStorage.setItem(SECTION_STORAGE_KEY, id);
        } catch {
            // The choice stays for this session only.
        }
    };

    useEffect(() => {
        api.app.info().then(setInfo, () => undefined);
    }, []);

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            // Escape in a field only leaves the field. The page closes on Escape elsewhere.
            const target = event.target as HTMLElement;
            const field =
                target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement || target.isContentEditable;
            if (event.key === 'Escape' && !field) {
                onClose();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    const terminalSection = (
        <SettingsGroup
            title="Ghostty settings"
            description="ShipWarden uses your Ghostty settings for the font, the colors, the cursor and text keybinds. Change them in your Ghostty config. They apply after a restart."
            card
        >
            {terminal ? (
                <>
                    <SettingsRow
                        label="Source"
                        control={<span className="settings-value mono">{terminal.source ?? 'ShipWarden defaults (no Ghostty config found)'}</span>}
                    />
                    <SettingsRow
                        label="Font"
                        control={
                            <span className="settings-value">
                                {terminal.fontFamily.split(',')[0].replace(/["']/g, '')}, {terminal.fontSize} pt
                            </span>
                        }
                    />
                    <SettingsRow
                        label="Cursor"
                        control={
                            <span className="settings-value">
                                {terminal.cursorStyle}
                                {terminal.cursorBlink ? ', blinks' : ''}
                            </span>
                        }
                    />
                    <SettingsRow label="Text keybinds" control={<span className="settings-value">{terminal.keybinds.length}</span>} />
                </>
            ) : (
                <SettingsRow label="Loading…" />
            )}
        </SettingsGroup>
    );

    const aboutSection = (
        <SettingsGroup title="ShipWarden" card>
            {info && (
                <>
                    <SettingsRow label="Version" control={<span className="settings-value">{info.version}</span>} />
                    <SettingsRow
                        label="Updates"
                        description="New versions come from the releases of the GitHub repository austinChappell/shipwarden."
                        control={<UpdateSettings />}
                    />
                    <SettingsRow label="Data folder" control={<span className="settings-value mono">{info.dataFolder}</span>} />
                    <SettingsRow label="Terminal host log" control={<span className="settings-value mono">{info.ptyHostLog}</span>} />
                </>
            )}
        </SettingsGroup>
    );

    const repoSection = section.startsWith('repo:') ? section.slice('repo:'.length) : undefined;
    // A repository section only applies while the repository is in the active project.
    const current =
        repoSection && repos.includes(repoSection)
            ? { id: section, label: repoDisplayName(settings, repoSection) }
            : (SECTIONS.find(item => item.id === section) ?? SECTIONS[0]);

    return (
        <div className="settings-view">
            <header className="settings-header">
                <h1>
                    <span className="settings-crumb">Settings</span>
                    <span className="settings-crumb-separator">/</span>
                    {current.label}
                </h1>
                <button className="icon-button" title="Close settings (Escape)" onClick={onClose}>
                    <X size={16} strokeWidth={1.75} />
                </button>
            </header>
            <div className="settings-body">
                <nav className="settings-nav" aria-label="Settings sections">
                    {SECTIONS.map(item => (
                        <button
                            key={item.id}
                            className={`settings-nav-item${item.id === current.id ? ' selected' : ''}`}
                            aria-current={item.id === current.id ? 'page' : undefined}
                            onClick={() => selectSection(item.id)}
                        >
                            <item.icon size={15} strokeWidth={1.6} />
                            {item.label}
                        </button>
                    ))}
                    {repos.length > 0 && <div className="settings-nav-heading">Repositories</div>}
                    {repos.map(repo => {
                        const id = `repo:${repo}` as const;
                        const color = settings.repos[repo]?.color;
                        return (
                            <button
                                key={repo}
                                className={`settings-nav-item${id === current.id ? ' selected' : ''}`}
                                aria-current={id === current.id ? 'page' : undefined}
                                title={repo}
                                onClick={() => selectSection(id)}
                            >
                                <RepoIcon color={color} size={15} strokeWidth={1.6} />
                                <span className="settings-nav-text">{repoDisplayName(settings, repo)}</span>
                            </button>
                        );
                    })}
                </nav>
                <div className="settings-scroll">
                    <div className="settings-page" key={current.id}>
                        {current.id === 'appearance' && (
                            <AppearanceSettings
                                appearance={settings.appearance}
                                mode={mode}
                                onChange={appearance => onSave({ appearance }).catch(err => setStatus(errorText(err)))}
                            />
                        )}
                        {current.id === 'tasks' && <TaskManagersSettings />}
                        {current.id === 'review' && <CodeReviewSettings />}
                        {current.id === 'worktrees' && <WorktreeSettings settings={settings} repos={repos} onSave={onSave} />}
                        {current.id === 'notifications' && <NotificationSettings settings={settings} onSave={onSave} />}
                        {current.id === 'network' && <NetworkSettings settings={settings} onSave={onSave} />}
                        {current.id === 'mobile' && <MobileSettings settings={settings} onSave={onSave} />}
                        {current.id === 'dashboard' && <DashboardSettings settings={settings} onSave={onSave} prefill={rulePrefill} />}
                        {current.id === 'agents' && <AgentsSettings settings={settings} onSave={onSave} />}
                        {repoSection && current.id === section && <RepoSettingsPage repo={repoSection} settings={settings} onSave={onSave} />}
                        {status && <div className="form-error">{status}</div>}
                        {current.id === 'terminal' && terminalSection}
                        {current.id === 'about' && aboutSection}
                    </div>
                </div>
            </div>
        </div>
    );
}
