import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { MultiFileDiff, PatchDiff, Virtualizer, type DiffLineAnnotation, type FileDiffOptions } from '@pierre/diffs/react';
import { Bot, ChevronDown, ChevronRight, ChevronUp, ExternalLink, LoaderCircle, MessageSquare, Search, X } from 'lucide-react';
import type { DiffSide, FileVersions, PendingComment, PullRequest, PullRequestFile, RepoTarget, ReviewThread } from '@shared/github';
import { unifiedPatch } from '@shared/patch';
import { reviewStore, useReviewState } from '../github/review-store';
import { errorText, timeAgo } from '../util';
import { ComposerZone, PendingZone, QuestionZone, ThreadZone, type AgentQuestion, type QuestionAction } from './DiffView';
import { CopyButton } from './CopyButton';
import { askPrompt, lineLabel, sliceLines, type SavedAnswer } from '@shared/ask-agent';
import { searchPatches, type PatchMatch } from '@shared/pr-search';
import { openLink } from '../links';

export const STYLE_KEY = 'shipwarden.diffStyle';

export type DiffStyle = 'unified' | 'split';

/**
 * Colors of the app theme for the diff. The diff is in a shadow root, but the app variables go into it.
 * The highlight theme sets its background on the element, so these rules need "!important".
 */
export const THEME_CSS = `
:host {
    --diffs-dark-bg: var(--bg) !important;
    --diffs-light-bg: var(--bg) !important;
    --diffs-bg-context-override: var(--bg);
    --diffs-bg-context-gutter-override: var(--bg);
    --diffs-bg-separator-override: var(--panel);
    --diffs-bg-buffer-override: var(--panel);
}
[data-line-annotation], [data-gutter-buffer=annotation] {
    --diffs-annotation-bg: var(--bg);
}
`;

/** What an annotation under a diff line shows: a review thread, a pending comment, or the box for a new comment. */
type Note =
    | { kind: 'thread'; thread: ReviewThread }
    | { kind: 'pending'; comment: PendingComment }
    | { kind: 'composer'; line: number; startLine: number; side: DiffSide }
    | { kind: 'question'; question: AgentQuestion };

/** The box for a new comment or question: the lines from `startLine` to `line` on one side. */
interface Composer {
    line: number;
    startLine: number;
    side: DiffSide;
}

interface Props {
    target: RepoTarget;
    pr: PullRequest;
    files: PullRequestFile[] | undefined;
    /** A file to show: it opens and scrolls into view. A new `nonce` does it again. */
    scrollTo?: { path: string; nonce: number };
    onRefresh(): Promise<void>;
    onError(message: string): void;
    /** A request to open the search bar (⌘F). A new value opens it again and selects its text. */
    findRequest?: number;
}

export function readStyle(): DiffStyle {
    try {
        return localStorage.getItem(STYLE_KEY) === 'split' ? 'split' : 'unified';
    } catch {
        return 'unified';
    }
}

/** The color mode of the app ("light" or "dark"), from the root element. */
export function useColorMode(): 'light' | 'dark' {
    const read = (): 'light' | 'dark' => (document.documentElement.dataset.mode === 'light' ? 'light' : 'dark');
    const [mode, setMode] = useState(read);
    useEffect(() => {
        const observer = new MutationObserver(() => setMode(read()));
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] });
        return () => observer.disconnect();
    }, []);
    return mode;
}

/** Returns a saved answer as a question card. A saved answer starts collapsed. */
const fromSaved = (saved: SavedAnswer): AgentQuestion => ({
    id: saved.id,
    path: saved.path,
    side: saved.side,
    startLine: saved.startLine,
    line: saved.line,
    question: saved.question,
    status: 'done',
    agent: saved.agent,
    answer: saved.answer,
    commit: saved.commit,
    answeredAt: saved.answeredAt,
    collapsed: true
});

const toSide = (side: DiffSide): 'deletions' | 'additions' => (side === 'LEFT' ? 'deletions' : 'additions');
const fromSide = (side: 'deletions' | 'additions' | undefined): DiffSide => (side === 'deletions' ? 'LEFT' : 'RIGHT');

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
}

/**
 * The diff of one file, with the review threads, the pending comments and the comment box under their lines.
 * The "+" in the gutter starts a comment. GitHub's patch is enough for most files. Without it (a large file),
 * the view loads both versions of the file.
 */
