import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMessageParser, encodeMessage } from '../sdk/index.js';
import { createHandlers } from './handlers.js';
import * as local from './map.js';
import { TaskFile, writeFileAtomic } from './store.js';

let dir;
beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shipwarden-local-'));
});
afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
});

describe('Local tasks mapping', () => {
    it('uses To do, In progress and Done without a setting', () => {
        expect(local.parseStatuses('').map(status => [status.id, status.name, status.category])).toEqual([
            ['to-do', 'To do', 'todo'],
            ['in-progress', 'In progress', 'in_progress'],
            ['done', 'Done', 'done']
        ]);
    });

    it('reads custom statuses and finds the category from the name or the position', () => {
        const statuses = local.parseStatuses('Backlog, Ready, Doing, Review\nShipped, Canceled, Doing');
        expect(statuses.map(status => [status.id, status.category, status.order])).toEqual([
            ['backlog', 'backlog', 0],
            ['ready', 'todo', 1],
            ['doing', 'in_progress', 2],
            ['review', 'in_progress', 3],
            ['shipped', 'done', 4],
            ['canceled', 'canceled', 5]
        ]);
        expect(local.parseStatuses('Next, Now, Then').map(status => status.category)).toEqual(['todo', 'in_progress', 'done']);
        expect(local.parseStatuses(' , ,').map(status => status.name)).toEqual(['To do', 'In progress', 'Done']);
    });

    it('shows a status that is not in the settings with its ID', () => {
        expect(local.statusFor(local.parseStatuses(''), 'blocked')).toMatchObject({ id: 'blocked', name: 'blocked', category: 'todo' });
    });

    it('puts the task file in the repository or in the home folder', () => {
        expect(local.taskFilePath('/code/app', { inRepository: true, home: '/home/me' })).toBe(path.join('/code/app', '.shipwarden', 'tasks.json'));
        const a = local.taskFilePath('/code/app', { inRepository: false, home: '/home/me' });
        const b = local.taskFilePath('/other/app', { inRepository: false, home: '/home/me' });
        expect(path.dirname(a)).toBe(path.join('/home/me', '.shipwarden', 'tasks'));
        expect(path.basename(a)).toMatch(/^app-[0-9a-f]{8}\.json$/);
        expect(a).not.toBe(b);
    });

    it('makes and reads task IDs with the repository path', () => {
        expect(local.taskId('/code/my#app', 7)).toBe('/code/my#app#7');
        expect(local.parseTaskId('/code/my#app#7')).toEqual({ collection: '/code/my#app', number: 7 });
        expect(() => local.parseTaskId('7')).toThrow('not valid');
        expect(() => local.parseTaskId('/code/app#x')).toThrow('not valid');
    });

    it('maps a stored task', () => {
        const stored = { number: 3, title: 'Fix login', description: 'Body', status: 'done', createdAt: 'c', updatedAt: 'u', archived: true, comments: [{}] };
        expect(local.toTask(stored, '/r', local.parseStatuses(''), { withDescription: true })).toEqual({
            id: '/r#3',
            key: 'T-3',
            title: 'Fix login',
            status: { id: 'done', name: 'Done', color: '#3fb950', category: 'done', order: 2 },
            labels: [{ name: 'archived', color: '#8b949e' }],
            updatedAt: 'u',
            description: 'Body',
            fields: { createdAt: 'c', comments: 1 }
        });
    });

    it('filters by the archive state and searches the title, the description and the comments', () => {
        const task = { number: 12, title: 'Fix login', description: 'The session expires', comments: [{ body: 'Safari only' }] };
        expect(local.matchesFilter(task)).toBe(true);
        expect(local.matchesFilter({ ...task, archived: true })).toBe(false);
        expect(local.matchesFilter({ ...task, archived: true }, 'archived')).toBe(true);
        expect(local.matchesFilter(task, 'all')).toBe(true);
        expect(local.matchesQuery(task, 't-12 login')).toBe(true);
        expect(local.matchesQuery(task, 'SESSION safari')).toBe(true);
        expect(local.matchesQuery(task, 'billing')).toBe(false);
    });
});

