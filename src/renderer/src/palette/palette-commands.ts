import {
    Bot,
    ClipboardList,
    Contrast,
    Download,
    FileText,
    FolderGit2,
    GitBranch,
    GitBranchPlus,
    GitPullRequest,
    HelpCircle,
    Keyboard,
    LayoutDashboard,
    ListTodo,
    Palette,
    Plus,
    Rocket,
    Settings,
    SquareTerminal,
    Trash2,
    Workflow,
    Zap
} from 'lucide-react';
import { AUTOMATION_TEMPLATES, type Automation } from '@shared/automations';
import type { NoteInfo } from '@shared/notes';
import type { Plan } from '@shared/plans';
import type { OpenPullRequest } from '@shared/review-queue';
import { APP_KEY_INFO, SHORTCUT_INFO } from '@shared/shortcuts';
import type { TaskLink } from '@shared/tasks';
import { THEMES, type Appearance, type ColorScheme, type Mode } from '@shared/themes';
import { worktreeLabel, type Worktree } from '@shared/worktrees';
import type { HelpAction } from '@shared/onboarding';
import type { ContentView } from '../app/views';
import type { PaletteItem, PalettePage } from './palette-model';

/** A section of the settings page, for the palette. */
export interface PaletteSettingsSection {
    id: string;
    label: string;
}

/** The actions of the app that the palette runs. */
export interface PaletteActions {
    newWorktree(repo: string): void;
    showWorktree(path: string): void;
    removeWorktree(repo: string, worktree: Worktree): Promise<void>;
    enterView(view: ContentView): void;
    /** Opens a pull request in the Review view. `repo` is "owner/name". */
    openPullRequest(repo: string, number: number): void;
    openLinkedTask(worktreePath: string): void;
    createTask(): void;
    createPlan(): Promise<void>;
    openPlan(id: string): void;
    createNote(): Promise<void>;
    openNote(name: string): void;
    /** Opens the editor of a new automation from a template. "blank" is the empty automation. */
    newAutomation(templateId: string): void;
    editAutomation(id: string): void;
    openSettings(section?: string): void;
    setAppearance(change: Partial<Appearance>): Promise<void>;
    checkForUpdates(): Promise<void>;
    help(action: HelpAction): void;
}

/** The state of the app that the palette shows. */
export interface PaletteContext {
    repos: readonly string[];
    worktreesByRepo: Record<string, Worktree[]>;
    worktreeNames: Record<string, string> | undefined;
    repoLabel(repo: string): string;
    /** The repository of the selected worktree. "Create a worktree" uses it first. */
    selectedRepo: string | undefined;
    selectedPath: string | undefined;
    links: Record<string, TaskLink>;
    /** False when the project has no repositories. The sidebar then does not show Tasks. */
    tasksAvailable: boolean;
    /** False until a project is active. Plans need a project. */
    hasProject: boolean;
    plans: readonly Plan[];
    /** The notes, or undefined while they load. */
    notes: readonly NoteInfo[] | undefined;
    automations: readonly Automation[];
    /** The pull requests of the review queue. `repo` is "owner/name". */
    reviewQueue: readonly { repo: string; pr: OpenPullRequest }[];
    /** False when no review provider is on. The Review view then shows its setup page. */
    reviewAvailable: boolean;
    appearance: Appearance;
    /** The mode that applies now. A theme change applies to the theme of this mode. */
    mode: Mode;
    settingsSections: readonly PaletteSettingsSection[];
    actions: PaletteActions;
}

/** The worktrees of the project, with their repository, in the order of the sidebar. */
function allWorktrees(context: PaletteContext): { repo: string; worktree: Worktree }[] {
    return context.repos.flatMap(repo => (context.worktreesByRepo[repo] ?? []).map(worktree => ({ repo, worktree })));
}

/** The text at the right of a worktree: its repository, when the project has more than one. */
function worktreeDetail(context: PaletteContext, repo: string): string | undefined {
    return context.repos.length > 1 ? context.repoLabel(repo) : undefined;
}

