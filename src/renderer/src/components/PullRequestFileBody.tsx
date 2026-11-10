import { memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import { MultiFileDiff, PatchDiff, type DiffLineAnnotation, type FileDiffOptions } from '@pierre/diffs/react';
import { ExternalLink, LoaderCircle } from 'lucide-react';
import type { DiffSide, FileVersions, PendingComment, PullRequest, PullRequestFile, RepoTarget } from '@shared/github';
import { unifiedPatch } from '@shared/patch';
import { reviewStore } from '../github/review-store';
import { composerFromRange, lineAnnotations, toSide, type Composer, type Note } from '../github/diff-notes';
import type { AgentQuestion, QuestionAction } from '../github/agent-questions';
import { openLink } from '../links';
import { THEME_CSS, type DiffStyle } from './diff-style';
import { ComposerZone, PendingZone, QuestionZone, ThreadZone } from './ReviewZones';

interface FileBodyProps {
    target: RepoTarget;
    pr: PullRequest;
    file: PullRequestFile;
    pending: PendingComment[];
    composer: Composer | undefined;
    questions: AgentQuestion[];
    /** The line of the current search match in this file. */
    highlight: { side: DiffSide; line: number } | undefined;
    diffStyle: DiffStyle;
    mode: 'light' | 'dark';
    onComposer(composer: Composer | undefined): void;
    /** Asks the agent a question about the lines of the composer. Undefined when no agent can answer. */
    onAsk?(composer: Composer, question: string): void;
    onQuestion(question: AgentQuestion, action: QuestionAction): void;
    onRefresh(): Promise<void>;
    onGoToDefinition?(path: string, line: number, column: number): void;
}

/**
 * The diff of one file, with the review threads, the pending comments and the comment box under their lines.
 * The "+" in the gutter starts a comment. GitHub's patch is enough for most files. Without it (a large file),
 * the view loads both versions of the file.
 */
export const FileBody = memo(function FileBody({
    target,
    pr,
    file,
    pending,
    composer,
    questions,
    highlight,
    diffStyle,
    mode,
    onComposer,
    onAsk,
    onQuestion,
    onRefresh,
    onGoToDefinition
}: FileBodyProps) {
    const patch = useMemo(() => unifiedPatch(file), [file]);
    const [versions, setVersions] = useState<FileVersions | 'error'>();
    const canComment = pr.state === 'OPEN';

    useEffect(() => {
        if (patch) return;
        let current = true;
        reviewStore.fileVersions(target, file, pr.baseRefOid, pr.headRefOid).then(
            result => current && setVersions(result),
            () => current && setVersions('error')
        );
        return () => {
            current = false;
        };
    }, [patch, target, file, pr.baseRefOid, pr.headRefOid]);

    const annotations = useMemo(
        () => lineAnnotations({ path: file.path, threads: pr.threads, pending, questions, composer }),
        [pr.threads, file.path, pending, questions, composer]
    );

    const options = useMemo(
        (): FileDiffOptions<Note, undefined> => ({
            diffStyle,
            themeType: mode,
            disableFileHeader: true,
            unsafeCSS: THEME_CSS,
            overflow: 'wrap',
            lineDiffType: 'word',
            // A closed pull request takes no comments, but the agent can still answer questions about it.
            enableGutterUtility: canComment || !!onAsk,
            onGutterUtilityClick: range => onComposer(composerFromRange(range)),
            // Only the new side is in the local copy of the pull request. A removed line has no definition there.
            ...(onGoToDefinition
                ? ({
                      onTokenClick: (token, event) => {
                          if (!event.metaKey || token.side !== 'additions') return;
                          event.preventDefault();
                          onGoToDefinition(file.path, token.lineNumber, token.lineCharStart + 1);
                      }
                  } satisfies Partial<FileDiffOptions<Note, undefined>>)
                : {}),
            // The patch has only the lines near the changes. To show the hidden lines, the diff loads the two full files.
            loadDiffFiles: async () => {
                const result = await reviewStore.fileVersions(target, file, pr.baseRefOid, pr.headRefOid);
                if (result.unavailable) throw new Error(`The full versions of ${file.path} are not available.`);
                return {
                    oldFile: { name: file.previousPath ?? file.path, contents: result.base },
                    newFile: { name: file.path, contents: result.head }
                };
            }
        }),
        [diffStyle, mode, canComment, onAsk, onComposer, onGoToDefinition, target, file, pr.baseRefOid, pr.headRefOid]
    );

    const renderAnnotation = (annotation: DiffLineAnnotation<Note>): ReactNode => {
        const note = annotation.metadata;
        // Keys in a comment box must not go to the diff.
        const stop = (event: React.KeyboardEvent) => event.stopPropagation();
        if (note.kind === 'thread') {
            const thread = note.thread;
            return (
                <div className="stream-zone" onKeyDown={stop}>
                    {thread.line === null && <div className="stream-zone-note">Outdated: line {thread.originalLine ?? '?'} of an older commit</div>}
                    <ThreadZone
                        thread={thread}
                        onReply={async body => {
                            await window.shipwarden.github.reply(target, pr.number, thread.comments[thread.comments.length - 1].databaseId, body);
                            await onRefresh();
                        }}
                        onResolve={async () => {
                            await window.shipwarden.github.setThreadResolved(target, thread.id, !thread.isResolved);
                            await onRefresh();
                        }}
                    />
                </div>
            );
        }
        if (note.kind === 'pending') {
            return (
                <div className="stream-zone" onKeyDown={stop}>
                    <PendingZone
                        comment={note.comment}
                        onRemove={() => reviewStore.removePending(target, pr.number, note.comment)}
                        onEdit={canComment ? body => reviewStore.updatePending(target, pr.number, note.comment, body) : undefined}
                        onAccept={() => reviewStore.acceptPending(target, pr.number, note.comment)}
                    />
                </div>
            );
        }
        if (note.kind === 'question') {
            const question = note.question;
            return (
                <div className="stream-zone">
                    <QuestionZone question={question} headRefOid={pr.headRefOid} canComment={canComment} onAction={action => onQuestion(question, action)} />
                </div>
            );
        }
        return (
            <div className="stream-zone" onKeyDown={stop}>
                <ComposerZone
                    line={note.line}
                    startLine={note.startLine}
                    canComment={canComment}
                    onAsk={onAsk && (question => onAsk({ line: note.line, startLine: note.startLine, side: note.side }, question))}
                    onCancel={() => onComposer(undefined)}
                    onAdd={body => {
                        reviewStore.addPending(target, pr.number, { path: file.path, line: note.line, side: note.side, body });
                        onComposer(undefined);
                    }}
                />
            </div>
        );
    };

    const selectedLines = useMemo(
        () => (highlight ? { start: highlight.line, end: highlight.line, side: toSide(highlight.side) } : null),
        [highlight?.line, highlight?.side]
    );

    if (patch) {
        return (
            <PatchDiff<Note, undefined>
                patch={patch}
                options={options}
                lineAnnotations={annotations}
                selectedLines={selectedLines}
                renderAnnotation={renderAnnotation}
            />
        );
    }
    if (!versions) {
        return (
            <div className="stream-file-note">
                <LoaderCircle size={13} className="spin" /> GitHub sent no patch for this large file. Loading both versions…
            </div>
        );
    }
    if (versions === 'error') {
        return (
            <div className="stream-file-note">
                ShipWarden cannot show this file. It is possibly binary or too large.
                <button className="link-button" onClick={event => openLink(`${pr.url}/files`, event)}>
                    Open on GitHub <ExternalLink size={12} />
                </button>
            </div>
        );
    }
    return (
        <MultiFileDiff<Note, undefined>
            oldFile={{ name: file.previousPath ?? file.path, contents: versions.base }}
            newFile={{ name: file.path, contents: versions.head }}
            options={options}
            lineAnnotations={annotations}
            selectedLines={selectedLines}
            renderAnnotation={renderAnnotation}
        />
    );
});
