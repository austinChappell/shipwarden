import { describe, expect, it } from 'vitest';
import {
    activeStepIndex,
    ciWatchPrompt,
    opensPullRequests,
    watchesCi,
    resumeAction,
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
    planGroups,
    planProblems,
    planReview,
    pullRequestBaseOf,
    pullRequestBody,
    pullRequestTitle,
    restackOldBases,
    restackTargets,
    reviewText,
    stackWait,
    stackedOnIndex,
    stepBranch,
    stepBranchTask,
    freeBranchName,
    stepPrompt,
    stepStatusLabel,
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

    it('keeps "no PR group" only when it is true', () => {
        expect(normalizePlan({ id: 'a', projectId: 'p', noPrGroup: true })?.noPrGroup).toBe(true);
        expect(normalizePlan({ id: 'a', projectId: 'p', noPrGroup: 'yes' })).not.toHaveProperty('noPrGroup');
        expect(normalizePlan({ id: 'a', projectId: 'p' })).not.toHaveProperty('noPrGroup');
    });

    it('keeps the agent settings only when they are true', () => {
        expect(normalizePlan({ id: 'a', projectId: 'p', keepAgents: true, watchCi: true })).toMatchObject({ keepAgents: true, watchCi: true });
        const plain = normalizePlan({ id: 'a', projectId: 'p', keepAgents: 'yes', watchCi: 1 });
        expect(plain).not.toHaveProperty('keepAgents');
        expect(plain).not.toHaveProperty('watchCi');
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
        expect(problems.map(problem => problem.message)).toEqual([
            'Step 1 has no title.',
            'Step 2 has no repository.',
            'Step 3: the repository is not in the project anymore.',
            'Step 4 makes a new task. Select a task manager and a collection.'
        ]);
        expect(problems[3].field).toBe('task');
        expect(problems[3].stepId).toBeUndefined();
        expect(problems[1]).toMatchObject({ stepId: steps[1].id, field: 'repo', hint: 'Choose the repository this step runs in.' });
    });

    it('reports new tasks when the task manager cannot make tasks', () => {
        const steps = [step({ title: 'A', repo: API, task: { kind: 'new' } })];
        expect(planProblems(plan(steps, { taskTarget: { connectionId: 'c', collectionId: 'l' } }), [API], false)).toHaveLength(1);
        expect(planProblems(plan(steps, { taskTarget: { connectionId: 'c', collectionId: 'l' } }), [API], true)).toEqual([]);
    });

    it('reports all steps with new tasks in one problem', () => {
        const steps = [step({ title: 'A', repo: API, task: { kind: 'new' } }), step({ title: 'B', repo: API, task: { kind: 'new' } })];
        expect(planProblems(plan(steps), [API], true).map(problem => problem.message)).toEqual([
            '2 steps make new tasks. Select a task manager and a collection.'
        ]);
    });
});