function worktreeItems(context: PaletteContext, searchOnly: boolean): PaletteItem[] {
    return allWorktrees(context).map(({ repo, worktree }) => ({
        id: `worktree:${worktree.path}`,
        label: worktreeLabel(worktree, context.worktreeNames),
        group: 'Worktrees',
        detail: worktreeDetail(context, repo),
        keywords: [worktree.branch ?? '', worktree.path],
        icon: worktree.isMain ? FolderGit2 : GitBranch,
        current: worktree.path === context.selectedPath,
        searchOnly,
        run: () => context.actions.showWorktree(worktree.path)
    }));
}

function removableWorktreeItems(context: PaletteContext): PaletteItem[] {
    return allWorktrees(context)
        .filter(({ worktree }) => !worktree.isMain)
        .map(({ repo, worktree }) => ({
            id: `remove:${worktree.path}`,
            label: worktreeLabel(worktree, context.worktreeNames),
            group: 'Worktrees',
            detail: worktreeDetail(context, repo),
            keywords: [worktree.branch ?? '', worktree.path],
            icon: Trash2,
            danger: true,
            run: () => context.actions.removeWorktree(repo, worktree)
        }));
}

function repoItems(context: PaletteContext): PaletteItem[] {
    return context.repos.map(repo => ({
        id: `repo:${repo}`,
        label: context.repoLabel(repo),
        group: 'Worktrees',
        detail: repo,
        icon: FolderGit2,
        current: repo === context.selectedRepo,
        run: () => context.actions.newWorktree(repo)
    }));
}

function pullRequestItems(context: PaletteContext, searchOnly: boolean): PaletteItem[] {
    return context.reviewQueue.map(({ repo, pr }) => ({
        id: `pr:${repo}#${pr.number}`,
        label: pr.title,
        group: 'Review',
        detail: `${repo.split('/').pop()} #${pr.number}`,
        keywords: [repo, `#${pr.number}`, pr.author ?? '', pr.headRefName],
        icon: GitPullRequest,
        searchOnly,
        run: () => context.actions.openPullRequest(repo, pr.number)
    }));
}

function linkedTaskItems(context: PaletteContext, searchOnly: boolean): PaletteItem[] {
    return allWorktrees(context).flatMap(({ worktree }) => {
        const link = context.links[worktree.path];
        if (!link) return [];
        return [
            {
                id: `task:${worktree.path}`,
                label: link.key ? `${link.key} ${link.title}` : link.title,
                group: 'Tasks' as const,
                detail: worktreeLabel(worktree, context.worktreeNames),
                icon: ListTodo,
                searchOnly,
                run: () => context.actions.openLinkedTask(worktree.path)
            }
        ];
    });
}

function planItems(context: PaletteContext, searchOnly: boolean): PaletteItem[] {
    return context.plans.map(plan => ({
        id: `plan:${plan.id}`,
        label: plan.title || 'Untitled plan',
        group: 'Plans',
        keywords: [plan.idea.slice(0, 200)],
        icon: ClipboardList,
        searchOnly,
        run: () => context.actions.openPlan(plan.id)
    }));
}

function noteItems(notes: readonly NoteInfo[], context: PaletteContext, searchOnly: boolean): PaletteItem[] {
    return notes.map(note => ({
        id: `note:${note.name}`,
        label: note.fileName,
        group: 'Notes',
        detail: note.folder || undefined,
        keywords: note.tags,
        icon: FileText,
        searchOnly,
        run: () => context.actions.openNote(note.name)
    }));
}

function automationItems(context: PaletteContext, searchOnly: boolean): PaletteItem[] {
    return context.automations.map(automation => ({
        id: `automation:${automation.id}`,
        label: automation.name,
        group: 'Automations',
        detail: automation.status === 'off' ? 'Off' : automation.status === 'dry-run' ? 'Dry run' : undefined,
        icon: Zap,
        searchOnly,
        run: () => context.actions.editAutomation(automation.id)
    }));
}

