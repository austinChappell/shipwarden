import { describe, expect, it } from 'vitest';
import {
    activeStepIndex,
    answerProse,
    applyProposal,
    duplicatePlan,
    exploreCommand,
    explorePrompt,
    newPlan,
    newStep,
    nextStepIndex,
    normalizePlan,
    parseProposal,
    planCounts,
    planProblems,
    pullRequestBaseOf,
    pullRequestBody,
    pullRequestTitle,
    stepBranch,
    stepPrompt,
    worktreeBaseOf,
    type Plan,
    type PlanStep
} from './plans';

const API = '/code/api';
const WEB = '/code/web';
const repos = [
    { name: 'api', path: API },
    { name: 'web', path: WEB }
];
const repoName = (path: string) => repos.find(repo => repo.path === path)?.name ?? path;

function step(patch: Partial<PlanStep>): PlanStep {
    return { ...newStep(), ...patch };
}

function plan(steps: PlanStep[], patch: Partial<Plan> = {}): Plan {
    return { ...newPlan('project-1', 1000), id: 'plan-abcd', title: 'Dark mode', idea: 'Add a dark mode.', steps, ...patch };
}

describe('normalizePlan', () => {
    it('refuses a value without an ID or a project', () => {
        expect(normalizePlan({ id: 'a' })).toBeUndefined();
        expect(normalizePlan({ projectId: 'p' })).toBeUndefined();
        expect(normalizePlan(null)).toBeUndefined();
    });

    it('keeps the valid fields and drops the others', () => {
        const value = {
            id: 'a',
            projectId: 'p',
            title: 'T',
            status: 'running',
            agentMode: 'auto',
            taskTarget: { connectionId: 'c', collectionId: 'l' },
            steps: [
                {
                    id: 's1',
                    title: 'One',
                    repo: API,
                    status: 'done',
                    pr: { number: 3, url: 'https://x/3', base: 'main' },
                    task: { kind: 'existing', link: { pluginId: 'p', taskId: 't', title: 'Task' } }
                },
                { id: 's1', title: 'Duplicate ID' },
                { id: 's2', repo: 'relative/path', status: 'nonsense', task: { kind: 'existing' } }
            ],
            extra: true
        };
        const result = normalizePlan(value);
        expect(result?.status).toBe('running');
        expect(result?.agentMode).toBe('auto');
        expect(result?.taskTarget).toEqual({ connectionId: 'c', collectionId: 'l' });
        expect(result?.steps.map(item => item.id)).toEqual(['s1', 's2']);
        expect(result?.steps[0].pr?.number).toBe(3);
        expect(result?.steps[0].task.kind).toBe('existing');
        expect(result?.steps[1].repo).toBeUndefined();
        expect(result?.steps[1].status).toBe('pending');
        expect(result?.steps[1].task).toEqual({ kind: 'none' });
        expect(result).not.toHaveProperty('extra');
    });
});

describe('planProblems', () => {
    it('reports a plan without steps', () => {
        expect(planProblems(plan([]), [API], true)).toHaveLength(1);
    });

    it('reports missing titles, repositories and task targets of the steps that run', () => {
        const steps = [
            step({ title: '', repo: API }),
            step({ title: 'B' }),
            step({ title: 'C', repo: '/gone' }),
            step({ title: 'D', repo: API, task: { kind: 'new' } }),
            step({ title: '', skip: true })
        ];
        const problems = planProblems(plan(steps), [API], true);
        expect(problems).toEqual([
            'Step 1 has no title.',
            'Step 2 has no repository.',
            'Step 3: the repository is not in the project anymore.',
            'Step 4 makes a new task. Select a task manager and a collection for new tasks.'
        ]);
    });

    it('reports new tasks when the task manager cannot make tasks', () => {
        const steps = [step({ title: 'A', repo: API, task: { kind: 'new' } })];
        expect(planProblems(plan(steps, { taskTarget: { connectionId: 'c', collectionId: 'l' } }), [API], false)).toHaveLength(1);
        expect(planProblems(plan(steps, { taskTarget: { connectionId: 'c', collectionId: 'l' } }), [API], true)).toEqual([]);
    });
});

