import { useCallback, useSyncExternalStore } from 'react';
import { canSaveCode, codeAskPrompt, type SavedCodeAnswer } from '@shared/ask-agent';
import type { AgentQuestion } from '../components/DiffView';
import { errorText } from '../util';

const EMPTY: AgentQuestion[] = [];

function key(root: string, path: string): string {
    return `${root}\0${path}`;
}

/** Returns a saved answer as a question card. A saved answer starts collapsed. */
const fromSaved = (saved: SavedCodeAnswer): AgentQuestion => ({
    id: saved.id,
    path: saved.path,
    side: 'RIGHT',
    startLine: saved.startLine,
    line: saved.line,
    question: saved.question,
    status: 'done',
    agent: saved.agent,
    answer: saved.answer,
    answeredAt: saved.answeredAt,
    collapsed: true
});

/**
 * Keeps the questions to the agent about the files of the worktrees, and the answers.
 * The main process keeps each answer on disk, with the text of its lines. The editor shows an answer only while the
 * file has this text (`locateCode`), or when the user asked it while the app runs. A question continues when the user closes the tab of the file.
 */
class CodeQuestionStore {
    private readonly lists = new Map<string, AgentQuestion[]>();
    /** The text of the lines of each question, when the user asked. */
    private readonly codes = new Map<string, string>();
    /** The questions that the user asked while the app runs. They show also when their lines changed. */
    private readonly asked = new Set<string>();
    /** The files whose saved answers loaded or load now. */
    private readonly loaded = new Set<string>();
    private readonly listeners = new Set<() => void>();

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    list(root: string, path: string): AgentQuestion[] {
        return this.lists.get(key(root, path)) ?? EMPTY;
    }

    /** Returns the text of the lines of a question when the user asked. */
    code(id: string): string | undefined {
        return this.codes.get(id);
    }

    /** Returns true when the user asked the question while the app runs. */
    isNew(id: string): boolean {
        return this.asked.has(id);
    }

    /** Loads the saved answers of a file one time. Calls `onError` when they do not load. */
    load(root: string, path: string, onError: (message: string) => void): void {
        const id = key(root, path);
        if (this.loaded.has(id)) return;
        this.loaded.add(id);
        window.shipwarden.ask
            .codeAnswers(root, path)
            .then(saved => {
                saved.forEach(item => this.codes.set(item.id, item.code));
                // A question that the user asked while the list loaded stays.
                this.set(root, path, list => [...saved.map(fromSaved).filter(item => !list.some(other => other.id === item.id)), ...list]);
            })
            .catch(err => {
                this.loaded.delete(id);
                onError(`The saved agent answers did not load. ${errorText(err)}`);
            });
    }

    /** Asks the agent a question about lines `startLine` to `line` of a file. `code` is the text of the lines. */
    ask(root: string, path: string, startLine: number, line: number, code: string, text: string, onError: (message: string) => void): void {
        const question: AgentQuestion = { id: crypto.randomUUID(), path, side: 'RIGHT', startLine, line, question: text, status: 'running' };
        this.codes.set(question.id, code);
        this.asked.add(question.id);
        this.set(root, path, list => [...list, question]);
        void this.run(root, question, onError);
    }

    /** Asks the same question again. */
    retry(root: string, question: AgentQuestion, onError: (message: string) => void): void {
        void this.run(root, question, onError);
    }

    /** Changes the fields of a question. */
    change(root: string, path: string, id: string, change: Partial<AgentQuestion>): void {
        this.set(root, path, list => list.map(item => (item.id === id ? { ...item, ...change } : item)));
    }

    /** Removes a question, also from the disk. A question that runs stops. */
    remove(root: string, question: AgentQuestion, onError: (message: string) => void): void {
        if (question.status === 'running') void window.shipwarden.ask.cancel(question.id);
        if (question.status === 'done') {
            window.shipwarden.ask.removeCodeAnswer(question.id).catch(err => onError(`The answer was not deleted. ${errorText(err)}`));
        }
        this.codes.delete(question.id);
        this.asked.delete(question.id);
        this.set(root, question.path, list => list.filter(item => item.id !== question.id));
    }

    private async run(root: string, question: AgentQuestion, onError: (message: string) => void): Promise<void> {
        const { path, id } = question;
        const code = this.codes.get(id) ?? '';
        this.change(root, path, id, { status: 'running', error: undefined, answer: undefined });
        const prompt = codeAskPrompt({ path, startLine: question.startLine, endLine: question.line, code, question: question.question });
        try {
            const result = await window.shipwarden.ask.run({ id, worktree: root, prompt });
            const answeredAt = Date.now();
            this.set(root, path, list =>
                list.map(item =>
                    item.id === id && item.status === 'running'
                        ? { ...item, status: 'done', agent: result.agent, answer: result.answer, answeredAt, collapsed: false }
                        : item
                )
            );
            // A cancelled run rejects, so each answer here is a real answer. Very long code stays only in memory.
            if (canSaveCode(code)) {
                const saved: SavedCodeAnswer = {
                    id,
                    worktree: root,
                    path,
                    startLine: question.startLine,
                    line: question.line,
                    code,
                    question: question.question,
                    agent: result.agent,
                    answer: result.answer,
                    answeredAt
                };
                window.shipwarden.ask.saveCodeAnswer(saved).catch(err => onError(`The answer was not saved. ${errorText(err)}`));
            }
        } catch (err) {
            this.set(root, path, list =>
                list.map(item => (item.id === id && item.status === 'running' ? { ...item, status: 'error', error: errorText(err) } : item))
            );
        }
    }

    private set(root: string, path: string, update: (list: AgentQuestion[]) => AgentQuestion[]): void {
        const id = key(root, path);
        const next = update(this.lists.get(id) ?? EMPTY);
        if (next.length) this.lists.set(id, next);
        else this.lists.delete(id);
        this.listeners.forEach(listener => listener());
    }
}

export const codeQuestions = new CodeQuestionStore();

/** Returns the questions about a file. The component renders again when they change. */
export function useCodeQuestions(root: string, path: string): AgentQuestion[] {
    const snapshot = useCallback(() => codeQuestions.list(root, path), [root, path]);
    return useSyncExternalStore(codeQuestions.subscribe, snapshot);
}
