import { useEffect, useMemo, useState } from 'react';
import { blameDate, type BlameCommit, type FileBlame } from '@shared/git-blame';
import { monaco } from '../editor/monaco';
import { onGitChanged } from '../git/git-store';

interface Props {
    editor: monaco.editor.IStandaloneCodeEditor;
    root: string;
    path: string;
    /** Changes after each edit of the text. The column then reads the blame again. */
    textVersion: number;
    /** Shows a commit in the history of the file. Without it, a click on a line does nothing. */
    onShowCommit?(hash: string): void;
}

/** The longest author name that the column shows. A longer name gets an ellipsis. */
const MAX_AUTHOR_CHARS = 18;

interface Row {
    line: number;
    top: number;
    height: number;
    hash: string;
    /** True on the first visible line of a block of lines with the same commit. Only these lines show the text. */
    first: boolean;
}

/**
 * The blame column at the left of the editor: the date and the author of the last commit that changed each line.
 * Only the first line of a block of lines with the same commit shows the text. A click on a line shows the commit in
 * the history of the file. The column follows the scroll, the folded lines, and the zones of the editor.
 */
export function BlameGutter({ editor, root, path, textVersion, onShowCommit }: Props) {
    const [blame, setBlame] = useState<FileBlame | null>();
    const [gitVersion, setGitVersion] = useState(0);
    const [layout, setLayout] = useState(0);
    const [hovered, setHovered] = useState<string>();

    // A commit, a checkout, or the focus of the window can change the blame without an edit of the text.
    useEffect(() => {
        const bump = () => setGitVersion(value => value + 1);
        const off = onGitChanged(bump);
        window.addEventListener('focus', bump);
        return () => {
            off();
            window.removeEventListener('focus', bump);
        };
    }, []);

    // biome-ignore lint/correctness/useExhaustiveDependencies: textVersion and gitVersion tell the effect to read the blame again.
    useEffect(() => {
        const model = editor.getModel();
        if (!model) return;
        let current = true;
        // Git blames the text of the editor, so the lines match while the file has changes that are not saved.
        window.shipwarden.git.blame(root, path, model.getValue()).then(
            next => current && setBlame(next),
            // The root is not a worktree of a project. The column does not show.
            () => current && setBlame(undefined)
        );
        return () => {
            current = false;
        };
    }, [editor, root, path, textVersion, gitVersion]);

    // Render the rows again when the editor scrolls, folds lines, or changes its size.
    useEffect(() => {
        let frame = 0;
        const update = () => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => setLayout(value => value + 1));
        };
        const disposables = [
            editor.onDidScrollChange(update),
            editor.onDidLayoutChange(update),
            editor.onDidContentSizeChange(update),
            editor.onDidChangeHiddenAreas(update)
        ];
        return () => {
            cancelAnimationFrame(frame);
            disposables.forEach(item => item.dispose());
        };
    }, [editor]);

    const width = useMemo(() => {
        if (!blame) return 0;
        const longest = Math.max(6, ...Object.values(blame.commits).map(commit => Math.min(commit.author.length, MAX_AUTHOR_CHARS)));
        // The date has 10 characters, then one space, then the author.
        return longest + 11;
    }, [blame]);

    // biome-ignore lint/correctness/useExhaustiveDependencies: layout tells the memo to read the positions of the editor again.
    const rows = useMemo(() => {
        if (blame === undefined) return [];
        const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight);
        const scrollTop = editor.getScrollTop();
        const next: Row[] = [];
        let previous: string | undefined;
        for (const range of editor.getVisibleRanges()) {
            for (let line = range.startLineNumber; line <= range.endLineNumber; line++) {
                // An untracked file has no blame. All its lines are new.
                const hash = blame ? (blame.lines[line - 1] ?? '') : '';
                next.push({
                    line,
                    top: editor.getTopForLineNumber(line) - scrollTop,
                    height: lineHeight,
                    hash,
                    first: previous === undefined || hash !== previous || isAfterFold(next, line)
                });
                previous = hash;
            }
        }
        return next;
    }, [blame, editor, layout]);

    if (blame === undefined) return null;

    // A screen reader does not read the column. The history button of the path bar gives the same commits.

    return (
        <div className="blame-gutter" style={{ width: `calc(${width}ch + 20px)` }} aria-hidden="true">
            {rows.map(row => {
                const commit = blame?.commits[row.hash];
                const uncommitted = !commit || commit.uncommitted;
                return (
                    <div
                        key={row.line}
                        className={`blame-row${row.hash && row.hash === hovered ? ' hover' : ''}${uncommitted ? ' uncommitted' : ''}${row.first ? ' first' : ''}`}
                        style={{ top: row.top, height: row.height, lineHeight: `${row.height}px` }}
                        title={commitTitle(commit)}
                        onMouseEnter={() => setHovered(row.hash)}
                        onMouseLeave={() => setHovered(undefined)}
                        onClick={() => commit && !commit.uncommitted && onShowCommit?.(commit.hash)}
                    >
                        {row.first &&
                            (uncommitted ? (
                                <span className="blame-uncommitted">Not committed yet</span>
                            ) : (
                                <>
                                    <span className="blame-date">{blameDate(commit.date)}</span>
                                    <span className="blame-author">{commit.author}</span>
                                </>
                            ))}
                    </div>
                );
            })}
        </div>
    );
}

/** True when the line is the first line after folded lines. That line shows its text again. */
function isAfterFold(rows: Row[], line: number): boolean {
    const last = rows[rows.length - 1];
    return last !== undefined && last.line !== line - 1;
}

/** The tooltip of a line: the subject, the author, the date, and the short hash. */
function commitTitle(commit: BlameCommit | undefined): string {
    if (!commit || commit.uncommitted) return 'This line is not in a commit yet.';
    return `${commit.summary}\n${commit.author} <${commit.authorEmail}>\n${new Date(commit.date).toLocaleString()}\n${commit.hash.slice(0, 8)} · Click to show the commit in the file history.`;
}