const FileBody = memo(function FileBody({ target, pr, file, pending, composer, questions, highlight, diffStyle, mode, onComposer, onAsk, onQuestion, onRefresh }: FileBodyProps) {
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

    const annotations = useMemo(() => {
        const list: DiffLineAnnotation<Note>[] = [];
        for (const thread of pr.threads) {
            if (thread.path !== file.path) continue;
            // An outdated thread has no line in the current diff. It shows above the first line.
            list.push({ side: toSide(thread.side), lineNumber: thread.line ?? 0, metadata: { kind: 'thread', thread } });
        }
        for (const comment of pending) {
            list.push({ side: toSide(comment.side), lineNumber: comment.line, metadata: { kind: 'pending', comment } });
        }
        for (const question of questions) {
            list.push({ side: toSide(question.side), lineNumber: question.line, metadata: { kind: 'question', question } });
        }
        if (composer) {
            list.push({ side: toSide(composer.side), lineNumber: composer.line, metadata: { kind: 'composer', ...composer } });
        }
        return list;
    }, [pr.threads, file.path, pending, questions, composer]);

    const options = useMemo((): FileDiffOptions<Note, undefined> => ({
        diffStyle,
        themeType: mode,
        disableFileHeader: true,
        unsafeCSS: THEME_CSS,
        overflow: 'wrap',
        lineDiffType: 'word',
        // A closed pull request takes no comments, but the agent can still answer questions about it.
        enableGutterUtility: canComment || !!onAsk,
        onGutterUtilityClick: range => {
            const side = fromSide(range.endSide ?? range.side);
            // A range across both sides has no clear start line, so the box takes only the last line.
            const sameSide = fromSide(range.side) === side;
            onComposer({ line: range.end, startLine: sameSide ? Math.min(range.start, range.end) : range.end, side });
        },
        // The patch has only the lines near the changes. To show the hidden lines, the diff loads the two full files.
        loadDiffFiles: async () => {
            const result = await reviewStore.fileVersions(target, file, pr.baseRefOid, pr.headRefOid);
            if (result.unavailable) throw new Error(`The full versions of ${file.path} are not available.`);
            return {
                oldFile: { name: file.previousPath ?? file.path, contents: result.base },
                newFile: { name: file.path, contents: result.head }
            };
        }
    }), [diffStyle, mode, canComment, onAsk, onComposer, target, file, pr.baseRefOid, pr.headRefOid]);

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
                    />
                </div>
            );
        }
        if (note.kind === 'question') {
            const question = note.question;
            return (
                <div className="stream-zone">
                    <QuestionZone
                        question={question}
                        headRefOid={pr.headRefOid}
                        canComment={canComment}
                        onAction={action => onQuestion(question, action)}
                    />
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
        return <PatchDiff<Note, undefined> patch={patch} options={options} lineAnnotations={annotations} selectedLines={selectedLines} renderAnnotation={renderAnnotation} />;
    }
    if (!versions) {
        return <div className="stream-file-note"><LoaderCircle size={13} className="spin" /> GitHub sent no patch for this large file. Loading both versions…</div>;
    }
    if (versions === 'error') {
        return (
            <div className="stream-file-note">
                ShipWarden cannot show this file. It is possibly binary or too large.
                <button className="link-button" onClick={event => openLink(`${pr.url}/files`, event)}>Open on GitHub <ExternalLink size={12} /></button>
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

/**
 * Returns the element of a diff line. The diff is in a shadow root. A removed line has the old line number,
 * and the other lines have the new line number. Returns undefined when the line is not rendered.
 */
export function findLineElement(section: HTMLElement, side: DiffSide, line: number): HTMLElement | undefined {
    for (const host of section.querySelectorAll('*')) {
        const root = host.shadowRoot;
        if (!root) continue;
        for (const element of root.querySelectorAll<HTMLElement>(`[data-line="${line}"]`)) {
            const removed = (element.dataset.lineType ?? '').includes('deletion');
            if (removed === (side === 'LEFT')) return element;
        }
    }
    return undefined;
}

/** The search bar of the changed files (⌘F). Enter goes to the next match, Shift+Enter to the previous one. */
export function FindBar({ query, caseSensitive, count, index, focusNonce, onQuery, onCaseSensitive, onMove, onClose }: {
    query: string;
    caseSensitive: boolean;
    count: number;
    index: number;
    focusNonce: number;
    onQuery(value: string): void;
    onCaseSensitive(value: boolean): void;
    onMove(step: 1 | -1): void;
    onClose(): void;
}) {
    const inputRef = useRef<HTMLInputElement>(null);
    useEffect(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
    }, [focusNonce]);
    return (
        <div className="find-bar" role="search">
            <Search size={13} strokeWidth={1.6} />
            <input
                ref={inputRef}
                value={query}
                placeholder="Find in the changes"
                aria-label="Find in the changes"
                onChange={event => onQuery(event.target.value)}
                onKeyDown={event => {
                    if (event.key === 'Enter') {
                        event.preventDefault();
                        onMove(event.shiftKey ? -1 : 1);
                    }
                    if (event.key === 'Escape') onClose();
                }}
            />
            <span className="find-count">{query ? (count ? `${index + 1} of ${count}` : 'No results') : ''}</span>
            <button className={`icon-button find-case${caseSensitive ? ' selected' : ''}`} title="Match case" aria-pressed={caseSensitive} onClick={() => onCaseSensitive(!caseSensitive)}>Aa</button>
            <button className="icon-button" title="Previous match (Shift+Enter)" disabled={!count} onClick={() => onMove(-1)}><ChevronUp size={14} /></button>
            <button className="icon-button" title="Next match (Enter)" disabled={!count} onClick={() => onMove(1)}><ChevronDown size={14} /></button>
            <button className="icon-button" title="Close (Escape)" onClick={onClose}><X size={14} /></button>
        </div>
    );
}

/**
 * All changed files of a pull request in one stream, like the "Files changed" page of GitHub. Each file can collapse.
 * A file that the user marks as viewed collapses, and viewed files start collapsed.
 */
export function PullRequestFilesStream({ target, pr, files, scrollTo, onRefresh, onError, findRequest }: Props) {
    const review = useReviewState(target, pr.number);
    const mode = useColorMode();
    const [diffStyle, setDiffStyle] = useState<DiffStyle>(readStyle);
    /** The open state of each file, by path. A file without an entry is open unless it is viewed. */
    const [open, setOpen] = useState<Record<string, boolean>>({});
    const [composer, setComposer] = useState<Composer & { path: string }>();
    const [questions, setQuestions] = useState<AgentQuestion[]>([]);
    const [answersOpen, setAnswersOpen] = useState(false);
    const [findOpen, setFindOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [caseSensitive, setCaseSensitive] = useState(false);
    const [matchIndex, setMatchIndex] = useState(0);
    const matches = useMemo(() => (findOpen ? searchPatches(files ?? [], query, caseSensitive) : []), [findOpen, files, query, caseSensitive]);
    const current: PatchMatch | undefined = matches[Math.min(matchIndex, matches.length - 1)];
    /** The repository for the agent. Only the Review view has one. */
    const repo = typeof target === 'string' ? undefined : target;
    const sections = useRef(new Map<string, HTMLElement>());

    // A different pull request starts with the default open state, and with its saved answers.
    useEffect(() => {
        setOpen({});
        setComposer(undefined);
        setQuestions([]);
        setAnswersOpen(false);
        if (!repo) return;
        let active = true;
        window.shipwarden.ask.answers(repo, pr.number).then(saved => {
            if (!active) return;
            const loaded = saved.map(fromSaved);
            // A question that the user asked while the list loaded stays.
            setQuestions(list => [...loaded.filter(item => !list.some(other => other.id === item.id)), ...list]);
        }).catch(err => onError(`The saved answers did not load. ${errorText(err)}`));
        return () => {
            active = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pr.number, repo?.owner, repo?.name]);

    const changeQuestion = (id: string, change: Partial<AgentQuestion>) =>
        setQuestions(list => list.map(item => (item.id === id ? { ...item, ...change } : item)));

    /** Sends a question to the agent. The answer shows under the lines of the question. */
    const runQuestion = async (question: AgentQuestion) => {
        if (!repo) return;
        changeQuestion(question.id, { status: 'running', error: undefined, answer: undefined });
        const file = files?.find(item => item.path === question.path);
        let code: string | undefined;
        if (file) {
            try {
                const versions = await reviewStore.fileVersions(target, file, pr.baseRefOid, pr.headRefOid);
                if (!versions.unavailable) code = sliceLines(question.side === 'LEFT' ? versions.base : versions.head, question.startLine, question.line);
            } catch {
                // The prompt has the diff. The agent can read the file itself.
            }
        }
        const prompt = askPrompt({ pr, repo, path: question.path, side: question.side, startLine: question.startLine, endLine: question.line, code, patch: file?.patch, question: question.question });
        try {
            const result = await window.shipwarden.ask.run({ id: question.id, repo, headRefOid: pr.headRefOid, prompt });
            const answeredAt = Date.now();
            setQuestions(list => list.map(item => (item.id === question.id && item.status === 'running'
                ? { ...item, status: 'done', agent: result.agent, answer: result.answer, commit: pr.headRefOid, answeredAt, collapsed: false }
                : item)));
            // A cancelled run rejects, so each answer here is a real answer. It is saved also when the user opened a different pull request.
            const saved: SavedAnswer = {
                id: question.id, repo, number: pr.number, path: question.path, side: question.side, startLine: question.startLine, line: question.line,
                question: question.question, agent: result.agent, answer: result.answer, commit: pr.headRefOid, answeredAt
            };
            window.shipwarden.ask.saveAnswer(saved).catch(err => onError(`The answer was not saved. ${errorText(err)}`));
        } catch (err) {
            setQuestions(list => list.map(item => (item.id === question.id && item.status === 'running' ? { ...item, status: 'error', error: errorText(err) } : item)));
        }
    };

    const ask = (path: string, at: Composer, text: string) => {
        const question: AgentQuestion = { id: crypto.randomUUID(), path, ...at, question: text, status: 'running' };
        setQuestions(list => [...list, question]);
        setComposer(undefined);
        void runQuestion(question);
    };

    const onQuestion = (question: AgentQuestion, action: QuestionAction) => {
        switch (action) {
            case 'retry':
                void runQuestion(question);
                return;
            case 'toggle':
                changeQuestion(question.id, { collapsed: !question.collapsed });
                return;
            case 'comment':
                // The answer stays saved. The card collapses, so the pending comment is easy to see.
                if (question.answer) {
                    reviewStore.addPending(target, pr.number, { path: question.path, line: question.line, side: question.side, body: question.answer, fromAgent: true });
                }
                changeQuestion(question.id, { collapsed: true });
                return;
            case 'delete':
                window.shipwarden.ask.removeAnswer(question.id).catch(err => onError(`The answer was not deleted. ${errorText(err)}`));
                break;
            default:
                if (question.status === 'running') void window.shipwarden.ask.cancel(question.id);
        }
        setQuestions(list => list.filter(item => item.id !== question.id));
    };

    /** Opens the file of a saved answer, opens the card and scrolls to its line. */
    const showAnswer = (question: AgentQuestion) => {
        setAnswersOpen(false);
        changeQuestion(question.id, { collapsed: false });
        reveal(question);
    };

    const isOpen = (file: PullRequestFile) => open[file.path] ?? !file.viewed;

    useEffect(() => {
        if (findRequest) setFindOpen(true);
    }, [findRequest]);

    /** Opens the file of a match and scrolls its line into view. The line can render some frames later. */
    const reveal = (match: Pick<PatchMatch, 'path' | 'side' | 'line'>) => {
        setOpen(map => ({ ...map, [match.path]: true }));
        let tries = 0;
        const step = () => {
            const section = sections.current.get(match.path);
            const element = section && findLineElement(section, match.side, match.line);
            if (element) {
                element.scrollIntoView({ block: 'center' });
                return;
            }
            // The virtual list renders only the files near the view. Scroll to the file, then look for the line again.
            if (tries === 0) section?.scrollIntoView({ block: 'start' });
            if (++tries < 30) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
    };

    // A new search text goes to the first match.
    useEffect(() => {
        setMatchIndex(0);
        if (matches[0]) reveal(matches[0]);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [query, caseSensitive]);

    const moveMatch = (step: 1 | -1) => {
        if (!matches.length) return;
        const next = (Math.min(matchIndex, matches.length - 1) + step + matches.length) % matches.length;
        setMatchIndex(next);
        reveal(matches[next]);
    };

    useEffect(() => {
        if (!scrollTo) return;
        setOpen(map => ({ ...map, [scrollTo.path]: true }));
        requestAnimationFrame(() => sections.current.get(scrollTo.path)?.scrollIntoView({ block: 'start' }));
    }, [scrollTo?.nonce]);

    const changeStyle = (value: DiffStyle) => {
        setDiffStyle(value);
        try {
            localStorage.setItem(STYLE_KEY, value);
        } catch {
            // The choice stays for this session only.
        }
    };

    /** Marks a file as viewed (it collapses) or not viewed (it opens), on GitHub. */
    const setViewed = (file: PullRequestFile, viewed: boolean) => {
        setOpen(map => ({ ...map, [file.path]: !viewed }));
        reviewStore.setViewed(target, pr.number, pr.id, file.path, viewed).catch(err => onError(errorText(err)));
        if (viewed) {
            // The next file comes to the top, so the review goes on from there.
            requestAnimationFrame(() => sections.current.get(file.path)?.scrollIntoView({ block: 'nearest' }));
        }
    };

    const commentCount = (path: string) =>
        pr.threads.filter(thread => thread.path === path && !thread.isResolved).length + review.pending.filter(comment => comment.path === path).length;

    if (!files) {
        return <div className="panel-message"><LoaderCircle size={14} className="spin" /> Loading the changed files…</div>;
    }
    const viewedCount = files.filter(file => file.viewed).length;
    const answered = questions.filter(question => question.status === 'done');

    return (
        <div className="files-stream">
            {findOpen && (
                <FindBar
                    query={query}
                    caseSensitive={caseSensitive}
                    count={matches.length}
                    index={Math.min(matchIndex, matches.length - 1)}
                    focusNonce={findRequest ?? 0}
                    onQuery={setQuery}
                    onCaseSensitive={setCaseSensitive}
                    onMove={moveMatch}
                    onClose={() => setFindOpen(false)}
                />
            )}
            <div className="files-stream-toolbar">
                <span className="files-stream-count">{viewedCount} of {files.length} viewed</span>
                <span className="header-spacer" />
                {answered.length > 0 && (
                    <div className="answers-menu">
                        <button className="link-button" aria-expanded={answersOpen} onClick={() => setAnswersOpen(value => !value)}>
                            <Bot size={12} strokeWidth={1.6} /> Agent answers ({answered.length})
                        </button>
                        {answersOpen && (
                            <div className="answers-menu-list" role="menu">
                                {answered.map(question => (
                                    <button key={question.id} role="menuitem" className="answers-menu-item" onClick={() => showAnswer(question)}>
                                        <span className="answers-menu-question">{question.question}</span>
                                        <span className="answers-menu-where">
                                            {question.path}, {lineLabel(question.startLine, question.line)}
                                            {question.answeredAt ? ` · ${timeAgo(new Date(question.answeredAt).toISOString())}` : ''}
                                        </span>
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                )}
                <button className="link-button" onClick={() => setOpen(Object.fromEntries(files.map(file => [file.path, false])))}>Collapse all</button>
                <button className="link-button" onClick={() => setOpen(Object.fromEntries(files.map(file => [file.path, true])))}>Expand all</button>
                <div className="segmented compact" role="radiogroup" aria-label="Diff layout">
                    <button className={diffStyle === 'unified' ? 'selected' : ''} onClick={() => changeStyle('unified')}>Unified</button>
                    <button className={diffStyle === 'split' ? 'selected' : ''} onClick={() => changeStyle('split')}>Split</button>
                </div>
            </div>
            <Virtualizer className="files-stream-scroll" contentClassName="files-stream-content">
                {files.map(file => {
                    const expanded = isOpen(file);
                    const count = commentCount(file.path);
                    return (
                        <section
                            key={file.path}
                            className={`stream-file${expanded ? ' open' : ''}${file.viewed ? ' viewed' : ''}`}
                            ref={element => {
                                if (element) sections.current.set(file.path, element);
                                else sections.current.delete(file.path);
                            }}
                        >
                            <header className="stream-file-header" onClick={() => setOpen(map => ({ ...map, [file.path]: !expanded }))}>
                                <ChevronRight size={14} strokeWidth={1.8} className={`group-chevron${expanded ? ' open' : ''}`} />
                                <span className={`file-status status-${file.status}`}>{file.status[0].toUpperCase()}</span>
                                <span className="stream-file-path" title={file.path}>
                                    {file.previousPath && file.previousPath !== file.path ? `${file.previousPath} → ` : ''}{file.path}
                                </span>
                                <CopyButton text={file.path} title="Copy the file path" size={13} className="icon-button stream-file-copy" />
                                {count > 0 && <span className="comment-count"><MessageSquare size={12} strokeWidth={1.6} />{count}</span>}
                                <span className="additions">+{file.additions}</span>
                                <span className="deletions">−{file.deletions}</span>
                                <label className="viewed-toggle" title="Mark the file as viewed, as on GitHub" onClick={event => event.stopPropagation()}>
                                    <input type="checkbox" checked={!!file.viewed} onChange={event => setViewed(file, event.target.checked)} />
                                    Viewed
                                </label>
                            </header>
                            {expanded && (
                                <FileBody
                                    target={target}
                                    pr={pr}
                                    file={file}
                                    pending={review.pending.filter(comment => comment.path === file.path)}
                                    composer={composer?.path === file.path ? composer : undefined}
                                    questions={questions.filter(question => question.path === file.path)}
                                    highlight={findOpen && current?.path === file.path ? current : undefined}
                                    diffStyle={diffStyle}
                                    mode={mode}
                                    onComposer={next => setComposer(next ? { ...next, path: file.path } : undefined)}
                                    onAsk={repo && ((at, text) => ask(file.path, at, text))}
                                    onQuestion={onQuestion}
                                    onRefresh={onRefresh}
                                />
                            )}
                        </section>
                    );
                })}
            </Virtualizer>
        </div>
    );
}
