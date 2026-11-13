import { createContext, useContext, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { normalizeCodeFolder } from '@shared/settings';
import { Button, Input } from './ui';

/** The code folder setting. A clone goes to <folder>/<repository name>. */
export interface CodeFolderState {
    /** The saved folder. It is undefined until the user sets it. */
    folder: string | undefined;
    /** A folder to show first, for example the parent folder of the repositories of the user. */
    suggestion: string | undefined;
    /** Saves the folder. */
    save(folder: string): Promise<void>;
}

export const CodeFolderContext = createContext<CodeFolderState>({ folder: undefined, suggestion: undefined, save: async () => undefined });

/** The title of the folder dialog for the code folder. */
export const CODE_FOLDER_DIALOG_TITLE = 'Choose a Folder for Your Code';

/** The draft of the code folder in a clone dialog. Without a saved folder, the dialog shows a field for it. */
export interface CodeFolderDraft {
    /** True when no folder is saved, so the dialog must show the field. */
    needed: boolean;
    /** The folder that a clone uses now: the saved folder, or the text in the field. */
    folder: string | undefined;
    text: string;
    setText(text: string): void;
    /** Saves the folder in the field when no folder is saved. Throws an error when the text is not a full path. */
    commit(): Promise<void>;
}

/** Returns the state of the code folder field of a clone dialog. The field starts with the suggestion. */
export function useCodeFolderDraft(): CodeFolderDraft {
    const { folder, suggestion, save } = useContext(CodeFolderContext);
    const [text, setText] = useState(suggestion ?? '');
    const needed = !folder;
    return {
        needed,
        folder: folder ?? normalizeCodeFolder(text),
        text,
        setText,
        commit: async () => {
            if (!needed) return;
            const value = normalizeCodeFolder(text);
            if (!value) throw new Error('Type the full path of the code folder, for example "~/code".');
            await save(value);
        }
    };
}

/** The code folder field of a clone dialog, with a "Choose…" button. */
export function CodeFolderInput({ draft, id, disabled }: { draft: CodeFolderDraft; id: string; disabled?: boolean }) {
    return (
        <div className="ca-file-row">
            <Input
                id={id}
                className="ca-file-input"
                mono
                value={draft.text}
                placeholder="~/code"
                spellCheck={false}
                disabled={disabled}
                onChange={event => draft.setText(event.target.value)}
            />
            <Button
                icon={<FolderOpen size={14} strokeWidth={1.6} />}
                title="Choose a folder"
                disabled={disabled}
                onClick={async () => {
                    const chosen = await window.shipwarden.worktrees.chooseFolder(CODE_FOLDER_DIALOG_TITLE);
                    if (chosen) draft.setText(chosen);
                }}
            >
                Choose…
            </Button>
        </div>
    );
}
