import { useQuery } from '@tanstack/react-query';
import { NO_EDITOR_TEXT } from '@shared/editors';
import { errorText } from '../util';
import { editorListQuery, setSelectedEditor } from '../files/external-editor';
import { SettingsGroup, SettingsRow } from './settings-ui';
import { Select } from './ui';

interface Props {
    /** Saves the app path of the editor. */
    onChange(appPath: string): Promise<void>;
    onError(message: string): void;
}

/**
 * The editor for "Open in editor" in the worktree menu, the file tabs, and the file explorer. The list shows the
 * installed editors. The list loads again each time this group shows, so a new app shows at once.
 */
export function EditorSettings({ onChange, onError }: Props) {
    const { data, isPending } = useQuery({ ...editorListQuery, staleTime: 0 });
    const editors = data?.editors ?? [];
    const select = (appPath: string) =>
        onChange(appPath).then(
            () => setSelectedEditor(appPath),
            error => onError(errorText(error))
        );

    return (
        <SettingsGroup title="External editor" card>
            <SettingsRow
                label="Open in"
                description={
                    isPending || editors.length > 0
                        ? 'The editor for "Open in editor" (⌥⌘O) in the worktree menu, the file tabs, and the file explorer. A file opens at its cursor line.'
                        : NO_EDITOR_TEXT
                }
                control={
                    <Select
                        aria-label="External editor"
                        value={data?.selected}
                        disabled={editors.length === 0}
                        placeholder={isPending ? 'Loading…' : 'No editor'}
                        options={editors.map(editor => ({ value: editor.appPath, label: editor.name }))}
                        onChange={select}
                    />
                }
            />
        </SettingsGroup>
    );
}