describe('explorePrompt', () => {
    it('lists the repositories and the idea', () => {
        const text = explorePrompt({ idea: 'Add a dark mode.', repos });
        expect(text).toContain('- api: /code/api');
        expect(text).toContain('Add a dark mode.');
        expect(text).toContain('"pullRequest": true');
        expect(text).not.toContain('The current plan');
    });

    it('adds the current steps and the feedback for a revision', () => {
        const current = plan([step({ title: 'Theme tokens', repo: WEB, description: 'Add CSS variables.' })]);
        const text = explorePrompt({ idea: current.idea, repos, current, feedback: 'Put the API first.' });
        expect(text).toContain('1. Theme tokens [web; pull request]');
        expect(text).toContain('Put the API first.');
    });
});

describe('parseProposal', () => {
    const answer = [
        'The app has a theme context already.',
        '```json',
        JSON.stringify({
            title: 'Dark mode',
            summary: 'Two steps.',
            steps: [
                { title: 'Store the theme', repo: 'api', description: 'Add a column.', pullRequest: true },
                { title: 'Toggle', repo: 'WEB', description: 'Add a toggle.', pullRequest: false },
                { title: 'Unknown repo', repo: 'mobile' },
                { description: 'No title' }
            ]
        }),
        '```'
    ].join('\n');

    it('reads the last JSON block and maps the repository names to folders', () => {
        const proposal = parseProposal(answer, repos);
        expect(proposal.title).toBe('Dark mode');
        expect(proposal.steps).toHaveLength(3);
        expect(proposal.steps[0]).toMatchObject({ title: 'Store the theme', repo: API, pullRequest: true });
        expect(proposal.steps[1]).toMatchObject({ repo: WEB, pullRequest: false });
        expect(proposal.steps[2].repo).toBeUndefined();
    });

    it('reads a JSON object without a code block', () => {
        expect(parseProposal('Plan: {"steps":[{"title":"A","repo":"api"}]}', repos).steps[0].repo).toBe(API);
    });

    it('throws an error when the answer has no plan', () => {
        expect(() => parseProposal('I could not find the code.', repos)).toThrow(/no plan/);
        expect(() => parseProposal('```json\n{"steps":[]}\n```', repos)).toThrow(/no steps/);
    });

    it('returns the text before the JSON block as the summary', () => {
        expect(answerProse(answer)).toBe('The app has a theme context already.');
    });
});

describe('applyProposal', () => {
    it('replaces the steps and keeps the task choices of steps with the same title', () => {
        const link = { pluginId: 'p', taskId: 't', title: 'Task' };
        const before = plan([step({ title: 'Toggle', task: { kind: 'existing', link } })], { title: 'New plan' });
        const result = applyProposal(before, { title: 'Dark mode', steps: [{ title: 'toggle', description: 'x', pullRequest: true }] }, 'Claude Code', 5);
        expect(result.title).toBe('Dark mode');
        expect(result.agent).toBe('Claude Code');
        expect(result.steps[0].task).toEqual({ kind: 'existing', link });
        expect(result.steps[0].id).not.toBe(before.steps[0].id);
    });

    it('keeps a title that the user typed', () => {
        const result = applyProposal(plan([], { title: 'My title' }), { title: 'Other', steps: [{ title: 'A', description: '', pullRequest: true }] }, 'a', 1);
        expect(result.title).toBe('My title');
    });
});

describe('exploreCommand', () => {
    it('adds the other repositories for Claude Code and Gemini CLI', () => {
        expect(exploreCommand('claude -p', 'claude', ['/a b', '/c'])).toBe("claude -p --add-dir '/a b' '/c'");
        expect(exploreCommand("gemini -p 'x'", 'gemini', ['/a', '/c'])).toBe("gemini -p 'x' --include-directories '/a,/c'");
        expect(exploreCommand('codex exec -', 'codex', ['/a'])).toBe('codex exec -');
        expect(exploreCommand('claude -p', 'claude', [])).toBe('claude -p');
    });
});

describe('the order of the steps', () => {
    const steps = [
        step({ id: 'a', title: 'API 1', repo: API, status: 'done', branch: 'b/1', pr: { number: 1, url: 'https://gh/api/1', base: 'main' } }),
        step({ id: 'b', title: 'Web 1', repo: WEB, status: 'done', branch: 'b/2' }),
        step({ id: 'c', title: 'API 2', repo: API, status: 'skipped', skip: true }),
        step({ id: 'd', title: 'Web 2', repo: WEB }),
        step({ id: 'e', title: 'API 3', repo: API })
    ];

    it('finds the next step and the active step', () => {
        expect(nextStepIndex(plan(steps))).toBe(3);
        expect(activeStepIndex(plan(steps))).toBe(-1);
        expect(activeStepIndex(plan(steps.map(item => (item.id === 'd' ? { ...item, status: 'attention' } : item))))).toBe(3);
    });

    it('stacks a worktree on the last done step of the same repository', () => {
        expect(worktreeBaseOf(steps, 3)).toBe('b/2');
        expect(worktreeBaseOf(steps, 4)).toBe('b/1');
        expect(worktreeBaseOf(steps, 0)).toBeUndefined();
    });

    it('targets a pull request at the last step of the same repository with a pull request', () => {
        expect(pullRequestBaseOf(steps, 4)).toBe('b/1');
        // The web step before it has no pull request, so its branch is not on the remote.
        expect(pullRequestBaseOf(steps, 3)).toBeUndefined();
    });

    it('counts the steps that run', () => {
        expect(planCounts(plan(steps))).toEqual({ steps: 4, pullRequests: 4, newTasks: 0, repos: 2 });
    });
});

