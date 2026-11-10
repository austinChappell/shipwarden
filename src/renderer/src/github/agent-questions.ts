import type { DiffSide, RepoRef } from '@shared/github';
import type { SavedAnswer } from '@shared/ask-agent';

/** A question to the agent about lines of a file, and its answer when it comes. */
export interface AgentQuestion {
    id: string;
    path: string;
    side: DiffSide;
    startLine: number;
    line: number;
    question: string;
    status: 'running' | 'done' | 'error';
    agent?: string;
    answer?: string;
    error?: string;
    /** The head commit of the pull request when the agent answered. */
    commit?: string;
    /** The time of the answer, in milliseconds since 1970. */
    answeredAt?: number;
    /** True when the card shows only the question. A saved answer starts collapsed. */
    collapsed?: boolean;
}

/** The actions on a question card. */
export type QuestionAction = 'close' | 'cancel' | 'retry' | 'comment' | 'toggle' | 'delete';

/** Returns a saved answer as a question card. A saved answer starts collapsed. */
export function fromSaved(saved: SavedAnswer): AgentQuestion {
    return {
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
    };
}

/** The result of an agent run. */
export interface AgentAnswer {
    agent: string;
    answer: string;
}

/** Returns the answer to a question in the form that goes to disk. */
export function toSaved(question: AgentQuestion, repo: RepoRef, number: number, result: AgentAnswer, commit: string, answeredAt: number): SavedAnswer {
    return {
        id: question.id, repo, number, path: question.path, side: question.side, startLine: question.startLine, line: question.line,
        question: question.question, agent: result.agent, answer: result.answer, commit, answeredAt
    };
}

/** Adds the loaded answers before the questions in the list. A question that is in the list already stays as it is. */
export function addLoaded(list: AgentQuestion[], loaded: AgentQuestion[]): AgentQuestion[] {
    return [...loaded.filter(item => !list.some(other => other.id === item.id)), ...list];
}

/** Changes the fields of one question in the list. */
export function changeQuestion(list: AgentQuestion[], id: string, change: Partial<AgentQuestion>): AgentQuestion[] {
    return list.map(item => (item.id === id ? { ...item, ...change } : item));
}

/** Puts the answer on a running question. A question that does not run (for example a cancelled one) does not change. */
export function answerQuestion(list: AgentQuestion[], id: string, result: AgentAnswer, commit: string, answeredAt: number): AgentQuestion[] {
    return list.map(item => (item.id === id && item.status === 'running'
        ? { ...item, status: 'done', agent: result.agent, answer: result.answer, commit, answeredAt, collapsed: false }
        : item));
}

/** Puts the error on a running question. A question that does not run does not change. */
export function failQuestion(list: AgentQuestion[], id: string, error: string): AgentQuestion[] {
    return list.map(item => (item.id === id && item.status === 'running' ? { ...item, status: 'error', error } : item));
}

/** True when the agent answered on a commit that is not the current head commit. */
export function answerOutdated(question: AgentQuestion, headRefOid: string): boolean {
    return question.status === 'done' && !!question.answer && !!question.commit && question.commit !== headRefOid;
}
