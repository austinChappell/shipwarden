import { useContext, useEffect, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { normalizeCodeFolder, repoDisplayName, type AppSettings } from '@shared/settings';
import {
    DEFAULT_COPY_EXCLUDE,
    DEFAULT_COPY_PATTERNS,
    type CopyIgnoredSettings,
    type CopyMode,
    type WorktreeSettings as WorktreeSettingsValue
} from '@shared/worktree-settings';
import { BRANCH_VARIABLES, exampleValues, renderBranchTemplate, unknownVariables } from '@shared/branch-template';
import { WORKTREE_SORT_LABELS, type WorktreeSort, type WorktreeSortKey } from '@shared/worktrees';
import { errorText } from '../util';
import { fetchAppInfo } from '../app/task-branch';
import { CODE_FOLDER_DIALOG_TITLE, CodeFolderContext } from './code-folder';
import { SettingsGroup, SettingsRow } from './settings-ui';
import { Button, ButtonGroup, Input, Select, Switch, TextArea } from './ui';
import { radioGroupKeys } from './keyboard';

/** Splits the text of the patterns field into patterns, one on each line. */
function parsePatterns(text: string): string[] {
    return text
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);
}

/** A folder field with a "Choose…" button. It saves when the field loses focus. `dialogTitle` is the title of the folder dialog. */
export function FolderField({
    value,
    placeholder,
    dialogTitle,
    onSave
}: {
    value: string | undefined;
    placeholder: string;
    dialogTitle?: string;
    onSave(value: string | undefined): void;
}) {
    const [text, setText] = useState(value ?? '');
    useEffect(() => setText(value ?? ''), [value]);
    const commit = (next: string) => {
        if (next.trim() !== (value ?? '')) onSave(next.trim() || undefined);
    };
    return (
        <div className="ca-file-row">
            <Input
                className="ca-file-input"
                mono
                value={text}
                placeholder={placeholder}
                spellCheck={false}
                onChange={event => setText(event.target.value)}
                onBlur={() => commit(text)}
                onKeyDown={event => event.key === 'Enter' && (event.target as HTMLInputElement).blur()}
            />
            <Button
                icon={<FolderOpen size={14} strokeWidth={1.6} />}
                title="Choose a folder"
                onClick={async () => {
                    const folder = await window.shipwarden.worktrees.chooseFolder(dialogTitle);
                    if (folder) {
                        setText(folder);
                        commit(folder);
                    }
                }}
            >
                Choose…
            </Button>
        </div>
    );
}

/** The files that the copy settings copy now from the main worktree of a repository. */
export function CopyPreview({ repo, copy }: { repo: string | undefined; copy: CopyIgnoredSettings }) {
    const [matches, setMatches] = useState<string[]>();
    const [error, setError] = useState<string>();
    const key = JSON.stringify(copy);
    // biome-ignore lint/correctness/useExhaustiveDependencies: key holds the content of copy. The copy object can change identity without a change in content.
    useEffect(() => {
        if (!repo) return;
        let current = true;
        setMatches(undefined);
        setError(undefined);
        window.shipwarden.worktrees.previewCopy(repo, copy).then(
            result => current && setMatches(result),
            err => current && setError(errorText(err))
        );
        return () => {
            current = false;
        };
    }, [repo, key]);
    if (!repo) return null;
    if (error) return <div className="form-error">{error}</div>;
    if (!matches) return <div className="panel-note">Finding the files…</div>;
    return (
        <div className="panel-note copy-preview">
            {matches.length === 0 ? (
                'No git-ignored file in the main worktree matches now.'
            ) : (
                <>A new worktree gets {matches.length === 1 ? 'this' : `these ${matches.length}`} (a name with &quot;/&quot; at the end is a folder):</>
            )}
            {matches.slice(0, 12).map(item => (
                <code key={item}>{item}</code>
            ))}
            {matches.length > 12 && <span>and {matches.length - 12} more</span>}
        </div>
    );
}