describe('stackedOnIndex', () => {
    it('finds the nearest earlier step in the same repository that runs', () => {
        const steps = [step({ repo: API }), step({ repo: WEB }), step({ repo: API, skip: true }), step({ repo: API }), step({})];
        expect(stackedOnIndex(steps, 0)).toBe(-1);
        expect(stackedOnIndex(steps, 1)).toBe(-1);
        expect(stackedOnIndex(steps, 2)).toBe(-1);
        expect(stackedOnIndex(steps, 3)).toBe(0);
        expect(stackedOnIndex(steps, 4)).toBe(-1);
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

    it('checks a running step on Resume when its agent is not working', () => {
        const running = (patch: Partial<PlanStep>) => plan(steps.map(item => (item.id === 'd' ? { ...item, status: 'running', ...patch } : item)));
        const withWorktree = running({ worktreePath: '/wt/d', sessionId: 's1' });
        expect(resumeAction(plan(steps), undefined)).toEqual({ kind: 'advance' });
        expect(resumeAction(plan(steps.map(item => (item.id === 'd' ? { ...item, status: 'failed' } : item))), 'done')).toEqual({
            kind: 'continue',
            stepId: 'd'
        });
        expect(resumeAction(withWorktree, 'working')).toEqual({ kind: 'wait', stepId: 'd' });
        expect(resumeAction(withWorktree, 'starting')).toEqual({ kind: 'wait', stepId: 'd' });
        expect(resumeAction(running({}), undefined)).toEqual({ kind: 'wait', stepId: 'd' });
        // The turn ended, but the step did not finish, for example after a save failed on a full disk.
        expect(resumeAction(withWorktree, 'done')).toEqual({ kind: 'check', stepId: 'd' });
        expect(resumeAction(withWorktree, 'waiting')).toEqual({ kind: 'check', stepId: 'd' });
        expect(resumeAction(withWorktree, 'exited')).toEqual({ kind: 'check', stepId: 'd' });
        // After a restart, ShipWarden can have no state for the agent.
        expect(resumeAction(withWorktree, undefined)).toEqual({ kind: 'check', stepId: 'd' });
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

    it('keeps the "no PR group" setting', () => {
        expect(duplicatePlan(plan([], { noPrGroup: true }), 10).noPrGroup).toBe(true);
        expect(duplicatePlan(plan([]), 10)).not.toHaveProperty('noPrGroup');
    });

    it('keeps the agent settings', () => {
        expect(duplicatePlan(plan([], { keepAgents: true, watchCi: true }), 10)).toMatchObject({ keepAgents: true, watchCi: true });
        expect(duplicatePlan(plan([]), 10)).not.toHaveProperty('keepAgents');
        expect(duplicatePlan(plan([]), 10)).not.toHaveProperty('watchCi');
    });
});

describe('agent settings after a step', () => {
    const pr = { number: 7, url: 'https://github.com/o/r/pull/7', base: 'main' };

    it('stops the agents by default', () => {
        expect(newPlan('p', 1).keepAgents).toBeUndefined();
        expect(watchesCi(plan([], { watchCi: true }), step({ pr }))).toBe(false);
    });

    it('watches CI only when the agents continue to run and the step has a pull request', () => {
        expect(watchesCi(plan([], { keepAgents: true, watchCi: true }), step({ pr }))).toBe(true);
        expect(watchesCi(plan([], { keepAgents: true, watchCi: true }), step({}))).toBe(false);
        expect(watchesCi(plan([], { keepAgents: true }), step({ pr }))).toBe(false);
    });

    it('finds a step that opens a pull request', () => {
        expect(opensPullRequests(plan([step({ pullRequest: true })]))).toBe(true);
        expect(opensPullRequests(plan([step({ pullRequest: false }), step({ pullRequest: true, skip: true })]))).toBe(false);
    });

    it('tells the agent to watch the checks and to push the fixes', () => {
        const text = ciWatchPrompt(pr);
        expect(text).toContain('#7');
        expect(text).toContain('gh pr checks 7 --watch');
        expect(text).toContain('push the branch');
    });
});

describe('stepStatusLabel', () => {
    it('says "Needs you" only while the agent waits for the user', () => {
        expect(stepStatusLabel('running', 'waiting')).toBe('Needs you');
        expect(stepStatusLabel('attention', 'waiting')).toBe('Needs you');
        expect(stepStatusLabel('running', 'working')).toBe('Agent is working');
        expect(stepStatusLabel('attention', 'done')).toBe('Stopped');
        expect(stepStatusLabel('attention')).toBe('Stopped');
        expect(stepStatusLabel('done', 'waiting')).toBe('Done');
    });
});

describe('the review of a draft', () => {
    it('needs each step that runs reviewed and each decision confirmed', () => {
        const draft = plan([step({ reviewed: true }), step({}), step({ skip: true })], {
            decisions: [
                { id: 'd1', text: 'One demo per director', confirmed: true },
                { id: 'd2', text: 'Max plan tier', confirmed: false }
            ]
        });
        const review = planReview(draft);
        expect(review).toEqual({ steps: 2, reviewedSteps: 1, decisions: 2, openDecisions: 1, complete: false });
        expect(reviewText(review)).toBe('Review 1 step and confirm 1 decision to run the plan.');
    });

    it('is complete when all steps are reviewed and the plan has no open decision', () => {
        const review = planReview(plan([step({ reviewed: true }), step({ skip: true })]));
        expect(review.complete).toBe(true);
        expect(reviewText(review)).toBe('All steps are reviewed and all decisions are confirmed.');
    });

    it('reads the decisions, the highlights and the step summaries of a proposal', () => {
        const answer = JSON.stringify({
            highlights: [
                { label: 'Data model', text: 'A flag' },
                { label: '', text: 'No label' }
            ],
            decisions: ['One demo per director', { text: 'Max plan tier', detail: 'Demos show all features.' }, { detail: 'No text' }],
            steps: [{ title: 'A', repo: 'api', summary: ' Adds a flag. ', touches: ['src/db.ts', '', 3] }]
        });
        const proposal = parseProposal(answer, repos);
        expect(proposal.highlights).toEqual([{ label: 'Data model', text: 'A flag' }]);
        expect(proposal.decisions).toEqual([{ text: 'One demo per director' }, { text: 'Max plan tier', detail: 'Demos show all features.' }]);
        expect(proposal.steps[0]).toMatchObject({ summary: 'Adds a flag.', touches: ['src/db.ts'] });
    });

    it('keeps a review and a confirmation only for things that did not change', () => {
        const before = plan(
            [
                step({ title: 'Same', repo: API, description: 'Do A.', reviewed: true }),
                step({ title: 'Changed', repo: API, description: 'Do B.', reviewed: true })
            ],
            { decisions: [{ id: 'd1', text: 'One demo per director', confirmed: true }] }
        );
        const result = applyProposal(
            before,
            {
                steps: [
                    { title: 'Same', repo: API, description: 'Do A.', pullRequest: true },
                    { title: 'Changed', repo: API, description: 'Do B and C.', pullRequest: true }
                ],
                decisions: [{ text: 'one demo per director' }, { text: 'A new decision' }]
            },
            'a',
            1
        );
        expect(result.steps.map(item => item.reviewed === true)).toEqual([true, false]);
        expect(result.decisions?.map(item => [item.id === 'd1', item.confirmed])).toEqual([
            [true, true],
            [false, false]
        ]);
    });

    it('keeps the decisions and the reviews in the file', () => {
        const saved = normalizePlan({
            ...plan([step({ id: 's1', reviewed: true, summary: 'Short.', touches: ['a.ts'] })]),
            decisions: [{ id: 'd1', text: 'X', confirmed: true }, { id: 'd1', text: 'Duplicate' }, { text: 'No ID' }],
            highlights: [{ label: 'L', text: 'T' }],
            approach: 'Two steps.'
        });
        expect(saved?.decisions).toEqual([{ id: 'd1', text: 'X', confirmed: true }]);
        expect(saved?.highlights).toEqual([{ label: 'L', text: 'T' }]);
        expect(saved?.approach).toBe('Two steps.');
        expect(saved?.steps[0]).toMatchObject({ reviewed: true, summary: 'Short.', touches: ['a.ts'] });
    });
});

describe('stepBranchTask', () => {
    const plan = { id: 'lx2-abcd12' };
    it('uses the task of the step', () => {
        const link = { pluginId: 'clickup', taskId: '86b2x9q4f', key: 'ENG-1', title: 'Fix the login' };
        expect(stepBranchTask(plan, { title: 'Step', description: 'Do it', task: { kind: 'existing', link } }, 0)).toEqual({
            id: '86b2x9q4f',
            key: 'ENG-1',
            title: 'Fix the login',
            description: 'Do it'
        });
    });
    it('uses the step and the plan for a step without a task', () => {
        expect(stepBranchTask(plan, { title: 'Store the theme', description: '', task: { kind: 'none' } }, 2)).toEqual({
            id: 'cd12-3',
            title: 'Store the theme',
            description: ''
        });
    });
});

describe('freeBranchName', () => {
    it('keeps a free branch', () => {
        expect(freeBranchName('jsmith/ENG-1', ['main'])).toBe('jsmith/ENG-1');
    });
    it('adds the next free number', () => {
        expect(freeBranchName('jsmith/ENG-1', ['jsmith/ENG-1', 'jsmith/ENG-1-2'])).toBe('jsmith/ENG-1-3');
    });
});

describe('stacked steps', () => {
    const pr = (number: number, base: string) => ({ number, url: `https://github.com/o/api/pull/${number}`, base });
    // Three stacked steps in the API repository and one step in the web repository.
    const stack = () => [
        step({ id: 's1', repo: API, status: 'done', branch: 'p/1', pr: pr(1, 'main'), worktreePath: '/wt/1' }),
        step({ id: 's2', repo: API, status: 'done', branch: 'p/2', baseBranch: 'p/1', stackBase: 'aaaaaaa', pr: pr(2, 'p/1'), worktreePath: '/wt/2' }),
        step({ id: 'w1', repo: WEB, status: 'done', branch: 'w/1', pr: pr(3, 'main'), worktreePath: '/wt/w' }),
        step({ id: 's3', repo: API, status: 'done', branch: 'p/3', baseBranch: 'p/2', stackBase: 'bbbbbbb', pr: pr(4, 'p/2'), worktreePath: '/wt/3' })
    ];

    it('gives each step the branch of the step before it, and the first step the default branch', () => {
        const steps = stack();
        expect([0, 1, 2, 3].map(index => worktreeBaseOf(steps, index))).toEqual([undefined, 'p/1', undefined, 'p/2']);
        expect([0, 1, 2, 3].map(index => pullRequestBaseOf(steps, index))).toEqual([undefined, 'p/1', undefined, 'p/2']);
        expect([0, 1, 2, 3].map(index => stackedOnIndex(steps, index))).toEqual([-1, 0, -1, 1]);
    });

    it('gives each step the default branch when the plan does not stack', () => {
        const steps = stack();
        expect([0, 1, 2, 3].map(index => worktreeBaseOf(steps, index, false))).toEqual([undefined, undefined, undefined, undefined]);
        expect([0, 1, 2, 3].map(index => pullRequestBaseOf(steps, index, false))).toEqual([undefined, undefined, undefined, undefined]);
        expect(stackedOnIndex(steps, 3, false)).toBe(-1);
    });

    it('skips a step whose pull request merged', () => {
        const steps = stack().map(item => (item.id === 's1' ? { ...item, mergedAt: 5 } : item));
        expect(worktreeBaseOf(steps, 1)).toBeUndefined();
        expect(pullRequestBaseOf(steps, 1)).toBeUndefined();
        expect(pullRequestBaseOf(steps, 3)).toBe('p/2');
        const both = steps.map(item => (item.id === 's2' ? { ...item, mergedAt: 6 } : item));
        expect(pullRequestBaseOf(both, 3)).toBeUndefined();
    });

    it('waits until the step below has its branch', () => {
        const steps = stack().map((item, index) => (index > 0 ? { ...item, status: 'pending' as const, branch: undefined, pr: undefined } : item));
        expect(stackWait(plan(steps), 1)).toBeUndefined();
        const running = steps.map(item => (item.id === 's2' ? { ...item, status: 'running' as const } : item));
        expect(stackWait(plan(running), 3)).toBe('Waiting for step 2 to push its branch.');
        expect(stackWait(plan(running, { noStack: true }), 3)).toBeUndefined();
        // The web step does not stack on the API steps.
        expect(stackWait(plan(running), 2)).toBeUndefined();
    });

    it('rebases the steps that target the merged branch onto the base of the merged pull request', () => {
        const steps = stack();
        expect(restackTargets(steps, 0)).toEqual([{ index: 1, onto: 'main' }]);
        expect(restackTargets(steps, 1)).toEqual([{ index: 3, onto: 'p/1' }]);
        expect(restackTargets(steps, 2)).toEqual([]);
        expect(restackTargets(steps, 3)).toEqual([]);
        // After the first restack, step 2 targets main. When it merges, step 3 moves onto main.
        const after = steps.map(item => (item.id === 's1' ? { ...item, mergedAt: 5 } : item.id === 's2' ? { ...item, pr: pr(2, 'main') } : item));
        expect(restackTargets(after, 1)).toEqual([{ index: 3, onto: 'main' }]);
        // A step without a worktree or with a merged pull request does not rebase.
        expect(
            restackTargets(
                steps.map(item => (item.id === 's2' ? { ...item, worktreePath: undefined } : item)),
                0
            )
        ).toEqual([]);
        expect(
            restackTargets(
                steps.map(item => (item.id === 's2' ? { ...item, mergedAt: 7 } : item)),
                0
            )
        ).toEqual([]);
    });

    it('gives the old base commits for "git rebase --onto"', () => {
        expect(restackOldBases({ stackBase: 'aaaaaaa' }, 'cccccccc')).toEqual(['aaaaaaa', 'cccccccc']);
        expect(restackOldBases({}, undefined)).toEqual([]);
        expect(restackOldBases({ stackBase: 'aaaaaaa' }, '--exec=x')).toEqual(['aaaaaaa']);
    });

    it('keeps the stack fields of a valid plan, and drops the fields that are not valid', () => {
        const saved = normalizePlan({
            id: 'a',
            projectId: 'p',
            noStack: true,
            steps: [
                { id: 's', stackBase: 'abcdef1', mergedAt: 9, restack: { onto: 'main', state: 'push', merged: 3, oldBases: ['abcdef1', 'nope'] } },
                { id: 't', stackBase: 'not a hash', restack: { onto: 'main', state: 'other', merged: 3 } }
            ]
        });
        expect(saved?.noStack).toBe(true);
        expect(saved?.steps[0]).toMatchObject({
            stackBase: 'abcdef1',
            mergedAt: 9,
            restack: { onto: 'main', state: 'push', merged: 3, oldBases: ['abcdef1'] }
        });
        expect(saved?.steps[1].stackBase).toBeUndefined();
        expect(saved?.steps[1].restack).toBeUndefined();
        expect(normalizePlan({ id: 'a', projectId: 'p' })?.noStack).toBeUndefined();
        expect(duplicatePlan(plan([], { noStack: true }), 1).noStack).toBe(true);
    });
});

describe('planGroups', () => {
    const project = (id: string) => ({ id, name: id.toUpperCase(), repos: [] });
    const plan = (id: string, projectId: string) => ({ ...newPlan(projectId, 1), id });

    it('puts the active project first and keeps the order of the other projects', () => {
        const plans = [plan('p1', 'a'), plan('p2', 'c'), plan('p3', 'b'), plan('p4', 'c')];
        const groups = planGroups(plans, [project('a'), project('b'), project('c')], 'b');
        expect(groups.map(group => group.project.id)).toEqual(['b', 'a', 'c']);
        expect(groups[2].plans.map(item => item.id)).toEqual(['p2', 'p4']);
    });

    it('leaves out projects without plans and plans of removed projects', () => {
        const groups = planGroups([plan('p1', 'a'), plan('p2', 'gone')], [project('a'), project('b')], 'b');
        expect(groups.map(group => group.project.id)).toEqual(['a']);
    });
});
