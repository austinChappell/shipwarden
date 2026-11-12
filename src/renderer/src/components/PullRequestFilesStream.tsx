import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Virtualizer } from '@pierre/diffs/react';
import { Bot, ChevronDown, ChevronRight, ChevronUp, FileCode, LoaderCircle, MessageSquare, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import type { DiffSide, PullRequest, PullRequestFile, RepoTarget } from '@shared/github';
import { reviewStore, useReviewState } from '../github/review-store';
import { errorText, timeAgo } from '../util';
import { CopyButton } from './CopyButton';
import { Button, ButtonGroup, Checkbox, Chip, Count, IconButton } from './ui';
import { radioGroupKeys } from './keyboard';
import { askPrompt, lineLabel, sliceLines } from '@shared/ask-agent';
import { searchPatches, type PatchMatch } from '@shared/pr-search';
import { isCommentKey, pendingCommentStep } from '@shared/shortcuts';
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
import { allFilesOpen, currentMatchIndex, isFileOpen, nextMatchIndex, seekDelta, type Composer } from '../github/diff-notes';
import { nextPendingIndex, openCommentCount, pendingOrder } from '../github/review-state';
import { readStyle, STYLE_KEY, useColorMode, useMetaKey, type DiffStyle } from './diff-style';
import { FindBar, findLineElement, renderedLines } from './FindBar';
import { useCopySelection, type FindRequest } from './selected-text';
import { FileBody } from './PullRequestFileBody';

export { readStyle, STYLE_KEY, THEME_CSS, useColorMode, type DiffStyle } from './diff-style';
export { FindBar, findLineElement } from './FindBar';

interface Props {
    target: RepoTarget;
    pr: PullRequest;
    files: PullRequestFile[] | undefined;
    /**
     * A file to show: it opens and scrolls into view. A new `nonce` does it again.
     * With `line`, the comment on that line comes into view. Without a comment, the line comes into view.
     */
    scrollTo?: { path: string; nonce: number; line?: number; side?: DiffSide };
    onRefresh(): Promise<void>;
    onError(message: string): void;
    /** A request to open the search bar (⌘F). A new value opens it again and selects its text. Its text replaces the search text. */
    findRequest?: FindRequest;
    /** The file list beside the stream. With it, the toolbar shows a button that hides and shows the list. */
    fileList?: { open: boolean; toggle(): void };
    /** ⌘-click on a name on the new side of a diff. The line and the column start at 1. */
    onGoToDefinition?(path: string, line: number, column: number): void;
    /** Opens the full file at the head commit. */
    onOpenFile?(path: string): void;
    /** Sends a prompt to an agent. Without it, the review threads have no "Send to agent" button. */
    onSendToAgent?(prompt: string): void;
}

/** Returns true when a key goes to a field that takes text. */
function isTextField(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return (
        target.isContentEditable ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLInputElement && !['checkbox', 'radio', 'button'].includes(target.type))
    );
}

/**
 * All changed files of a pull request in one stream, like the "Files changed" page of GitHub. Each file can collapse.
 * A file that the user marks as viewed collapses, and viewed files start collapsed.
 */