function settingsSectionItems(context: PaletteContext, searchOnly: boolean): PaletteItem[] {
    const sections = context.settingsSections.map(section => ({
        id: `settings:${section.id}`,
        label: `Settings: ${section.label}`,
        group: 'Settings' as const,
        icon: Settings,
        searchOnly,
        run: () => context.actions.openSettings(section.id)
    }));
    const repos = context.repos.map(repo => ({
        id: `settings:repo:${repo}`,
        label: `Settings: ${context.repoLabel(repo)}`,
        group: 'Settings' as const,
        detail: 'Repository',
        icon: FolderGit2,
        searchOnly,
        run: () => context.actions.openSettings(`repo:${repo}`)
    }));
    return [...sections, ...repos];
}

/** The page of a list of items. */
function page(id: string, title: string, placeholder: string, empty: string, items: PaletteItem[] | Promise<PaletteItem[]>): PalettePage {
    return { id, title, placeholder, empty, items };
}

const SCHEMES: { id: ColorScheme; label: string }[] = [
    { id: 'system', label: 'Use the macOS setting' },
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' }
];

/**
 * Returns the items of the first page of the command palette. The commands show in their groups. The worktrees, pull
 * requests, tasks, plans, notes, automations, and settings sections show only in the results of a search.
 */
export function paletteItems(context: PaletteContext): PaletteItem[] {
    const { actions } = context;
    const themeKey = context.mode === 'dark' ? 'darkTheme' : 'lightTheme';
    const items: PaletteItem[] = [];

    // Worktrees.
    if (context.repos.length > 0) {
        const repo = context.selectedRepo ?? context.repos[0];
        items.push(
            context.repos.length === 1
                ? {
                      id: 'new-worktree',
                      label: 'Create a worktree',
                      group: 'Worktrees',
                      keywords: ['new', 'branch'],
                      icon: GitBranchPlus,
                      keys: SHORTCUT_INFO.newWorktree.keys[0],
                      run: () => actions.newWorktree(repo)
                  }
                : {
                      id: 'new-worktree',
                      label: 'Create a worktree',
                      group: 'Worktrees',
                      keywords: ['new', 'branch'],
                      icon: GitBranchPlus,
                      page: () => page('new-worktree', 'Create a worktree', 'Select a repository', 'The project has no repositories.', repoItems(context))
                  },
            {
                id: 'go-worktree',
                label: 'Go to a worktree',
                group: 'Worktrees',
                keywords: ['open', 'switch', 'select', 'branch'],
                icon: GitBranch,
                page: () => page('go-worktree', 'Go to a worktree', 'Find a worktree', 'The project has no worktrees.', worktreeItems(context, false))
            },
            {
                id: 'remove-worktree',
                label: 'Remove a worktree',
                group: 'Worktrees',
                keywords: ['delete', 'branch'],
                icon: Trash2,
                page: () =>
                    page(
                        'remove-worktree',
                        'Remove a worktree',
                        'Find the worktree to remove',
                        'The project has no worktrees to remove. The main worktree of a repository stays.',
                        removableWorktreeItems(context)
                    )
            },
            ...worktreeItems(context, true)
        );
    }

    // Review.
    items.push({
        id: 'view-review',
        label: 'Open Review',
        group: 'Review',
        keywords: ['pull requests', 'code review'],
        icon: GitPullRequest,
        keys: SHORTCUT_INFO.viewReview.keys[0],
        run: () => actions.enterView('review')
    });
    if (context.reviewAvailable) {
        items.push(
            {
                id: 'review-pr',
                label: 'Review a pull request',
                group: 'Review',
                keywords: ['queue', 'open'],
                icon: GitPullRequest,
                page: () =>
                    page(
                        'review-pr',
                        'Review a pull request',
                        'Find a pull request',
                        'No pull requests wait for your review.',
                        pullRequestItems(context, false)
                    )
            },
            ...pullRequestItems(context, true)
        );
    }

    // Tasks.
    if (context.tasksAvailable) {
        items.push(
            {
                id: 'view-tasks',
                label: 'Open Tasks',
                group: 'Tasks',
                icon: ListTodo,
                keys: SHORTCUT_INFO.viewTasks.keys[0],
                run: () => actions.enterView('tasks')
            },
            {
                id: 'new-task',
                label: 'Create a task',
                group: 'Tasks',
                keywords: ['new', 'ticket', 'issue'],
                icon: Plus,
                run: () => actions.createTask()
            },
            {
                id: 'worktree-task',
                label: 'Open the task of a worktree',
                group: 'Tasks',
                keywords: ['linked', 'ticket', 'issue'],
                icon: ListTodo,
                page: () =>
                    page('worktree-task', 'Open the task of a worktree', 'Find a task', 'No worktree has a linked task.', linkedTaskItems(context, false))
            },
            ...linkedTaskItems(context, true)
        );
    }

    // Plans.
    if (context.hasProject) {
        items.push(
            {
                id: 'view-plans',
                label: 'Open Plans',
                group: 'Plans',
                icon: ClipboardList,
                run: () => actions.enterView('plans')
            },
            {
                id: 'new-plan',
                label: 'Create a plan',
                group: 'Plans',
                keywords: ['new', 'idea', 'explore'],
                icon: Plus,
                run: () => actions.createPlan()
            },
            {
                id: 'open-plan',
                label: 'Open a plan',
                group: 'Plans',
                keywords: ['existing', 'view'],
                icon: ClipboardList,
                page: () => page('open-plan', 'Open a plan', 'Find a plan', 'The project has no plans.', planItems(context, false))
            },
            ...planItems(context, true)
        );
    }

    // Notes.
    items.push(
        {
            id: 'view-notes',
            label: 'Open Notes',
            group: 'Notes',
            icon: FileText,
            keys: SHORTCUT_INFO.viewNotes.keys[0],
            run: () => actions.enterView('notes')
        },
        {
            id: 'new-note',
            label: 'Create a note',
            group: 'Notes',
            keywords: ['new', 'scratch'],
            icon: Plus,
            run: () => actions.createNote()
        },
        {
            id: 'open-note',
            label: 'Open a note',
            group: 'Notes',
            keywords: ['existing', 'find'],
            icon: FileText,
            page: () => page('open-note', 'Open a note', 'Find a note', 'You have no notes.', noteItems(context.notes ?? [], context, false))
        },
        ...noteItems(context.notes ?? [], context, true)
    );

    // Automations.
    items.push(
        {
            id: 'view-automations',
            label: 'Open Automations',
            group: 'Automations',
            icon: Zap,
            keys: SHORTCUT_INFO.viewAutomations.keys[0],
            run: () => actions.enterView('automations')
        },
        {
            id: 'new-automation',
            label: 'Create an automation',
            group: 'Automations',
            keywords: ['new', 'template'],
            icon: Plus,
            page: () =>
                page('new-automation', 'Create an automation', 'Select a template', 'No templates.', [
                    { id: 'blank', label: 'Empty automation', group: 'Automations', icon: Plus, run: () => actions.newAutomation('blank') },
                    ...AUTOMATION_TEMPLATES.map(template => ({
                        id: template.id,
                        label: template.name,
                        group: 'Automations' as const,
                        keywords: [template.description],
                        icon: Zap,
                        run: () => actions.newAutomation(template.id)
                    }))
                ])
        },
        {
            id: 'edit-automation',
            label: 'Edit an automation',
            group: 'Automations',
            keywords: ['open', 'existing', 'change'],
            icon: Zap,
            page: () => page('edit-automation', 'Edit an automation', 'Find an automation', 'You have no automations.', automationItems(context, false))
        },
        ...automationItems(context, true)
    );

    // Views.
    items.push(
        {
            id: 'view-dashboard',
            label: 'Open the Dashboard',
            group: 'Views',
            icon: LayoutDashboard,
            keys: SHORTCUT_INFO.viewDashboard.keys[0],
            run: () => actions.enterView('dashboard')
        },
        {
            id: 'view-agents',
            label: 'Open Agents',
            group: 'Views',
            icon: Bot,
            keys: SHORTCUT_INFO.viewAgents.keys[0],
            run: () => actions.enterView('agents')
        },
        {
            id: 'view-pipelines',
            label: 'Open Pipelines',
            group: 'Views',
            keywords: ['ci', 'builds', 'actions'],
            icon: Workflow,
            keys: SHORTCUT_INFO.viewPipelines.keys[0],
            run: () => actions.enterView('pipelines')
        },
        {
            id: 'view-terminal',
            label: 'Open Terminal',
            group: 'Views',
            keywords: ['shell', 'home'],
            icon: SquareTerminal,
            run: () => actions.enterView('terminal')
        }
    );

    // Settings.
    items.push(
        {
            id: 'settings',
            label: 'Open Settings',
            group: 'Settings',
            keywords: ['preferences'],
            icon: Settings,
            keys: APP_KEY_INFO.settings.keys[0],
            run: () => actions.openSettings()
        },
        {
            id: 'settings-section',
            label: 'Open a settings section',
            group: 'Settings',
            keywords: ['preferences', 'repository'],
            icon: Settings,
            page: () => page('settings-section', 'Open a settings section', 'Find a section', 'No sections.', settingsSectionItems(context, false))
        },
        {
            id: 'theme',
            label: 'Change the theme',
            group: 'Settings',
            keywords: ['appearance', 'colors'],
            detail: THEMES.find(theme => theme.id === context.appearance[themeKey])?.name,
            icon: Palette,
            page: () =>
                page(
                    'theme',
                    'Change the theme',
                    `Select the ${context.mode} theme`,
                    'No themes.',
                    THEMES.map(theme => ({
                        id: theme.id,
                        label: theme.name,
                        group: 'Settings' as const,
                        icon: Palette,
                        current: theme.id === context.appearance[themeKey],
                        run: () => actions.setAppearance({ [themeKey]: theme.id })
                    }))
                )
        },
        {
            id: 'scheme',
            label: 'Change the color mode',
            group: 'Settings',
            keywords: ['appearance', 'light', 'dark', 'scheme'],
            detail: SCHEMES.find(scheme => scheme.id === context.appearance.scheme)?.label,
            icon: Contrast,
            page: () =>
                page(
                    'scheme',
                    'Change the color mode',
                    'Select a mode',
                    'No modes.',
                    SCHEMES.map(scheme => ({
                        id: scheme.id,
                        label: scheme.label,
                        group: 'Settings' as const,
                        icon: Contrast,
                        current: scheme.id === context.appearance.scheme,
                        run: () => actions.setAppearance({ scheme: scheme.id })
                    }))
                )
        },
        {
            id: 'updates',
            label: 'Check for updates',
            group: 'Settings',
            keywords: ['version', 'upgrade'],
            icon: Download,
            keys: APP_KEY_INFO.checkForUpdates.keys[0],
            run: () => actions.checkForUpdates()
        },
        ...settingsSectionItems(context, true)
    );

    // Help.
    items.push(
        {
            id: 'shortcuts',
            label: 'Show the keyboard shortcuts',
            group: 'Help',
            keywords: ['keys', 'hotkeys'],
            icon: Keyboard,
            run: () => actions.help('shortcuts')
        },
        {
            id: 'tour',
            label: 'Start the tour',
            group: 'Help',
            keywords: ['guide', 'onboarding'],
            icon: Rocket,
            run: () => actions.help('tour')
        },
        {
            id: 'welcome',
            label: 'Open the welcome page',
            group: 'Help',
            keywords: ['onboarding', 'setup', 'getting started'],
            icon: HelpCircle,
            run: () => actions.help('welcome')
        }
    );

    return items;
}