/** A text field for copy patterns, one on each line. It saves when the field loses focus. */
export function PatternsField({
    patterns,
    placeholder = DEFAULT_COPY_PATTERNS,
    onSave
}: {
    patterns: string[];
    placeholder?: string[];
    onSave(patterns: string[]): void;
}) {
    const joined = patterns.join('\n');
    const [text, setText] = useState(joined);
    useEffect(() => setText(joined), [joined]);
    return (
        <TextArea
            className="patterns-field"
            mono
            value={text}
            spellCheck={false}
            placeholder={placeholder.join('\n')}
            onChange={event => setText(event.target.value)}
            onBlur={() => {
                const next = parsePatterns(text);
                if (next.join('\n') !== patterns.join('\n')) onSave(next);
            }}
        />
    );
}

export const PATTERN_HELP =
    'One pattern on each line. A pattern without "/" matches the name in any folder, for example .env.*. ' +
    'A pattern with "/" matches the path from the repository root, for example config/master.key. ' +
    'A pattern with "/" at the end matches only folders, for example node_modules/. Only git-ignored files are copied.';

const listOf = (copy: CopyIgnoredSettings) => (copy.mode === 'matching' ? copy.patterns : copy.exclude);
const defaultsOf = (mode: CopyMode) => (mode === 'matching' ? DEFAULT_COPY_PATTERNS : DEFAULT_COPY_EXCLUDE);
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((item, index) => item === b[index]);

/** The mode of the copy and its list: the patterns to copy, or the patterns to leave out. With a preview for `repo`. */
export function CopyEditor({ copy, repo, onSave }: { copy: CopyIgnoredSettings; repo: string | undefined; onSave(copy: CopyIgnoredSettings): void }) {
    const setMode = (mode: CopyMode) => onSave({ ...copy, mode });
    return (
        <>
            <ButtonGroup className="copy-mode" role="radiogroup" label="What to copy" onKeyDown={radioGroupKeys}>
                <Button
                    role="radio"
                    aria-checked={copy.mode === 'matching'}
                    onClick={() => setMode('matching')}
                    title="Copy only the ignored files that match the patterns"
                >
                    Matching files
                </Button>
                <Button
                    role="radio"
                    aria-checked={copy.mode === 'allExcept'}
                    onClick={() => setMode('allExcept')}
                    title="Copy all ignored files and folders except the patterns"
                >
                    All except
                </Button>
            </ButtonGroup>
            {copy.mode === 'matching' ? (
                <PatternsField key="patterns" patterns={copy.patterns} onSave={patterns => onSave({ ...copy, patterns })} />
            ) : (
                <PatternsField key="exclude" patterns={copy.exclude} placeholder={DEFAULT_COPY_EXCLUDE} onSave={exclude => onSave({ ...copy, exclude })} />
            )}
            {/* A saved list keeps its values when the defaults change. The link sets the current defaults. */}
            {!sameList(listOf(copy), defaultsOf(copy.mode)) && (
                <Button
                    variant="link"
                    className="copy-reset"
                    title={defaultsOf(copy.mode).join('\n')}
                    onClick={() =>
                        onSave(copy.mode === 'matching' ? { ...copy, patterns: [...DEFAULT_COPY_PATTERNS] } : { ...copy, exclude: [...DEFAULT_COPY_EXCLUDE] })
                    }
                >
                    Reset to the default list
                </Button>
            )}
            <div className="panel-note">
                {copy.mode === 'allExcept' &&
                    'ShipWarden copies every git-ignored file and folder except these. Large folders such as node_modules/ make a new worktree slow. '}
                {PATTERN_HELP}
            </div>
            {repo && <CopyPreview repo={repo} copy={copy} />}
        </>
    );
}

