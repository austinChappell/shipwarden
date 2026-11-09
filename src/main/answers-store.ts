import { JsonStore } from './tasks/json-store';
import { isAnswerFor, parseSavedAnswer, parseSavedCodeAnswer, type SavedAnswer, type SavedCodeAnswer } from '@shared/ask-agent';
import type { RepoRef } from '@shared/github';

/** The most answers that the store keeps. A new answer removes the oldest answer when the store is full. */
const MAX_ANSWERS = 2000;

interface AnswersFile {
    answers: SavedAnswer[];
}

/** Keeps the questions to the agent about pull requests, and the answers. Nothing goes to GitHub. */
export class AnswersStore {
    private readonly store: JsonStore<AnswersFile>;

    constructor(file: string) {
        this.store = new JsonStore<AnswersFile>(file, () => ({ answers: [] }));
    }

    /** Returns the saved answers of a pull request, oldest first. */
    async list(repo: RepoRef, number: number): Promise<SavedAnswer[]> {
        const value = await this.store.get();
        return this.valid(value).filter(answer => isAnswerFor(answer, repo, number));
    }

    /** Adds an answer, or replaces the answer with the same ID. Rejects an answer that is not correct. */
    async save(value: unknown): Promise<void> {
        const answer = parseSavedAnswer(value);
        if (!answer) throw new Error('The answer is not correct and was not saved.');
        await this.store.update(file => {
            const answers = this.valid(file).filter(item => item.id !== answer.id);
            answers.push(answer);
            return { answers: answers.slice(-MAX_ANSWERS) };
        });
    }

    /** Removes an answer. Does nothing when the ID is not in the store. */
    async remove(id: string): Promise<void> {
        await this.store.update(file => ({ answers: this.valid(file).filter(item => item.id !== id) }));
    }

    private valid(file: AnswersFile): SavedAnswer[] {
        return (Array.isArray(file.answers) ? file.answers : []).flatMap(item => parseSavedAnswer(item) ?? []);
    }
}

interface CodeAnswersFile {
    answers: SavedCodeAnswer[];
}

/**
 * Keeps the questions to the agent about worktree files, and the answers. Each answer keeps the text of its lines.
 * The editor shows an answer only while the file has this text.
 */
export class CodeAnswersStore {
    private readonly store: JsonStore<CodeAnswersFile>;

    constructor(file: string) {
        this.store = new JsonStore<CodeAnswersFile>(file, () => ({ answers: [] }));
    }

    /** Returns the saved answers of a file in a worktree, oldest first. */
    async list(worktree: string, path: string): Promise<SavedCodeAnswer[]> {
        const value = await this.store.get();
        return this.valid(value).filter(answer => answer.worktree === worktree && answer.path === path);
    }

    /** Adds an answer, or replaces the answer with the same ID. Rejects an answer that is not correct. */
    async save(value: unknown): Promise<void> {
        const answer = parseSavedCodeAnswer(value);
        if (!answer) throw new Error('The answer is not correct and was not saved.');
        await this.store.update(file => {
            const answers = this.valid(file).filter(item => item.id !== answer.id);
            answers.push(answer);
            return { answers: answers.slice(-MAX_ANSWERS) };
        });
    }

    /** Removes an answer. Does nothing when the ID is not in the store. */
    async remove(id: string): Promise<void> {
        await this.store.update(file => ({ answers: this.valid(file).filter(item => item.id !== id) }));
    }

    private valid(file: CodeAnswersFile): SavedCodeAnswer[] {
        return (Array.isArray(file.answers) ? file.answers : []).flatMap(item => parseSavedCodeAnswer(item) ?? []);
    }
}
