import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MultiFileDiff } from '@pierre/diffs/react';
import { ChevronRight } from 'lucide-react';
import type { BranchDiff, BranchFileStat } from '@shared/git';
import { branchDiffKey } from '../../compare/compare-cache';
import { optionalErrorText } from '../../util';
import { DIFF_THEME, readStyle, THEME_CSS, useColorMode } from '../diff-style';
import { SkeletonRows } from '../ui';

const api = window.shipwarden;

interface Props {
    worktree: string;
    diff: BranchDiff;
}

/** The changed files of a run. A click on a file shows its diff from the base commit to the working file. */
export function CompareDiff({ worktree, diff }: Props) {
    const [open, setOpen] = useState<string>();
    if (diff.files.length === 0) return <p className="panel-note">The agent did not change files yet.</p>;
    return (
        <div className="compare-diff">
            {diff.files.map(file => (
                <div key={file.path} className="compare-diff-file">
                    <button
                        type="button"
                        className="compare-diff-row"
                        aria-expanded={open === file.path}
                        onClick={() => setOpen(current => (current === file.path ? undefined : file.path))}
                    >
                        <ChevronRight size={13} strokeWidth={1.8} className={open === file.path ? 'open' : undefined} />
                        <span className="diff-path" title={file.path}>
                            {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                        </span>
                        <span className="header-spacer" />
                        <LineCounts file={file} />
                    </button>
                    {open === file.path && <FileDiff worktree={worktree} base={diff.base} file={file} />}
                </div>
            ))}
        </div>
    );
}

/** The added and removed lines of a file, or "binary". */
export function LineCounts({ file }: { file: Pick<BranchFileStat, 'added' | 'removed' | 'binary'> }) {
    if (file.binary) return <span className="panel-note">binary</span>;
    return (
        <span className="compare-lines">
            <span className="additions">+{file.added}</span> <span className="deletions">−{file.removed}</span>
        </span>
    );
}

function FileDiff({ worktree, base, file }: { worktree: string; base: string | undefined; file: BranchFileStat }) {
    const mode = useColorMode();
    const query = useQuery({
        queryKey: [...branchDiffKey(worktree), 'file', base ?? 'HEAD', file.path, file.oldPath ?? ''],
        queryFn: () => api.git.branchContents(worktree, file.path, base, file.oldPath),
        staleTime: 0,
        gcTime: 60_000
    });
    const options = useMemo(
        () => ({
            diffStyle: readStyle(),
            theme: DIFF_THEME,
            themeType: mode,
            disableFileHeader: true,
            overflow: 'wrap' as const,
            lineDiffType: 'word' as const,
            unsafeCSS: THEME_CSS
        }),
        [mode]
    );
    const error = optionalErrorText(query.error);
    const contents = query.data;
    if (error) return <div className="form-error">{error}</div>;
    if (!contents) return <SkeletonRows count={3} dot={false} label="Loading the diff" />;
    if (contents.binary) return <p className="panel-note">This is a binary file. ShipWarden does not show its diff.</p>;
    return (
        <div className="change-diff-body compare-diff-body">
            <MultiFileDiff
                oldFile={{ name: file.oldPath ?? file.path, contents: contents.original }}
                newFile={{ name: file.path, contents: contents.modified }}
                options={options}
            />
        </div>
    );
}