/** The text field of the branch template, with the variables and an example. It saves when the field loses focus. */
function BranchTemplateField({ value, onSave }: { value: string | undefined; onSave(value: string | undefined): void }) {
    const [text, setText] = useState(value ?? '');
    const [username, setUsername] = useState('');
    useEffect(() => setText(value ?? ''), [value]);
    useEffect(() => {
        fetchAppInfo().then(
            info => setUsername(info.username),
            () => undefined
        );
    }, []);
    const insert = (name: string) => {
        const next = `${text}{${name}}`;
        setText(next);
        onSave(next.trim() || undefined);
    };
    const unknown = unknownVariables(text);
    const example = text.trim() ? renderBranchTemplate(text, exampleValues(username)) : '';
    return (
        <>
            <Input
                className="settings-text-field"
                mono
                aria-label="Branch name template"
                value={text}
                placeholder="{username}/{taskKey}-{taskShortDescription}"
                spellCheck={false}
                onChange={event => setText(event.target.value)}
                onBlur={() => {
                    if (text.trim() !== (value ?? '')) onSave(text.trim() || undefined);
                }}
                onKeyDown={event => event.key === 'Enter' && (event.target as HTMLInputElement).blur()}
            />
            <div className="branch-variables">
                {BRANCH_VARIABLES.map(variable => (
                    <Button key={variable.name} variant="link" className="mono" title={variable.help} onClick={() => insert(variable.name)}>
                        {`{${variable.name}}`}
                    </Button>
                ))}
            </div>
            {unknown.length > 0 && (
                <div className="form-error">ShipWarden does not know {unknown.map(name => `{${name}}`).join(', ')}. The branch name leaves it out.</div>
            )}
            {example && (
                <div className="panel-note">
                    Example: <code>{example}</code>
                </div>
            )}
        </>
    );
}

const SORT_KEYS: WorktreeSortKey[] = ['name', 'created', 'updated'];

function directionLabel(by: WorktreeSortKey, direction: WorktreeSort['direction']): string {
    if (by === 'name') return direction === 'asc' ? 'A to Z' : 'Z to A';
    return direction === 'asc' ? 'Oldest first' : 'Newest first';
}

/** The sort key and the direction of the worktrees in the sidebar. */
function SortControl({ sort, onSave }: { sort: WorktreeSort; onSave(sort: WorktreeSort): void }) {
    return (
        <div className="worktree-sort-control">
            <Select
                aria-label="Sort worktrees by"
                value={sort.by}
                options={SORT_KEYS.map(by => ({ value: by, label: WORKTREE_SORT_LABELS[by] }))}
                onChange={by => onSave({ ...sort, by })}
            />
            <ButtonGroup role="radiogroup" label="Sort direction" onKeyDown={radioGroupKeys}>
                {(['asc', 'desc'] as const).map(direction => (
                    <Button key={direction} role="radio" aria-checked={sort.direction === direction} onClick={() => onSave({ ...sort, direction })}>
                        {directionLabel(sort.by, direction)}
                    </Button>
                ))}
            </ButtonGroup>
        </div>
    );
}

interface Props {
    settings: AppSettings;
    /** The repositories of the active project, for the preview. */
    repos: string[];
    onSave(change: Partial<AppSettings>): Promise<void>;
}