describe('Local task file', () => {
    it('reads a missing or empty file as an empty task file', async () => {
        expect(await new TaskFile(path.join(dir, 'none.json')).read()).toEqual({ version: 1, nextNumber: 1, tasks: [] });
        await fs.writeFile(path.join(dir, 'empty.json'), '  \n');
        expect((await new TaskFile(path.join(dir, 'empty.json')).read()).tasks).toEqual([]);
    });

    it('does not write to a file that is not valid JSON', async () => {
        const file = path.join(dir, 'bad.json');
        await fs.writeFile(file, '{ "tasks": [');
        const store = new TaskFile(file);
        await expect(store.update(data => data.tasks.push({ number: 1, title: 'x' }))).rejects.toThrow('not valid JSON');
        expect(await fs.readFile(file, 'utf8')).toBe('{ "tasks": [');
        await fs.writeFile(file, '[1, 2]');
        await expect(store.read()).rejects.toThrow('not a ShipWarden task file');
    });

    it('repairs the next number and the comments of a file that a person edited', async () => {
        const file = path.join(dir, 'edited.json');
        await fs.writeFile(file, JSON.stringify({ nextNumber: 2, tasks: [{ number: 5, title: 'a' }, { title: 'no number' }] }));
        const data = await new TaskFile(file).read();
        expect(data.nextNumber).toBe(6);
        expect(data.tasks).toEqual([{ number: 5, title: 'a', comments: [] }]);
    });

    it('does the changes of one process one at a time, so no change is lost', async () => {
        const file = path.join(dir, 'tasks.json');
        const store = new TaskFile(file);
        await Promise.all(
            Array.from({ length: 20 }, (_, index) =>
                store.update(data => {
                    data.tasks.push({ number: data.nextNumber, title: `Task ${index}` });
                    data.nextNumber += 1;
                })
            )
        );
        const data = JSON.parse(await fs.readFile(file, 'utf8'));
        expect(data.tasks.map(task => task.number)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    });

    it('continues after a failed change', async () => {
        const store = new TaskFile(path.join(dir, 'tasks.json'));
        await expect(
            store.update(() => {
                throw new Error('no');
            })
        ).rejects.toThrow('no');
        await store.update(data => {
            data.nextNumber = 9;
        });
        expect((await store.read()).nextNumber).toBe(9);
    });

    it('writes atomically and leaves no temporary file', async () => {
        const file = path.join(dir, 'sub', 'tasks.json');
        await writeFileAtomic(file, 'one');
        await writeFileAtomic(file, 'two');
        expect(await fs.readFile(file, 'utf8')).toBe('two');
        expect(await fs.readdir(path.dirname(file))).toEqual(['tasks.json']);
    });

    it('keeps the old file and removes the temporary file when the rename fails', async () => {
        // A folder in place of the file makes the rename fail.
        const file = path.join(dir, 'folder');
        await fs.mkdir(path.join(file, 'child'), { recursive: true });
        await expect(writeFileAtomic(file, 'text')).rejects.toThrow();
        expect((await fs.readdir(dir)).sort()).toEqual(['folder']);
    });
});

describe('Local tasks handlers', () => {
    const repo = '/code/app';
    const start = async (settings = {}) => {
        const plugin = createHandlers({ home: dir, author: async () => 'Ann' });
        await plugin.handlers.initialize({ protocolVersion: 3, settings, context: { repositories: [{ root: repo }, { root: '/code/api' }] } });
        return plugin.handlers;
    };

    it('lists a collection for each repository', async () => {
        const handlers = await start();
        expect(await handlers.listCollections({})).toEqual([
            { id: '/code/app', name: 'app', path: '/code', default: true },
            { id: '/code/api', name: 'api', path: '/code' }
        ]);
        await expect(handlers.listTasks({ collection: '/elsewhere' })).rejects.toThrow('not in a ShipWarden project');
    });

    it('creates, edits, moves, comments on and deletes a task', async () => {
        const handlers = await start();
        const created = await handlers.createTask({ collection: repo, title: '  Fix   login ', description: 'Steps' });
        expect(created).toMatchObject({ id: '/code/app#1', key: 'T-1', title: 'Fix login', description: 'Steps', status: { id: 'to-do' } });
        await handlers.createTask({ collection: repo, title: 'Second' });
        expect((await handlers.listTasks({ collection: repo })).tasks.map(task => task.key)).toEqual(['T-2', 'T-1']);
        expect((await handlers.listTasks({ collection: repo, query: 'steps' })).tasks.map(task => task.key)).toEqual(['T-1']);

        const edited = await handlers.updateTask({ id: created.id, title: 'Fix the login', description: 'New steps' });
        expect(edited).toMatchObject({ title: 'Fix the login', description: 'New steps', status: { id: 'to-do' } });
        expect((await handlers.updateTask({ id: created.id, status: 'done' })).status.name).toBe('Done');
        await expect(handlers.updateTask({ id: created.id, status: 'nope' })).rejects.toThrow('does not exist');
        await expect(handlers.updateTask({ id: created.id, title: ' ' })).rejects.toThrow('must have a title');

        const comment = await handlers.createComment({ taskId: created.id, body: 'Looks good' });
        expect(comment).toMatchObject({ author: { name: 'Ann' }, body: 'Looks good' });
        expect(await handlers.listComments({ taskId: created.id })).toEqual([comment]);

        await handlers.deleteTask({ id: created.id });
        await expect(handlers.getTask({ id: created.id })).rejects.toThrow('does not exist');
        // A deleted number is not used again.
        expect((await handlers.createTask({ collection: repo, title: 'Third' })).key).toBe('T-3');
    });

    it('archives and restores a task', async () => {
        const handlers = await start();
        const { id } = await handlers.createTask({ collection: repo, title: 'Old' });
        expect((await handlers.runAction({ taskId: id, actionId: 'archive' })).message).toContain('archived');
        expect((await handlers.listTasks({ collection: repo })).tasks).toEqual([]);
        expect((await handlers.listTasks({ collection: repo, filter: 'archived' })).tasks.map(task => task.id)).toEqual([id]);
        expect((await handlers.runAction({ taskId: id, actionId: 'archive' })).message).toContain('already');
        await handlers.runAction({ taskId: id, actionId: 'restore' });
        expect((await handlers.listTasks({ collection: repo })).tasks.map(task => task.id)).toEqual([id]);
    });

    it('uses the statuses from the settings and keeps the file in the repository when the setting is on', async () => {
        const root = path.join(dir, 'repo');
        const plugin = createHandlers({ home: path.join(dir, 'home') });
        await plugin.handlers.initialize({ settings: { inRepository: true, statuses: 'Open, Doing, Closed' }, context: { repositories: [{ root }] } });
        const task = await plugin.handlers.createTask({ collection: root, title: 'A' });
        expect(task.status).toMatchObject({ id: 'open', category: 'todo' });
        expect((await plugin.handlers.statusOrder({ collection: root })).statuses.map(status => status.name)).toEqual(['Open', 'Doing', 'Closed']);
        const stored = JSON.parse(await fs.readFile(path.join(root, '.shipwarden', 'tasks.json'), 'utf8'));
        expect(stored.tasks[0]).toMatchObject({ number: 1, title: 'A', status: 'open' });
    });
});

describe('Local tasks plugin process', () => {
    it('answers protocol requests over stdin and stdout', async () => {
        const child = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.js')], {
            env: { ...process.env, HOME: dir },
            stdio: ['pipe', 'pipe', 'pipe']
        });
        const parse = createMessageParser();
        const waiting = new Map();
        child.stdout.on('data', chunk => {
            for (const message of parse(chunk)) {
                waiting.get(message.id)?.(message);
            }
        });
        let next = 0;
        const send = (method, params) =>
            new Promise(resolve => {
                next += 1;
                waiting.set(next, resolve);
                child.stdin.write(encodeMessage({ jsonrpc: '2.0', id: next, method, params }));
            });
        const root = path.join(dir, 'repo');
        try {
            const init = await send('initialize', { protocolVersion: 3, settings: {}, context: { repositories: [{ root }] } });
            expect(init.result.capabilities).toMatchObject({ create: true, edit: true, delete: true, update: true, comments: true, statusOrder: true });
            const created = await send('tasks/create', { collection: root, title: 'From the protocol' });
            expect(created.result.key).toBe('T-1');
            const list = await send('tasks/list', { collection: root });
            expect(list.result.tasks.map(task => task.title)).toEqual(['From the protocol']);
            const failed = await send('tasks/get', { id: `${root}#9` });
            expect(failed.error.message).toContain('does not exist');
            expect(await fs.readdir(path.join(dir, '.shipwarden', 'tasks'))).toHaveLength(1);
            await send('shutdown');
        } finally {
            child.kill();
        }
    });
});
