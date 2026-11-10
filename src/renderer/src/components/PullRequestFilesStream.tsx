import { useEffect, useMemo, useRef, useState } from 'react';
import { Virtualizer } from '@pierre/diffs/react';
import { Bot, ChevronRight, FileCode, LoaderCircle, MessageSquare, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import type { PullRequest, PullRequestFile, RepoTarget } from '@shared/github';
import { reviewStore, useReviewState } from '../github/review-store';
import { errorText, timeAgo } from '../util';
import { CopyButton } from './CopyButton';
import { radioGroupKeys } from './keyboard';
import { askPrompt, lineLabel, sliceLines } from '@shared/ask-agent';
import { searchPatches, type PatchMatch } from '@shared/pr-search';
import { isCommentKey } from '@shared/shortcuts';
import {
    addLoaded,
    answerQuestion,
    changeQuestion as changeQuestionIn,
    failQuestion,
    fromSaved,
    toSaved,
    type AgentQuestion,
    type QuestionAction
} from '../github/agent-questions';
import { allFilesOpen, currentMatchIndex, isFileOpen, nextMatchIndex, type Composer } from '../github/diff-notes';
import { openCommentCount } from '../github/review-state';
import { readStyle, STYLE_KEY, useColorMode, useMetaKey, type DiffStyle } from './diff-style';
import { FindBar, findLineElement } from './FindBar';
import { FileBody } from './PullRequestFileBody';

export { readStyle, STYLE_KEY, THEME_CSS, useColorMode, type DiffStyle } from './diff-style';
export { FindBar, findLineElement } from './FindBar';

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
    /** The file list beside the stream. With it, the toolbar shows a button that hides and shows the list. */
    fileList?: { open: boolean; toggle(): void };
    /** ⌘-click on a name on the new side of a diff. The line and the column start at 1. */
    onGoToDefinition?(path: string, line: number, column: number): void;
    /** Opens the full file at the head commit. */
    onOpenFile?(path: string): void;
}

/**
 * All changed files of a pull request in one stream, like the "Files changed" page of GitHub. Each file can collapse.
 * A file that the user marks as viewed collapses, and viewed files start collapsed.
 */
