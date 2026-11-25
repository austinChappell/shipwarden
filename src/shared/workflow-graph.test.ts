import { describe, expect, it } from 'vitest';
import type { CheckRun } from './github';
import { buildWorkflowGraph, groupState, matchJobs, shortJobName, type WorkflowJobSpec } from './workflow-graph';

let nextId = 1;

function job(name: string, change: Partial<CheckRun> = {}): CheckRun {
    return {
        id: nextId++,
        name,
        status: 'completed',
        conclusion: 'success',
        startedAt: null,
        completedAt: null,
        url: null,
        isActions: true,
        ...change
    };
}

function spec(id: string, change: Partial<WorkflowJobSpec> = {}): WorkflowJobSpec {
    return { id, needs: [], matrix: false, reusable: false, ...change };
}

describe('matchJobs', () => {
    it('matches the names, the matrix jobs, the reusable workflows and the expressions', () => {
        const specs = [
            spec('lint', { name: 'Lint code' }),
            spec('test', { matrix: true }),
            spec('test-e2e'),
            spec('deploy', { reusable: true }),
            spec('build', { name: 'Build ${{ matrix.os }}', matrix: true })
        ];
        const jobs = [
            job('Lint code'),
            job('test (20)'),
            job('test (22, yarn test:ci --coverage-directory=co...'),
            job('test-e2e'),
            job('deploy / release'),
            job('Build linux'),
            job('other')
        ];
        const { byId, rest } = matchJobs(specs, jobs);
        expect(byId.get('lint')?.map(item => item.name)).toEqual(['Lint code']);
        expect(byId.get('test')?.map(item => item.name)).toEqual(['test (20)', 'test (22, yarn test:ci --coverage-directory=co...']);
        expect(byId.get('test-e2e')?.map(item => item.name)).toEqual(['test-e2e']);
        expect(byId.get('deploy')?.map(item => item.name)).toEqual(['deploy / release']);
        expect(byId.get('build')?.map(item => item.name)).toEqual(['Build linux']);
        expect(rest.map(item => item.name)).toEqual(['other']);
    });
});

describe('buildWorkflowGraph', () => {
    it('puts each job in the column after its latest need and shares a box between jobs with the same needs', () => {
        const specs = [
            spec('setup'),
            spec('docker'),
            spec('schema', { needs: ['setup', 'docker'] }),
            spec('docs', { needs: ['docker', 'setup'] }),
            spec('test', { needs: ['schema', 'setup'], matrix: true }),
            spec('coverage', { needs: ['test'] })
        ];
        const jobs = [job('setup'), job('docker'), job('schema'), job('docs'), job('test (1)'), job('test (2)', { status: 'in_progress', conclusion: null })];
        const graph = buildWorkflowGraph(specs, jobs);
        expect(graph.columns.map(column => column.map(stack => stack.nodes.map(node => node.id)))).toEqual([
            [['setup'], ['docker']],
            [['schema', 'docs']],
            [['test']],
            [['coverage']]
        ]);
        const test = graph.columns[2][0].nodes[0];
        expect(test).toMatchObject({ kind: 'group', label: 'Matrix: test' });
        expect(test.jobs).toHaveLength(2);
        expect(graph.columns[3][0].nodes[0].jobs).toEqual([]);
        expect(graph.edges).toEqual([
            { from: 'setup', to: 'stack:schema' },
            { from: 'docker', to: 'stack:schema' },
            { from: 'schema', to: 'stack:test' },
            { from: 'setup', to: 'stack:test' },
            { from: 'test', to: 'stack:coverage' }
        ]);
    });

    it('ignores unknown needs and cycles, and puts the jobs that match nothing in the first column', () => {
        const graph = buildWorkflowGraph([spec('a', { needs: ['b', 'missing'] }), spec('b', { needs: ['a'] })], [job('a'), job('extra')]);
        expect(graph.columns.flat().flatMap(stack => stack.nodes.map(node => node.id))).toEqual(expect.arrayContaining(['a', 'b', `job:${nextId - 1}`]));
        expect(graph.columns[0].some(stack => stack.nodes[0].label === 'extra')).toBe(true);
    });

    it('sorts the boxes of a column by the rows of their needs', () => {
        const specs = [spec('a'), spec('b'), spec('from-b', { needs: ['b'] }), spec('from-a', { needs: ['a'] })];
        const graph = buildWorkflowGraph(specs, []);
        expect(graph.columns[1].map(stack => stack.id)).toEqual(['stack:from-a', 'stack:from-b']);
    });
});

describe('groupState', () => {
    it('shows a failure first, then a running job, then a waiting job', () => {
        expect(groupState([job('a'), job('b', { conclusion: 'failure' }), job('c', { status: 'in_progress', conclusion: null })])).toMatchObject({
            status: 'completed',
            conclusion: 'failure',
            completed: 2,
            total: 3
        });
        expect(groupState([job('a'), job('b', { status: 'in_progress', conclusion: null })])).toMatchObject({ status: 'in_progress', completed: 1 });
        expect(groupState([job('a'), job('b', { status: 'queued', conclusion: null })])).toMatchObject({ status: 'queued' });
        expect(groupState([job('a', { conclusion: 'skipped' })])).toMatchObject({ conclusion: 'skipped' });
        expect(groupState([job('a')])).toMatchObject({ conclusion: 'success' });
    });
});

describe('shortJobName', () => {
    it('returns the matrix values or the inner job', () => {
        expect(shortJobName('test (20, ubuntu)')).toBe('20, ubuntu');
        expect(shortJobName('test (rest-3, yarn test:ci --co...')).toBe('rest-3, yarn test:ci --co...');
        expect(shortJobName('deploy / release')).toBe('release');
        expect(shortJobName('lint')).toBe('lint');
    });
});