export function PullRequestFilesStream({
    target,
    pr,
    files,
    scrollTo,
    onRefresh,
    onError,
    findRequest,
    fileList,
    onGoToDefinition,
    onOpenFile,
    onSendToAgent
}: Props) {
    // The file bodies are memoized. A stable function keeps them from a new render each time the parent renders.
    const sendRef = useRef(onSendToAgent);
    sendRef.current = onSendToAgent;
    const sendToAgent = useCallback((prompt: string) => sendRef.current?.(prompt), []);
    const review = useReviewState(target, pr.number);
    const mode = useColorMode();
    const [diffStyle, setDiffStyle] = useState<DiffStyle>(readStyle);
    /** The open state of each file, by path. A file without an entry is open unless it is viewed. */
    const [open, setOpen] = useState<Record<string, boolean>>({});
    const [composer, setComposer] = useState<Composer & { path: string }>();
    const [questions, setQuestions] = useState<AgentQuestion[]>([]);
    const [answersOpen, setAnswersOpen] = useState(false);
    /** The index of the pending comment that the ↑ and ↓ buttons showed last. Undefined before the first click. */
    const [pendingIndex, setPendingIndex] = useState<number>();
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
        setPendingIndex(undefined);
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
        if (!findRequest) return;
        setFindOpen(true);
        if (findRequest.text) setQuery(findRequest.text);
    }, [findRequest]);

    /** The number of the last reveal request. A new request stops the loop of the request before it. */
    const revealRun = useRef(0);

    /**
     * Opens a file and scrolls a line to the center of the view. The diff renders only the lines near the view.
     * Each frame, the loop estimates the position of the line from the lines that show, and scrolls to it.
     * With `note`, the comment zone on the line comes into view and flashes. `nth` selects one of more zones on the same line.
     */
    const reveal = (target: { path: string; line: number; side?: DiffSide; note?: { kind?: 'pending' | 'thread'; nth?: number } }) => {
        setOpen(map => ({ ...map, [target.path]: true }));
        const run = ++revealRun.current;
        const side = target.side ?? 'RIGHT';
        const note = target.note;
        const selector =
            note &&
            `.stream-zone[data-line="${target.line}"]${target.side ? `[data-side="${target.side}"]` : ''}${note.kind ? `[data-note="${note.kind}"]` : ''}`;
        let tries = 0;
        /** The count of frames to wait after a scroll. The diff renders the new lines in the next frames. */
        let wait = 0;
        /** The line or the nearest line that the loop found. The loop stops on it when the zone does not show. */
        let fallback: HTMLElement | undefined;
        const finish = (element: HTMLElement, flash: boolean) => {
            element.scrollIntoView({ block: 'center' });
            if (!flash) return;
            element.classList.remove('note-flash');
            void element.offsetWidth;
            element.classList.add('note-flash');
        };
        const step = () => {
            if (run !== revealRun.current) return;
            if (++tries > 90) {
                if (fallback) finish(fallback, false);
                return;
            }
            if (wait > 0) {
                wait--;
                requestAnimationFrame(step);
                return;
            }
            const section = sections.current.get(target.path);
            if (!section) {
                requestAnimationFrame(step);
                return;
            }
            // A zone is in the DOM before its line renders. It has a box only when its line shows.
            const zone = selector ? section.querySelectorAll<HTMLElement>(selector)[note?.nth ?? 0] : undefined;
            if (zone && zone.getClientRects().length > 0) {
                finish(zone, true);
                return;
            }
            const line = findLineElement(section, side, target.line);
            if (line) {
                if (!selector) {
                    finish(line, false);
                    return;
                }
                // The zone shows in a later frame.
                fallback = line;
                line.scrollIntoView({ block: 'center' });
                requestAnimationFrame(step);
                return;
            }
            const rendered = renderedLines(section);
            const scroller = section.closest<HTMLElement>('.files-stream-scroll');
            if (!rendered.length || !scroller) {
                // The file does not show. Scroll to the file first.
                section.scrollIntoView({ block: 'start' });
                wait = 2;
                requestAnimationFrame(step);
                return;
            }
            const box = scroller.getBoundingClientRect();
            const delta = seekDelta(target.line, rendered, box.top + box.height / 2);
            if (delta !== undefined && Math.abs(delta) >= 1) {
                scroller.scrollBy({ top: delta });
                wait = 2;
                requestAnimationFrame(step);
                return;
            }
            // The line is between lines that show, but it is not in the diff (for example, in a collapsed part).
            // Stop on the nearest line.
            const nearest = rendered.reduce((best, item) => (Math.abs(item.line - target.line) < Math.abs(best.line - target.line) ? item : best));
            const element = findLineElement(section, side, nearest.line) ?? findLineElement(section, side === 'LEFT' ? 'RIGHT' : 'LEFT', nearest.line);
            if (element) finish(element, false);
        };
        requestAnimationFrame(step);
    };

    const pendingStops = pendingOrder(review.pending, files);
    const pendingCurrent = pendingIndex === undefined || !pendingStops.length ? undefined : Math.min(pendingIndex, pendingStops.length - 1);

    /** Shows the next (↓) or the previous (↑) pending comment, in the order of the files and the lines. */
    const movePending = (step: 1 | -1) => {
        if (!pendingStops.length) return;
        const next = nextPendingIndex(pendingCurrent, pendingStops.length, step);
        setPendingIndex(next);
        const { comment, nth } = pendingStops[next];
        reveal({ path: comment.path, line: comment.line, side: comment.side, note: { kind: 'pending', nth } });
    };
    const rootRef = useRef<HTMLDivElement>(null);
    useCopySelection(rootRef);
    const movePendingRef = useRef(movePending);
    movePendingRef.current = movePending;

    // N shows the next pending comment and P shows the previous one. A key in a text field types the letter.
    // The keys apply when the focus is on the pull request page or on the page body.
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.defaultPrevented || isTextField(event.target)) return;
            const step = pendingCommentStep(event);
            if (!step) return;
            const target = event.target;
            const inside = target === document.body || (target instanceof Element && !!target.closest('.review-pr'));
            // A hidden view keeps the stream. Its root then has no box.
            if (!inside || !rootRef.current?.getClientRects().length) return;
            event.preventDefault();
            movePendingRef.current(step);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

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
        if (scrollTo.line !== undefined) {
            reveal({ path: scrollTo.path, line: scrollTo.line, side: scrollTo.side, note: {} });
            return;
        }
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
        <div ref={rootRef} className={`files-stream${armed ? ' goto-armed' : ''}`} onKeyDown={commentKey}>
            {findOpen && (
                <FindBar
                    query={query}
                    caseSensitive={caseSensitive}
                    count={matches.length}
                    index={currentMatchIndex(matchIndex, matches.length)}
                    focusNonce={findRequest?.at ?? 0}
                    onQuery={setQuery}
                    onCaseSensitive={setCaseSensitive}
                    onMove={moveMatch}
                    onClose={() => setFindOpen(false)}
                />
            )}
            <div className="files-stream-toolbar">
                {fileList && (
                    <IconButton
                        size="sm"
                        icon={fileList.open ? <PanelLeftClose size={14} strokeWidth={1.5} /> : <PanelLeftOpen size={14} strokeWidth={1.5} />}
                        label={fileList.open ? 'Hide the file list' : 'Show the file list'}
                        aria-pressed={fileList.open}
                        onClick={fileList.toggle}
                    />
                )}
                <span className="files-stream-count">
                    {viewedCount} of {files.length} viewed
                </span>
                <span className="header-spacer" />
                {pendingStops.length > 0 && (
                    <div className="pending-stepper" role="group" aria-label="Pending comments">
                        <MessageSquare size={12} strokeWidth={1.6} />
                        <span className="pending-stepper-count">
                            {pendingCurrent === undefined ? `${pendingStops.length} pending` : `${pendingCurrent + 1} of ${pendingStops.length} pending`}
                        </span>
                        <IconButton
                            size="sm"
                            icon={<ChevronUp size={14} strokeWidth={1.8} />}
                            label="Go to the previous pending comment (P)"
                            onClick={() => movePending(-1)}
                        />
                        <IconButton
                            size="sm"
                            icon={<ChevronDown size={14} strokeWidth={1.8} />}
                            label="Go to the next pending comment (N)"
                            onClick={() => movePending(1)}
                        />
                    </div>
                )}
                {onGoToDefinition && <span className="files-stream-hint">⌘-click a name to go to its definition</span>}
                {answered.length > 0 && (
                    <div className="answers-menu">
                        <Button
                            variant="link"
                            icon={<Bot size={12} strokeWidth={1.6} />}
                            aria-expanded={answersOpen}
                            onClick={() => setAnswersOpen(value => !value)}
                        >
                            Agent answers <Count value={answered.length} />
                        </Button>
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
                <Button variant="link" onClick={() => setOpen(allFilesOpen(files, false))}>
                    Collapse all
                </Button>
                <Button variant="link" onClick={() => setOpen(allFilesOpen(files, true))}>
                    Expand all
                </Button>
                <ButtonGroup size="sm" role="radiogroup" label="Diff layout" onKeyDown={radioGroupKeys}>
                    <Button size="sm" role="radio" aria-checked={diffStyle === 'unified'} onClick={() => changeStyle('unified')}>
                        Unified
                    </Button>
                    <Button size="sm" role="radio" aria-checked={diffStyle === 'split'} onClick={() => changeStyle('split')}>
                        Split
                    </Button>
                </ButtonGroup>
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
                            <header
                                className="stream-file-header"
                                onClick={event => {
                                    // A click on the Viewed box changes only the box, not the open state of the file.
                                    if ((event.target as Element).closest('.viewed-toggle')) return;
                                    setOpen(map => ({ ...map, [file.path]: !expanded }));
                                }}
                            >
                                <button className="row-toggle" aria-expanded={expanded}>
                                    <ChevronRight size={14} strokeWidth={1.8} className={`group-chevron${expanded ? ' open' : ''}`} />
                                    <span className={`file-status status-${file.status}`}>{file.status[0].toUpperCase()}</span>
                                    <span className="stream-file-path" title={file.path}>
                                        {file.previousPath && file.previousPath !== file.path ? `${file.previousPath} → ` : ''}
                                        {file.path}
                                    </span>
                                </button>
                                <CopyButton text={file.path} title="Copy the file path" size={13} className="stream-file-copy" />
                                {onOpenFile && file.status !== 'removed' && (
                                    <IconButton
                                        size="sm"
                                        className="stream-file-copy"
                                        icon={<FileCode size={13} strokeWidth={1.6} />}
                                        label="Open the full file, with go to definition"
                                        onClick={event => {
                                            event.stopPropagation();
                                            onOpenFile(file.path);
                                        }}
                                    />
                                )}
                                {count > 0 && (
                                    <Chip icon={<MessageSquare size={12} strokeWidth={1.6} />} title={`${count} open comments`}>
                                        {count}
                                    </Chip>
                                )}
                                <span className="additions">+{file.additions}</span>
                                <span className="deletions">−{file.deletions}</span>
                                <Checkbox
                                    className="viewed-toggle"
                                    label="Viewed"
                                    title="Mark the file as viewed, as on GitHub"
                                    checked={!!file.viewed}
                                    onChange={checked => setViewed(file, checked)}
                                />
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
                                    onSendToAgent={onSendToAgent ? sendToAgent : undefined}
                                />
                            )}
                        </section>
                    );
                })}
            </Virtualizer>
        </div>
    );
}
