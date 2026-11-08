import { describe, expect, it } from 'vitest';
import { addRepo, cleanProjectName, createProject, deleteProject, moveProject, moveRepo, normalizeProjects, removeRepo, renameProject, repoName, setActiveProject, type ProjectsState } from './projects';

const ids = () => {
    let next = 0;
    return () => `id-${++next}`;
};

const state: ProjectsState = {
    projects: [
        { id: 'a', name: 'Work', repos: ['/r/api', '/r/web'] },
        { id: 'b', name: 'Side', repos: ['/r/game'] }
    ],
    activeId: 'a'
};

describe('normalizeProjects', () => {
    it('makes a default project when nothing is stored', () => {
        expect(normalizeProjects(undefined, ids())).toEqual({ projects: [{ id: 'id-1', name: 'Default', repos: [] }], activeId: 'id-1' });
    });

    it('removes bad entries, duplicate IDs and duplicate or relative repos', () => {
        const value = {
            projects: [
                { id: 'a', name: ' Work ', repos: ['/r/api', '/r/api', 'relative', 7] },
                { id: 'a', name: 'Duplicate', repos: [] },
                { name: 'No ID' },
                'text',
                { id: 'b', name: '', repos: 'bad' }
            ],
            activeId: 'missing'
        };
        expect(normalizeProjects(value, ids())).toEqual({
            projects: [{ id: 'a', name: 'Work', repos: ['/r/api'] }, { id: 'b', name: 'Untitled', repos: [] }],
            activeId: 'a'
        });
    });
});

describe('project changes', () => {
    it('creates a project and makes it active', () => {
        const next = createProject(state, 'c', '  Client   work ');
        expect(next.projects[2]).toEqual({ id: 'c', name: 'Client work', repos: [] });
        expect(next.activeId).toBe('c');
    });

    it('rejects empty and long names', () => {
        expect(() => cleanProjectName('   ')).toThrow('Type a name');
        expect(() => renameProject(state, 'a', 'x'.repeat(81))).toThrow('80 characters');
        expect(renameProject(state, 'b', 'Hobby').projects[1].name).toBe('Hobby');
    });

    it('deletes a project, moves the active project, and keeps the last project', () => {
        expect(deleteProject(state, 'a')).toEqual({ projects: [state.projects[1]], activeId: 'b' });
        expect(deleteProject(state, 'b').activeId).toBe('a');
        expect(() => deleteProject({ projects: [state.projects[0]], activeId: 'a' }, 'a')).toThrow('at least one project');
        expect(() => setActiveProject(state, 'zzz')).toThrow('does not exist');
    });

    it('adds a repo once and removes it', () => {
        const added = addRepo(state, 'b', '/r/api');
        expect(added.projects[1].repos).toEqual(['/r/game', '/r/api']);
        expect(addRepo(added, 'b', '/r/api')).toBe(added);
        expect(removeRepo(added, 'b', '/r/game').projects[1].repos).toEqual(['/r/api']);
        // The same repo stays in the other project.
        expect(removeRepo(added, 'b', '/r/api').projects[0].repos).toEqual(['/r/api', '/r/web']);
    });

    it('names a repo after its folder', () => {
        expect(repoName('/Users/me/dev/shipwarden/')).toBe('shipwarden');
    });
});

describe('order changes', () => {
    it('moves a project to a new position', () => {
        expect(moveProject(state, 'b', 0).projects.map(project => project.id)).toEqual(['b', 'a']);
        expect(moveProject(state, 'a', 99).projects.map(project => project.id)).toEqual(['b', 'a']);
        expect(moveProject(state, 'a', 0).activeId).toBe('a');
    });

    it('moves a repository in a project', () => {
        const three = addRepo(state, 'a', '/r/docs');
        expect(moveRepo(three, 'a', '/r/docs', 0).projects[0].repos).toEqual(['/r/docs', '/r/api', '/r/web']);
        expect(moveRepo(three, 'a', '/r/api', 1).projects[0].repos).toEqual(['/r/web', '/r/api', '/r/docs']);
        expect(moveRepo(three, 'a', '/r/api', -5).projects[0].repos).toEqual(['/r/api', '/r/web', '/r/docs']);
    });

    it('rejects a repository or project that does not exist', () => {
        expect(() => moveRepo(state, 'a', '/r/game', 0)).toThrow(/not in the project/);
        expect(() => moveProject(state, 'x', 0)).toThrow(/does not exist/);
    });
});