export function PullRequestFilesStream({ target, pr, files, scrollTo, onRefresh, onError, findRequest, fileList, onGoToDefinition, onOpenFile }: Props) {
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
    const current: PatchMatch | undefined = matches[currentMatchIndex(matchIndex, matches.length)];
    /** The repository for the agent. Only the Review view has one. */
    const repo = typeof target === 'string' ? undefined : target;
    const sections = useRef(new Map<string, HTMLElement>());
    /** True while ⌘ is down. Then the names on the new side show as links. */
    const armed = useMetaKey(!!onGoToDefinition);
    // FileBody is memoized, so it gets one function for the life of the stream.
    const goToRef = useRef(onGoToDefinition);
    goToRef.current = onGoToDefinition;
    const canGoTo = !!onGoToDefinition;
    const goTo = useMemo(() => (canGoTo ? (path: string, line: number, column: number) => goToRef.current?.(path, line, column) : undefined), [canGoTo]);

    // A different pull request starts with the default open state, and with its saved answers.
    // biome-ignore lint/correctness/useExhaustiveDependencies: The state resets only for a new pull request or repository. A new repo object with the same name must not reset it.
    useEffect(() => {
        setOpen({});
        setComposer(undefined);
        setQuestions([]);
        setAnswersOpen(false);
        if (!repo) return;
        let active = true;
        window.shipwarden.ask
            .answers(repo, pr.number)
            .then(saved => {
                if (!active) return;
                const loaded = saved.map(fromSaved);
                // A question that the user asked while the list loaded stays.
                setQuestions(list => addLoaded(list, loaded));
            })
            .catch(err => onError(`The saved answers did not load. ${errorText(err)}`));
        return () => {
            active = false;
        };
    }, [pr.number, repo?.owner, repo?.name]);

    const changeQuestion = (id: string, change: Partial<AgentQuestion>) => setQuestions(list => changeQuestionIn(list, id, change));

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
        const prompt = askPrompt({
            pr,
            repo,
            path: question.path,
            side: question.side,
            startLine: question.startLine,
            endLine: question.line,
            code,
            patch: file?.patch,
            question: question.question
        });
        try {
            const result = await window.shipwarden.ask.run({ id: question.id, repo, headRefOid: pr.headRefOid, prompt });
            const answeredAt = Date.now();
            setQuestions(list => answerQuestion(list, question.id, result, pr.headRefOid, answeredAt));
            // A cancelled run rejects, so each answer here is a real answer. It is saved also when the user opened a different pull request.
            const saved = toSaved(question, repo, pr.number, result, pr.headRefOid, answeredAt);
            window.shipwarden.ask.saveAnswer(saved).catch(err => onError(`The answer was not saved. ${errorText(err)}`));
        } catch (err) {
            setQuestions(list => failQuestion(list, question.id, errorText(err)));
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
                    reviewStore.addPending(target, pr.number, {
                        path: question.path,
                        line: question.line,
                        side: question.side,
                        body: question.answer,
                        fromAgent: true
                    });
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

    const isOpen = (file: PullRequestFile) => isFileOpen(open, file);

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
    // biome-ignore lint/correctness/useExhaustiveDependencies: Only a new search text or case option moves to the first match. A file refresh must not move it.
    useEffect(() => {
        setMatchIndex(0);
        if (matches[0]) reveal(matches[0]);
    }, [query, caseSensitive]);

    const moveMatch = (step: 1 | -1) => {
        if (!matches.length) return;
        const next = nextMatchIndex(matchIndex, matches.length, step);
        setMatchIndex(next);
        reveal(matches[next]);
    };

    // biome-ignore lint/correctness/useExhaustiveDependencies: Each new nonce is one scroll request. A new object with the same nonce must not scroll again.
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

    const commentCount = (path: string) => openCommentCount(pr.threads, review.pending, path);

    if (!files) {
        return (
            <div className="panel-message">
                <LoaderCircle size={14} className="spin" /> Loading the changed files…
            </div>
        );
    }
    const viewedCount = files.filter(file => file.viewed).length;
    const answered = questions.filter(question => question.status === 'done');

    /**
     * ⇧⌘M starts a comment from the keyboard, on the line of the current search match (⌘F).
     * The diff has no cursor, so the search finds the line.
     */
    const commentKey = (event: React.KeyboardEvent) => {
        if (!isCommentKey(event) || !current || (pr.state !== 'OPEN' && !repo)) return;
        event.preventDefault();
        setOpen(map => ({ ...map, [current.path]: true }));
        setComposer({ path: current.path, side: current.side, line: current.line, startLine: current.line });
    };

    return (
        <div className={`files-stream${armed ? ' goto-armed' : ''}`} onKeyDown={commentKey}>
            {findOpen && (
                <FindBar
                    query={query}
                    caseSensitive={caseSensitive}
                    count={matches.length}
                    index={currentMatchIndex(matchIndex, matches.length)}
                    focusNonce={findRequest ?? 0}
                    onQuery={setQuery}
                    onCaseSensitive={setCaseSensitive}
                    onMove={moveMatch}
                    onClose={() => setFindOpen(false)}
                />
            )}
            <div className="files-stream-toolbar">
                {fileList && (
                    <button
                        className="icon-button file-list-toggle"
                        title={fileList.open ? 'Hide the file list' : 'Show the file list'}
                        aria-pressed={fileList.open}
                        onClick={fileList.toggle}
                    >
                        {fileList.open ? <PanelLeftClose size={15} strokeWidth={1.5} /> : <PanelLeftOpen size={15} strokeWidth={1.5} />}
                    </button>
                )}
                <span className="files-stream-count">
                    {viewedCount} of {files.length} viewed
                </span>
                <span className="header-spacer" />
                {onGoToDefinition && <span className="files-stream-hint">⌘-click a name to go to its definition</span>}
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
                <button className="link-button" onClick={() => setOpen(allFilesOpen(files, false))}>
                    Collapse all
                </button>
                <button className="link-button" onClick={() => setOpen(allFilesOpen(files, true))}>
                    Expand all
                </button>
                <div className="segmented compact" role="radiogroup" aria-label="Diff layout" onKeyDown={radioGroupKeys}>
                    <button
                        role="radio"
                        aria-checked={diffStyle === 'unified'}
                        className={diffStyle === 'unified' ? 'selected' : ''}
                        onClick={() => changeStyle('unified')}
                    >
                        Unified
                    </button>
                    <button
                        role="radio"
                        aria-checked={diffStyle === 'split'}
                        className={diffStyle === 'split' ? 'selected' : ''}
                        onClick={() => changeStyle('split')}
                    >
                        Split
                    </button>
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
                                <button className="row-toggle" aria-expanded={expanded}>
                                    <ChevronRight size={14} strokeWidth={1.8} className={`group-chevron${expanded ? ' open' : ''}`} />
                                    <span className={`file-status status-${file.status}`}>{file.status[0].toUpperCase()}</span>
                                    <span className="stream-file-path" title={file.path}>
                                        {file.previousPath && file.previousPath !== file.path ? `${file.previousPath} → ` : ''}
                                        {file.path}
                                    </span>
                                </button>
                                <CopyButton text={file.path} title="Copy the file path" size={13} className="icon-button stream-file-copy" />
                                {onOpenFile && file.status !== 'removed' && (
                                    <button
                                        className="icon-button stream-file-copy"
                                        title="Open the full file, with go to definition"
                                        onClick={event => {
                                            event.stopPropagation();
                                            onOpenFile(file.path);
                                        }}
                                    >
                                        <FileCode size={13} strokeWidth={1.6} />
                                    </button>
                                )}
                                {count > 0 && (
                                    <span className="comment-count">
                                        <MessageSquare size={12} strokeWidth={1.6} />
                                        {count}
                                    </span>
                                )}
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
                                    onGoToDefinition={goTo}
                                />
                            )}
                        </section>
                    );
                })}
            </Virtualizer>
        </div>
    );
}
