import { describe, expect, it } from 'vitest';
import * as azure from './map.js';

const { FIELDS } = azure;
const HOUR = 60 * 60 * 1000;
const taskFields = new Set([
    FIELDS.title,
    FIELDS.description,
    FIELDS.assignedTo,
    FIELDS.tags,
    FIELDS.priority,
    FIELDS.startDate,
    FIELDS.dueDate,
    FIELDS.originalEstimate
]);
const bugFields = new Set([FIELDS.title, FIELDS.description, FIELDS.reproSteps, FIELDS.priority]);
const featureFields = new Set([FIELDS.title, FIELDS.description, FIELDS.acceptanceCriteria, FIELDS.targetDate, FIELDS.startDate]);

describe('Azure DevOps edits', () => {
    it('gives a person the unique name as the ID', () => {
        expect(azure.person({ displayName: 'Jamal', uniqueName: 'jamal@example.com' })).toEqual({ id: 'jamal@example.com', name: 'Jamal' });
        expect(azure.person('Jamal Hartnett <jamal@example.com>')).toEqual({ id: 'jamal@example.com', name: 'Jamal Hartnett' });
    });

    it('reads the details: creator, dates and times in hours', () => {
        const item = {
            fields: {
                'System.AreaPath': 'Web\\UI',
                'System.CreatedBy': { displayName: 'Ann', uniqueName: 'ann@example.com' },
                'System.CreatedDate': '2026-11-01T10:00:00Z',
                [FIELDS.startDate]: '2026-11-02T00:00:00Z',
                [FIELDS.targetDate]: '2026-11-20T00:00:00Z',
                [FIELDS.originalEstimate]: 1.5,
                [FIELDS.completedWork]: 0
            }
        };
        expect(azure.toDetails(item)).toEqual({
            location: 'Web\\UI',
            creator: { id: 'ann@example.com', name: 'Ann' },
            createdAt: '2026-11-01T10:00:00Z',
            startDate: '2026-11-02T00:00:00Z',
            dueDate: '2026-11-20T00:00:00Z',
            timeEstimate: 1.5 * HOUR,
            timeSpent: 0
        });
        expect(azure.toDetails({ fields: {} })).toEqual({});
    });

    it('finds the editable parts from the fields of the work item type', () => {
        expect(azure.editableParts({ fields: {} }, taskFields)).toEqual({
            title: true,
            description: true,
            assignees: true,
            labels: true,
            priority: true,
            startDate: true,
            dueDate: true,
            timeEstimate: true
        });
        const bug = azure.editableParts({ fields: { [FIELDS.reproSteps]: '' } }, bugFields);
        expect(bug).toMatchObject({ description: false, priority: true, startDate: false, dueDate: false, timeEstimate: false });
        expect(azure.editableParts({ fields: {} }, featureFields)).toMatchObject({ description: true, dueDate: true, priority: false });
        expect(azure.editableParts({ fields: { [FIELDS.acceptanceCriteria]: '<p>Done</p>' } }, featureFields).description).toBe(false);
    });

    it('makes JSON Patch operations for the state, the title, the description, the assignee and the tags', () => {
        expect(azure.workItemPatch({ id: '1' }, taskFields)).toEqual([]);
        expect(azure.workItemPatch({ id: '1', status: 'Active', title: ' New ' }, taskFields)).toEqual([
            { op: 'add', path: '/fields/System.State', value: 'Active' },
            { op: 'add', path: '/fields/System.Title', value: 'New' }
        ]);
        expect(azure.workItemPatch({ id: '1', description: '**a**' }, taskFields)).toEqual([
            { op: 'add', path: '/fields/System.Description', value: '**a**' },
            { op: 'add', path: '/multilineFieldsFormat/System.Description', value: 'Markdown' }
        ]);
        expect(azure.workItemPatch({ id: '1', description: 'a < b\nc\n\nd' }, taskFields, { htmlDescription: true })).toEqual([
            { op: 'add', path: '/fields/System.Description', value: '<div>a &lt; b<br>c</div><div>d</div>' }
        ]);
        expect(azure.workItemPatch({ id: '1', assignees: ['a@x.com', 'b@x.com'] }, taskFields)).toEqual([
            { op: 'add', path: '/fields/System.AssignedTo', value: 'b@x.com' }
        ]);
        expect(azure.workItemPatch({ id: '1', assignees: [] }, taskFields)).toEqual([{ op: 'add', path: '/fields/System.AssignedTo', value: '' }]);
        expect(azure.workItemPatch({ id: '1', labels: ['ui', ' api ', 'ui'] }, taskFields)).toEqual([
            { op: 'add', path: '/fields/System.Tags', value: 'ui; api' }
        ]);
    });

    it('makes JSON Patch operations for the priority, the dates and the estimate', () => {
        expect(azure.workItemPatch({ id: '1', priority: '2' }, taskFields)).toEqual([{ op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: 2 }]);
        expect(azure.workItemPatch({ id: '1', priority: null }, taskFields)).toEqual([{ op: 'remove', path: '/fields/Microsoft.VSTS.Common.Priority' }]);
        expect(azure.workItemPatch({ id: '1', startDate: '2026-12-01', dueDate: null }, taskFields)).toEqual([
            { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.StartDate', value: new Date(2026, 11, 1).toISOString() },
            { op: 'remove', path: '/fields/Microsoft.VSTS.Scheduling.DueDate' }
        ]);
        expect(azure.workItemPatch({ id: '1', dueDate: '2026-12-24' }, featureFields)).toEqual([
            { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.TargetDate', value: new Date(2026, 11, 24).toISOString() }
        ]);
        expect(azure.workItemPatch({ id: '1', timeEstimate: 90 * 60 * 1000 }, taskFields)).toEqual([
            { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.OriginalEstimate', value: 1.5 }
        ]);
    });

    it('refuses the parts that the work item type does not have, and values that are not valid', () => {
        expect(() => azure.workItemPatch({ id: '1', title: '' }, taskFields)).toThrow('must have a title');
        expect(() => azure.workItemPatch({ id: '1', dueDate: '2026-12-01' }, bugFields)).toThrow('does not have a due date');
        expect(() => azure.workItemPatch({ id: '1', timeEstimate: 1 }, featureFields)).toThrow('original estimate');
        expect(() => azure.workItemPatch({ id: '1', startDate: '1/12/2026' }, taskFields)).toThrow('YYYY-MM-DD');
        expect(() => azure.workItemPatch({ id: '1', priority: 'high' }, taskFields)).toThrow('not valid');
        expect(() => azure.workItemPatch({ id: '1', checklistItem: { id: 'c', done: true } }, taskFields)).toThrow('checklists');
    });

    it('lists the team members once, without groups, sorted by name', () => {
        const lists = [
            [{ identity: { displayName: 'Zoe', uniqueName: 'zoe@x.com' } }, { identity: { displayName: 'Admins', uniqueName: 'admins', isContainer: true } }],
            [{ identity: { displayName: 'Ann', uniqueName: 'ann@x.com' } }, { identity: { displayName: 'Zoe', uniqueName: 'ZOE@x.com' } }]
        ];
        expect(azure.memberOptions(lists)).toEqual([
            { id: 'ann@x.com', name: 'Ann' },
            { id: 'zoe@x.com', name: 'Zoe' }
        ]);
        expect(azure.PRIORITIES).toEqual([
            { id: '1', name: 'Critical' },
            { id: '2', name: 'High' },
            { id: '3', name: 'Medium' },
            { id: '4', name: 'Low' }
        ]);
    });

    it('finds the parent and the children in the relations of a work item', () => {
        const link = (rel, id) => ({ rel, url: `https://dev.azure.com/o/_apis/wit/workItems/${id}` });
        const item = {
            relations: [link(azure.PARENT_RELATION, 7), link(azure.CHILD_RELATION, 9), link('System.LinkTypes.Related', 3), link(azure.CHILD_RELATION, 8)]
        };
        expect(azure.hierarchyIds(item)).toEqual({ parent: 7, children: [9, 8] });
        expect(azure.hierarchyIds({})).toEqual({ parent: undefined, children: [] });
    });

    it('selects the type of a new work item from the categories of the project', () => {
        const categories = [
            { referenceName: 'Microsoft.RequirementCategory', defaultWorkItemType: { name: 'User Story' } },
            { referenceName: 'Microsoft.TaskCategory', defaultWorkItemType: { name: 'Task' } }
        ];
        expect(azure.newItemType(categories, ['Bug'], false)).toBe('User Story');
        expect(azure.newItemType(categories, ['Bug'], true)).toBe('Task');
        expect(azure.newItemType([], ['Issue', 'Task'], true)).toBe('Issue');
        expect(() => azure.newItemType([], [], false)).toThrow('no work item type');
    });
});