describe('stepBranch', () => {
    it('puts all branches of a plan in one folder', () => {
        expect(stepBranch({ id: 'lx2-abcd12', title: 'Dark mode: phase 1!' }, { title: 'Store the théme' }, 0)).toBe(
            'plan/dark-mode-phase-1-cd12/1-store-the-theme'
        );
        expect(stepBranch({ id: 'x', title: '' }, { title: '' }, 4)).toBe('plan/step-x/5-step');
    });
});

describe('the texts of a step', () => {
    const link = { pluginId: 'p', taskId: 't', key: 'ENG-7', title: 'Dark mode toggle', url: 'https://tasks/7' };
    const steps = [
        step({ title: 'Store the theme', repo: API, status: 'done', branch: 'b/1', pr: { number: 4, url: 'https://gh/api/pull/4', base: 'main' } }),
        step({ title: 'Toggle', repo: WEB, status: 'running', branch: 'b/2', description: 'Add a toggle.', task: { kind: 'existing', link } }),
        step({ title: 'Experiment', repo: WEB, pullRequest: false }),
        step({ title: 'Skipped', repo: WEB, skip: true, status: 'skipped' })
    ];
    const current = plan(steps);

    it('gives the agent the plan, its step and the rules', () => {
        const text = stepPrompt(current, 1, repoName);
        expect(text).toContain('step 2 of 3');
        expect(text).toContain('1. Store the theme [api] (done: https://gh/api/pull/4)');
        expect(text).toContain('2. Toggle [web] ← this step');
        expect(text).not.toContain('Skipped');
        expect(text).toContain('ENG-7: Dark mode toggle (https://tasks/7)');
        expect(text).toContain('on the branch "b/2"');
        expect(text).toContain('Do not push');
    });

    it('tells the agent of an experiment that it is an experiment', () => {
        expect(stepPrompt(current, 2, repoName)).toContain('This step is an experiment.');
    });

    it('writes the title and the merge order of the pull request', () => {
        expect(pullRequestTitle(steps[1])).toBe('ENG-7: Toggle');
        expect(pullRequestTitle(steps[0])).toBe('Store the theme');
        const body = pullRequestBody(current, 1, repoName);
        expect(body).toContain('Add a toggle.');
        expect(body).toContain('Task: [ENG-7: Dark mode toggle](https://tasks/7)');
        expect(body).toContain('1. Store the theme (api): https://gh/api/pull/4');
        expect(body).toContain('2. Toggle (web): **this pull request**');
        expect(body).not.toContain('Experiment');
    });
});

describe('duplicatePlan', () => {
    it('makes a draft with new IDs and without the results of the run', () => {
        const link = { pluginId: 'p', taskId: 't', title: 'Task' };
        const ran = plan(
            [
                step({
                    title: 'A',
                    repo: API,
                    status: 'done',
                    branch: 'b',
                    pr: { number: 1, url: 'u', base: 'main' },
                    task: { kind: 'existing', link, created: true }
                }),
                step({ title: 'B', repo: API, status: 'skipped' })
            ],
            { status: 'done', executedAt: 5, finishedAt: 6 }
        );
        const copy = duplicatePlan(ran, 10);
        expect(copy.status).toBe('draft');
        expect(copy.id).not.toBe(ran.id);
        expect(copy.title).toBe('Dark mode (copy)');
        expect(copy.executedAt).toBeUndefined();
        expect(copy.steps[0]).toMatchObject({ title: 'A', status: 'pending', task: { kind: 'existing', link } });
        expect(copy.steps[0].pr).toBeUndefined();
        expect(copy.steps[0].branch).toBeUndefined();
        expect(copy.steps[1].skip).toBe(true);
    });
});