/** The worktree settings of all repositories: the sidebar sort, the folder of new worktrees and the git-ignored files to copy. */
export function WorktreeSettings({ settings, repos, onSave }: Props) {
    const value = settings.worktrees;
    const [defaultFolder, setDefaultFolder] = useState('~/.shipwarden/worktrees');
    const [previewRepo, setPreviewRepo] = useState(repos[0]);
    const [error, setError] = useState<string>();
    useEffect(() => {
        window.shipwarden.worktrees.defaultFolder().then(setDefaultFolder, () => undefined);
    }, []);
    useEffect(() => setPreviewRepo(current => (current && repos.includes(current) ? current : repos[0])), [repos]);

    const save = async (change: Partial<WorktreeSettingsValue>) => {
        setError(undefined);
        try {
            await onSave({ worktrees: { ...value, ...change } });
        } catch (err) {
            setError(errorText(err));
        }
    };
    const { suggestion } = useContext(CodeFolderContext);
    const [folderError, setFolderError] = useState<string>();
    /** Saves the code folder. A clone needs it, so an empty field does not remove it. */
    const saveCodeFolder = async (text: string | undefined) => {
        const codeFolder = normalizeCodeFolder(text);
        if (!codeFolder) {
            setFolderError('Type the full path of the code folder, for example "~/code". A clone needs this folder.');
            return;
        }
        setFolderError(undefined);
        try {
            await onSave({ codeFolder });
        } catch (err) {
            setFolderError(errorText(err));
        }
    };
    const saveCopy = (change: Partial<CopyIgnoredSettings>) => save({ copyIgnored: { ...value.copyIgnored, ...change } });
    // The preview needs a repository. With more than one, the user chooses it below the list.

    return (
        <>
            <SettingsGroup title="Clones" description="ShipWarden clones a GitHub repository into your code folder and adds it to a project." card>
                <SettingsRow
                    label="Code folder"
                    description={
                        <>
                            A clone goes to <code>{settings.codeFolder ?? suggestion ?? '~/code'}/&lt;repository&gt;</code>. ShipWarden needs this folder to
                            clone a repository.
                        </>
                    }
                >
                    <FolderField
                        value={settings.codeFolder}
                        placeholder={suggestion ?? '~/code'}
                        dialogTitle={CODE_FOLDER_DIALOG_TITLE}
                        onSave={folder => void saveCodeFolder(folder)}
                    />
                    {folderError && <div className="form-error">{folderError}</div>}
                </SettingsRow>
            </SettingsGroup>
            <SettingsGroup
                title="Worktrees"
                description="These settings apply to all repositories. A repository can have its own values in its settings, with a setup and a teardown script."
                card
            >
                <SettingsRow
                    label="Sort order"
                    description="The order of the worktrees of each repository in the sidebar. The main worktree stays first."
                    control={<SortControl sort={value.sort} onSave={sort => void save({ sort })} />}
                />
                <SettingsRow
                    label="Folder"
                    description={
                        <>
                            New worktrees go to <code>{value.directory ?? defaultFolder}/&lt;repository&gt;/&lt;branch&gt;</code>. Empty: the default folder.
                        </>
                    }
                >
                    <FolderField value={value.directory} placeholder={defaultFolder} onSave={directory => void save({ directory })} />
                </SettingsRow>
                <SettingsRow
                    label="Branch names for tasks"
                    description={
                        <>
                            The branch of a worktree that starts from a task, in the New worktree dialog and in automations. Click a variable to add it. When
                            the template has <code>{'{taskShortDescription}'}</code>, an agent writes the description in a few seconds. Empty: the task key and
                            the title, for example <code>eng-1234-fix-the-login-redirect</code>.
                        </>
                    }
                >
                    <BranchTemplateField value={value.branchTemplate} onSave={branchTemplate => void save({ branchTemplate })} />
                </SettingsRow>
                <SettingsRow
                    label="Close stale shells"
                    description="Closes a shell tab with no input and no output for 7 days. A shell that runs a command stays open. Agent tabs stay open."
                    control={
                        <Switch checked={value.closeStaleShells} title="Close stale shells" onChange={closeStaleShells => void save({ closeStaleShells })} />
                    }
                />
                <SettingsRow
                    label="Remove merged worktrees"
                    description="Removes a worktree and its local branch after its pull request is merged. ShipWarden also checks for merged pull requests every 15 minutes, so it finds merges that happened while the app was closed. A worktree with uncommitted changes or new commits stays. The remote branch stays."
                    control={<Switch checked={value.removeMerged} title="Remove merged worktrees" onChange={removeMerged => void save({ removeMerged })} />}
                />
                <SettingsRow
                    label="Copy ignored files"
                    description="Copies git-ignored files, for example .env, from the main worktree into each new worktree."
                    control={
                        <Switch
                            checked={value.copyIgnored.enabled}
                            title={value.copyIgnored.enabled ? 'On' : 'Off'}
                            onChange={enabled => void saveCopy({ enabled })}
                        />
                    }
                >
                    {value.copyIgnored.enabled && (
                        <>
                            <CopyEditor
                                copy={value.copyIgnored}
                                repo={previewRepo && !settings.repos[previewRepo]?.worktrees?.copyIgnored ? previewRepo : undefined}
                                onSave={copy => void saveCopy(copy)}
                            />
                            {repos.length > 1 && (
                                <div className="copy-preview-repo">
                                    Preview in
                                    <Select
                                        value={previewRepo}
                                        options={repos.map(repo => ({ value: repo, label: repoDisplayName(settings, repo) }))}
                                        onChange={setPreviewRepo}
                                    />
                                </div>
                            )}
                            {previewRepo && settings.repos[previewRepo]?.worktrees?.copyIgnored && (
                                <div className="panel-note">{repoDisplayName(settings, previewRepo)} has its own copy settings.</div>
                            )}
                        </>
                    )}
                </SettingsRow>
                {error && (
                    <div className="settings-row">
                        <div className="form-error">{error}</div>
                    </div>
                )}
            </SettingsGroup>
        </>
    );
}
