import { useCallback, useEffect, useMemo, useState } from 'react';
import { MultiFileDiff } from '@pierre/diffs/react';
import { FileText, LoaderCircle, Minus, Plus, RefreshCw, Undo2 } from 'lucide-react';
import type { ChangeContents, ChangeSide, FileChange } from '@shared/git';
import { gitChanged, onGitChanged } from '../git/git-store';
import { errorText } from '../util';
import { confirmDiscard } from './ChangesPanel';
import { readStyle, STYLE_KEY, THEME_CSS, useColorMode, type DiffStyle } from './PullRequestFilesStream';
import { radioGroupKeys } from './keyboard';

interface Props {
    worktree: string;
    change: FileChange;
    side: ChangeSide;
    onOpenFile(path: string): void;
}

/**
 * The diff of one local change in a tab. Staged: HEAD and the index. Unstaged: the index and the working file.
 * It loads again when the file or the index changes.
 */
export function ChangeDiffView({ worktree, change, side, onOpenFile }: Props) {
    const [contents, setContents] = useState<ChangeContents>();
    const [error, setError] = useState<string>();
    const [busy, setBusy] = useState(false);
    const [diffStyle, setDiffStyle] = useState<DiffStyle>(readStyle);
    const mode = useColorMode();

    const load = useCallback(async () => {
        try {
            setContents(await window.shipwarden.git.contents(worktree, change.path, side, change.oldPath));
            setError(undefined);
        } catch (err) {
            setError(errorText(err));
        }
    }, [worktree, change.path, change.oldPath, side]);

    useEffect(() => {
        void load();
        const offFiles = window.shipwarden.files.onChanged(event => event.root === worktree && void load());
        const offGit = onGitChanged(() => void load());
        window.addEventListener('focus', load);
        return () => {
            offFiles();
            offGit();
            window.removeEventListener('focus', load);
        };
    }, [load, worktree]);

    const changeStyle = (value: DiffStyle) => {
        setDiffStyle(value);
        try {
            localStorage.setItem(STYLE_KEY, value);
        } catch {
            // The choice stays for this session only.
        }
    };
    const toggleStage = async () => {
        setBusy(true);
        try {
            if (side === 'staged') await window.shipwarden.git.unstage(worktree, [change.path]);
            else await window.shipwarden.git.stage(worktree, [change.path]);
        } catch (err) {
            setError(errorText(err));
        } finally {
            setBusy(false);
            gitChanged();
        }
    };

    const discard = async () => {
        try {
            await confirmDiscard(worktree, [change]);
        } catch (err) {
            setError(errorText(err));
        } finally {
            gitChanged();
        }
    };

    const options = useMemo(() => ({
        diffStyle,
        themeType: mode,
        disableFileHeader: true,
        overflow: 'wrap' as const,
        lineDiffType: 'word' as const,
        unsafeCSS: THEME_CSS
    }), [diffStyle, mode]);

    const same = contents && !contents.binary && contents.original === contents.modified;

    return (
        <div className="editor change-diff">
            <div className="diff-header">
                <span className={`change-side ${side}`}>{side === 'staged' ? 'Staged' : 'Working tree'}</span>
                <span className="diff-path" title={change.path}>{change.oldPath ? `${change.oldPath} → ${change.path}` : change.path}</span>
                <span className="header-spacer" />
                <div className="segmented compact" role="radiogroup" aria-label="Diff layout" onKeyDown={radioGroupKeys}>
                    <button role="radio" aria-checked={diffStyle === 'unified'} className={diffStyle === 'unified' ? 'selected' : ''} onClick={() => changeStyle('unified')}>Unified</button>
                    <button role="radio" aria-checked={diffStyle === 'split'} className={diffStyle === 'split' ? 'selected' : ''} onClick={() => changeStyle('split')}>Split</button>
                </div>
                <button className="button change-stage" disabled={busy} onClick={() => void toggleStage()}>
                    {side === 'staged' ? <Minus size={13} strokeWidth={2} /> : <Plus size={13} strokeWidth={2} />}
                    {side === 'staged' ? 'Unstage' : 'Stage'}
                </button>
                {side === 'unstaged' && change.kind !== 'conflicted' && (
                    <button className="button change-stage" disabled={busy} title="Discard the changes in this file" onClick={() => void discard()}>
                        <Undo2 size={13} strokeWidth={1.8} /> Discard
                    </button>
                )}
                {change.kind !== 'deleted' && (
                    <button className="icon-button" title="Open the file" onClick={() => onOpenFile(change.path)}><FileText size={14} strokeWidth={1.6} /></button>
                )}
                <button className="icon-button" title="Load again" onClick={() => void load()}><RefreshCw size={14} strokeWidth={1.6} /></button>
            </div>
            {error && <div className="editor-failure">{error}</div>}
            {!contents && !error && <div className="panel-message"><LoaderCircle size={14} className="spin" /> Loading the diff…</div>}
            {contents?.binary && <div className="panel-message">This is a binary file. ShipWarden does not show its diff.</div>}
            {same && <div className="panel-message">No {side === 'staged' ? 'staged' : 'unstaged'} changes in this file now.</div>}
            {contents && !contents.binary && !same && (
                <div className="change-diff-body">
                    <MultiFileDiff
                        oldFile={{ name: change.oldPath ?? change.path, contents: contents.original }}
                        newFile={{ name: change.path, contents: contents.modified }}
                        options={options}
                    />
                </div>
            )}
        </div>
    );
}
